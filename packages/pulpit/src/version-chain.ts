/**
 * @copyright Thomas Foster
 *
 * **The node / version chain discipline** — create, append, tombstone,
 * restore and history over an append-only chain, generic in the leaf.
 *
 * Every node carries an append-only chain of `(version, action, timestamp,
 * actor)` rows (`READ-009` / `PUB-003`): each edit appends a row rather than
 * rewriting in place, and "repointing the current version" is nothing but
 * that append — the current version is the chain's maximum, resolved by the
 * current-version view. The behavioural spec is gardeneria's
 * `packages/database/src/nodes.ts` (`createNodeE` / `updateNodeE` /
 * `deleteNodeE`), the leaf-chain half of `apps/api/src/operations/subtype.ts`
 * (`defineVersionOpsE`, the merge / carry-forward writers) and
 * `version-history.ts`; a `#NNN` here names a gardeneria issue.
 *
 * ## The invariants
 *
 * - **Append-only** (`VERSION-CHAIN-001/002`). Every write lands at
 *   `N_max + 1`; no existing version row is ever updated, deleted or
 *   reordered. A restore is a new version whose content came from history.
 * - **Create is never an upsert.** A caller-supplied id that already belongs
 *   to a node fails {@link NodeAlreadyExists} (F-OP-02) rather than minting a
 *   version onto it.
 * - **Update carries forward.** A patch is tri-state per column: a value
 *   sets, `null` clears, an absent (or `undefined`) key carries the previous
 *   version's value forward. Never `input.x ?? null`.
 * - **Delete is a tombstone that carries the state forward**, so a `delete`
 *   version is itself a complete snapshot — which is what makes restoring
 *   *from* a tombstone possible. It is idempotent: on an already tombstoned
 *   node it returns the existing tombstone and writes nothing.
 * - **A plain update never resurrects** (`VERSION-CHAIN-006`). Over a
 *   tombstone it fails {@link NodeNotFound}; only the explicit `restore` and
 *   `restoreVersion` write over one.
 * - **No partial restore.** `restoreVersion` reads the whole snapshot first
 *   and fails {@link VersionNotFound} when any level of the chain has no row
 *   at that version — before anything is written.
 * - **Every chain read is bounded** (`PERF-DB-001`): `history` takes a
 *   `limit`, capped at {@link MAX_HISTORY_LIMIT}.
 *
 * ## The seam
 *
 * The chain is read and written through a {@link VersionChainStore} the
 * application supplies — in production, a Drizzle store over
 * effect-drizzle-ext's `./versioned-chain` tables and views, which is not yet
 * published (see `packages/pulpit/CLAUDE.md` → Seams for the expected table
 * shape). The operations here own the discipline; the store owns persistence
 * and nothing else. Authorisation is not this module's concern either: the
 * subtype factory (`./subtype`) gates before it calls in.
 *
 * @module pulpit/version-chain
 */

import * as Array from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// ── Vocabulary ────────────────────────────────────────────────────────

/** What one version row recorded: the create, an edit (restores included), or a tombstone. */
export const VersionAction = Schema.Literals(["create", "update", "delete"]);
export type VersionAction = typeof VersionAction.Type;

/**
 * One column's value in a leaf's state: a JSON value, or one of the two
 * non-JSON scalars a Drizzle row carries (`Date` for timestamps, `bigint` for
 * `bigint` columns). Documents are carried inline as their parsed JSON.
 */
export type ColumnValue = Schema.Json | Date | bigint;

/**
 * A leaf's domain state at one version: every column of every level of its
 * chain, keyed by column name (the leaf-most level wins on a shared name).
 * Generated columns (a `search_vector`) are not part of it — they regenerate.
 */
export type ChainState = { readonly [column: string]: ColumnValue };

/**
 * A tri-state patch over a {@link ChainState}: a value sets, `null` clears,
 * an absent or `undefined` key carries the previous version's value forward.
 */
