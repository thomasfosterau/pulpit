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
 *   The one exception is erasure (`./purge`), which deletes a node's whole
 *   chain, never part of one.
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
 * ## The port
 *
 * The chain is read and written through a {@link VersionChain} the
 * application supplies, one per leaf: the operations above, each holding
 * the invariants, plus a `head` read and the erasure's whole-chain `purge`
 * (pulpit#246). In production it is `@thomasfosterau/pulpit-drizzle-pg`
 * (pulpit#247) delegating to effect-drizzle-ext's `-pg/chain`, which owns
 * the discipline over the tables; in the kernel's tests it is
 * `./testing`'s `makeInMemoryVersionChain`, and `./testing`'s
 * `versionChainConformance` is the suite both must pass, so they cannot
 * drift. This module keeps what is the kernel's: the vocabulary, the tagged
 * errors, the tri-state patch and the field-level compare, and
 * {@link defineVersionChain}, which runs a leaf's before-append hooks
 * (`./subtype`'s lifecycle hooks) over the port. Authorisation is not this
 * module's concern either: the subtype factory (`./subtype`) gates before
 * it calls in.
 *
 * @copyright Thomas Foster
 * @module pulpit/version-chain
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { mintNodeId } from "./internal/node-id.ts";

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
 * A localised leaf's locale level at one version (pulpit#56, model (b)): each
 * locale the version carries, keyed by its tag (`"en"`, `"fr-CA"`), and that
 * locale's translated columns. The node's shared (untranslated) columns stay
 * in its {@link ChainState}; a translated column lives here only. A store
 * keeps it as the locale level's fact rows, keyed `(id, version, locale)`.
 * A version that carries no locale has none; an absent `locales` and `{}`
 * mean the same.
 *
 * @since 0.1.0
 */
export type LocaleStates = { readonly [locale: string]: ChainState };

/**
 * A tri-state patch over a {@link LocaleStates}, per locale: a
 * {@link ChainPatch} updates that locale's columns (starting from none for a
 * locale the version did not carry), `null` drops the locale, and an absent
 * or `undefined` key carries it forward unchanged.
 *
 * @since 0.1.0
 */
// oxlint-disable-next-line effect/prefer-option-over-null -- the tri-state rule, one level up: `null` drops a locale and `undefined` carries it forward, as a decoded update input says it
export type LocalePatch = { readonly [locale: string]: ChainPatch | null | undefined };

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
  /** The shared (untranslated) columns, or every column of a leaf with no locale level. */
  readonly state: ChainState;
  /**
   * A localised leaf's locale level at this version (pulpit#56); absent, the
   * version carries no locale. A store reconstructs it with the rest of the
   * snapshot, or reports the version absent.
   */
  readonly locales?: LocaleStates;
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
  /**
   * The contributor whose accepted proposal this version applies
   * (`./proposals`), recorded beside the actor, who is the account that
   * accepted it; none for every other write. A store persists it with the
   * version row (README → Seams → `VersionChain`).
   */
  readonly proposedBy: Option.Option<string>;
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
export class NodeNotFound extends Schema.TaggedError<
  NodeNotFound,
  { readonly brand: unique symbol }
>()("NodeNotFound", {
  type: Schema.String,
  id: Schema.String,
}) {}

/**
 * No reconstructable version at `(id, version)`: an unknown version, or a partial chain.
 *
 * @since 0.1.0
 */
export class VersionNotFound extends Schema.TaggedError<
  VersionNotFound,
  { readonly brand: unique symbol }
>()("VersionNotFound", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * A create whose caller-supplied id already belongs to a node — never an upsert: the wire's 409.
 *
 * @since 0.1.0
 */
export class NodeAlreadyExists extends Schema.TaggedError<
  NodeAlreadyExists,
  { readonly brand: unique symbol }
>()("NodeAlreadyExists", { type: Schema.String, id: Schema.String }) {}

/**
 * The store refused an append because `(id, version)` is already taken — a
 * concurrent writer got there first. Raised by the store (the `(id, version)`
 * primary key is what enforces append-only under concurrency); never retried
 * here, because a retry would silently base the write on a version the
 * caller never read.
 *
 * @since 0.1.0
 */
export class VersionConflict extends Schema.TaggedError<
  VersionConflict,
  { readonly brand: unique symbol }
>()("VersionConflict", {
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
export class StaleVersion extends Schema.TaggedError<
  StaleVersion,
  { readonly brand: unique symbol }
>()("StaleVersion", {
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
export class BrokenChain extends Schema.TaggedError<
  BrokenChain,
  { readonly brand: unique symbol }
>()("BrokenChain", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

// ── The port ──────────────────────────────────────────────────────────

/**
 * One leaf's version chain: the operation-level port the kernel writes and
 * reads every node of that leaf through (pulpit#246). `E` is the
 * implementation's own failure (a Drizzle store's query error); `R` its
 * requirements (a Drizzle store's `CurrentTransaction` — no operation opens
 * a transaction itself: the boundary belongs to the caller, website #1883).
 *
 * The operations and their error channels are effect-drizzle-ext `-pg/chain`'s
 * `LeafChain` (`create`, `update`, `restore`, `delete`, `restoreVersion`,
 * `getVersion`, `history`, `head`), in the kernel's own input types, plus
 * `purge`. **Every invariant in the module doc is the implementation's
 * contract**, checked by `./testing`'s `versionChainConformance`. Above all:
 * an `expectedVersion` is checked against the head the append extends, and
 * the append lands at that head + 1, so a writer that slips in between
 * takes the `(id, version)` key first and this one fails
 * {@link VersionConflict}; the key is what makes the check atomic. The
 * errors name the implementation's leaf in their `type`.
 *
 * @since 0.2.0
 */
export interface VersionChain<E, R> {
  /**
   * Insert the node and its version 0 (`create`), minting an id when the
   * input carries none. Fails {@link NodeAlreadyExists} on a taken id,
   * never an upsert.
   */
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<ChainWrite, E | NodeAlreadyExists | VersionConflict, R>;
  /**
   * Append an `update` version carrying the tri-state patch over the head's
   * state (and the locale patch over its locale level), recording
   * `actorId` and `proposedBy`. Fails {@link NodeNotFound} for an unknown
   * id and for a tombstoned node (`VERSION-CHAIN-006`), and
   * {@link StaleVersion} when `input.expectedVersion` is not the head.
   */
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, R>;
  /** {@link VersionChain.update}, except a tombstone does not fail: the explicit restore surface (`VERSION-CHAIN-006`). */
  readonly restore: (
    input: UpdateInput,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, R>;
  /**
   * Append a `delete` version carrying the head's state forward.
   * Idempotent: on a tombstone it returns the existing one with
   * `alreadyDeleted: true` and writes nothing, whatever the precondition
   * says. Fails {@link NodeNotFound} for an unknown id and
   * {@link StaleVersion} when a live node's head is not the expected one.
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
  /**
   * Re-apply the full snapshot at `(id, version)`, its locale level
   * included, as a new `update` version, over a tombstone too. Fails
   * {@link VersionNotFound}, before writing anything, when any level has no
   * row at that version (no partial restore), and {@link StaleVersion} when
   * the head (not the restored version) is not the expected one.
   */
  readonly restoreVersion: (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
    precondition?: Precondition,
  ) => Effect.Effect<ChainWrite, E | VersionNotFound | StaleVersion | VersionConflict, R>;
  /** The reconstructed state at `(id, version)`. Fails {@link VersionNotFound} when any level has no row there. */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<VersionSnapshot, E | VersionNotFound, R>;
  /**
   * The chain, oldest first, at most `limit` entries (default and cap
   * {@link MAX_HISTORY_LIMIT}, `PERF-DB-001`). Fails {@link NodeNotFound}
   * when the id has no versions of this leaf.
   */
  readonly history: (
    id: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<VersionChainEntry>, E | NodeNotFound, R>;
  /** The node's latest version entry, or none for an id with no versions of this leaf. */
  readonly head: (id: string) => Effect.Effect<Option.Option<VersionChainEntry>, E, R>;
  /**
   * Hard-delete the node's whole chain, every level and the identity row
   * (the Drizzle store: one identity delete that cascades). The erasure's
   * one write (`./purge`, pulpit#58), the documented exception to
   * `VERSION-CHAIN-001/002`; nothing else calls it, and it never deletes
   * part of a chain. A no-op for an id with no versions.
   */
  readonly purge: (id: string) => Effect.Effect<void, E, R>;
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
  ...R.filter(patch, (value): value is ColumnValue => value !== undefined),
});

/**
 * Apply a {@link LocalePatch} to a locale level: a patch updates its locale
 * (from nothing for a locale `locales` lacks) with {@link applyPatch}, `null`
 * drops the locale, `undefined` carries it forward. Pure and total.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { applyLocalePatch } from "@thomasfosterau/pulpit/version-chain";
 *
 * const before = { en: { title: "Hello" }, fr: { title: "Bonjour" } };
 * deepStrictEqual(applyLocalePatch(before, { en: { title: "Hi" }, fr: null, de: { title: "Hallo" } }), {
 *   en: { title: "Hi" },
 *   de: { title: "Hallo" },
 * });
 * ```
 *
 * @since 0.1.0
 */
export const applyLocalePatch = (locales: LocaleStates, patch: LocalePatch): LocaleStates =>
  R.reduce(patch, locales, (acc, change, locale) => {
    if (change === undefined) return acc;
    if (change === null) return R.remove(acc, locale);
    return {
      ...acc,
      [locale]: applyPatch(
        Option.getOrElse(R.get(acc, locale), () => ({})),
        change,
      ),
    };
  });

/**
 * The locale level a snapshot carries, `{}` for none.
 *
 * @since 0.1.0
 */
export const localesOf = (snapshot: Pick<VersionSnapshot, "locales">): LocaleStates =>
  snapshot.locales ?? {};

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
  return Eq.equals(before.value, after.value)
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
 * absent. Values compare structurally with `Eq.equals`: JSON objects and
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
  R.fromEntries(
    Arr.flatMap(Arr.dedupe([...R.keys(from), ...R.keys(to)]), (column) =>
      Arr.fromOption(
        Option.map(
          changeOf(R.get(from, column), R.get(to, column)),
          (change) => [column, change] as const,
        ),
      ),
    ),
  );

/**
 * How one locale differs between two versions' locale levels, read from the
 * first to the second: `added` (the second carries it, the first did not,
 * with its columns), `removed` (the reverse) or `changed` (both carry it, and
 * its columns differ: their {@link StateDiff}).
 *
 * @since 0.1.0
 */
export type LocaleChange =
  | { readonly _tag: "added"; readonly after: ChainState }
  | { readonly _tag: "removed"; readonly before: ChainState }
  | { readonly _tag: "changed"; readonly changes: StateDiff };

/**
 * The per-locale change set between two locale levels, keyed by locale: one
 * {@link LocaleChange} per locale that differs. An unchanged locale has no
 * key.
 *
 * @since 0.1.0
 */
export type LocaleDiff = { readonly [locale: string]: LocaleChange };

/** One locale's change, or none when both sides carry it with equal columns (or neither does). */
const localeChangeOf = (
  before: Option.Option<ChainState>,
  after: Option.Option<ChainState>,
): Option.Option<LocaleChange> => {
  if (Option.isNone(before)) {
    return Option.map(after, (state): LocaleChange => ({ _tag: "added", after: state }));
  }
  if (Option.isNone(after)) return Option.some({ _tag: "removed", before: before.value });
  const changes = diffStates(before.value, after.value);
  return R.isEmptyRecord(changes) ? Option.none() : Option.some({ _tag: "changed", changes });
};

/**
 * The per-locale change set from locale level `from` to locale level `to`
 * (pulpit#56): every locale added, removed, or whose columns changed by
 * {@link diffStates}; an unchanged locale is omitted. Pure and total.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { diffLocales } from "@thomasfosterau/pulpit/version-chain";
 *
 * deepStrictEqual(
 *   diffLocales({ en: { title: "Hello" }, fr: { title: "Bonjour" } }, { en: { title: "Hi" }, de: { title: "Hallo" } }),
 *   {
 *     en: { _tag: "changed", changes: { title: { _tag: "changed", before: "Hello", after: "Hi" } } },
 *     fr: { _tag: "removed", before: { title: "Bonjour" } },
 *     de: { _tag: "added", after: { title: "Hallo" } },
 *   },
 * );
 * ```
 *
 * @since 0.1.0
 */
export const diffLocales = (from: LocaleStates, to: LocaleStates): LocaleDiff =>
  R.fromEntries(
    Arr.flatMap(Arr.dedupe([...R.keys(from), ...R.keys(to)]), (locale) =>
      Arr.fromOption(
        Option.map(
          localeChangeOf(R.get(from, locale), R.get(to, locale)),
          (change) => [locale, change] as const,
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
  /** `diffStates(from.state, to.state)`: the shared columns. */
  readonly changes: StateDiff;
  /**
   * `diffLocales` over the two versions' locale levels (pulpit#56): the
   * per-locale changes, `{}` for a leaf with no locale level. Kept beside
   * `changes` rather than inside it, since a column may itself be named
   * `locales`.
   */
  readonly locales: LocaleDiff;
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
  /** The leaf's full state at version 0: its shared columns, on a localised leaf. */
  readonly state: ChainState;
  /** A localised leaf's locale level at version 0 (pulpit#56); absent, none. */
  readonly locales?: LocaleStates;
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
   * exactly this version; absent, the write extends whatever
   * the head is.
   */
  readonly expectedVersion?: bigint;
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
  /**
   * A localised leaf's per-locale patch ({@link LocalePatch}, pulpit#56):
   * absent, every locale carries forward. Even a write that touches one
   * locale appends one version of the whole node.
   */
  readonly locales?: LocalePatch;
  /** The acting account, recorded on the version row; none for a write with no session behind it. */
  readonly actorId: Option.Option<string>;
  /**
   * The contributor whose proposal this edit applies, recorded on the
   * version row as `proposedBy`; absent or none for an ordinary
   * edit. `./proposals`' `accept` sets it.
   */
  readonly proposedBy?: Option.Option<string>;
}

/**
 * The chain operations for one leaf type, as {@link defineVersionChain} binds
 * them over its {@link VersionChain}: the port's writes and reads, run
 * through the leaf's before-append hooks, plus the kernel's field-level
 * `compare`.
 *
 * @since 0.1.0
 */
export interface VersionChainOps<E, R> extends Omit<VersionChain<E, R>, "head" | "purge"> {
  /**
   * The field-level change set from version `from` to version `to` of one
   * node: two {@link VersionChainOps.getVersion} reads and {@link diffStates}.
   * Read-only. Fails {@link VersionNotFound} for whichever version (`from`
   * first) cannot be fully reconstructed. A tombstone on either side is that
   * side's `action`, never an entry in `changes` (see
   * {@link VersionComparison}). Ungated, like `getVersion`: `./subtype` gates
   * history reads (`READ-009`), and its `SubtypeOps.compare` is this behind
   * `getVersion`'s gate.
   */
  readonly compare: (
    id: string,
    from: bigint,
    to: bigint,
  ) => Effect.Effect<VersionComparison, E | VersionNotFound, R>;
}

// ── The before-append hook ────────────────────────────────────────────

/**
 * The write that is about to append: the chain's `action` vocabulary, with
 * the two explicit restore surfaces named apart (`VERSION-CHAIN-006`), so a
 * hook can tell a resurrection from an edit. `restore` and `restoreVersion`
 * still append an `update` row. `publish` and `unpublish` are `./subtype`'s
 * publication operations, which record a publication fact and append no
 * version; the chain itself never emits them.
 *
 * @since 0.1.0
 */
export const WriteAction = Schema.Literals([
  "create",
  "update",
  "delete",
  "restore",
  "restoreVersion",
  "publish",
  "unpublish",
]);
/**
 * The {@link WriteAction} literal union.
 *
 * @since 0.1.0
 */
export type WriteAction = typeof WriteAction.Type;

/**
 * What a {@link ChainHooks.beforeAppend} hook is shown: the write, the node,
 * the head it extends, and the patch it is about to apply.
 *
 * - `create` — `prior` is none, and `patch` is the whole initial state;
 * - `update` / `restore` — `prior` is the head, `patch` the caller's tri-state patch;
 * - `delete` — `prior` is the live head, `patch` is `{}` (the tombstone
 *   carries the head's state forward); an already tombstoned node writes
 *   nothing and runs no hook;
 * - `restoreVersion` — `prior` is the head, `patch` the whole state of the
 *   version being restored.
 *
 * The version written is the hook's patch applied to `prior`'s state (to
 * nothing for `create` and `restoreVersion`, whose patch is the whole state).
 *
 * On a localised leaf (pulpit#56) `locales` is the write's locale patch, in
 * the same reading: the whole locale level for `create` and
 * `restoreVersion`, the caller's {@link LocalePatch} for `update` /
 * `restore`, `{}` for `delete`. `beforeAppend`'s patch is the shared
 * columns' alone; `beforeAppendLocales` returns the locale patch the write
 * applies (see {@link ChainHooks}).
 *
 * @since 0.1.0
 */
export interface ChainAppendEvent {
  readonly action: WriteAction;
  readonly id: string;
  /** The head the append extends (its full state), or none for a create. */
  readonly prior: Option.Option<VersionSnapshot>;
  readonly patch: ChainPatch;
  /** The write's locale patch (see above); absent or `{}`, every locale carries forward. */
  readonly locales?: LocalePatch;
  /** The acting account the row will record. */
  readonly actorId: Option.Option<string>;
}

/**
 * The chain's hook point, bound once by {@link defineVersionChain}.
 *
 * @since 0.1.0
 */
export interface ChainHooks<E, R> {
  /**
   * Runs after the head is read and before the row is appended, in the
   * caller's transaction: its patch replaces the event's, and a failure
   * (its `E`) fails the write with nothing appended. It sees the very head
   * the append extends, so the expected-version check (pinned to it) still
   * runs against that head after it. Absent, nothing extra is read.
   */
  readonly beforeAppend?: (event: ChainAppendEvent) => Effect.Effect<ChainPatch, E, R>;
  /**
   * The locale level's counterpart of `beforeAppend` (pulpit#56): runs at the
   * same point, shown the same event, and its {@link LocalePatch} replaces
   * the event's `locales`, so a hook that validates or transforms a column
   * does so in every locale too. Absent, the event's locale patch is applied
   * as given.
   */
  readonly beforeAppendLocales?: (event: ChainAppendEvent) => Effect.Effect<LocalePatch, E, R>;
}

/**
 * A before-append hook returned a non-empty patch for a `delete`: a
 * tombstone carries the head's state forward and nothing else, so the hook
 * may refuse a delete but never change it. A defect (raised with
 * `Effect.die`), never a typed failure.
 */
class DeleteHookPatch extends Schema.TaggedError<
  DeleteHookPatch,
  { readonly brand: unique symbol }
>()("DeleteHookPatch", { type: Schema.String, id: Schema.String }) {}

/** Whether a patch changes nothing: every key is absent or `undefined`. */
const isEmptyPatch = (patch: ChainPatch): boolean =>
  R.isEmptyRecord(R.filter(patch, (value) => value !== undefined));

/** Whether a locale patch changes nothing: every locale is absent or `undefined`. */
const isEmptyLocalePatch = (patch: LocalePatch): boolean =>
  R.isEmptyRecord(R.filter(patch, (value) => value !== undefined));

/** Two patches set the same keys to the same values (`Eq.equals`, so a `Date` compares by instant). */
const samePatch = (left: ChainPatch, right: ChainPatch): boolean => {
  const keys = Arr.dedupe([...R.keys(left), ...R.keys(right)]);
  return keys.every((key) => Eq.equals(left[key], right[key]));
};

/** One locale's columns in a level, or none when the level lacks it. */
const localeIn = (level: LocaleStates, locale: string): Option.Option<ChainState> =>
  R.get(level, locale);

/** Two locale levels carry the same locales, each with the same columns. */
const sameLocales = (left: LocaleStates, right: LocaleStates): boolean =>
  Arr.dedupe([...R.keys(left), ...R.keys(right)]).every((locale) =>
    Option.getOrElse(
      Option.zipWith(localeIn(left, locale), localeIn(right, locale), samePatch),
      () => false,
    ),
  );

/**
 * Bind the chain operations for one leaf `type` over its
 * {@link VersionChain}. Every produced operation is traced as
 * `${type}.<operation>`.
 *
 * Without hooks, each write is the port's own. With `hooks.beforeAppend` /
 * `beforeAppendLocales` (see {@link ChainHooks}), each write reads the head
 * and its state, runs the hooks over the event, and appends the hooks'
 * patch through the port with `expectedVersion` pinned to the head it read
 * (the caller's own, when it gave one), so the version written is the
 * hooks' patch over exactly the head they were shown: a writer that lands
 * in between fails the write {@link StaleVersion} (or, losing the race at
 * the append, {@link VersionConflict}), both the wire's 409. Without a
 * caller precondition a lost race therefore surfaces as `StaleVersion`
 * where an unhooked write reports `VersionConflict`. A hook's failure is
 * each write's `E`, with nothing appended.
 *
 * - `restoreVersion` reads the restored version first (an unreconstructable
 *   one fails {@link VersionNotFound} before any hook runs); when the hooks
 *   return its state unchanged, the port's own `restoreVersion` writes it,
 *   and otherwise the hooks' state is appended through the port's `restore`
 *   with the restored locale level (a locale the head has and the version
 *   lacks is dropped).
 * - `delete` shows the hooks an empty patch; a tombstone carries the head's
 *   state forward and nothing else, so a hook may refuse a delete but not
 *   change it: a non-empty patch for a delete is a defect.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
 * import { makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";
 *
 * const notes = defineVersionChain("notes", makeInMemoryVersionChain("notes"), {
 *   beforeAppend: (event) => Effect.succeed({ ...event.patch, stamped: event.action }),
 * });
 * const actorId = Option.none<string>();
 * const program = Effect.gen(function* () {
 *   const { id } = yield* notes.create({ id: Option.none(), state: { title: "Hi" }, actorId });
 *   const written = yield* notes.getVersion(id, 0n);
 *   return written.state["stamped"];
 * });
 * strictEqual(Effect.runSync(program), "create");
 * ```
 *
 * @since 0.1.0
 */
export const defineVersionChain = <E, R>(
  type: string,
  chain: VersionChain<E, R>,
  hooks: ChainHooks<E, R> = {},
): VersionChainOps<E, R> => {
  const { beforeAppend, beforeAppendLocales } = hooks;
  const hooked = beforeAppend !== undefined || beforeAppendLocales !== undefined;

  /** The hooks' shared-column and locale patches for an event. */
  const patches = (event: ChainAppendEvent) =>
    Effect.all(
      {
        patch: beforeAppend === undefined ? Effect.succeed(event.patch) : beforeAppend(event),
        locales:
          beforeAppendLocales === undefined
            ? Effect.succeed(event.locales ?? {})
            : beforeAppendLocales(event),
      },
      { concurrency: 1 },
    );

  /** The head and its full state. A head without a state is a broken chain: a defect, not a miss. */
  const current = (id: string) =>
    Effect.gen(function* () {
      const head = yield* chain.head(id);
      if (Option.isNone(head)) return Option.none<VersionSnapshot>();
      const snapshot = yield* Effect.catchTag(
        chain.getVersion(id, head.value.version),
        "VersionNotFound",
        () => Effect.die(new BrokenChain({ type, id, version: head.value.version })),
      );
      return Option.some(snapshot);
    });

  /** The precondition a hooked write appends under: the caller's, else the head the hooks saw. */
  const pinned = (precondition: Precondition, head: VersionSnapshot): Precondition => ({
    expectedVersion: precondition.expectedVersion ?? head.version,
  });

  const create = Effect.fn(`${type}.create`)(function* (input: CreateInput) {
    if (!hooked) return yield* chain.create(input);
    const id = Option.isSome(input.id) ? input.id.value : yield* mintNodeId;
    const written = yield* patches({
      action: "create",
      id,
      prior: Option.none(),
      patch: input.state,
      locales: input.locales ?? {},
      actorId: input.actorId,
    });
    const locales = applyLocalePatch({}, written.locales);
    const next: CreateInput = {
      id: Option.some(id),
      state: applyPatch({}, written.patch),
      actorId: input.actorId,
    };
    return yield* chain.create(R.isEmptyRecord(locales) ? next : { ...next, locales });
  });

  const merge = (input: UpdateInput, allowDeleted: boolean) =>
    Effect.gen(function* () {
      if (!hooked) return yield* allowDeleted ? chain.restore(input) : chain.update(input);
      const head = yield* current(input.id);
      if (Option.isNone(head) || (head.value.action === "delete" && !allowDeleted)) {
        return yield* new NodeNotFound({ type, id: input.id });
      }
      const written = yield* patches({
        action: allowDeleted ? "restore" : "update",
        id: input.id,
        prior: head,
        patch: input.patch,
        locales: input.locales ?? {},
        actorId: input.actorId,
      });
      const next: UpdateInput = {
        ...input,
        patch: written.patch,
        locales: written.locales,
        ...pinned(input, head.value),
      };
      return yield* allowDeleted ? chain.restore(next) : chain.update(next);
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
    if (!hooked) return yield* chain.delete(id, actorId, precondition);
    const head = yield* current(id);
    if (Option.isNone(head)) return yield* new NodeNotFound({ type, id });
    // An already tombstoned node writes nothing and runs no hook.
    if (head.value.action === "delete") return yield* chain.delete(id, actorId, precondition);
    const written = yield* patches({ action: "delete", id, prior: head, patch: {}, actorId });
    if (!isEmptyPatch(written.patch) || !isEmptyLocalePatch(written.locales)) {
      return yield* Effect.die(new DeleteHookPatch({ type, id }));
    }
    return yield* chain.delete(id, actorId, pinned(precondition, head.value));
  });

  const restoreVersion = Effect.fn(`${type}.restoreVersion`)(function* (
    id: string,
    version: bigint,
    actorId: Option.Option<string>,
    precondition: Precondition = {},
  ) {
    if (!hooked) return yield* chain.restoreVersion(id, version, actorId, precondition);
    // Read the whole historical state FIRST, so an unreconstructable version
    // fails before any hook runs or the chain is touched.
    const restored = yield* chain.getVersion(id, version);
    const head = yield* current(id);
    if (Option.isNone(head)) return yield* new VersionNotFound({ type, id, version });
    const restoredLocales = localesOf(restored);
    const written = yield* patches({
      action: "restoreVersion",
      id,
      prior: head,
      patch: restored.state,
      locales: restoredLocales,
      actorId,
    });
    const expected = pinned(precondition, head.value);
    const hookedLocales = applyLocalePatch({}, written.locales);
    if (samePatch(written.patch, restored.state) && sameLocales(hookedLocales, restoredLocales)) {
      return yield* chain.restoreVersion(id, version, actorId, expected);
    }
    // The hooks changed what is restored: append their state over the head
    // through the explicit restore surface, with the restored locale level
    // replacing the head's (a locale only the head carries is dropped).
    const dropped = R.fromEntries(
      Arr.map(
        Arr.filter(R.keys(localesOf(head.value)), (locale) => !(locale in hookedLocales)),
        (locale) => [locale, null] as const,
      ),
    );
    return yield* chain
      .restore({
        id,
        patch: written.patch,
        locales: { ...dropped, ...hookedLocales },
        actorId,
        ...expected,
      })
      .pipe(
        // The head was read above, so a node gone since has no version to restore.
        Effect.catchTag("NodeNotFound", () =>
          Effect.fail(new VersionNotFound({ type, id, version })),
        ),
      );
  });

  const compare = Effect.fn(`${type}.compare`)(function* (id: string, from: bigint, to: bigint) {
    const before = yield* chain.getVersion(id, from);
    const after = yield* chain.getVersion(id, to);
    return {
      from: before,
      to: after,
      changes: diffStates(before.state, after.state),
      locales: diffLocales(localesOf(before), localesOf(after)),
    };
  });

  return {
    create,
    update,
    restore,
    delete: softDelete,
    getVersion: Effect.fn(`${type}.getVersion`)(function* (id: string, version: bigint) {
      return yield* chain.getVersion(id, version);
    }),
    compare,
    restoreVersion,
    history: Effect.fn(`${type}.history`)(function* (id: string, limit?: number) {
      return yield* chain.history(id, limit);
    }),
  };
};
