/**
 * The content-addressed document store: the hash contract (pinned to vectors
 * taken from Postgres), the never-rewritten invariant (`DOC-001`), the field
 * spread's projections, and a version chain whose rows carry document hashes.
 * The spec is gardeneria's `packages/database/src/Documents.ts` and its
 * `inline_documents` / `block_documents` tables.
 *
 * @module tests/documents
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import {
  canonicalText,
  DocumentHash,
  documentRef,
  onDocumentInsert,
  type DocumentInserted,
  checkedDocumentStore,
  DOCUMENT_VIOLATION,
  documentCheckHook,
  DocumentViolation,
  type DocumentCheck,
} from "../src/Documents.ts";
import {
  defineSubtype,
  ownedAccess,
  WriteRejected,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type LeafRow,
} from "../src/Subtype.ts";
import type { LocalePatch, WriteAction } from "../src/VersionChain.ts";
import { defineVersionChain } from "../src/VersionChain.ts";
import { decodes, NOW } from "./fixtures.ts";
import {
  makeInMemoryDocumentStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryVersionChain,
} from "../src/testing.ts";

const ACTOR = Option.some("u-author");

/** A ProseKit-shaped block document with one paragraph of `text`. */
const paragraph = (text: string): Schema.Json => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** `paragraph("Hello")`'s hash, the first vector below. */
const HELLO = "3a6e0f5584dcd201c82e2b50d8b7ede3dbf3cbed767dac7e8c13c6479da9e721";

/** A well-formed hash no store below holds (the heading vector's). */
const UNSEEN = "643c79922779a36ec34e986f42de968e004b3f3810ec63e32000f83857321b44";

/**
 * Vectors from PostgreSQL (PGlite 0.5.8, PostgreSQL 18.3, pgcrypto, a UTF8
 * database): each document inserted into
 * `hash_id bytea GENERATED ALWAYS AS (digest(document_jsonb::text, 'sha256'))`
 * and read back as `encode(hash_id, 'hex')` and `document_jsonb::text`.
 */
const VECTORS: ReadonlyArray<{
  readonly name: string;
  readonly document: Schema.Json;
  readonly text: string;
  readonly hash: string;
}> = [
  {
    name: "a paragraph",
    document: paragraph("Hello"),
    text: '{"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Hello", "type": "text"}]}]}',
    hash: HELLO,
  },
  {
    name: "a heading with attrs and an empty paragraph",
    document: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        { type: "paragraph" },
      ],
    },
    text: '{"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}, "content": [{"text": "Title", "type": "text"}]}, {"type": "paragraph"}]}',
    hash: UNSEEN,
  },
  {
    name: "a double quote",
    document: paragraph('say "hi"'),
    text: '{"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "say \\"hi\\"", "type": "text"}]}]}',
    hash: "eb4d856a05a76f074f0e5d36d5a709359128e6e6a965273c9a7591f7e4fbff17",
  },
  {
    name: "a newline",
    document: paragraph("a\nb"),
    text: '{"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "a\\nb", "type": "text"}]}]}',
    hash: "4b3a4c221873b8acdacfe1473d71d736f41a4bad0578f70ef3e9797e0c680dc2",
  },
  {
    name: "a backslash",
    document: paragraph("back\\slash"),
    text: '{"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "back\\\\slash", "type": "text"}]}]}',
    hash: "4a83ea253068c9c9d06bc59357266d2c023966f59e02cbd58ac1bd872ec89f29",
  },
  {
    name: "a tab and control characters, escaped in lowercase hex",
    document: paragraph("tab\there \u0001 \u000b \u001f ctl / slash"),
    text: '{"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "tab\\there \\u0001 \\u000b \\u001f ctl / slash", "type": "text"}]}]}',
    hash: "363f051dc515fb6be05f1838dea36489243fa73d61e5e613161133fb97f97d77",
  },
  {
    name: "key order by byte length, non-ASCII, and numbers without an exponent",
    document: { b: 1, aa: 2, a: [1.5, 1e21, 1e-7, -0, 10, "é—€😀"], é: true, z: null },
    text: '{"a": [1.5, 1000000000000000000000, 0.0000001, 0, 10, "é—€😀"], "b": 1, "z": null, "aa": 2, "é": true}',
    hash: "584a9439b9fc8c1d6ab1c758d9749feecd255a88e6670fe577723d1932e43b15",
  },
  {
    name: "empty containers, an empty key, and more numbers",
    document: {
      numbers: [1.5e-7, -2.5, 1.2345e25, 123456789012345680000, 0.1, -0, 100],
      empty: {},
      list: [],
      nested: { "": "x", ab: {}, b: [[]] },
    },
    text: '{"list": [], "empty": {}, "nested": {"": "x", "b": [[]], "ab": {}}, "numbers": [0.00000015, -2.5, 12345000000000000000000000, 123456789012345680000, 0.1, 0, 100]}',
    hash: "a123e7f0b2118242f3a3675215cbe554d20796048ca573345e3c608aa0604fe1",
  },
];