// oxlint-disable-next-line effect/prefer-option-over-null -- the tri-state rule IS the `undefined` arm: it is how a decoded update input says "not supplied", and an `Option` here would have to be unwrapped from every generated update projection first
export type ChainPatch = { readonly [column: string]: ColumnValue | undefined };

/** One entry in a node's append-only version chain. */
export interface VersionChainEntry {
  /** The version number (0 is the create). */
  readonly version: bigint;
  /** The edit action this version recorded. */
  readonly action: VersionAction;
  /** When the version was written. */
  readonly timestamp: Date;
}

/** One version's reconstructed state, for the edits (browse / compare) surface. */
export interface VersionSnapshot extends VersionChainEntry {
  readonly state: ChainState;
}

/** The row a write appends: the entry, the node's leaf type, the acting account, the full state. */
export interface VersionRow extends VersionSnapshot {
  readonly id: string;
  /** The concrete leaf's wire type, threaded onto the node row at version 0 (#864 S3). */
  readonly type: string;
  /** The acting account (#1581) — recorded on the version row, never inferred. */
  readonly actorId: Option.Option<string>;
}

/** What a chain write returns: the node and the version it landed at. */
export interface ChainWrite {
  readonly id: string;
  readonly version: bigint;
}

// ── Errors ────────────────────────────────────────────────────────────

/** No such node, or (for a plain update) a tombstoned one: the wire's 404. */
export class NodeNotFound extends Schema.TaggedError<NodeNotFound>()("NodeNotFound", {
  type: Schema.String,
  id: Schema.String,
}) {}

