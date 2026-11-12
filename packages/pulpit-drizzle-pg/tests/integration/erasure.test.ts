/**
 * The erasure stores against PostgreSQL (pulpit#361), checked against the
 * kernel's `makeInMemoryPurgeStore` and `makeInMemoryAccountErasureStore`
 * over the same chains:
 *
 * - `eraseNode` reads the hashes the node's version rows carry and deletes
 *   its dependent rows; the leaf's `VersionChain.purge` then deletes the
 *   whole chain. A document or blob is unreferenced only once no remaining
 *   row carries it. Beyond the fake: the purge is the whole chain or
 *   nothing, a failure after it rolling every delete back.
 * - `ownedNodes`, `setOwner`, and `unredactedNodes` with the redaction
 *   marker (pulpit#284): a node stops needing redaction once a later
 *   version has actor `redactedAs` and no `proposedBy`, and a tombstoned
 *   head never needs it.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { DocumentHash } from "@thomasfosterau/pulpit/documents";
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
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeDocumentStore } from "../../src/documents.ts";
import { makeAccountErasureStore, makePurgeStore } from "../../src/erasure.ts";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
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
  runtime.runPromise(transact(effect));

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
  references: [
    { table: notesVersion, id: notesVersion.id, documents: [notesVersion.body] },
    { table: linksVersion, id: linksVersion.id, blobs: [linksVersion.href] },
  ],
  documents: [documents],
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

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(
          `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.${getTableName(documents)} CASCADE`,
        ),
      );
    }),
  );
  [d1, d2] = await run(
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
  ).then(([a, b]) => [a ?? d1, b ?? d2]);
  await run(
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
});

/** Purge `id` from its chain in both worlds, as `definePurge` does: erase, purge, then the documents and blobs. */
const purgeBoth = async (
  id: string,
  chain: (typeof chains)["notes"],
  memoryChain: typeof memoryNotes,
) => {
  const fromSql = await run(
    Effect.gen(function* () {
      const erased = yield* purgeStore.eraseNode(id);
      yield* chain.purge(id);
      const documentsDeleted = yield* purgeStore.deleteUnreferencedDocuments(erased.documents);
      const blobsUnreferenced = yield* purgeStore.unreferencedBlobs(erased.blobs);
      return { erased, documentsDeleted, blobsUnreferenced };
    }),
  );
  const fromMemory = await Effect.runPromise(
    Effect.gen(function* () {
      const erased = yield* memoryPurge.eraseNode(id);
      yield* memoryChain.purge(id);
      const documentsDeleted = yield* memoryPurge.deleteUnreferencedDocuments(erased.documents);
      const blobsUnreferenced = yield* memoryPurge.unreferencedBlobs(erased.blobs);
      return { erased, documentsDeleted, blobsUnreferenced };
    }),
  );
  expect(fromSql).toEqual(fromMemory);
  return fromSql;
};

describe("PurgeStore over PostgreSQL agrees with the in-memory store", () => {
  it("a document is deleted once no remaining version row references it", async () => {
    const third = await purgeBoth(node(3), chains.notes, memoryNotes);
    expect(third).toEqual({
      erased: { documents: [d2], blobs: [] },
      documentsDeleted: [d2],
      blobsUnreferenced: [],
    });
    const first = await purgeBoth(node(1), chains.notes, memoryNotes);
    expect(first.documentsDeleted).toEqual([]);
    expect(await storedDocuments()).toEqual([d1]);
    expect(await versionsOf(node(1))).toBe(0);
  });

  it("a blob is unreferenced once no remaining version row carries it", async () => {
    const thirteen = await purgeBoth(node(13), chains.links, memoryLinks);
    expect(thirteen.blobsUnreferenced).toEqual([blob("b")]);
    const eleven = await purgeBoth(node(11), chains.links, memoryLinks);
    expect(eleven.blobsUnreferenced).toEqual([]);
    expect(
      await run(purgeStore.unreferencedBlobs([blob("a"), blob("b"), blob("c"), "nope"])),
    ).toEqual([blob("b"), blob("c")]);
  });

  it("an unknown or malformed id erases nothing", async () => {
    expect(await run(purgeStore.eraseNode(node(99)))).toEqual({ documents: [], blobs: [] });
    expect(await run(purgeStore.eraseNode("nope"))).toEqual({ documents: [], blobs: [] });
    expect(await run(purgeStore.deleteUnreferencedDocuments(["nope"]))).toEqual([]);
  });
});

