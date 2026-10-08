/**
 * **The node / version chain discipline** — create, append, tombstone,
 * restore, history and field-level compare over an append-only chain,
 * generic in the leaf.
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
 * - **An expected version is a precondition on the append.** A write to an
 *   existing node (`update`, `restore`, `delete`, `restoreVersion`) may
 *   carry the head version its caller last read ({@link Precondition}); a
 *   head that has moved fails {@link StaleVersion} and nothing is written.
 *   It is checked against the very head the append extends, and the append
 *   lands at that head + 1, so a writer that slips in between the read and
 *   the append takes the `(id, version)` key first and this one fails
 *   {@link VersionConflict}: the store's primary key is what makes the check
 *   atomic. Without one, a write extends whatever the head is (last writer
 *   wins on a column two patches both set).
 *
 * ## The seam
 *
 * The chain is read and written through a {@link VersionChainStore} the
 * application supplies — in production, a Drizzle store over
 * effect-drizzle-ext's `./versioned-chain` tables and views, which is not yet
 * published (see the package README → Seams for the expected table shape).
 * The operations here own the discipline; the store owns persistence
 * and nothing else. Authorisation is not this module's concern either: the
 * subtype factory (`./subtype`) gates before it calls in.
 *
 * @copyright Thomas Foster
 * @module pulpit/version-chain
 * @since 0.1.0
 */

import * as Array from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * What one version row recorded: the create, an edit (restores included), or a tombstone.
 *
 * @since 0.1.0
 */
export const VersionAction = Schema.Literals(["create", "update", "delete"]);
/**
 * The {@link VersionAction} literal union: `"create" | "update" | "delete"`.
 *
 * @since 0.1.0
 */
export type VersionAction = typeof VersionAction.Type;

/**
 * One column's value in a leaf's state: a JSON value, or one of the two
 * non-JSON scalars a Drizzle row carries (`Date` for timestamps, `bigint` for
 * `bigint` columns). A content-addressed document is carried as its
 * `DocumentHash` (`./documents`' `documentRef`), never as a copy; a document
 * a leaf keeps inline is its parsed JSON.
 *
 * @since 0.1.0
 */
export type ColumnValue = Schema.Json | Date | bigint;

/**
 * A leaf's domain state at one version: every column of every level of its
 * chain, keyed by column name (the leaf-most level wins on a shared name).
 * Generated columns (a `search_vector`) are not part of it — they regenerate.
 *
 * @since 0.1.0
 */
export type ChainState = { readonly [column: string]: ColumnValue };

/**
 * A tri-state patch over a {@link ChainState}: a value sets, `null` clears,
 * an absent or `undefined` key carries the previous version's value forward.
 *
 * @since 0.1.0
 */
// oxlint-disable-next-line effect/prefer-option-over-null -- the tri-state rule IS the `undefined` arm: it is how a decoded update input says "not supplied", and an `Option` here would have to be unwrapped from every generated update projection first
export type ChainPatch = { readonly [column: string]: ColumnValue | undefined };

/**
 * One entry in a node's append-only version chain.
 *
 * @since 0.1.0
 */
export interface VersionChainEntry {
  /** The version number (0 is the create). */
  readonly version: bigint;
  /** The edit action this version recorded. */
  readonly action: VersionAction;
  /** When the version was written. */
  readonly timestamp: Date;
}

/**
 * One version's reconstructed state, for the edits (browse / compare) surface.
 *
 * @since 0.1.0
 */
export interface VersionSnapshot extends VersionChainEntry {
  readonly state: ChainState;
}

/**
 * The row a write appends: the entry, the node's leaf type, the acting account, the full state.
 *
 * @since 0.1.0
 */
export interface VersionRow extends VersionSnapshot {
  readonly id: string;
  /** The concrete leaf's wire type, threaded onto the node row at version 0 (#864 S3). */
  readonly type: string;
  /** The acting account (#1581) — recorded on the version row, never inferred. */
  readonly actorId: Option.Option<string>;
}

/**
 * What a chain write returns: the node and the version it landed at.
 *
 * @since 0.1.0
 */