describe("the hash contract — the in-memory store against Postgres", () => {
  it.effect.each(VECTORS)("$name", ({ document, text, hash }) =>
    Effect.gen(function* () {
      expect(canonicalText(document)).toBe(text);
      expect((yield* makeInMemoryDocumentStore().put(document)).hash).toBe(hash);
      expect(decodes(DocumentHash, hash)).toBe(true);
    }),
  );

  it.effect("hashes the structure, not the spelling: member order is irrelevant", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const reordered = {
        content: [{ content: [{ text: "Hello", type: "text" }], type: "paragraph" }],
        type: "doc",
      };
      expect((yield* store.put(reordered)).hash).toBe(HELLO);
    }),
  );

  it("DocumentHash is exactly 64 lowercase hex characters", () => {
    expect(decodes(DocumentHash, HELLO.toUpperCase())).toBe(false);
    expect(decodes(DocumentHash, HELLO.slice(1))).toBe(false);
    expect(decodes(DocumentHash, `${HELLO}0`)).toBe(false);
  });
});

describe("put — idempotent, never rewritten (DOC-001)", () => {
  it.effect("a second put of the same document returns the same hash and writes nothing", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const document = paragraph("Hello");
      const first = yield* store.put(document);
      const second = yield* store.put(document);
      expect(first.inserted).toBe(true);
      expect(second).toEqual({ hash: first.hash, inserted: false });
      expect(HashMap.size(store.stored())).toBe(1);
      expect(store.writes()).toBe(1);
    }),
  );

  it.effect("an equal document never replaces the stored one; a different one is a new write", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const original = paragraph("Hello");
      const hash = (yield* store.put(original)).hash;
      expect(store.writes()).toBe(1);
      // A structurally equal copy reaches the same hash and writes nothing.
      // `stored()` alone can't show that: `HashMap.set` keeps the existing value
      // when the new one is `Equal`, so only the write count tells them apart.
      expect((yield* store.put(paragraph("Hello"))).hash).toBe(hash);
      expect(store.writes()).toBe(1);
      expect(
        Option.exists(HashMap.get(store.stored(), hash), (stored) => stored === original),
      ).toBe(true);
      yield* store.put(paragraph("Hello, world"));
      expect(store.writes()).toBe(2);
    }),
  );

  it.effect("a changed document is a new hash, and the old one is untouched", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const original = paragraph("Hello");
      const before = (yield* store.put(original)).hash;
      const after = (yield* store.put(paragraph("Hello, world"))).hash;
      expect(after).not.toBe(before);
      expect(HashMap.size(store.stored())).toBe(2);
      expect(yield* store.get(before)).toEqual(Option.some(original));
    }),
  );
});
const recording = () => {
  const seen: Array<DocumentInserted<Schema.Json>> = [];
  const inner = makeInMemoryDocumentStore();
  const store = onDocumentInsert(inner, (event) =>
    Effect.sync(() => {
      seen.push(event);
    }),
  );
  return { seen, inner, store };
};

describe("onDocumentInsert — the first-insert event", () => {
  it.effect("runs once per stored document, never for a put that found it stored", () =>
    Effect.gen(function* () {
      const { seen, store } = recording();
      const first = yield* store.put(paragraph("Hello"));
      yield* store.put(paragraph("Hello"));
      const second = yield* store.put(paragraph("World"));
      expect(seen).toEqual([
        { hash: first.hash, document: paragraph("Hello") },
        { hash: second.hash, document: paragraph("World") },
      ]);
    }),
  );

  it.effect("a hook that fails fails the put; get and getMany are the store's own", () =>
    Effect.gen(function* () {
      const inner = makeInMemoryDocumentStore();
      const store = onDocumentInsert(inner, () => Effect.fail("queue down" as const));
      const exit = yield* Effect.exit(store.put(paragraph("Hello")));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(store.get).toBe(inner.get);
      expect(store.getMany).toBe(inner.getMany);
    }),
  );
});

