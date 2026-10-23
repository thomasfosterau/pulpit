/**
 * **Purge**: erasure, the one destructive path through a node's history
 * (pulpit#58).
 *
 * A tombstone hides a node and keeps every version of its content, readable
 * at the view-deleted rung. Where that content is personal data and the law
 * requires it erased rather than hidden, {@link definePurge}'s `purge`
 * hard-deletes it. It removes the node's whole chain, every row the kernel's
 * other seams keep for the node, and the documents and file bytes no other
 * version references any longer.
 *
 * ## The model (owner decision on pulpit#58, 2026-10-14)
 *
 * - **The whole chain goes.** Every version row on every level of the
 *   node's chain is deleted, with its identity row. It is the one sanctioned
 *   exception to the append-only chain (`VERSION-CHAIN-001/002`, SECURITY.md):
 *   nothing else deletes or rewrites a version row. With the chain go the
 *   node's working copies, proposals, publication facts, path claims, reports
 *   and every edge with the node at an end: rows that name a node that no
 *   longer exists.
 * - **Shared content is deleted only when nothing else references it.**
 *   Documents (`./documents`) and bytes (`./blobs`) are shared by hash. A
 *   purge drops the node's references; a document or a blob is deleted only
 *   when no version of any other node still references its hash, so
 *   identical content another node uses survives. A deleted document is the
 *   one exception to `DOC-001` (a stored document is never rewritten).
 * - **Bytes are deleted after the commit**, as `./blobs` writes them after
 *   the commit: the chain's erasure and the document deletes run in
 *   `transact`, the caller's write boundary, and the blob store is told only
 *   once it has returned. A failed byte delete never fails the purge, which
 *   has committed: the report lists the bytes left behind
 *   ({@link PurgeReport.bytesLeft}) for a retry through `BlobStore.delete`.
 * - **A dedicated rung.** `purge` runs at the rung the definition's
 *   `canPurge` names, checked before anything is read, so a caller below it
 *   learns nothing about any id (`Unauthorized` / `Forbidden` for every id
 *   alike). At the rung, an unknown or already purged id fails
 *   `NodeNotFound`. A live node purges as a tombstoned one does: erasure is
 *   one step, never "delete, then purge".
 *
 * ## The seam
 *
 * The erasure itself is the application's {@link PurgeStore}: it knows
 * which tables hold rows keyed to a node and which columns carry a document
 * or content hash. The contract is stated in the package README → Seams.
 *
 * @copyright Thomas Foster
 * @module pulpit/purge
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { blobKey, type BlobStore, type ContentHash } from "./blobs.ts";
import type { DocumentHash } from "./documents.ts";
import {
  Forbidden,
  Unauthorized,
  type ResourceCacheSeam,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";
import { NodeNotFound, type VersionChainStore } from "./version-chain.ts";

// ── The seam ──────────────────────────────────────────────────────────

/**
 * What {@link PurgeStore.eraseNode} reports: every document hash and every
 * content hash the erased version rows referenced, each once.
 *
 * @since 0.1.0
 */
export interface ErasedReferences {
  readonly documents: ReadonlyArray<DocumentHash>;
  readonly blobs: ReadonlyArray<ContentHash>;
}

/**
 * The erasure seam an application supplies, over the same tables as its
 * other stores. Like them it applies no policy, fails only with its `E`,
 * and never opens a transaction: {@link definePurge} runs its three methods,
 * in order, inside the caller's `transact`.
 *
 * @since 0.1.0
 */