/** No reconstructable version at `(id, version)`: an unknown version, or a partial chain. */
export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()("VersionNotFound", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/** A create whose caller-supplied id already belongs to a node — never an upsert: the wire's 409. */
export class NodeAlreadyExists extends Schema.TaggedError<NodeAlreadyExists>()(
  "NodeAlreadyExists",
  { type: Schema.String, id: Schema.String },
) {}

/**
 * The store refused an append because `(id, version)` is already taken — a
 * concurrent writer got there first. Raised by the store (the `(id, version)`
 * primary key is what enforces append-only under concurrency); never retried
 * here, because a retry would silently base the write on a version the
 * caller never read.
 */
export class VersionConflict extends Schema.TaggedError<VersionConflict>()("VersionConflict", {
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * The chain's head version has no reconstructable state — the store broke its
 * own contract (a head it reports must be readable). A defect, never a typed
 * failure: there is nothing a caller could do about it.
 */
export class BrokenChain extends Schema.TaggedError<BrokenChain>()("BrokenChain", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The persistence seam the chain operations run over. `E` is the store's own
 * failure (a Drizzle store's `EffectDrizzleQueryError`); `R` its requirements
 * (a Drizzle store's `CurrentTransaction` — the operations never open a
 * transaction themselves: `transact` is always-open and the boundary belongs
 * to the caller, website #1883).
 *
 * Every method reads or writes exactly what it says and applies no policy.
 */
export interface VersionChainStore<E, R> {
  /** The node's latest version entry, or none for an id with no versions. */
  readonly head: (id: string) => Effect.Effect<Option.Option<VersionChainEntry>, E, R>;
  /**
   * The full state at `(id, version)`, or none when the version does not
   * exist OR any level of the chain has no row there — a version that cannot
   * be fully reconstructed is reported as absent, never as a partial state.
   */
  readonly snapshot: (
    id: string,
    version: bigint,
  ) => Effect.Effect<Option.Option<VersionSnapshot>, E, R>;
  /**
   * Append one version row — at version 0 together with the node's identity
   * row. Fails {@link VersionConflict} when `(id, version)` already exists
   * (at version 0: the id already belongs to a node).
   */
  readonly append: (row: VersionRow) => Effect.Effect<void, E | VersionConflict, R>;
  /** The chain's entries, oldest first, at most `limit` of them. */
  readonly entries: (
    id: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VersionChainEntry>, E, R>;
  /** Mint a fresh node id (a UUID) when the caller supplies none. */
  readonly mintId: Effect.Effect<string, E, R>;
}

// ── The operations ────────────────────────────────────────────────────

/** The hard cap on a history read (`PERF-DB-001`): a chain is tiny in practice; this bounds a pathological one. */
export const MAX_HISTORY_LIMIT = 1000;

/** Apply a tri-state patch to a state: a value sets, `null` clears, `undefined` carries forward. */
export const applyPatch = (state: ChainState, patch: ChainPatch) => ({
  ...state,
  ...Record.filter(patch, (value): value is ColumnValue => value !== undefined),
});

/** The create / update inputs: the leaf's state (or patch), the node id, the acting account. */
export interface CreateInput {
  /** A caller-supplied node id (client-generated ids); minted by the store when absent. */
  readonly id: Option.Option<string>;
  readonly state: ChainState;
  readonly actorId: Option.Option<string>;
}

export interface UpdateInput {
  readonly id: string;
  readonly patch: ChainPatch;
  readonly actorId: Option.Option<string>;
}

/** The chain operations for one leaf type, bound to a store. */
export interface VersionChainOps<E, R> {
  /** Insert the node and its version 0 (`create`). Fails {@link NodeAlreadyExists} on a taken id. */
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<ChainWrite, E | NodeAlreadyExists | VersionConflict, R>;
  /**
   * Append an `update` version carrying the patch over the current state.
   * Fails {@link NodeNotFound} for an unknown id and for a tombstoned node.
   */
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | VersionConflict, R>;
  /**
   * {@link update}, except a tombstone does not fail: the explicit restore
   * surface (`VERSION-CHAIN-006`) — the node comes back live.
   */
  readonly restore: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | VersionConflict, R>;
  /**
   * Append a `delete` version carrying the state forward. Idempotent: on a
   * tombstoned node it returns the existing tombstone with
   * `alreadyDeleted: true` and writes nothing.
   */
  readonly delete: (
    id: string,
    actorId: Option.Option<string>,
  ) => Effect.Effect<
    ChainWrite & { readonly alreadyDeleted: boolean },
    E | NodeNotFound | VersionConflict,
    R
  >;
  /** The reconstructed state at `(id, version)`. Read-only. */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<VersionSnapshot, E | VersionNotFound, R>;
  /**
   * Re-apply the full snapshot at `(id, version)` as a NEW `update` version —
   * over a tombstone too. Fails {@link VersionNotFound}, before writing
   * anything, when the version cannot be fully reconstructed.
   */
  readonly restoreVersion: (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
  ) => Effect.Effect<ChainWrite, E | VersionNotFound | VersionConflict, R>;
  /**
   * The chain, oldest first, at most `limit` entries (default and cap
   * {@link MAX_HISTORY_LIMIT}). Fails {@link NodeNotFound} when the id has no
   * versions, so a caller surfaces the 404 a missing resource would.
   */
  readonly history: (
    id: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<VersionChainEntry>, E | NodeNotFound, R>;
}

const isVersionConflict = Schema.is(VersionConflict);

/** The write clock: the current instant, as the `Date` a version row stores. */
const now: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.toDate(DateTime.makeUnsafe(millis)),
);

/**
 * Bind the chain operations for one leaf `type` to a store. Every produced
 * operation is traced as `${type}.<operation>`.
 */
export const defineVersionChain = <E, R>(
  type: string,
  store: VersionChainStore<E, R>,
): VersionChainOps<E, R> => {
  const appendNext = (
    id: string,
    previous: VersionChainEntry,
    action: VersionAction,
    state: ChainState,
    actorId: Option.Option<string>,
  ): Effect.Effect<ChainWrite, E | VersionConflict, R> =>
    Effect.gen(function* () {
      const version = previous.version + 1n;
      const timestamp = yield* now;
      yield* store.append({ id, type, version, action, timestamp, state, actorId });
      return { id, version };
    });

  /** The current state: the head's snapshot. A head without a snapshot is a broken chain — a defect, not a miss. */
  const current = (id: string) =>
    Effect.gen(function* () {
      const head = yield* store.head(id);
      if (Option.isNone(head)) return Option.none();
      const snapshot = yield* store.snapshot(id, head.value.version);
      if (Option.isNone(snapshot)) {
        return yield* Effect.die(new BrokenChain({ type, id, version: head.value.version }));
      }
      return Option.some(snapshot.value);
    });

  const create = Effect.fn(`${type}.create`)(function* (input: CreateInput) {
    const id = Option.isSome(input.id) ? input.id.value : yield* store.mintId;
    if (Option.isSome(input.id) && Option.isSome(yield* store.head(id))) {
      return yield* new NodeAlreadyExists({ type, id });
    }
    const timestamp = yield* now;
    yield* store
      .append({
        id,
        type,
        version: 0n,
        action: "create",
        timestamp,
        state: input.state,
        actorId: input.actorId,
      })
      .pipe(
        // A racing create that took the id between the check above and this
        // append surfaces as the store's version-0 collision.
        Effect.mapError((error) =>
          isVersionConflict(error) && error.version === 0n
            ? new NodeAlreadyExists({ type, id })
            : error,
        ),
      );
    return { id, version: 0n };
  });

  const merge = (input: UpdateInput, allowDeleted: boolean) =>
    Effect.gen(function* () {
      const head = yield* current(input.id);
      if (Option.isNone(head) || (head.value.action === "delete" && !allowDeleted)) {
        return yield* new NodeNotFound({ type, id: input.id });
      }
      return yield* appendNext(
        input.id,
        head.value,
        "update",
        applyPatch(head.value.state, input.patch),
        input.actorId,
      );
    });

  const update = Effect.fn(`${type}.update`)(function* (input: UpdateInput) {
    return yield* merge(input, false);
  });

  const restore = Effect.fn(`${type}.restore`)(function* (input: UpdateInput) {
    return yield* merge(input, true);
  });

  const softDelete = Effect.fn(`${type}.delete`)(function* (
    id: string,
    actorId: Option.Option<string>,
  ) {
    const head = yield* current(id);
    if (Option.isNone(head)) return yield* new NodeNotFound({ type, id });
    if (head.value.action === "delete") {
      return { id, version: head.value.version, alreadyDeleted: true };
    }
    const written = yield* appendNext(id, head.value, "delete", head.value.state, actorId);
    return { ...written, alreadyDeleted: false };
  });

  const getVersion = Effect.fn(`${type}.getVersion`)(function* (id: string, version: bigint) {
    const snapshot = yield* store.snapshot(id, version);
    if (Option.isNone(snapshot)) return yield* new VersionNotFound({ type, id, version });
    return snapshot.value;
  });

  const restoreVersion = Effect.fn(`${type}.restoreVersion`)(function* (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
  ) {
    // Read the whole historical state FIRST, so an unreconstructable version
    // fails before the chain is touched at all.
    const snapshot = yield* store.snapshot(id, version);
    if (Option.isNone(snapshot)) return yield* new VersionNotFound({ type, id, version });
    const head = yield* store.head(id);
    if (Option.isNone(head)) return yield* new VersionNotFound({ type, id, version });
    // `update`, not a fourth action: a restore is an ordinary edit whose
    // content came from history, and `action` stays the currency / tombstone
    // axis every fail-closed view reads (#864 A8).
    return yield* appendNext(id, head.value, "update", snapshot.value.state, actorId);
  });

  const history = Effect.fn(`${type}.history`)(function* (
    id: string,
    limit: number = MAX_HISTORY_LIMIT,
  ) {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_HISTORY_LIMIT));
    const entries = yield* store.entries(id, bounded);
    return yield* Array.match(entries, {
      onEmpty: () => Effect.fail(new NodeNotFound({ type, id })),
      onNonEmpty: (nonEmpty) => Effect.succeed<ReadonlyArray<VersionChainEntry>>(nonEmpty),
    });
  });

  return { create, update, restore, delete: softDelete, getVersion, restoreVersion, history };
};