describe("get / getMany", () => {
  it.effect("get returns the stored document, or none for an unseen hash", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const hash = (yield* store.put(paragraph("Hello"))).hash;
      expect(yield* store.get(hash)).toEqual(Option.some(paragraph("Hello")));
      expect(yield* store.get(UNSEEN)).toEqual(Option.none());
    }),
  );

  it.effect("getMany returns the found documents keyed by hash, omitting an unseen one", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore();
      const hello = (yield* store.put(paragraph("Hello"))).hash;
      const world = (yield* store.put(paragraph("World"))).hash;
      const found = yield* store.getMany([hello, UNSEEN, world, hello]);
      expect(HashMap.size(found)).toBe(2);
      expect(HashMap.get(found, hello)).toEqual(Option.some(paragraph("Hello")));
      expect(HashMap.get(found, world)).toEqual(Option.some(paragraph("World")));
    }),
  );
});

describe("documentRef — the version row's document reference", () => {
  const NoteResource = Resource.make("notes", {
    attributes: { ...documentRef("title"), ...documentRef("body") },
  });
  const UUID = "00000000-0000-4000-8000-000000000000";

  it("is required on the resource and at create, and must be a DocumentHash", () => {
    expect(decodes(NoteResource.fields.attributes, { title: HELLO, body: HELLO })).toBe(true);
    expect(decodes(NoteResource.createInput, { title: HELLO, body: HELLO })).toBe(true);
    expect(decodes(NoteResource.createInput, { title: HELLO })).toBe(false);
    expect(decodes(NoteResource.createInput, { title: HELLO, body: "not a hash" })).toBe(false);
  });

  it("is optional at update (carry forward) and never cleared", () => {
    expect(R.keys(NoteResource.updateInput.fields).toSorted()).toEqual(["body", "id", "title"]);
    expect(decodes(NoteResource.updateInput, { id: UUID })).toBe(true);
    expect(decodes(NoteResource.updateInput, { id: UUID, body: HELLO })).toBe(true);
    expect(decodes(NoteResource.updateInput, { id: UUID, body: null })).toBe(false);
  });
});
const setup = () => {
  const documents = makeInMemoryDocumentStore();
  const chainStore = makeInMemoryVersionChain("notes");
  const chain = defineVersionChain("notes", chainStore);
  return { documents, chainStore, chain };
};

describe("version rows that reference documents", () => {
  it.effect("two nodes share one stored document", () =>
    Effect.gen(function* () {
      const { documents, chainStore, chain } = setup();
      const body = paragraph("Shared");
      const createWith = (document: Schema.Json) =>
        Effect.gen(function* () {
          const { hash } = yield* documents.put(document);
          const write = yield* chain.create({
            id: Option.none(),
            state: { body: hash },
            actorId: ACTOR,
          });
          return { hash, id: write.id };
        });
      const first = yield* createWith(body);
      const second = yield* createWith(paragraph("Shared"));
      expect(second.id).not.toBe(first.id);
      expect(second.hash).toBe(first.hash);
      expect(HashMap.size(documents.stored())).toBe(1);
      expect(chainStore.rows().map((row) => row.state["body"])).toEqual([first.hash, first.hash]);
      expect(yield* documents.get(first.hash)).toEqual(Option.some(body));
    }),
  );

  it.effect("restoreVersion restores the old hash, which still reads back the old document", () =>
    Effect.gen(function* () {
      const { documents, chainStore, chain } = setup();
      const original = paragraph("First draft");
      const restored = yield* Effect.gen(function* () {
        const { hash: before } = yield* documents.put(original);
        const { id } = yield* chain.create({
          id: Option.none(),
          state: { body: before },
          actorId: ACTOR,
        });
        const { hash: after } = yield* documents.put(paragraph("Second draft"));
        yield* chain.update({ id, patch: { body: after }, actorId: ACTOR });
        const write = yield* chain.restoreVersion(id, 0n, ACTOR);
        return { before, after, write };
      });
      expect(restored.write.version).toBe(2n);
      expect(chainStore.rows().map((row) => row.state["body"])).toEqual([
        restored.before,
        restored.after,
        restored.before,
      ]);
      // Nothing was re-stored or rewritten: both drafts, each at its own hash.
      expect(HashMap.size(documents.stored())).toBe(2);
      expect(yield* documents.get(restored.before)).toEqual(Option.some(original));
    }),
  );
});
const reasonOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) =>
    error instanceof WriteRejected ? error.reason : String(error),
  );
