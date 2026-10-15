/**
 * The content-addressed document store: the hash contract (pinned to vectors
 * taken from Postgres), the never-rewritten invariant (`DOC-001`), the field
 * spread's projections, and a version chain whose rows carry document hashes.
 * The spec is gardeneria's `packages/database/src/documents.ts` and its
 * `inline_documents` / `block_documents` tables.
 *
 * @module tests/documents
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { DocumentHash, documentRef } from "../src/documents.ts";
import { defineVersionChain } from "../src/version-chain.ts";
import { decodes } from "./fixtures.ts";
import {
  canonicalText,
  makeInMemoryChainStore,
  makeInMemoryDocumentStore,
} from "../src/testing.ts";

// oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

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
  it.each(VECTORS)("$name", async ({ document, text, hash }) => {
    expect(canonicalText(document)).toBe(text);
    expect(await run(makeInMemoryDocumentStore().put(document))).toBe(hash);
    expect(decodes(DocumentHash, hash)).toBe(true);
  });

  it("hashes the structure, not the spelling: member order is irrelevant", async () => {
    const store = makeInMemoryDocumentStore();
    const reordered = {
      content: [{ content: [{ text: "Hello", type: "text" }], type: "paragraph" }],
      type: "doc",
    };
    expect(await run(store.put(reordered))).toBe(HELLO);
  });

  it("DocumentHash is exactly 64 lowercase hex characters", () => {
    expect(decodes(DocumentHash, HELLO.toUpperCase())).toBe(false);
    expect(decodes(DocumentHash, HELLO.slice(1))).toBe(false);
    expect(decodes(DocumentHash, `${HELLO}0`)).toBe(false);
  });
});

describe("put — idempotent, never rewritten (DOC-001)", () => {
  it("a second put of the same document returns the same hash and writes nothing", async () => {
    const store = makeInMemoryDocumentStore();
    const document = paragraph("Hello");
    const first = await run(store.put(document));
    const second = await run(store.put(document));
    expect(second).toBe(first);
    expect(HashMap.size(store.stored())).toBe(1);
    expect(store.writes()).toBe(1);
  });

  it("an equal document never replaces the stored one; a different one is a new write", async () => {
    const store = makeInMemoryDocumentStore();
    const original = paragraph("Hello");
    const hash = await run(store.put(original));
    expect(store.writes()).toBe(1);
    // A structurally equal copy reaches the same hash and writes nothing.
    // `stored()` alone can't show that: `HashMap.set` keeps the existing value
    // when the new one is `Equal`, so only the write count tells them apart.
    expect(await run(store.put(paragraph("Hello")))).toBe(hash);
    expect(store.writes()).toBe(1);
    expect(Option.exists(HashMap.get(store.stored(), hash), (stored) => stored === original)).toBe(
      true,
    );
    await run(store.put(paragraph("Hello, world")));
    expect(store.writes()).toBe(2);
  });

  it("a changed document is a new hash, and the old one is untouched", async () => {
    const store = makeInMemoryDocumentStore();
    const original = paragraph("Hello");
    const before = await run(store.put(original));
    const after = await run(store.put(paragraph("Hello, world")));
    expect(after).not.toBe(before);
    expect(HashMap.size(store.stored())).toBe(2);
    expect(await run(store.get(before))).toEqual(Option.some(original));
  });
});

describe("get / getMany", () => {
  it("get returns the stored document, or none for an unseen hash", async () => {
    const store = makeInMemoryDocumentStore();
    const hash = await run(store.put(paragraph("Hello")));
    expect(await run(store.get(hash))).toEqual(Option.some(paragraph("Hello")));
    expect(await run(store.get(UNSEEN))).toEqual(Option.none());
  });

  it("getMany returns the found documents keyed by hash, omitting an unseen one", async () => {
    const store = makeInMemoryDocumentStore();
    const hello = await run(store.put(paragraph("Hello")));
    const world = await run(store.put(paragraph("World")));
    const found = await run(store.getMany([hello, UNSEEN, world, hello]));
    expect(HashMap.size(found)).toBe(2);
    expect(HashMap.get(found, hello)).toEqual(Option.some(paragraph("Hello")));
    expect(HashMap.get(found, world)).toEqual(Option.some(paragraph("World")));
  });
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
    expect(Record.keys(NoteResource.updateInput.fields).toSorted()).toEqual([
      "body",
      "id",
      "title",
    ]);
    expect(decodes(NoteResource.updateInput, { id: UUID })).toBe(true);
    expect(decodes(NoteResource.updateInput, { id: UUID, body: HELLO })).toBe(true);
    expect(decodes(NoteResource.updateInput, { id: UUID, body: null })).toBe(false);
  });
});

describe("version rows that reference documents", () => {
  const setup = () => {
    const documents = makeInMemoryDocumentStore();
    const chainStore = makeInMemoryChainStore();
    const chain = defineVersionChain("notes", chainStore);
    return { documents, chainStore, chain };
  };

  it("two nodes share one stored document", async () => {
    const { documents, chainStore, chain } = setup();
    const body = paragraph("Shared");
    const createWith = (document: Schema.Json) =>
      Effect.gen(function* () {
        const hash = yield* documents.put(document);
        const write = yield* chain.create({
          id: Option.none(),
          state: { body: hash },
          actorId: ACTOR,
        });
        return { hash, id: write.id };
      });
    const first = await run(createWith(body));
    const second = await run(createWith(paragraph("Shared")));
    expect(second.id).not.toBe(first.id);
    expect(second.hash).toBe(first.hash);
    expect(HashMap.size(documents.stored())).toBe(1);
    expect(chainStore.rows().map((row) => row.state["body"])).toEqual([first.hash, first.hash]);
    expect(await run(documents.get(first.hash))).toEqual(Option.some(body));
  });

  it("restoreVersion restores the old hash, which still reads back the old document", async () => {
    const { documents, chainStore, chain } = setup();
    const original = paragraph("First draft");
    const restored = await run(
      Effect.gen(function* () {
        const before = yield* documents.put(original);
        const { id } = yield* chain.create({
          id: Option.none(),
          state: { body: before },
          actorId: ACTOR,
        });
        const after = yield* documents.put(paragraph("Second draft"));
        yield* chain.update({ id, patch: { body: after }, actorId: ACTOR });
        const write = yield* chain.restoreVersion(id, 0n, ACTOR);
        return { before, after, write };
      }),
    );
    expect(restored.write.version).toBe(2n);
    expect(chainStore.rows().map((row) => row.state["body"])).toEqual([
      restored.before,
      restored.after,
      restored.before,
    ]);
    // Nothing was re-stored or rewritten: both drafts, each at its own hash.
    expect(HashMap.size(documents.stored())).toBe(2);
    expect(await run(documents.get(restored.before))).toEqual(Option.some(original));
  });
});