export interface PurgeStore<E, R> {
  /**
   * Hard-delete node `id`: every version row on every level of its chain,
   * its identity row and owner row, and every row the kernel's other seams
   * keep for it (working copies, proposals, publication facts, path claims
   * and aliases, reports, and each edge with the node at an end). Returns
   * the document and content hashes the deleted version rows referenced
   * (`DELETE … RETURNING`). An id with no rows deletes nothing and returns
   * none.
   */
  readonly eraseNode: (id: string) => Effect.Effect<ErasedReferences, E, R>;
  /**
   * Delete each document of `hashes` that no version row of any node
   * references any longer, and return the hashes deleted. Runs after
   * {@link PurgeStore.eraseNode} in the same transaction, so the purged
   * node's own references are already gone.
   */
  readonly deleteUnreferencedDocuments: (
    hashes: ReadonlyArray<DocumentHash>,
  ) => Effect.Effect<ReadonlyArray<DocumentHash>, E, R>;
  /**
   * Of `hashes`, the content hashes no version row of any node references
   * any longer: the bytes {@link definePurge} deletes once the transaction
   * has returned. Runs after {@link PurgeStore.eraseNode} in the same
   * transaction.
   */
  readonly unreferencedBlobs: (
    hashes: ReadonlyArray<ContentHash>,
  ) => Effect.Effect<ReadonlyArray<ContentHash>, E, R>;
}

// ── The operation ─────────────────────────────────────────────────────

/**
 * What a purge did: the node erased, the documents deleted, the bytes
 * deleted, and the bytes left behind because their delete failed (or no
 * blob store was given), each by hash.
 *
 * @since 0.1.0
 */
export interface PurgeReport {
  readonly id: string;
  /** The documents deleted: those the node referenced and no other version does. */
  readonly documents: ReadonlyArray<DocumentHash>;
  /** The bytes deleted from the blob store. */
  readonly blobs: ReadonlyArray<ContentHash>;
  /**
   * Unreferenced bytes still in the blob store: their delete failed after
   * the commit, or the definition has no blob store. Delete each with
   * `BlobStore.delete(blobKey(hash))`; nothing references them any more.
   */
  readonly bytesLeft: ReadonlyArray<ContentHash>;
}

/**
 * The operation {@link definePurge} produces.
 *
 * @since 0.1.0
 */
export interface PurgeOps<E, R> {
  /** The leaf's wire type, as declared. */
  readonly type: string;
  /**
   * Erase node `id`. Fails `Unauthorized` when anonymous and `Forbidden`
   * below the purge rung, for every id alike; at the rung, `NodeNotFound`
   * when `id` has no chain.
   */
  readonly purge: (
    id: string,
  ) => Effect.Effect<PurgeReport, Unauthorized | Forbidden | NodeNotFound | E, R>;
}

/**
 * What {@link definePurge} binds.
 *
 * @since 0.1.0
 */
