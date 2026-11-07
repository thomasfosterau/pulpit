/**
 * **The purge itself, ungated** (pulpit#58), shared by `./purge`'s
 * `definePurge` (behind the purge rung) and `./erasure`'s account erasure
 * (behind the erasure rung, pulpit#207), so a node is erased one way.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { blobKey, type ContentHash } from "../blobs.ts";
import type { PurgeDefinition, PurgeReport } from "../purge.ts";
import { NodeNotFound } from "../version-chain.ts";

/**
 * The purge itself, ungated: inside `transact`, erase node `id` through the
 * {@link PurgeStore}, delete the documents nothing else references and read
 * which of its bytes nothing else references; once `transact` has returned,
 * evict the cache and delete those bytes. Fails `NodeNotFound` when `id` has
 * no chain. {@link definePurge} runs it behind the purge rung and
 * `./erasure` behind the erasure rung; nothing else may call it.
 *
 * @internal
 */
export const purgeNode =
  <E, EB, R>(
    definition: Pick<
      PurgeDefinition<E, EB, R>,
      "type" | "chain" | "store" | "transact" | "blobs" | "cache"
    >,
  ) =>
  (id: string): Effect.Effect<PurgeReport, NodeNotFound | E, R> => {
    const { type, chain, store, transact } = definition;
    /** The erasure, in the caller's transaction: what it deleted and which bytes it freed. */
    const erase = (id: string) =>
      Effect.gen(function* () {
        const head = yield* chain.head(id);
        if (Option.isNone(head)) return yield* new NodeNotFound({ type, id });
        const erased = yield* store.eraseNode(id);
        yield* chain.purge(id);
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

    return Effect.gen(function* () {
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
  };
