/**
 * The erasure stores against PostgreSQL, checked against the
 * kernel's `makeInMemoryPurgeStore` and `makeInMemoryAccountErasureStore`
 * over the same chains:
 *
 * - `eraseNode` reads the hashes the node's version rows carry and deletes
 *   its dependent rows; the leaf's `VersionChain.purge` then deletes the
 *   whole chain. A document or blob is unreferenced only once no remaining
 *   row carries it. Beyond the fake: the purge is the whole chain or
 *   nothing, a failure after it rolling every delete back.
 * - `ownedNodes`, `setOwner`, and `unredactedNodes` with the redaction
 *   marker: a node stops needing redaction once a later
 *   version has actor `redactedAs` and no `proposedBy`, and a tombstoned
 *   head never needs it.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
import type { DocumentHash } from "@thomasfosterau/pulpit/Documents";
import {
  makeInMemoryAccountErasureStore,
  makeInMemoryDocumentStore,
  makeInMemoryLeafStore,
  makeInMemoryPurgeStore,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import { eq, getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeDocumentStore } from "../../src/Documents.ts";
import { makeAccountErasureStore, makePurgeStore } from "../../src/Erasure.ts";
import { makeLeafStores } from "../../src/LeafStore.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { documents, owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitErasureDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 2 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const stores = makeLeafStores({ tree, tables, views, owners, CurrentTransaction });
const docs = makeDocumentStore({
  table: documents,
  document: Schema.Struct({ text: Schema.String }),
  CurrentTransaction,
});
const notesVersion = tables.levels.notes.version;
const linksVersion = tables.levels.links.version;
const purgeStore = makePurgeStore({
  documents: {
    tables: [documents],
    references: [{ table: notesVersion, id: notesVersion.id, column: notesVersion.body }],
  },
  blobs: [{ table: linksVersion, id: linksVersion.id, column: linksVersion.href }],
  dependents: [{ table: owners, id: owners.nodeId }],
  CurrentTransaction,
});
const erasure = makeAccountErasureStore({ root: tables.root, owners, CurrentTransaction });

const memoryNotes = makeInMemoryVersionChain("notes");
const memoryLinks = makeInMemoryVersionChain("links");
const memoryPosts = makeInMemoryVersionChain("posts");
const memoryDocuments = makeInMemoryDocumentStore<{ readonly text: string }>();
const memoryPurge = makeInMemoryPurgeStore({
  chains: [memoryNotes, memoryLinks],
  documents: memoryDocuments,
  documentColumns: ["body"],
  blobColumns: ["href"],
});
const memoryPostLeaves = makeInMemoryLeafStore(memoryPosts, {
  columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
});
const memoryErasure = makeInMemoryAccountErasureStore([
  { type: "posts", chain: memoryPosts, leaves: memoryPostLeaves },
]);

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const blob = (c: string) => c.repeat(64);
const none = Option.none<string>();
const postState = {
  title: "post",
  visibility: "public",
  draft: false,
  groupId: null,
  rank: null,
  score: null,
  publishedAt: null,
};

let d1: DocumentHash = "";
let d2: DocumentHash = "";

/** A version count of one node, across its root chain. */
const versionsOf = (id: string) =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return (yield* tx.select().from(tables.root.version).where(eq(tables.root.version.id, id)))
        .length;
    }),
  );
const storedDocuments = () =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ hash: sql<string>`encode(${documents.hashId}, 'hex')` })
        .from(documents);
      return Arr.sort(
        Arr.map(rows, (row) => row.hash),
        (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
      );
    }),
  );

beforeAll(() =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql.raw(
            `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.${getTableName(documents)} CASCADE`,
          ),
        );
      }),
    );
    [d1, d2] = yield* Effect.map(
      run(
        Effect.forEach(
          ["one", "two"],
          (text) =>
            Effect.gen(function* () {
              const { hash } = yield* docs.put({ text });
              yield* memoryDocuments.put({ text });
              return hash;
            }),
          { concurrency: 1 },
        ),
      ),
      ([a, b]) => [a ?? d1, b ?? d2],
    );
    yield* run(
      Effect.gen(function* () {
        const notes: ReadonlyArray<readonly [number, string]> = [
          [1, d1],
          [2, d1],
          [3, d2],
        ];
        yield* Effect.forEach(
          notes,
          ([n, body]) => {
            const create = {
              id: Option.some(node(n)),
              state: { title: `note ${String(n)}`, body, summary: null },
              actorId: none,
            };
            return Effect.andThen(
              Effect.andThen(chains.notes.create(create), memoryNotes.create(create)),
              stores.notes.stampOwner(node(n), "owner"),
            );
          },
          { concurrency: 1 },
        );
        const links: ReadonlyArray<readonly [number, string]> = [
          [11, blob("a")],
          [12, blob("a")],
          [13, blob("b")],
        ];
        yield* Effect.forEach(
          links,
          ([n, href]) => {
            const create = {
              id: Option.some(node(n)),
              state: { title: `link ${String(n)}`, href },
              actorId: none,
            };
            return Effect.andThen(chains.links.create(create), memoryLinks.create(create));
          },
          { concurrency: 1 },
        );
      }),
    );
  }),
);

