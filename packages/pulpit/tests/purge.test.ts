/**
 * Purge: erasure as a hard delete.
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

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { blobKey, type BlobStore } from "../src/Blobs.ts";
import { definePurge, type PurgeDefinition } from "../src/Purge.ts";
import type { Viewer } from "../src/Subtype.ts";
import { defineVersionChain, type ChainState } from "../src/VersionChain.ts";
import {
  type InMemoryBlobFailure,
  makeInMemoryBlobStore,
  makeInMemoryVersionChain,
  makeInMemoryDocumentStore,
  makeInMemoryLeafStore,
  makeInMemoryPurgeStore,
  makeInMemoryResourceCache,
  makeInMemoryWorkingCopyStore,
} from "../src/testing.ts";
import { admin, member, moderator, NOW } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const setup = (
  options: Partial<Pick<PurgeDefinition<never, unknown, never>, "blobs">> & {
    readonly withoutBlobs?: boolean;
  } = {},
) =>
  Effect.sync(() => {
    const chain = makeInMemoryVersionChain("notes");
    const other = makeInMemoryVersionChain("others");
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
    const base: PurgeDefinition<never, unknown, never> = {
      type: "notes",
      chain,
      store: makeInMemoryPurgeStore({
        chains: [chain, other],
        documents,
        documentColumns: ["body"],
        blobColumns: ["contentHash"],
        dependents: [
          (id) => Effect.sync(() => leaves.dropOwner(id)),
          (id) => Effect.asVoid(copies.discard({ id, userId: member.id })),
        ],
      }),
      viewer: Effect.sync(() => viewer),
      canPurge: (account) => account.role === "admin",
      transact: (effect) =>
        Effect.sync(() => events.push("begin")).pipe(
          Effect.andThen(effect),
          Effect.tap(() => Effect.sync(() => events.push("commit"))),
        ),
      cache,
    };
    const purge = definePurge(
      options.withoutBlobs === true ? base : { ...base, blobs: options.blobs ?? recording },
    );
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
  });

describe("definePurge — the rung", () => {
  it.effect("is checked before anything is read: Unauthorized / Forbidden for every id alike", () =>
    Effect.gen(function* () {
      const { create, purge, actAs, chain } = yield* setup();
      const id = yield* create({ body: null });
      const refusal = (who: Viewer, target: string) =>
        Effect.map(Effect.flip(actAs(who, purge.purge(target))), (error) => error._tag);
      const answers = yield* Effect.forEach(
        [id, "no-such-node"],
        (target) =>
          Effect.all([refusal(Option.none(), target), refusal(Option.some(moderator), target)], {
            concurrency: 1,
          }),
        { concurrency: 1 },
      );
      expect(answers).toEqual([
        ["Unauthorized", "Forbidden"],
        ["Unauthorized", "Forbidden"],
      ]);
      expect(chain.rows()).toHaveLength(1);
    }),
  );

  it.effect("at the rung, an unknown or already purged id is NodeNotFound", () =>
    Effect.gen(function* () {
      const { create, purge } = yield* setup();
      expect(yield* tagOf(purge.purge("no-such-node"))).toEqual(Option.some("NodeNotFound"));
      const id = yield* create({ body: null });
      yield* purge.purge(id);
      expect(yield* tagOf(purge.purge(id))).toEqual(Option.some("NodeNotFound"));
    }),
  );
});

describe("definePurge — the chain and the rows kept for the node", () => {
  it.effect(
    "hard-deletes every version, the tombstone included, and leaves other nodes alone",
    () =>
      Effect.gen(function* () {
        const { chain, notes, create, purge } = yield* setup();
        const id = yield* create({ body: null });
        const kept = yield* create({ body: null });
        yield* notes.update({ id, patch: { body: null }, actorId: Option.none() });
        yield* notes.delete(id, Option.none());
        const report = yield* purge.purge(id);
        expect(report).toEqual({ id, documents: [], blobs: [], bytesLeft: [] });
        expect(chain.rows().map((row) => row.id)).toEqual([kept]);
        expect(yield* tagOf(notes.getVersion(id, 0n))).toEqual(Option.some("VersionNotFound"));
      }),
  );

  it.effect("purges a live node in one step, with the rows the other seams keep for it", () =>
    Effect.gen(function* () {
      const { leaves, copies, create, purge } = yield* setup();
      const id = yield* create({ body: null });
      yield* leaves.stampOwner(id, member.id);
      yield* copies.put({ id, userId: member.id }, { patch: {}, baseVersion: 0n, savedAt: NOW });
      yield* purge.purge(id);
      expect(HashMap.has(leaves.owners(), id)).toBe(false);
      expect(HashMap.size(copies.copies())).toBe(0);
      expect(Option.isNone(yield* leaves.get(id))).toBe(true);
    }),
  );

  it.effect("evicts the cache past the purged head", () =>
    Effect.gen(function* () {
      const { notes, cache, create, purge } = yield* setup();
      const id = yield* create({ body: null });
      yield* notes.update({ id, patch: { body: null }, actorId: Option.none() });
      yield* cache.set(id, "cached", 1n);
      yield* purge.purge(id);
      expect(cache.get(id)).toEqual(Option.none());
      expect(cache.versionOf(id)).toEqual(Option.some(2n));
    }),
  );
});

describe("definePurge — shared content", () => {
  it.effect("deletes a document only when no other version references it", () =>
    Effect.gen(function* () {
      const { documents, others, put, create, notes, purge } = yield* setup();
      const own = yield* put("only mine");
      const shared = yield* put("shared");
      const id = yield* create({ body: own });
      yield* notes.update({ id, patch: { body: shared }, actorId: Option.none() });
      yield* others.create({
        id: Option.some("other-node"),
        state: { body: shared },
        actorId: Option.none(),
      });
      const report = yield* purge.purge(id);
      expect(report.documents).toEqual([own]);
      expect([...HashMap.keys(documents.stored())]).toEqual([shared]);
    }),
  );

  it.effect(
    "deletes unreferenced bytes after the commit, and keeps bytes another version references",
    () =>
      Effect.gen(function* () {
        const { blobs, others, events, create, purge, putBytes } = yield* setup();
        yield* putBytes(HASH_A);
        yield* putBytes(HASH_B);
        const id = yield* create({ contentHash: HASH_A });
        yield* others.create({
          id: Option.some("other-node"),
          state: { contentHash: HASH_B },
          actorId: Option.none(),
        });
        const report = yield* purge.purge(id);
        expect(report).toEqual({ id, documents: [], blobs: [HASH_A], bytesLeft: [] });
        expect([...HashMap.keys(blobs.objects())]).toEqual([blobKey(HASH_B)]);
        expect(events).toEqual(["begin", "commit", `delete ${blobKey(HASH_A)}`]);
      }),
  );

  it.effect("a failed byte delete is reported in bytesLeft, never a failure", () =>
    Effect.gen(function* () {
      const failing: BlobStore<InMemoryBlobFailure | string, never> = {
        ...makeInMemoryBlobStore(),
        delete: () => Effect.fail("outage"),
      };
      const { create, purge, chain } = yield* setup({ blobs: failing });
      const id = yield* create({ contentHash: HASH_A });
      const report = yield* purge.purge(id);
      expect(report).toEqual({ id, documents: [], blobs: [], bytesLeft: [HASH_A] });
      expect(chain.rows()).toEqual([]);
    }),
  );

  it.effect("without a blob store, every unreferenced content hash is left for the caller", () =>
    Effect.gen(function* () {
      const { create, purge } = yield* setup({ withoutBlobs: true });
      const id = yield* create({ contentHash: HASH_A });
      expect((yield* purge.purge(id)).bytesLeft).toEqual([HASH_A]);
    }),
  );
});