const beforeWriteEvent = (action: WriteAction, locales: LocalePatch): BeforeWriteEvent => ({
  type: "posts",
  viewer: Option.none(),
  action,
  id: "p-1",
  prior: Option.none(),
  patch: {},
  locales,
  actorId: Option.none(),
});

// ── The grammar check ────────────────────────────────────

type Doc = { readonly type: string };
/** The allow-list: a paragraph only. */
const check: DocumentCheck<Doc> = (field, document) =>
  document.type === "paragraph"
    ? Effect.void
    : Effect.fail(new DocumentViolation({ field, message: `${document.type} is not allowed` }));
const fixture = (extra: ReadonlyArray<BeforeWriteHook<never, never>> = []) => {
  const store = makeInMemoryDocumentStore<Doc>();
  const checks: Array<string> = [];
  const counted: DocumentCheck<Doc> = (field, document) =>
    Effect.andThen(
      Effect.sync(() => checks.push(`${field}:${document.type}`)),
      check(field, document),
    );
  const chain = makeInMemoryVersionChain("posts");
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["title", "body", "visibility"],
    now: NOW,
  });
  const posts = defineSubtype({
    type: "posts",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: Effect.succeedSome({ id: "u-1", role: "user" }),
    policy: {
      canViewPrivate: () => false,
      canViewDeleted: () => false,
      canModerate: () => false,
      canWriteCorpus: () => false,
    },
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
    hooks: Effect.succeed({
      before: [
        ...extra,
        documentCheckHook({ type: "posts", fields: ["body"], documents: store, check: counted }),
      ],
      after: [],
    }),
  });
  const bodies = checkedDocumentStore(store, "body", check);
  return { store, bodies, chain, posts, checks };
};