/** Purge `id` from its chain in both worlds, as `definePurge` does: erase, purge, then the documents and blobs. */
const purgeBoth = (id: string, chain: (typeof chains)["notes"], memoryChain: typeof memoryNotes) =>
  Effect.gen(function* () {
    const fromSql = yield* run(
      Effect.gen(function* () {
        const erased = yield* purgeStore.eraseNode(id);
        yield* chain.purge(id);
        const documentsDeleted = yield* purgeStore.deleteUnreferencedDocuments(erased.documents);
        const blobsUnreferenced = yield* purgeStore.unreferencedBlobs(erased.blobs);
        return { erased, documentsDeleted, blobsUnreferenced };
      }),
    );
    const fromMemory = yield* Effect.gen(function* () {
      const erased = yield* memoryPurge.eraseNode(id);
      yield* memoryChain.purge(id);
      const documentsDeleted = yield* memoryPurge.deleteUnreferencedDocuments(erased.documents);
      const blobsUnreferenced = yield* memoryPurge.unreferencedBlobs(erased.blobs);
      return { erased, documentsDeleted, blobsUnreferenced };
    });
    expect(fromSql).toEqual(fromMemory);
    return fromSql;
  });

describe("PurgeStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("a document is deleted once no remaining version row references it", () =>
    Effect.gen(function* () {
      const third = yield* purgeBoth(node(3), chains.notes, memoryNotes);
      expect(third).toEqual({
        erased: { documents: [d2], blobs: [] },
        documentsDeleted: [d2],
        blobsUnreferenced: [],
      });
      const first = yield* purgeBoth(node(1), chains.notes, memoryNotes);
      expect(first.documentsDeleted).toEqual([]);
      expect(yield* storedDocuments()).toEqual([d1]);
      expect(yield* versionsOf(node(1))).toBe(0);
    }),
  );

  it.live("a blob is unreferenced once no remaining version row carries it", () =>
    Effect.gen(function* () {
      const thirteen = yield* purgeBoth(node(13), chains.links, memoryLinks);
      expect(thirteen.blobsUnreferenced).toEqual([blob("b")]);
      const eleven = yield* purgeBoth(node(11), chains.links, memoryLinks);
      expect(eleven.blobsUnreferenced).toEqual([]);
      expect(
        yield* run(purgeStore.unreferencedBlobs([blob("a"), blob("b"), blob("c"), "nope"])),
      ).toEqual([blob("b"), blob("c")]);
    }),
  );

  it.live("a document still referenced survives a direct delete (the guard fails closed)", () =>
    Effect.gen(function* () {
      // node 2 still carries d1: asked outright, the store keeps it.
      expect(yield* run(purgeStore.deleteUnreferencedDocuments([d1]))).toEqual([]);
      expect(yield* storedDocuments()).toEqual([d1]);
      // A store with no `documents` deletes nothing at all.
      const blind = makePurgeStore({ CurrentTransaction });
      expect(yield* run(blind.deleteUnreferencedDocuments([d1]))).toEqual([]);
      expect(yield* run(blind.unreferencedBlobs([blob("z")]))).toEqual([]);
      expect(yield* storedDocuments()).toEqual([d1]);
    }),
  );

  it.live("an unknown or malformed id erases nothing", () =>
    Effect.gen(function* () {
      expect(yield* run(purgeStore.eraseNode(node(99)))).toEqual({ documents: [], blobs: [] });
      expect(yield* run(purgeStore.eraseNode("nope"))).toEqual({ documents: [], blobs: [] });
      expect(yield* run(purgeStore.deleteUnreferencedDocuments(["nope"]))).toEqual([]);
    }),
  );
});

describe("the purge is the whole chain or nothing (beyond the fake)", () => {
  it.live(
    "a failure after the purge rolls back every delete: owner row, versions and documents",
    () =>
      Effect.gen(function* () {
        const before = yield* versionsOf(node(2));
        expect(before).toBeGreaterThan(0);
        const exit = yield* Effect.exit(
          Effect.provide(
            transact(
              Effect.gen(function* () {
                const erased = yield* purgeStore.eraseNode(node(2));
                yield* chains.notes.purge(node(2));
                yield* purgeStore.deleteUnreferencedDocuments(erased.documents);
                return yield* Effect.fail("the blob store is down" as const);
              }),
            ),
            yield* runtime.contextEffect,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* versionsOf(node(2))).toBe(before);
        expect(yield* storedDocuments()).toEqual([d1]);
        expect(Option.isSome(yield* run(stores.notes.ownerOf(node(2))))).toBe(true);
      }),
  );
});
const both = <A, E>(
  fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
  fromMemory: Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const answer = { sql: yield* run(fromSql), memory: yield* fromMemory };
    expect(answer.sql).toEqual(answer.memory);
    return answer.sql;
  });

