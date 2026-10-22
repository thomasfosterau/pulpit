/**
 * **The working copy** — an editor's autosave buffer, kept outside the
 * version chain and overwritten freely, which an explicit save appends as
 * one ordinary `update` version.
 *
 * ## The model (owner decisions on pulpit#46)
 *
 * - **Nothing in a working copy is a version**: saving it writes only the
 *   {@link WorkingCopyStore}, so `VERSION-CHAIN-001` is untouched and a
 *   hundred autosaves leave no trace in history.
 * - **One copy per (node, editor)**, so two editors never overwrite each
 *   other's unsaved work.
 * - **`commit` appends the copy** through the leaf's own `update`, expecting
 *   the head the copy was first based on: an edit landing in between fails
 *   `StaleVersion` (and keeps the copy), so a commit never silently
 *   overwrites work its editor didn't see. A committed copy is cleared.
 * - **Every operation is gated like a write** (the leaf's `authorize`):
 *   reading a copy shows unpublished state, so it is gated like the head.
 *
 * @copyright Thomas Foster
 * @module pulpit/working-copy
 * @since 0.1.0
 */

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Forbidden, SubtypeOps, Unauthorized, WriteRejected } from "./subtype.ts";
import {
  NodeNotFound,
  type ChainPatch,
  type ChainWrite,
  type StaleVersion,
  type VersionChainStore,
  type VersionConflict,
} from "./version-chain.ts";

/**
 * One editor's working copy of one node: the tri-state patch over the head
 * it was based on, and when it was last saved.
 *
 * @since 0.1.0
 */
export interface WorkingCopy {
  readonly patch: ChainPatch;
  /** The head the copy was first based on; `commit` expects it. */
  readonly baseVersion: bigint;
  readonly savedAt: Date;
}

/**
 * Whose copy of which node.
 *
 * @since 0.1.0
 */
export interface WorkingCopyKey {
  readonly id: string;
  readonly userId: string;
}

/**
 * The overwritable buffer an application supplies (a table keyed by
 * `(node_id, user_id)`, or a KV namespace). Applies no policy and fails
 * only with its `E` (README → Seams).
 *
 * @since 0.1.0
 */
export interface WorkingCopyStore<E, R> {
  /** Write the copy, replacing any earlier one under the key. */
  readonly put: (key: WorkingCopyKey, copy: WorkingCopy) => Effect.Effect<void, E, R>;
  readonly get: (key: WorkingCopyKey) => Effect.Effect<Option.Option<WorkingCopy>, E, R>;
  /** Remove the copy; idempotent. */
  readonly discard: (key: WorkingCopyKey) => Effect.Effect<void, E, R>;
}

/**
 * No working copy to commit: the wire's 404.
 *
 * @since 0.1.0
 */
export class WorkingCopyNotFound extends Schema.TaggedError<WorkingCopyNotFound>()(
  "WorkingCopyNotFound",
  { type: Schema.String, id: Schema.String },
) {}

type Gate = Unauthorized | Forbidden | NodeNotFound;

/**
 * The operations {@link defineWorkingCopy} produces, each acting on the
 * calling editor's own copy.
 *
 * @since 0.1.0
 */
export interface WorkingCopyOps<E, R> {
  /**
   * Save `patch` over the editor's copy (a value sets, `null` clears, an
   * absent key keeps the copy's), based on the head when there was no
   * copy. Fails at the leaf's write gate, and `NodeNotFound` for a missing
   * or tombstoned node.
   */
  readonly save: (id: string, patch: ChainPatch) => Effect.Effect<WorkingCopy, Gate | E, R>;
  /** The editor's copy, or none. Gated like a write. */
  readonly get: (id: string) => Effect.Effect<Option.Option<WorkingCopy>, Gate | E, R>;
  /** Throw the editor's copy away. Gated like a write. */
  readonly discard: (id: string) => Effect.Effect<void, Gate | E, R>;
  /**
   * Append the copy as one `update` version, expecting its base head, and
   * clear it. Fails `WorkingCopyNotFound` without a copy, and as the
   * leaf's `update` does (`StaleVersion` when the head moved since the
   * copy's base, keeping the copy; `WriteRejected` from its hooks).
   */
  readonly commit: (
    id: string,
  ) => Effect.Effect<
    ChainWrite,
    Gate | WorkingCopyNotFound | StaleVersion | VersionConflict | WriteRejected | E,
    R
  >;
}

const nowDate: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.toDate(DateTime.makeUnsafe(millis)),
);

/**
 * Bind a leaf's working copies: `leaf` gates and commits, `chain` reads
 * the head a new copy is based on, `store` keeps the copies.
 *
 * @since 0.1.0
 */
export const defineWorkingCopy = <Resource, E, R>(definition: {
  readonly leaf: SubtypeOps<Resource, E, R>;
  readonly chain: VersionChainStore<E, R>;
  readonly store: WorkingCopyStore<E, R>;
}): WorkingCopyOps<E, R> => {
  const { leaf, chain, store } = definition;
  const type = leaf.type;
  const keyFor = (id: string) =>
    Effect.map(leaf.authorize(id), (account) => ({ id, userId: account.id }));

  const save = Effect.fn(`${type}.workingCopy.save`)(function* (id: string, patch: ChainPatch) {
    const key = yield* keyFor(id);
    const head = yield* chain.head(id);
    if (Option.isNone(head) || head.value.action === "delete") {
      return yield* new NodeNotFound({ type, id });
    }
    const earlier = yield* store.get(key);
    const copy: WorkingCopy = {
      patch: Option.match(earlier, {
        onNone: () => patch,
        // An absent (or `undefined`) key in the new patch keeps the copy's own.
        onSome: (existing): ChainPatch => ({
          ...existing.patch,
          ...Record.filter(patch, (value) => value !== undefined),
        }),
      }),
      baseVersion: Option.match(earlier, {
        onNone: () => head.value.version,
        onSome: (existing) => existing.baseVersion,
      }),
      savedAt: yield* nowDate,
    };
    yield* store.put(key, copy);
    return copy;
  });

  const get = Effect.fn(`${type}.workingCopy.get`)(function* (id: string) {
    return yield* store.get(yield* keyFor(id));
  });

  const discard = Effect.fn(`${type}.workingCopy.discard`)(function* (id: string) {
    yield* store.discard(yield* keyFor(id));
  });

  const commit = Effect.fn(`${type}.workingCopy.commit`)(function* (id: string) {
    const key = yield* keyFor(id);
    const copy = yield* store.get(key);
    if (Option.isNone(copy)) return yield* new WorkingCopyNotFound({ type, id });
    const written = yield* leaf.update({
      id,
      patch: copy.value.patch,
      expectedVersion: copy.value.baseVersion,
    });
    yield* store.discard(key);
    return written;
  });

  return { save, get, discard, commit };
};