describe("the grammar check", () => {
  it.effect("checkedDocumentStore never stores an off-grammar document", () =>
    Effect.gen(function* () {
      const { store, bodies } = fixture();
      const exit = yield* Effect.exit(bodies.put({ type: "script" }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(store.writes()).toBe(0);
      expect((yield* bodies.put({ type: "paragraph" })).inserted).toBe(true);
      expect(store.writes()).toBe(1);
    }),
  );

  it.effect(
    "refuses a create or an update whose document fails its grammar, appending nothing",
    () =>
      Effect.gen(function* () {
        const { store, chain, posts } = fixture();
        const outcome = yield* Effect.gen(function* () {
          const good = yield* store.put({ type: "paragraph" });
          const bad = yield* store.put({ type: "script" });
          const created = yield* reasonOf(
            posts.create({ id: Option.none(), state: { body: bad.hash, visibility: "public" } }),
          );
          const rowsAfterCreate = chain.rows().length;
          const { id } = yield* posts.create({
            id: Option.none(),
            state: { body: good.hash, visibility: "public" },
          });
          const updated = yield* reasonOf(posts.update({ id, patch: { body: bad.hash } }));
          return { created, rowsAfterCreate, updated, rows: chain.rows().length };
        });
        expect(outcome).toEqual({
          created: `${DOCUMENT_VIOLATION} body: script is not allowed`,
          rowsAfterCreate: 0,
          updated: `${DOCUMENT_VIOLATION} body: script is not allowed`,
          rows: 1,
        });
      }),
  );

  it.effect("refuses a reference to no stored document (fail closed)", () =>
    Effect.gen(function* () {
      const { posts } = fixture();
      const reason = yield* reasonOf(
        posts.create({ id: Option.none(), state: { body: "0".repeat(64), visibility: "public" } }),
      );
      expect(reason).toBe(`${DOCUMENT_VIOLATION} body: no stored document at this reference`);
    }),
  );

  it.effect(
    "checks only what the patch sets: an absent field, a cleared one and undeclared columns are not read",
    () =>
      Effect.gen(function* () {
        const { store, posts, checks } = fixture();
        const versions = yield* Effect.gen(function* () {
          const good = yield* store.put({ type: "paragraph" });
          const { id } = yield* posts.create({
            id: Option.none(),
            state: { body: good.hash, title: "Hello", visibility: "public" },
          });
          yield* posts.update({ id, patch: { title: "Hi" } });
          yield* posts.update({ id, patch: { body: null } });
          return id;
        });
        expect(versions).toBeTypeOf("string");
        expect(checks).toEqual(["body:paragraph"]);
      }),
  );

  it.effect("leaves restoreVersion, delete and restore over an unchanged reference unchecked", () =>
    Effect.gen(function* () {
      const { store, posts, checks } = fixture();
      yield* Effect.gen(function* () {
        const good = yield* store.put({ type: "paragraph" });
        const { id } = yield* posts.create({
          id: Option.none(),
          state: { body: good.hash, visibility: "public" },
        });
        yield* posts.delete(id);
        yield* posts.restoreVersion(id, 0n);
        yield* posts.delete(id);
        yield* posts.restore({ id, patch: {} });
      });
      expect(checks).toEqual(["body:paragraph"]);
    }),
  );

  it.effect("checks a restore that sets a document", () =>
    Effect.gen(function* () {
      const { store, posts } = fixture();
      const reason = yield* Effect.gen(function* () {
        const good = yield* store.put({ type: "paragraph" });
        const bad = yield* store.put({ type: "script" });
        const { id } = yield* posts.create({
          id: Option.none(),
          state: { body: good.hash, visibility: "public" },
        });
        yield* posts.delete(id);
        return yield* reasonOf(posts.restore({ id, patch: { body: bad.hash } }));
      });
      expect(reason).toBe(`${DOCUMENT_VIOLATION} body: script is not allowed`);
    }),
  );

  it.effect("composes with other before hooks, seeing the patch they return", () =>
    Effect.gen(function* () {
      const { bodies, posts, chain } = yield* Effect.sync(() => {
        const swap: BeforeWriteHook<never, never> = {
          name: "posts.swap",
          run: (event) => Effect.succeed({ ...event.patch, title: "Normalised" }),
          locales: (event) => Effect.succeed(event.locales ?? {}),
        };
        return fixture([swap]);
      });
      yield* Effect.gen(function* () {
        const good = yield* bodies.put({ type: "paragraph" });
        yield* posts.create({
          id: Option.none(),
          state: { body: good.hash, visibility: "public" },
        });
      });
      expect(chain.rows().map((row) => row.state["title"])).toEqual(["Normalised"]);
    }),
  );
  it.effect("checks every locale's patch, and passes the locale patch through", () =>
    Effect.gen(function* () {
      const store = makeInMemoryDocumentStore<Doc>();
      const hook = documentCheckHook({ type: "posts", fields: ["body"], documents: store, check });
      const locales =
        hook.locales ?? (() => Effect.die("documentCheckHook declares no locale pass"));
      const outcome = yield* Effect.gen(function* () {
        const good = yield* store.put({ type: "paragraph" });
        const bad = yield* store.put({ type: "script" });
        const passed = yield* locales(
          beforeWriteEvent("update", { en: { body: good.hash }, fr: null }),
        );
        const refused = yield* reasonOf(
          locales(beforeWriteEvent("update", { de: { body: bad.hash } })),
        );
        const exempt = yield* locales(
          beforeWriteEvent("restoreVersion", { de: { body: bad.hash } }),
        );
        const { locales: _omitted, ...withoutLocales } = beforeWriteEvent("update", {});
        const none = yield* locales(withoutLocales);
        return { passed, refused, exempt, none, good: good.hash, bad: bad.hash };
      });
      expect(outcome).toEqual({
        passed: { en: { body: outcome.good }, fr: null },
        refused: `${DOCUMENT_VIOLATION} body: script is not allowed`,
        exempt: { de: { body: outcome.bad } },
        none: {},
        good: outcome.good,
        bad: outcome.bad,
      });
    }),
  );
});