describe("the purge is the whole chain or nothing (beyond the fake)", () => {
  it("a failure after the purge rolls back every delete: owner row, versions and documents", async () => {
    const before = await versionsOf(node(2));
    expect(before).toBeGreaterThan(0);
    const exit = await runtime.runPromiseExit(
      transact(
        Effect.gen(function* () {
          const erased = yield* purgeStore.eraseNode(node(2));
          yield* chains.notes.purge(node(2));
          yield* purgeStore.deleteUnreferencedDocuments(erased.documents);
          return yield* Effect.fail("the blob store is down" as const);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await versionsOf(node(2))).toBe(before);
    expect(await storedDocuments()).toEqual([d1]);
    expect(Option.isSome(await run(stores.notes.ownerOf(node(2))))).toBe(true);
  });
});

describe("AccountErasureStore over PostgreSQL agrees with the in-memory store", () => {
  beforeAll(async () => {
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
    await run(
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
    await run(
      Effect.andThen(chains.posts.delete(node(24), none), memoryPosts.delete(node(24), none)),
    );
  });

  const both = async <A, E>(
    fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
    fromMemory: Effect.Effect<A>,
  ) => {
    const answer = { sql: await run(fromSql), memory: await Effect.runPromise(fromMemory) };
    expect(answer.sql).toEqual(answer.memory);
    return answer.sql;
  };

  it("ownedNodes is the account's owned nodes of the leaf, by id, at most limit", async () => {
    const query = { accountId: "acct", type: "posts", limit: 10 };
    expect(await both(erasure.ownedNodes(query), memoryErasure.ownedNodes(query))).toEqual([
      node(21),
      node(22),
      node(24),
    ]);
    const one = { ...query, limit: 1 };
    await both(erasure.ownedNodes(one), memoryErasure.ownedNodes(one));
    const other = { ...query, type: "notes" };
    expect(await run(erasure.ownedNodes(other))).toEqual([]);
  });

  it("setOwner reassigns or retracts the owner record", async () => {
    const reassign = { type: "posts", id: node(21), ownerId: Option.some("tombstone") };
    const retract = { type: "posts", id: node(22), ownerId: none };
    await both(erasure.setOwner(reassign), memoryErasure.setOwner(reassign));
    await both(erasure.setOwner(retract), memoryErasure.setOwner(retract));
    const query = { accountId: "acct", type: "posts", limit: 10 };
    expect(await both(erasure.ownedNodes(query), memoryErasure.ownedNodes(query))).toEqual([
      node(24),
    ]);
  });

  it("unredactedNodes: a redacting version (actor redactedAs, no proposedBy) clears a node", async () => {
    const query = {
      accountId: "acct",
      type: "posts",
      redactedAs: Option.some("redacted"),
      limit: 10,
    };
    expect(
      await both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
    ).toEqual([node(21), node(22), node(23)]);
    const redact = {
      id: node(22),
      patch: { title: "[redacted]" },
      actorId: Option.some("redacted"),
    };
    await run(Effect.andThen(chains.posts.update(redact), memoryPosts.update(redact)));
    // A version by the marker that carries a proposedBy is no redaction.
    const notYet = {
      id: node(23),
      patch: { title: "[redacted]" },
      actorId: Option.some("redacted"),
      proposedBy: Option.some("acct"),
    };
    await run(Effect.andThen(chains.posts.update(notYet), memoryPosts.update(notYet)));
    expect(
      await both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
    ).toEqual([node(21), node(23)]);
    const limited = { ...query, limit: 1 };
    expect(
      await both(erasure.unredactedNodes(limited), memoryErasure.unredactedNodes(limited)),
    ).toEqual([node(21)]);
  });

  it("with no redactedAs, the marker is a version with no actor and no proposedBy", async () => {
    const query = { accountId: "acct", type: "posts", redactedAs: none, limit: 10 };
    const before = await both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query));
    expect(before).toContain(node(21));
    const redact = { id: node(21), patch: { title: "[redacted]" }, actorId: none };
    await run(Effect.andThen(chains.posts.update(redact), memoryPosts.update(redact)));
    expect(
      await both(erasure.unredactedNodes(query), memoryErasure.unredactedNodes(query)),
    ).not.toContain(node(21));
    expect(await run(erasure.unredactedNodes({ ...query, limit: 0 }))).toEqual([]);
  });
});