export interface PurgeDefinition<E, EB, R> {
  /** The leaf's JSON:API wire type: names spans and tags `NodeNotFound`. */
  readonly type: string;
  /** The leaf's version-chain store: `head` says whether the node exists. */
  readonly chain: VersionChainStore<E, R>;
  /** The erasure seam. */
  readonly store: PurgeStore<E, R>;
  /** The request's viewer (effect-auth's session context). */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /**
   * The purge rung: whether `account` may erase a node of this leaf. An
   * application rung of its own (an admin, a data-protection officer),
   * which, like the `AccessPolicy` axes, must fail closed on an unknown
   * role.
   */
  readonly canPurge: (account: ViewerAccount) => boolean;
  /** The caller's write boundary; the erasure runs inside it. */
  readonly transact: <A, E2>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>;
  /**
   * The byte store unreferenced bytes are deleted from, after the commit.
   * Omitted, every unreferenced content hash is reported in
   * {@link PurgeReport.bytesLeft}.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is "no blob store"
  readonly blobs?: BlobStore<EB, R> | undefined;
  /**
   * The resource cache, evicted after the commit at the version past the
   * purged head, so no cached copy outlives the erasure (`CACHE-AUTH-005`).
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "the leaf is not cached"
  readonly cache?: ResourceCacheSeam<unknown, R> | undefined;
}

/**
 * Bind a leaf's purge. `purge(id)` checks the purge rung, then, inside
 * `transact`, erases the node through the {@link PurgeStore}, deletes the
 * documents nothing else references, and reads which of its bytes nothing
 * else references; once `transact` has returned it evicts the cache and
 * deletes those bytes. A failed byte delete is logged and reported in
 * {@link PurgeReport.bytesLeft}, never a failure.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
 * import { definePurge } from "@thomasfosterau/pulpit/purge";
 * import {
 *   makeInMemoryChainStore,
 *   makeInMemoryDocumentStore,
 *   makeInMemoryPurgeStore,
 * } from "@thomasfosterau/pulpit/testing";
 *
 * const chain = makeInMemoryChainStore();
 * const documents = makeInMemoryDocumentStore();
 * const notes = defineVersionChain("notes", chain);
 * const purge = definePurge({
 *   type: "notes",
 *   chain,
 *   store: makeInMemoryPurgeStore({ chains: [chain], documents, documentColumns: ["body"] }),
 *   viewer: Effect.succeed(Option.some({ id: "u-admin", role: "admin" })),
 *   canPurge: (account) => account.role === "admin",
 *   transact: (effect) => effect,
 * });
 *
 * const report = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const { hash } = yield* documents.put({ text: "personal data" });
 *     const { id } = yield* notes.create({
 *       id: Option.none(),
 *       state: { body: hash },
 *       actorId: Option.none(),
 *     });
 *     return yield* purge.purge(id);
 *   }),
 * );
 *
 * // The chain and its only document (a hash no other version references) are gone.
 * deepStrictEqual(chain.rows(), []);
 * deepStrictEqual(HashMap.size(documents.stored()), 0);
 * deepStrictEqual(report.documents.length, 1);
 * ```
 *
 * @since 0.1.0
 */
export const definePurge = <E, EB, R>(definition: PurgeDefinition<E, EB, R>): PurgeOps<E, R> => {
  const { type, chain, store, transact } = definition;

  /** The purge rung, checked before any row is read. */
  const gate = Effect.flatMap(
    definition.viewer,
    (viewer): Effect.Effect<ViewerAccount, Unauthorized | Forbidden> =>
      Option.match(viewer, {
        onNone: () => Effect.fail(new Unauthorized()),
        onSome: (account) =>
          definition.canPurge(account) ? Effect.succeed(account) : Effect.fail(new Forbidden()),
      }),
  );

  /** The erasure, in the caller's transaction: what it deleted and which bytes it freed. */
  const erase = (id: string) =>
    Effect.gen(function* () {
      const head = yield* chain.head(id);
      if (Option.isNone(head)) return yield* new NodeNotFound({ type, id });
      const erased = yield* store.eraseNode(id);
      const documents = yield* store.deleteUnreferencedDocuments(Arr.dedupe(erased.documents));
      const freed = yield* store.unreferencedBlobs(Arr.dedupe(erased.blobs));
      return { head: head.value.version, documents, freed };
    });

  /** Delete one blob's bytes after the commit: whether they are gone. */
  const deleteBytes = (hash: ContentHash) =>
    definition.blobs === undefined
      ? Effect.succeed(false)
      : Effect.exit(definition.blobs.delete(blobKey(hash))).pipe(
          Effect.tap((exit) =>
            Exit.isFailure(exit)
              ? Effect.logWarning(`${type}: bytes ${hash} left after purge`, exit.cause)
              : Effect.void,
          ),
          Effect.map(Exit.isSuccess),
        );

  const purge = Effect.fn(`${type}.purge`)(function* (id: string) {
    yield* gate;
    const erased = yield* transact(erase(id));
    if (definition.cache !== undefined) yield* definition.cache.delete(id, erased.head + 1n);
    const deleted = yield* Effect.forEach(
      erased.freed,
      (hash) => Effect.map(deleteBytes(hash), (gone) => [hash, gone] as const),
      { concurrency: 1 },
    );
    const gone = (wanted: boolean) =>
      Arr.map(
        Arr.filter(deleted, ([, deletedNow]) => deletedNow === wanted),
        ([hash]) => hash,
      );
    const report: PurgeReport = {
      id,
      documents: erased.documents,
      blobs: gone(true),
      bytesLeft: gone(false),
    };
    return report;
  });

  return { type, purge };
};
