/**
 * Purge (pulpit#58): erasure as a hard delete.
 *
 * - The purge rung is checked before anything is read: anonymous is
 *   `Unauthorized`, below the rung `Forbidden`, for every id alike.
 * - The node's whole chain goes (a live node's and a tombstone's alike),
 *   with every row the other seams keep for it; a purged id is `NodeNotFound`.
 * - A document or bytes go only when no other version references the hash.
 * - Bytes are deleted after `transact` has returned; a failed delete is
 *   reported, never a failure.
 * - The resource cache is evicted past the purged head.
 *
 * @module tests/purge
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { blobKey, type BlobStore } from "../src/blobs.ts";
import { definePurge, type PurgeDefinition } from "../src/purge.ts";
import type { Viewer } from "../src/subtype.ts";
import { defineVersionChain, type ChainState } from "../src/version-chain.ts";
import {
  type InMemoryBlobFailure,
  makeInMemoryBlobStore,
  makeInMemoryChainStore,
  makeInMemoryDocumentStore,
  makeInMemoryLeafStore,
  makeInMemoryPurgeStore,
  makeInMemoryResourceCache,
  makeInMemoryWorkingCopyStore,
} from "../src/testing.ts";
import { admin, member, moderator, NOW } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const setup = async (
  options: Partial<Pick<PurgeDefinition<never, unknown, never>, "blobs">> & {
    readonly withoutBlobs?: boolean;
  } = {},
) => {
  const chain = makeInMemoryChainStore();
  const other = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, { columns: ["body", "contentHash"], now: NOW });
  const documents = makeInMemoryDocumentStore();
  const blobs = makeInMemoryBlobStore();
  const copies = makeInMemoryWorkingCopyStore();
  const cache = makeInMemoryResourceCache<unknown>(() => true);
  const events: Array<string> = [];
  const recording: BlobStore<InMemoryBlobFailure, never> = {
    ...blobs,
    delete: (key) =>
      Effect.andThen(
        Effect.sync(() => events.push(`delete ${key}`)),
        blobs.delete(key),
      ),
  };
  let viewer: Viewer = Option.some(admin);
  const notes = defineVersionChain("notes", chain);
  const others = defineVersionChain("others", other);
  const purge = definePurge({
    type: "notes",
    chain,
    store: makeInMemoryPurgeStore({
      chains: [chain, other],
      documents,
      documentColumns: ["body"],
      blobColumns: ["contentHash"],
      dependents: [
        leaves.dropOwner,
        (id) => Effect.runSync(copies.discard({ id, userId: member.id })),
      ],
    }),
    viewer: Effect.sync(() => viewer),
    canPurge: (account) => account.role === "admin",
    transact: (effect) =>
      Effect.sync(() => events.push("begin")).pipe(
        Effect.andThen(effect),
        Effect.tap(() => Effect.sync(() => events.push("commit"))),
      ),
    blobs: options.withoutBlobs === true ? undefined : (options.blobs ?? recording),
    cache,
  });
  const put = (body: string) => Effect.map(documents.put({ body }), (stored) => stored.hash);
  const create = (state: ChainState) =>
    Effect.map(notes.create({ id: Option.none(), state, actorId: Option.none() }), (w) => w.id);
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const putBytes = (hash: string) =>
    blobs.put(blobKey(hash), new Uint8Array([1]), { byteSize: 1, mediaType: "image/png" });
  return {
    chain,
    other,
    others,
    leaves,
    documents,
    blobs,
    copies,
    cache,
    events,
    notes,
    purge,
    put,
    create,
    actAs,
    putBytes,
  };
};

describe("definePurge — the rung", () => {
  it("is checked before anything is read: Unauthorized / Forbidden for every id alike", async () => {
    const { create, purge, actAs, chain } = await setup();
    const id = await run(create({ body: null }));
    const refusal = (who: Viewer, target: string) =>
      Effect.map(Effect.flip(actAs(who, purge.purge(target))), (error) => error._tag);
    const answers = await run(
      Effect.forEach(
        [id, "no-such-node"],
        (target) =>
          Effect.all([refusal(Option.none(), target), refusal(Option.some(moderator), target)], {
            concurrency: 1,
          }),
        { concurrency: 1 },
      ),
    );
    expect(answers).toEqual([
      ["Unauthorized", "Forbidden"],
      ["Unauthorized", "Forbidden"],
    ]);
    expect(chain.rows()).toHaveLength(1);
  });

  it("at the rung, an unknown or already purged id is NodeNotFound", async () => {
    const { create, purge } = await setup();
    expect(await tagOf(purge.purge("no-such-node"))).toEqual(Option.some("NodeNotFound"));
    const id = await run(create({ body: null }));
    await run(purge.purge(id));
    expect(await tagOf(purge.purge(id))).toEqual(Option.some("NodeNotFound"));
  });
});

describe("definePurge — the chain and the rows kept for the node", () => {
  it("hard-deletes every version, the tombstone included, and leaves other nodes alone", async () => {
    const { chain, notes, create, purge } = await setup();
    const id = await run(create({ body: null }));
    const kept = await run(create({ body: null }));
    await run(notes.update({ id, patch: { body: null }, actorId: Option.none() }));
    await run(notes.delete(id, Option.none()));
    const report = await run(purge.purge(id));
    expect(report).toEqual({ id, documents: [], blobs: [], bytesLeft: [] });
    expect(chain.rows().map((row) => row.id)).toEqual([kept]);
    expect(await tagOf(notes.getVersion(id, 0n))).toEqual(Option.some("VersionNotFound"));
  });

  it("purges a live node in one step, with the rows the other seams keep for it", async () => {
    const { leaves, copies, create, purge } = await setup();
    const id = await run(create({ body: null }));
    await run(leaves.stampOwner(id, member.id));
    await run(copies.put({ id, userId: member.id }, { patch: {}, baseVersion: 0n, savedAt: NOW }));
    await run(purge.purge(id));
    expect(HashMap.has(leaves.owners(), id)).toBe(false);
    expect(HashMap.size(copies.copies())).toBe(0);
    expect(Option.isNone(await run(leaves.get(id)))).toBe(true);
  });

  it("evicts the cache past the purged head", async () => {
    const { notes, cache, create, purge } = await setup();
    const id = await run(create({ body: null }));
    await run(notes.update({ id, patch: { body: null }, actorId: Option.none() }));
    await run(cache.set(id, "cached", 1n));
    await run(purge.purge(id));
    expect(cache.get(id)).toEqual(Option.none());
    expect(cache.versionOf(id)).toEqual(Option.some(2n));
  });
});

describe("definePurge — shared content", () => {
  it("deletes a document only when no other version references it", async () => {
    const { documents, others, put, create, notes, purge } = await setup();
    const own = await run(put("only mine"));
    const shared = await run(put("shared"));
    const id = await run(create({ body: own }));
    await run(notes.update({ id, patch: { body: shared }, actorId: Option.none() }));
    await run(
      others.create({
        id: Option.some("other-node"),
        state: { body: shared },
        actorId: Option.none(),
      }),
    );
    const report = await run(purge.purge(id));
    expect(report.documents).toEqual([own]);
    expect([...HashMap.keys(documents.stored())]).toEqual([shared]);
  });

  it("deletes unreferenced bytes after the commit, and keeps bytes another version references", async () => {
    const { blobs, others, events, create, purge, putBytes } = await setup();
    await run(putBytes(HASH_A));
    await run(putBytes(HASH_B));
    const id = await run(create({ contentHash: HASH_A }));
    await run(
      others.create({
        id: Option.some("other-node"),
        state: { contentHash: HASH_B },
        actorId: Option.none(),
      }),
    );
    const report = await run(purge.purge(id));
    expect(report).toEqual({ id, documents: [], blobs: [HASH_A], bytesLeft: [] });
    expect([...HashMap.keys(blobs.objects())]).toEqual([blobKey(HASH_B)]);
    expect(events).toEqual(["begin", "commit", `delete ${blobKey(HASH_A)}`]);
  });

  it("a failed byte delete is reported in bytesLeft, never a failure", async () => {
    const failing: BlobStore<InMemoryBlobFailure | string, never> = {
      ...makeInMemoryBlobStore(),
      delete: () => Effect.fail("outage"),
    };
    const { create, purge, chain } = await setup({ blobs: failing });
    const id = await run(create({ contentHash: HASH_A }));
    const report = await run(purge.purge(id));
    expect(report).toEqual({ id, documents: [], blobs: [], bytesLeft: [HASH_A] });
    expect(chain.rows()).toEqual([]);
  });

  it("without a blob store, every unreferenced content hash is left for the caller", async () => {
    const { create, purge } = await setup({ withoutBlobs: true });
    const id = await run(create({ contentHash: HASH_A }));
    expect((await run(purge.purge(id))).bytesLeft).toEqual([HASH_A]);
  });
});