export interface ChainWrite {
  readonly id: string;
  readonly version: bigint;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * No such node, or (for a plain update) a tombstoned one: the wire's 404.
 *
 * @since 0.1.0
 */
export class NodeNotFound extends Schema.TaggedError<NodeNotFound>()("NodeNotFound", {
  type: Schema.String,
  id: Schema.String,
}) {}

/**
 * No reconstructable version at `(id, version)`: an unknown version, or a partial chain.
 *
 * @since 0.1.0
 */
export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()("VersionNotFound", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * A create whose caller-supplied id already belongs to a node — never an upsert: the wire's 409.
 *
 * @since 0.1.0
 */
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
 *
 * @since 0.1.0
 */
export class VersionConflict extends Schema.TaggedError<VersionConflict>()("VersionConflict", {
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * An expected-version precondition that no longer holds: the head moved past
 * the version the caller last read, so the write would have overwritten an
 * edit the caller never saw. Nothing was written. Carries the head the write
 * would have extended (`current`), so the caller can re-read and re-apply;
 * the wire's 412 (a failed `If-Match`) or 409.
 *
 * A writer that passes the check but loses the race to the append fails
 * {@link VersionConflict} instead: the same stale read, caught one step later
 * by the store's key.
 *
 * @since 0.1.0
 */
export class StaleVersion extends Schema.TaggedError<StaleVersion>()("StaleVersion", {
  type: Schema.String,
  id: Schema.String,
  /** The version the caller expected the head to be. */
  expected: Schema.BigInt,
  /** The head version the write found. */
  current: Schema.BigInt,
}) {}

/**
 * The chain's head version has no reconstructable state — the store broke its
 * own contract (a head it reports must be readable). A defect, never a typed
 * failure: there is nothing a caller could do about it.
 *
 * @since 0.1.0
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
 *
 * @since 0.1.0
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

/**
 * The hard cap on a history read (`PERF-DB-001`): a chain is tiny in practice; this bounds a pathological one.
 *
 * @since 0.1.0
 */
export const MAX_HISTORY_LIMIT = 1000;

/**
 * Apply a tri-state patch to a state: a value sets, `null` clears, `undefined` carries forward.
 *
 * @since 0.1.0
 */
export const applyPatch = (state: ChainState, patch: ChainPatch) => ({
  ...state,
  ...Record.filter(patch, (value): value is ColumnValue => value !== undefined),
});

// ── Version compare ───────────────────────────────────────────────────

/**
 * How one column differs between two states, read from the first state to
 * the second: `added` (absent before, present after), `removed` (present
 * before, absent after) or `changed` (present on both sides, structurally
 * unequal). A `null` is a present value: a column cleared to `null` is
 * `changed`, never `removed`, and a column absent from a state is a column
 * that state does not have, not one it cleared.
 *
 * @since 0.1.0
 */
export type AttributeChange =
  | { readonly _tag: "added"; readonly after: ColumnValue }
  | { readonly _tag: "removed"; readonly before: ColumnValue }
  | { readonly _tag: "changed"; readonly before: ColumnValue; readonly after: ColumnValue };

/**
 * The field-level change set between two states, keyed by column: one
 * {@link AttributeChange} per column that differs. An unchanged column has
 * no key, so two equal states diff to `{}`.
 *
 * @since 0.1.0
 */
export type StateDiff = { readonly [column: string]: AttributeChange };

/** One column's change, or none when both sides hold structurally equal values. */
const changeOf = (
  before: Option.Option<ColumnValue>,
  after: Option.Option<ColumnValue>,
): Option.Option<AttributeChange> => {
  if (Option.isNone(before)) {
    return Option.map(after, (value): AttributeChange => ({ _tag: "added", after: value }));
  }
  if (Option.isNone(after)) return Option.some({ _tag: "removed", before: before.value });
  return Equal.equals(before.value, after.value)
    ? Option.none()
    : Option.some({ _tag: "changed", before: before.value, after: after.value });
};

/**
 * The field-level change set from state `from` to state `to`: every column
 * that is added, removed or changed, with its before and after values;
 * unchanged columns are omitted. Pure and total, with no error channel.
 *
 * Presence is read per key, so the tri-state distinction survives: a column
 * holding `null` is present (a clear), and only a column with no key is
 * absent. Values compare structurally with `Equal.equals`: JSON objects and
 * arrays by content (key order ignored), a `Date` by its instant, a `bigint`
 * by value, and a `Date` never equals the string of its instant. A
 * content-addressed document is held as its `DocumentHash`, so it compares by
 * hash: changed or unchanged, never a textual diff, which is the UI's job.
 *
 * The diff is directed: swapping the arguments swaps `added` and `removed`
 * and each change's `before` and `after`. A state's values are compared as
 * immutable (Effect caches structural hashes), as a {@link ChainState} is.
 *
 * @since 0.1.0
 */
export const diffStates = (from: ChainState, to: ChainState): StateDiff =>
  Record.fromEntries(
    Array.flatMap(Array.dedupe([...Record.keys(from), ...Record.keys(to)]), (column) =>
      Array.fromOption(
        Option.map(
          changeOf(Record.get(from, column), Record.get(to, column)),
          (change) => [column, change] as const,
        ),
      ),
    ),
  );

/**
 * What {@link VersionChainOps.compare} returns: both versions as read
 * (entry and full state) and the {@link StateDiff} from the first to the
 * second.
 *
 * A tombstone is not an attribute: it is the version's `action`, so it shows
 * as `from.action` / `to.action` being `"delete"` and never as a key in
 * `changes`. A tombstone carries its state forward, so a version compared
 * with the tombstone that followed it has no changes; a history view labels
 * the version deleted from its action and lists only what the content did.
 *
 * @since 0.1.0
 */
export interface VersionComparison {
  /** The version compared from, with its state. */
  readonly from: VersionSnapshot;
  /** The version compared to, with its state. */
  readonly to: VersionSnapshot;
  /** `diffStates(from.state, to.state)`. */
  readonly changes: StateDiff;
}

/**
 * The input to {@link VersionChainOps.create}: the node id, the leaf's
 * initial state, the acting account.
 *
 * @since 0.1.0
 */
export interface CreateInput {
  /** A caller-supplied node id (client-generated ids); minted by the store when absent. */
  readonly id: Option.Option<string>;
  /** The leaf's full state at version 0. */
  readonly state: ChainState;
  /** The acting account, recorded on the version row; none for a write with no session behind it. */
  readonly actorId: Option.Option<string>;
}

/**
 * An optimistic-concurrency precondition on a write to an existing node: the
 * head version the caller last read. Every write that extends a chain
 * ({@link VersionChainOps.update}, {@link VersionChainOps.restore},
 * {@link VersionChainOps.delete}, {@link VersionChainOps.restoreVersion})
 * accepts one.
 *
 * @since 0.1.0
 */
export interface Precondition {
  /**
   * The head version the caller last read. When present, the write fails
   * {@link StaleVersion}, writing nothing, unless the head it extends is
   * exactly this version; absent (or `undefined`), the write extends whatever
   * the head is.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such by every reader, so there is no value to model as an `Option`
  readonly expectedVersion?: bigint | undefined;
}

/**
 * The input to {@link VersionChainOps.update} and
 * {@link VersionChainOps.restore}: the node, a tri-state patch, the acting
 * account, and an optional expected version.
 *
 * @since 0.1.0
 */
export interface UpdateInput extends Precondition {
  /** The node to append to. */
  readonly id: string;
  /**
   * The tri-state patch over the current state: a value sets, `null` clears,
   * an absent key carries forward.
   */
  readonly patch: ChainPatch;
  /** The acting account, recorded on the version row; none for a write with no session behind it. */
  readonly actorId: Option.Option<string>;
}

/**
 * The chain operations for one leaf type, bound to a store.
 *
 * @since 0.1.0
 */
export interface VersionChainOps<E, R> {
  /** Insert the node and its version 0 (`create`). Fails {@link NodeAlreadyExists} on a taken id. */
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<ChainWrite, E | NodeAlreadyExists | VersionConflict, R>;
  /**
   * Append an `update` version carrying the patch over the current state.
   * Fails {@link NodeNotFound} for an unknown id and for a tombstoned node,
   * and {@link StaleVersion} when `input.expectedVersion` is not the head.
   */
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, R>;
  /**
   * {@link update}, except a tombstone does not fail: the explicit restore
   * surface (`VERSION-CHAIN-006`) — the node comes back live. Fails
   * {@link NodeNotFound} for an unknown id and {@link StaleVersion} when
   * `input.expectedVersion` is not the head.
   */
  readonly restore: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, R>;
  /**
   * Append a `delete` version carrying the state forward. Idempotent: on a
   * tombstoned node it returns the existing tombstone with
   * `alreadyDeleted: true` and writes nothing, whatever the precondition
   * says (the delete it asked for has happened). Fails {@link NodeNotFound}
   * for an unknown id and {@link StaleVersion} when a live node's head is
   * not `precondition.expectedVersion`.
   */
  readonly delete: (
    id: string,
    actorId: Option.Option<string>,
    precondition?: Precondition,
  ) => Effect.Effect<
    ChainWrite & { readonly alreadyDeleted: boolean },
    E | NodeNotFound | StaleVersion | VersionConflict,
    R
  >;
  /** The reconstructed state at `(id, version)`. Read-only. */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<VersionSnapshot, E | VersionNotFound, R>;
  /**
   * The field-level change set from version `from` to version `to` of one
   * node: two {@link VersionChainOps.getVersion} reads and {@link diffStates}.
   * Read-only. Fails {@link VersionNotFound} for whichever version (`from`
   * first) cannot be fully reconstructed. A tombstone on either side is that
   * side's `action`, never an entry in `changes` (see
   * {@link VersionComparison}). Ungated, like `getVersion`: `./subtype` gates
   * history reads (`READ-009`), and a gated `compare` there is pulpit#82.
   */
  readonly compare: (
    id: string,
    from: bigint,
    to: bigint,
  ) => Effect.Effect<VersionComparison, E | VersionNotFound, R>;
  /**
   * Re-apply the full snapshot at `(id, version)` as a NEW `update` version —
   * over a tombstone too. Fails {@link VersionNotFound}, before writing
   * anything, when the version cannot be fully reconstructed, and
   * {@link StaleVersion} when the head is not
   * `precondition.expectedVersion` (the precondition is on the head the
   * restore extends, not on the version it restores).
   */
  readonly restoreVersion: (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
    precondition?: Precondition,
  ) => Effect.Effect<ChainWrite, E | VersionNotFound | StaleVersion | VersionConflict, R>;
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
 *
 * @since 0.1.0
 */
export const defineVersionChain = <E, R>(
  type: string,
  store: VersionChainStore<E, R>,
): VersionChainOps<E, R> => {
  /**
   * Append at `previous + 1`, after checking the precondition against that
   * same `previous`. The check and the append's version come from one read,
   * so a writer that lands in between takes `previous + 1` first and this
   * append fails the store's `(id, version)` key ({@link VersionConflict}):
   * success means the head was still `expectedVersion` when the row went in.
   */
  const appendNext = (
    id: string,
    previous: VersionChainEntry,
    action: VersionAction,
    state: ChainState,
    actorId: Option.Option<string>,
    precondition: Precondition,
  ): Effect.Effect<ChainWrite, E | StaleVersion | VersionConflict, R> =>
    Effect.gen(function* () {
      const expected = precondition.expectedVersion;
      if (expected !== undefined && expected !== previous.version) {
        return yield* new StaleVersion({ type, id, expected, current: previous.version });
      }
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
        input,
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
    precondition: Precondition = {},
  ) {
    const head = yield* current(id);
    if (Option.isNone(head)) return yield* new NodeNotFound({ type, id });
    if (head.value.action === "delete") {
      return { id, version: head.value.version, alreadyDeleted: true };
    }
    const written = yield* appendNext(
      id,
      head.value,
      "delete",
      head.value.state,
      actorId,
      precondition,
    );
    return { ...written, alreadyDeleted: false };
  });

  const getVersion = Effect.fn(`${type}.getVersion`)(function* (id: string, version: bigint) {
    const snapshot = yield* store.snapshot(id, version);
    if (Option.isNone(snapshot)) return yield* new VersionNotFound({ type, id, version });
    return snapshot.value;
  });

  const compare = Effect.fn(`${type}.compare`)(function* (id: string, from: bigint, to: bigint) {
    const before = yield* getVersion(id, from);
    const after = yield* getVersion(id, to);
    return { from: before, to: after, changes: diffStates(before.state, after.state) };
  });

  const restoreVersion = Effect.fn(`${type}.restoreVersion`)(function* (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
    precondition: Precondition = {},
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
    return yield* appendNext(id, head.value, "update", snapshot.value.state, actorId, precondition);
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

  return {
    create,
    update,
    restore,
    delete: softDelete,
    getVersion,
    compare,
    restoreVersion,
    history,
  };
};