describe("AccountErasureStore over PostgreSQL agrees with the in-memory store", () => {
  beforeAll(() =>
    Effect.gen(function* () {
      const posts: ReadonlyArray<
        readonly [
          number,
          Option.Option<string>,
          ReadonlyArray<readonly [Option.Option<string>, Option.Option<string>]>,
        ]
      > = [
        // [node, owner, updates as (actor, proposedBy)]
        [21, Option.some("acct"), []],
        [22, Option.some("acct"), [[Option.some("other"), Option.some("acct")]]],
        [23, Option.some("other"), [[Option.some("acct"), none]]],
        [24, Option.some("acct"), [[Option.some("acct"), none]]],
        [25, Option.some("other"), []],
      ];
      yield* run(
        Effect.forEach(
          posts,
          ([n, owner, updates]) =>
            Effect.gen(function* () {
              const create = {
                id: Option.some(node(n)),
                state: postState,
                actorId: n === 25 ? none : Option.some("acct"),
              };
              yield* chains.posts.create(create);
              yield* memoryPosts.create(create);
              yield* Effect.forEach(
                updates,
                ([actorId, proposedBy]) => {
                  const update = { id: node(n), patch: { title: "edited" }, actorId, proposedBy };
                  return Effect.andThen(chains.posts.update(update), memoryPosts.update(update));
                },
                { concurrency: 1 },
              );
              yield* Effect.forEach(
                Option.toArray(owner),
                (ownerId) =>
                  Effect.andThen(
                    stores.posts.stampOwner(node(n), ownerId),
                    memoryPostLeaves.stampOwner(node(n), ownerId),
                  ),
                { concurrency: 1 },
              );
            }),
          { concurrency: 1 },
        ),
      );
      // A tombstoned head never needs redacting.
      yield* run(
        Effect.andThen(chains.posts.delete(node(24), none), memoryPosts.delete(node(24), none)),
      );
    }),
  );
  it.live("ownedNodes is the account's owned nodes of the leaf, by id, at most limit", () =>
    Effect.gen(function* () {
      const query = { accountId: "acct", type: "posts", limit: 10 };
      expect(yield* both(erasure.ownedNodes(query), memoryErasure.ownedNodes(query))).toEqual([
        node(21),
        node(22),
        node(24),
      ]);
      const one = { ...query, limit: 1 };
      yield* both(erasure.ownedNodes(one), memoryErasure.ownedNodes(one));
      const other = { ...query, type: "notes" };
      expect(yield* run(erasure.ownedNodes(other))).toEqual([]);
    }),
  );

  it.live("setOwner reassigns or retracts the owner record", () =>
    Effect.gen(function* () {
      const reassign = { type: "posts", id: node(21), ownerId: Option.some("tombstone") };
      const retract = { type: "posts", id: node(22), ownerId: none };
      yield* both(erasure.setOwner(reassign), memoryErasure.setOwner(reassign));
      yield* both(erasure.setOwner(retract), memoryErasure.setOwner(retract));
      const query = { accountId: "acct", type: "posts", limit: 10 };
      expect(yield* both(erasure.ownedNodes(query), memoryErasure.ownedNodes(query))).toEqual([
        node(24),
      ]);
    }),
  );

  it.live(
    "unredactedNodes: a redacting version (actor redactedAs, no proposedBy) clears a node",
    () =>
      Effect.gen(function* () {
        const query = {
          accountId: "acct",
          type: "posts",
          redactedAs: Option.some("redacted"),
          limit: 10,
        };
        expect(
          yield* both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
        ).toEqual([node(21), node(22), node(23)]);
        const redact = {
          id: node(22),
          patch: { title: "[redacted]" },
          actorId: Option.some("redacted"),
        };
        yield* run(Effect.andThen(chains.posts.update(redact), memoryPosts.update(redact)));
        // A version by the marker that carries a proposedBy is no redaction.
        const notYet = {
          id: node(23),
          patch: { title: "[redacted]" },
          actorId: Option.some("redacted"),
          proposedBy: Option.some("acct"),
        };
        yield* run(Effect.andThen(chains.posts.update(notYet), memoryPosts.update(notYet)));
        expect(
          yield* both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
        ).toEqual([node(21), node(23)]);
        const limited = { ...query, limit: 1 };
        expect(
          yield* both(erasure.unredactedNodes(limited), memoryErasure.unredactedNodes(limited)),
        ).toEqual([node(21)]);
      }),
  );

  it.live("with no redactedAs, the marker is a version with no actor and no proposedBy", () =>
    Effect.gen(function* () {
      const query = { accountId: "acct", type: "posts", redactedAs: none, limit: 10 };
      const before = yield* both(
        erasure.unredactedNodes(query),
        memoryErasure.unredactedNodes(query),
      );
      expect(before).toContain(node(21));
      const redact = { id: node(21), patch: { title: "[redacted]" }, actorId: none };
      yield* run(Effect.andThen(chains.posts.update(redact), memoryPosts.update(redact)));
      expect(
        yield* both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
      ).not.toContain(node(21));
      expect(yield* run(erasure.unredactedNodes({ ...query, limit: 0 }))).toEqual([]);
    }),
  );
});
