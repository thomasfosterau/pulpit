/**
 * **Suggested edits (proposals)** — a contributor's patch against a node
 * they can read, stamped with the version it was written against, which
 * the node's writer accepts (appending it) or rejects.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/proposals.ts`,
 * `proposal-patch.ts` and `proposal-conflict.ts` (#565), with their tests; a
 * `#NNN` here names a gardeneria issue.
 *
 * ## The model (owner decisions on pulpit#49)
 *
 * - **A proposal is a plain row, not a node.** It carries the target, the
 *   patch as submitted, the `baseVersion` it was written against (stamped
 *   from the target's head, never client-supplied), its status (`pending |
 *   accepted | rejected | withdrawn`), the reviewer and the timestamps.
 *   Rejecting or withdrawing changes its status; only accepting writes to
 *   the target.
 * - **Accepting appends through the target's own `update`** (`PUB-003`), as
 *   the account that accepted, so it runs the target's gate, its precondition
 *   and its before hooks, and lands as an ordinary `update` version
 *   (`VERSION-CHAIN-001/002`). The version records the proposer as its
 *   `proposedBy` fact beside that actor, so history shows both.
 *
 * ## Classification, in two tiers (#565, decision 2)
 *
 * - {@link classifyProposalBase} — `clean` or `moved`, from two version
 *   numbers in hand: no read, safe for every row of a list page.
 * - {@link classifyProposalConflict} — `clean`, `stale` or `conflicting`,
 *   from the target's states at the base version and at the head
 *   (`diffStates`): two version reads, so only {@link ProposalOps.review}
 *   and {@link ProposalOps.accept} run it (`PERF-DB-003`).
 *
 * A touched attribute either state lacks (one kept in a side table, outside
 * the chain) cannot be compared, so on a moved target it counts as
 * conflicting: fail closed, since `stale` would let an accept overwrite a
 * change nobody looked at.
 *
 * ## The gates
 *
 * - **Submit:** a signed-in account at the application's propose rung
 *   ({@link ProposalsDefinition.canPropose}) that can `get` the target; a
 *   target it can't read fails `NodeNotFound`, never `Forbidden`
 *   (`SEC-AUTH-ENUM-001`).
 * - **Accept / reject / review:** the target's write gate (`requireWriter`:
 *   owner-or-moderator on an owned leaf, the corpus-write rung on a reference
 *   one), before the proposal's status is disclosed. Accept and review then
 *   read the two versions through the target's gated `compare` (`READ-009`).
 * - **Withdraw:** the proposal's own author, while it is pending.
 * - **Reads:** the moderate rung reads every proposal; any other signed-in
 *   account reads its own and those on targets it owns; the anonymous read
 *   none. A proposal is never public.
 *
 * ## A localised leaf (pulpit#184)
 *
 * On a leaf with a locale level (pulpit#56) a proposal may also carry a
 * per-locale patch over the leaf's translated columns
 * ({@link ProposalsDefinition.localeAttributes}), stored beside its shared
 * patch and accepted through the same `update` as one version. Its conflict
 * check reads each touched locale at the base and at the head: a touched
 * translated column conflicts when it changed, when either version lacks it,
 * or when the locale was added or dropped in between. A proposal may add a
 * translation but never drop one (a `null` locale is refused): removing a
 * locale is the owner's.
 *
 * Rate limiting, notifications and the wire shape are the application's.
 *
 * @copyright Thomas Foster
 * @module pulpit/proposals
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { always, eq, never, or, type ListFilter } from "./filter.ts";
import { nowDate, plainRowQuery, signedIn as signedInAs } from "./internal/plain-rows.ts";
import {
  Forbidden,
  requireWriter,
  Unauthorized,
  type AccessPolicy,
  type Page,
  type SubtypeOps,
  type Viewer,
  type ViewerAccount,
  type WriteRejected,
} from "./subtype.ts";
import {
  diffStates,
  localesOf,
  NodeNotFound,
  type ChainPatch,
  type LocalePatch,
  type ChainWrite,
  type StaleVersion,
  type VersionChainStore,
  type VersionConflict,
  type VersionNotFound,
  type VersionSnapshot,
} from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * A proposal's status. `pending` is the only open one; the other three are
 * terminal, and a withdrawn proposal is recorded, not deleted.
 *
 * @since 0.1.0
 */
export const ProposalStatus = Schema.Literals(["pending", "accepted", "rejected", "withdrawn"]);
/**
 * The {@link ProposalStatus} literal union.
 *
 * @since 0.1.0
 */
export type ProposalStatus = typeof ProposalStatus.Type;

/**
 * The cheap verdict: `moved` means "stale or conflicting, not yet told
 * apart", never a claim that the patch still applies.
 *
 * @since 0.1.0
 */
export type ProposalBaseState = "clean" | "moved";

/**
 * The full verdict: `clean` (the target has not moved), `stale` (it moved,
 * but no touched attribute changed) or `conflicting`.
 *
 * @since 0.1.0
 */
export type ProposalConflictState = "clean" | "stale" | "conflicting";

/**
 * One proposal row, as the {@link ProposalStore} keeps it.
 *
 * @since 0.1.0
 */
export interface ProposalRow {
  readonly id: string;
  /** The target node and its leaf type. */
  readonly targetId: string;
  readonly targetType: string;
  /** The proposer. */
  readonly authorId: string;
  /** The patch as submitted (what the reviewer reads), decoded again at accept. */
  readonly patch: Schema.Json;
  /**
   * A localised leaf's per-locale patch as submitted (pulpit#184), decoded
   * again at accept; none for a proposal that touches no translation.
   */
  readonly locales: Option.Option<Schema.Json>;
  readonly rationale: Option.Option<string>;
  /** The target's head when the proposal was submitted. */
  readonly baseVersion: bigint;
  readonly status: ProposalStatus;
  readonly submittedAt: Date;
  /** When, and by whom, it left `pending` (the author, for a withdrawal). */
  readonly decidedAt: Option.Option<Date>;
  readonly decidedBy: Option.Option<string>;
  readonly decisionNote: Option.Option<string>;
  /** The version an accepted proposal produced: its provenance pointer. */
  readonly appliedVersion: Option.Option<bigint>;
}

/**
 * A proposal row as a read returns it, with the target's head version (none
 * when the target has no versions), read in the same query.
 *
 * @since 0.1.0
 */
export interface ProposalListing {
  readonly row: ProposalRow;
  readonly targetVersion: Option.Option<bigint>;
}

/**
 * The write that closes a pending proposal.
 *
 * @since 0.1.0
 */
export interface ProposalDecision {
  readonly status: Exclude<ProposalStatus, "pending">;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly decisionNote: Option.Option<string>;
  readonly appliedVersion: Option.Option<bigint>;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * No proposal at that id that the viewer may read: the wire's 404.
 *
 * @since 0.1.0
 */
export class ProposalNotFound extends Schema.TaggedError<ProposalNotFound>()("ProposalNotFound", {
  id: Schema.String,
}) {}

/**
 * The proposal is no longer pending, so it can't be decided or withdrawn
 * again: the wire's 409.
 *
 * @since 0.1.0
 */
export class ProposalClosed extends Schema.TaggedError<ProposalClosed>()("ProposalClosed", {
  id: Schema.String,
  status: ProposalStatus,
}) {}

/**
 * The target changed underneath a touched attribute since the proposal was
 * written (or one can't be compared), so accepting would overwrite an edit
 * the reviewer never saw: the wire's 409. Reject it and resubmit against
 * the new head.
 *
 * @since 0.1.0
 */
export class ProposalConflict extends Schema.TaggedError<ProposalConflict>()("ProposalConflict", {
  id: Schema.String,
  attributes: Schema.Array(Schema.String),
  /** The conflicting translated columns, by locale (pulpit#184); `{}` when none. */
  locales: Schema.Record(Schema.String, Schema.Array(Schema.String)),
}) {}

/**
 * A patch that can't be proposed: not an object, empty, touching a
 * forbidden or unknown attribute, or refused by the leaf's decoder. The
 * wire's 422.
 *
 * @since 0.1.0
 */
export class InvalidProposalPatch extends Schema.TaggedError<InvalidProposalPatch>()(
  "InvalidProposalPatch",
  { type: Schema.String, reason: Schema.String },
) {}

// ── Classification ────────────────────────────────────────────────────

/**
 * The cheap verdict, from the base version and the target's head: `clean`
 * only when they are equal.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { classifyProposalBase } from "@thomasfosterau/pulpit/proposals";
 *
 * strictEqual(classifyProposalBase(4n, 4n), "clean");
 * strictEqual(classifyProposalBase(4n, 5n), "moved");
 * ```
 *
 * @since 0.1.0
 */
export const classifyProposalBase = (
  baseVersion: bigint,
  currentVersion: bigint,
): ProposalBaseState => (baseVersion === currentVersion ? "clean" : "moved");

/**
 * The full verdict, and the attributes responsible for it.
 *
 * @since 0.1.0
 */
export interface ProposalConflictVerdict {
  readonly state: ProposalConflictState;
  /** The touched attributes that changed or can't be compared; empty unless `conflicting`. */
  readonly conflictingAttributes: ReadonlyArray<string>;
  /**
   * The touched translated columns that changed or can't be compared, by
   * locale (pulpit#184); a locale with none is omitted, so it is `{}` unless
   * `conflicting`.
   */
  readonly conflictingLocales: TouchedLocales;
}

/**
 * The translated columns a proposal touches, by locale (pulpit#184).
 *
 * @since 0.1.0
 */
export type TouchedLocales = { readonly [locale: string]: ReadonlyArray<string> };

/**
 * The full verdict from the target's states at the base version and at the
 * head, over the attributes the patch touches. Equal versions are `clean`
 * without comparing anything. Otherwise a touched attribute conflicts when
 * `diffStates` reports it changed (values compare structurally: a document
 * by content, `null` against a value is a change, two `null`s are not) or
 * when either state lacks it (fail closed).
 *
 * On a localised leaf, `touchedLocales` names the translated columns the
 * proposal touches, by locale (pulpit#184), and each is read from the two
 * versions' locale levels the same way. A locale neither version carries
 * cannot conflict (a new translation); a locale only one carries (added or
 * dropped in between) conflicts on every touched column. Pure.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { classifyProposalConflict } from "@thomasfosterau/pulpit/proposals";
 *
 * const at = (version: bigint, state: { readonly [column: string]: string }) => ({
 *   version,
 *   action: "update" as const,
 *   timestamp: new Date(0),
 *   state,
 * });
 * deepStrictEqual(
 *   classifyProposalConflict(at(4n, { name: "a", note: "x" }), at(5n, { name: "b", note: "x" }), [
 *     "name",
 *     "note",
 *   ]),
 *   { state: "conflicting", conflictingAttributes: ["name"], conflictingLocales: {} },
 * );
 * ```
 *
 * @since 0.1.0
 */
export const classifyProposalConflict = (
  base: VersionSnapshot,
  current: VersionSnapshot,
  touchedKeys: ReadonlyArray<string>,
  touchedLocales: TouchedLocales = {},
): ProposalConflictVerdict => {
  if (base.version === current.version) {
    return { state: "clean", conflictingAttributes: [], conflictingLocales: {} };
  }
  const conflictingAttributes = conflictsIn(base.state, current.state, touchedKeys);
  const before = localesOf(base);
  const after = localesOf(current);
  const conflictingLocales = Record.filter(
    Record.map(touchedLocales, (keys, locale) =>
      Option.match(Record.get(before, locale), {
        // A locale neither version carries is a new translation; one only the head carries was added since.
        onNone: () => (Record.has(after, locale) ? keys : []),
        onSome: (from) =>
          Option.match(Record.get(after, locale), {
            // Dropped since the base.
            onNone: () => keys,
            onSome: (to) => conflictsIn(from, to, keys),
          }),
      }),
    ),
    Arr.isReadonlyArrayNonEmpty,
  );
  return Arr.isReadonlyArrayNonEmpty(conflictingAttributes) ||
    !Record.isEmptyRecord(conflictingLocales)
    ? { state: "conflicting", conflictingAttributes, conflictingLocales }
    : { state: "stale", conflictingAttributes: [], conflictingLocales: {} };
};

/** The touched `keys` that changed from `from` to `to`, or that either lacks (fail closed). */
const conflictsIn = (
  from: VersionSnapshot["state"],
  to: VersionSnapshot["state"],
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const changes = diffStates(from, to);
  return Arr.filter(
    keys,
    (key) => !Record.has(from, key) || !Record.has(to, key) || Record.has(changes, key),
  );
};

// ── Patch validation ──────────────────────────────────────────────────

/**
 * The attributes no proposal may carry, whatever the leaf declares:
 * identity (`id`, `type`) and the publication axes (`visibility`, `draft`,
 * `publishedAt`), which are the owner's to set (`PUB-005`). An application
 * adds its own through {@link ProposalsDefinition.forbidden} (gardeneria
 * adds `slug`, a node's public URL).
 *
 * @since 0.1.0
 */
export const PROPOSAL_FORBIDDEN_KEYS: ReadonlyArray<string> = [
  "id",
  "type",
  "visibility",
  "draft",
  "publishedAt",
];

/**
 * A patch that passed validation.
 *
 * @since 0.1.0
 */
export interface ValidatedPatch {
  /** The decoded patch, ready for the target's `update`. */
  readonly patch: ChainPatch;
  /** The attribute names it touches, in the leaf's declaration order. */
  readonly touchedKeys: ReadonlyArray<string>;
  /** The decoded per-locale patch (pulpit#184), ready for the target's `update`; `{}` for none. */
  readonly locales: LocalePatch;
  /** The translated columns it touches, by locale, each in the declaration order. */
  readonly touchedLocales: TouchedLocales;
}

const quoted = (keys: ReadonlyArray<string>) => Arr.map(keys, (key) => `\`${key}\``).join(", ");

/**
 * Why `keys` is not an admissible key set, or none. Forbidden is checked
 * before unknown, so a `visibility` patch reads as a policy refusal, not a
 * typo, even on a leaf that doesn't declare the attribute.
 */
const keyViolation = (
  keys: ReadonlyArray<string>,
  attributes: ReadonlyArray<string>,
  forbidden: ReadonlyArray<string>,
): Option.Option<string> => {
  const refused = Arr.filter(keys, (key) => Arr.contains(forbidden, key));
  if (Arr.isReadonlyArrayNonEmpty(refused)) {
    return Option.some(
      `${quoted(refused)} can't be proposed: identity and publication are the owner's to set`,
    );
  }
  const unknown = Arr.filter(keys, (key) => !Arr.contains(attributes, key));
  return Arr.isReadonlyArrayNonEmpty(unknown)
    ? Option.some(`${quoted(unknown)} is not a proposable attribute`)
    : Option.none();
};

/** A JSON object's members, or none for an array, a scalar or `null`. */
const jsonMembers = (
  value: Schema.Json,
): Option.Option<ReadonlyArray<readonly [string, Schema.Json]>> =>
  value === null ||
  Predicate.isBoolean(value) ||
  Predicate.isNumber(value) ||
  Predicate.isString(value) ||
  Arr.isArray<Schema.Json>(value)
    ? Option.none()
    : Option.some(Record.toEntries(value));

/**
 * Check a submitted patch's shape and keys against the leaf's proposable
 * `attributes` (its update fields, in declaration order) and the
 * `forbidden` keys, then decode it with the leaf's own decoder. Unknown keys
 * are refused loudly rather than dropped (a misspelt attribute would
 * otherwise accept and change nothing). Run at submit and again at accept,
 * since the leaf's schema may have moved in between. Fails
 * {@link InvalidProposalPatch}.
 *
 * On a localised leaf, `options.locales` is the per-locale patch as
 * submitted (pulpit#184): an object from a non-empty locale tag to an object
 * of changes to `options.localeAttributes` (the translated columns), each
 * checked and decoded as the shared patch is. A `null` locale (dropping a
 * translation) is refused, as is any locale on a leaf with no
 * `localeAttributes`. The shared patch may then be `{}`, so long as some
 * locale changes something.
 *
 * @since 0.1.0
 */
export const validateProposalPatch = <R>(
  type: string,
  patch: Schema.Json,
  options: {
    readonly attributes: ReadonlyArray<string>;
    readonly forbidden: ReadonlyArray<string>;
    readonly decode: (patch: Schema.Json) => Effect.Effect<ChainPatch, InvalidProposalPatch, R>;
    /** The per-locale patch as submitted (pulpit#184); absent, none. */
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no translation"
    readonly locales?: Schema.Json | undefined;
    /** The translated columns a proposal may touch, in declaration order; absent, none. */
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no locale level"
    readonly localeAttributes?: ReadonlyArray<string> | undefined;
  },
): Effect.Effect<ValidatedPatch, InvalidProposalPatch, R> => {
  const invalid = (reason: string) => Effect.fail(new InvalidProposalPatch({ type, reason }));
  if (!Predicate.isObject(patch) || Arr.isArray(patch)) {
    return invalid("expected an object of attribute changes");
  }
  const localeMembers = jsonMembers(options.locales ?? {});
  if (Option.isNone(localeMembers)) return invalid("expected an object of changes per locale");
  const keys = Record.keys(patch);
  const locales = localeMembers.value;
  if (!Arr.isReadonlyArrayNonEmpty(keys) && !Arr.isReadonlyArrayNonEmpty(locales)) {
    return invalid("it proposes no changes");
  }
  const translated = options.localeAttributes ?? [];
  const localeProblem = Arr.findFirst(locales, ([locale, changes]) =>
    localeViolation(locale, changes, translated, options.forbidden),
  );
  if (Option.isSome(localeProblem)) return invalid(localeProblem.value);
  return Option.match(keyViolation(keys, options.attributes, options.forbidden), {
    onSome: invalid,
    onNone: () =>
      Effect.gen(function* () {
        const decoded = Arr.isReadonlyArrayNonEmpty(keys) ? yield* options.decode(patch) : {};
        const decodedLocales = yield* Effect.forEach(
          locales,
          ([locale, changes]) =>
            Effect.map(
              options.decode(changes),
              (decodedChanges) => [locale, decodedChanges] as const,
            ),
          { concurrency: 1 },
        );
        return {
          patch: decoded,
          touchedKeys: Arr.filter(options.attributes, (key) => Arr.contains(keys, key)),
          locales: Record.fromEntries(decodedLocales),
          touchedLocales: Record.fromEntries(
            Arr.map(locales, ([locale, changes]) => {
              const touched = Option.match(jsonMembers(changes), {
                onNone: () => [],
                onSome: Arr.map(([key]) => key),
              });
              return [locale, Arr.filter(translated, (key) => Arr.contains(touched, key))] as const;
            }),
          ),
        };
      }),
  });
};

/** Why one locale's entry of a per-locale patch is not admissible, or none. */
const localeViolation = (
  locale: string,
  changes: Schema.Json,
  translated: ReadonlyArray<string>,
  forbidden: ReadonlyArray<string>,
): Option.Option<string> => {
  if (!Arr.isReadonlyArrayNonEmpty(translated)) {
    return Option.some("this leaf takes no translated attributes");
  }
  if (locale === "") return Option.some("a locale tag is empty");
  if (changes === null) {
    return Option.some(`dropping the \`${locale}\` translation is the owner's to do`);
  }
  const members = jsonMembers(changes);
  if (Option.isNone(members)) {
    return Option.some(`expected an object of attribute changes for \`${locale}\``);
  }
  const keys = Arr.map(members.value, ([key]) => key);
  if (!Arr.isReadonlyArrayNonEmpty(keys)) {
    return Option.some(`it proposes no changes for \`${locale}\``);
  }
  return Option.map(
    keyViolation(keys, translated, forbidden),
    (reason) => `${reason} (in \`${locale}\`)`,
  );
};

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The proposal table an application supplies (gardeneria's
 * `participation.proposal`). It applies no policy, never opens a
 * transaction, and fails only with its `E`. See the package README → Seams
 * for the expected schema.
 *
 * @since 0.1.0
 */
export interface ProposalStore<E, R> {
  /** Mint a fresh proposal id (a UUID). */
  readonly mintId: Effect.Effect<string, E, R>;
  /** Insert a new (pending) row. */
  readonly insert: (row: ProposalRow) => Effect.Effect<void, E, R>;
  /** One row with its target's head version, or none. */
  readonly get: (id: string) => Effect.Effect<Option.Option<ProposalListing>, E, R>;
  /**
   * One row, locked for the rest of the transaction (`SELECT … FOR
   * UPDATE`), so two decisions on one proposal serialise and the second
   * sees it closed.
   */
  readonly lock: (id: string) => Effect.Effect<Option.Option<ProposalRow>, E, R>;
  /** Close a pending row: write its terminal status, decider and provenance. */
  readonly close: (id: string, decision: ProposalDecision) => Effect.Effect<void, E, R>;
  /**
   * The page under `where`, newest first (`submitted_at DESC, id DESC`,
   * a total order), with the unpaged total. `where` reads the columns
   * `authorId`, `targetId`, `targetType`, `status` and `targetOwnerId`
   * (the target's owner, `core.node_owner`, or `NULL`).
   */
  readonly list: (query: {
    readonly where: ListFilter<never>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<ProposalListing>, E, R>;
}

// ── The operations ────────────────────────────────────────────────────

/**
 * One leaf's proposal surface: its target operations, the stores, and the
 * patch rules.
 *
 * @since 0.1.0
 */
export interface ProposalsDefinition<Resource, E, R> {
  /** The target leaf's wire type: the proposals' `targetType`. */
  readonly type: string;
  /** The target leaf's operations: `get` gates a submission, `compare` and `update` an acceptance. */
  readonly target: SubtypeOps<Resource, E, R>;
  /** The target leaf's chain store, for the head a proposal is stamped with. */
  readonly chain: VersionChainStore<E, R>;
  /** The target's owner (its `LeafStore.ownerOf`), for the write gate and the reads. */
  readonly ownerOf: (id: string) => Effect.Effect<Option.Option<string>, E, R>;
  readonly proposals: ProposalStore<E, R>;
  /** The request's viewer. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
  /** The rung that may propose (gardeneria: any signed-in account; website: contributor+). */
  readonly canPropose: (account: ViewerAccount) => boolean;
  /** The attributes a proposal may touch: the leaf's update fields, in declaration order. */
  readonly attributes: ReadonlyArray<string>;
  /** The keys no proposal may carry; {@link PROPOSAL_FORBIDDEN_KEYS} when omitted. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the kernel's default list
  readonly forbidden?: ReadonlyArray<string> | undefined;
  /** The leaf's update decoder over a patch's values (`SEC-INPUT-001`), shared or one locale's. */
  readonly decode: (patch: Schema.Json) => Effect.Effect<ChainPatch, InvalidProposalPatch, R>;
  /**
   * The translated columns a proposal may touch on a localised leaf
   * (pulpit#184), in declaration order: the leaf's locale level's columns,
   * or fewer. Omitted, a proposal carries no per-locale patch.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no translation is proposable"
  readonly localeAttributes?: ReadonlyArray<string> | undefined;
}

/**
 * A proposal as a read returns it: the row, and the cheap verdict while it
 * is pending.
 *
 * @since 0.1.0
 */
export interface ProposalView {
  readonly proposal: ProposalRow;
  readonly baseState: Option.Option<ProposalBaseState>;
}

/**
 * A pending proposal as the review screen reads it: the full verdict too.
 *
 * @since 0.1.0
 */
export interface ProposalReview extends ProposalView {
  readonly conflict: ProposalConflictVerdict;
}

type WriteGate = Unauthorized | Forbidden | NodeNotFound;

/**
 * The operations {@link defineProposals} produces.
 *
 * @since 0.1.0
 */
export interface ProposalOps<E, R> {
  /**
   * Submit a pending proposal against `targetId`, stamped with its head.
   * Fails `Unauthorized` when anonymous, `Forbidden` below the propose rung,
   * `NodeNotFound` when the viewer can't `get` the target, and
   * {@link InvalidProposalPatch}.
   */
  readonly submit: (input: {
    readonly targetId: string;
    readonly patch: Schema.Json;
    /** A localised leaf's per-locale patch (pulpit#184); absent, none. */
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no translation"
    readonly locales?: Schema.Json | undefined;
    readonly rationale: Option.Option<string>;
  }) => Effect.Effect<
    { readonly id: string },
    Unauthorized | Forbidden | NodeNotFound | InvalidProposalPatch | E,
    R
  >;
  /**
   * One proposal the viewer may read (the moderate rung, its author, or the
   * target's owner), with its cheap verdict while pending. Fails
   * {@link ProposalNotFound} for a missing or unreadable one.
   */
  readonly get: (id: string) => Effect.Effect<ProposalView, ProposalNotFound | E, R>;
  /** One page of the proposals the viewer may read, newest first, optionally narrowed. */
  readonly list: (request: {
    readonly targetId: Option.Option<string>;
    readonly status: Option.Option<ProposalStatus>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<ProposalView>, E, R>;
  /**
   * A pending proposal with the full verdict, behind the target's write
   * gate and its gated `compare`. Fails `ProposalNotFound`, the gate's
   * failures, `ProposalClosed`, `VersionNotFound`, or
   * `InvalidProposalPatch` when the stored patch no longer validates.
   */
  readonly review: (
    id: string,
  ) => Effect.Effect<
    ProposalReview,
    ProposalNotFound | WriteGate | ProposalClosed | VersionNotFound | InvalidProposalPatch | E,
    R
  >;
  /**
   * Accept a pending proposal: re-validate its patch, classify it against
   * the head (failing {@link ProposalConflict} when conflicting), append it
   * through the target's `update` with the head as its expected version and
   * the author as `proposedBy`, and close it with the version it produced.
   * Fails as `review` does, and as the target's `update` does
   * (`StaleVersion` when the head moved after the classification;
   * `WriteRejected` when one of its before hooks refuses the write).
   */
  readonly accept: (
    id: string,
    options?: { readonly note: Option.Option<string> },
  ) => Effect.Effect<
    ChainWrite,
    | ProposalNotFound
    | WriteGate
    | ProposalClosed
    | ProposalConflict
    | VersionNotFound
    | InvalidProposalPatch
    | StaleVersion
    | VersionConflict
    | WriteRejected
    | E,
    R
  >;
  /**
   * Reject a pending proposal, writing nothing to the target, behind its
   * write gate (a proposal whose target was deleted can still be rejected).
   * Fails `ProposalNotFound`, the gate's failures, `ProposalClosed`.
   */
  readonly reject: (
    id: string,
    options?: { readonly note: Option.Option<string> },
  ) => Effect.Effect<void, ProposalNotFound | WriteGate | ProposalClosed | E, R>;
  /**
   * Withdraw the caller's own pending proposal. Fails `Unauthorized` when
   * anonymous, `ProposalNotFound`, `Forbidden` for someone else's, and
   * `ProposalClosed`.
   */
  readonly withdraw: (
    id: string,
  ) => Effect.Effect<void, Unauthorized | ProposalNotFound | Forbidden | ProposalClosed | E, R>;
}

/** A decision's options: the reviewer's note. */
interface DecisionOptions {
  readonly note: Option.Option<string>;
}

const noNote: DecisionOptions = { note: Option.none() };

/** The cheap verdict, while pending and the target has a head. */
const viewOf = ({ row, targetVersion }: ProposalListing): ProposalView => ({
  proposal: row,
  baseState:
    row.status === "pending"
      ? Option.map(targetVersion, (head) => classifyProposalBase(row.baseVersion, head))
      : Option.none(),
});

/**
 * Bind one leaf's proposal operations. Every operation is traced as
 * `${type}.proposals.<operation>`, and the writes run in the caller's
 * transaction: an accept's append and its close commit or roll back
 * together. An accept runs the target's `update`, so its before hooks, but
 * not `subtypeHandlers`' write-through: an application that caches the
 * target writes the accepted version through itself.
 *
 * @since 0.1.0
 */
export const defineProposals = <Resource, E, R>(
  definition: ProposalsDefinition<Resource, E, R>,
): ProposalOps<E, R> => {
  const { type, target, proposals, policy } = definition;
  const forbidden = definition.forbidden ?? PROPOSAL_FORBIDDEN_KEYS;
  const validate = (patch: Schema.Json, locales: Option.Option<Schema.Json>) =>
    validateProposalPatch(type, patch, {
      attributes: definition.attributes,
      forbidden,
      decode: definition.decode,
      locales: Option.getOrUndefined(locales),
      localeAttributes: definition.localeAttributes,
    });

  const signedIn = signedInAs(definition.viewer);

  /** The target's write gate: before any proposal state is disclosed to the caller. */
  const writerOf = (targetId: string) =>
    Effect.flatMap(definition.viewer, (viewer) =>
      requireWriter(
        target.access,
        viewer,
        policy,
        { type, id: targetId },
        definition.ownerOf(targetId),
      ),
    );

  /** The locked row, the target's write gate passed, still pending. */
  const pendingForDecision = (id: string) =>
    Effect.gen(function* () {
      const row = yield* proposals.lock(id);
      if (Option.isNone(row) || row.value.targetType !== type) {
        return yield* new ProposalNotFound({ id });
      }
      const account = yield* writerOf(row.value.targetId);
      if (row.value.status !== "pending") {
        return yield* new ProposalClosed({ id, status: row.value.status });
      }
      return { row: row.value, account };
    });

  /** The target's head entry, or `NodeNotFound`. */
  const headOf = (targetId: string) =>
    Effect.flatMap(definition.chain.head(targetId), (head) =>
      Option.match(head, {
        onNone: () => Effect.fail(new NodeNotFound({ type, id: targetId })),
        onSome: Effect.succeed,
      }),
    );

  /** Re-validate the stored patch and classify it, through the target's gated `compare`. */
  const classify = (row: ProposalRow, head: bigint) =>
    Effect.gen(function* () {
      const validated = yield* validate(row.patch, row.locales);
      const comparison = yield* target.compare(row.targetId, row.baseVersion, head);
      return {
        validated,
        conflict: classifyProposalConflict(
          comparison.from,
          comparison.to,
          validated.touchedKeys,
          validated.touchedLocales,
        ),
      };
    });

  const close = (
    id: string,
    status: ProposalDecision["status"],
    decidedBy: string,
    note: Option.Option<string>,
    appliedVersion: Option.Option<bigint> = Option.none(),
  ) =>
    Effect.flatMap(nowDate, (decidedAt) =>
      proposals.close(id, { status, decidedAt, decidedBy, decisionNote: note, appliedVersion }),
    );

  const submit = Effect.fn(`${type}.proposals.submit`)(function* (input: {
    readonly targetId: string;
    readonly patch: Schema.Json;
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no translation"
    readonly locales?: Schema.Json | undefined;
    readonly rationale: Option.Option<string>;
  }) {
    const account = yield* signedIn;
    if (!definition.canPropose(account)) return yield* new Forbidden();
    // A target the proposer can't read is missing to them (SEC-AUTH-ENUM-001).
    yield* target.get(input.targetId);
    const locales = Option.fromUndefinedOr(input.locales);
    yield* validate(input.patch, locales);
    const head = yield* headOf(input.targetId);
    const id = yield* proposals.mintId;
    yield* proposals.insert({
      id,
      targetId: input.targetId,
      targetType: type,
      authorId: account.id,
      patch: input.patch,
      locales,
      rationale: input.rationale,
      baseVersion: head.version,
      status: "pending",
      submittedAt: yield* nowDate,
      decidedAt: Option.none(),
      decidedBy: Option.none(),
      decisionNote: Option.none(),
      appliedVersion: Option.none(),
    });
    return { id };
  });

  /** Whether the viewer may read `row`: the moderate rung, its author, or the target's owner. */
  const readable = (viewer: Viewer, row: ProposalRow) =>
    Option.match(viewer, {
      onNone: () => Effect.succeed(false),
      onSome: (account) =>
        policy.canModerate(account) || account.id === row.authorId
          ? Effect.succeed(true)
          : Effect.map(definition.ownerOf(row.targetId), (owner) =>
              Option.contains(owner, account.id),
            ),
    });

  const get = Effect.fn(`${type}.proposals.get`)(function* (id: string) {
    const viewer = yield* definition.viewer;
    const listing = yield* proposals.get(id);
    if (
      Option.isNone(listing) ||
      listing.value.row.targetType !== type ||
      !(yield* readable(viewer, listing.value.row))
    ) {
      return yield* new ProposalNotFound({ id });
    }
    return viewOf(listing.value);
  });

  /** The read scope as a list filter: the same three facts as `readable`. */
  const readFilter = (viewer: Viewer): ListFilter<never> =>
    Option.match(viewer, {
      onNone: (): ListFilter<never> => never,
      onSome: (account) =>
        policy.canModerate(account)
          ? always
          : or<never>(eq("authorId", account.id), eq("targetOwnerId", account.id)),
    });

  const list = Effect.fn(`${type}.proposals.list`)(function* (request: {
    readonly targetId: Option.Option<string>;
    readonly status: Option.Option<ProposalStatus>;
    readonly limit: number;
    readonly offset: number;
  }) {
    const viewer = yield* definition.viewer;
    const page = yield* proposals.list(plainRowQuery(type, readFilter(viewer), request));
    return { rows: Arr.map(page.rows, viewOf), total: page.total };
  });

  const review = Effect.fn(`${type}.proposals.review`)(function* (id: string) {
    const listing = yield* proposals.get(id);
    if (Option.isNone(listing) || listing.value.row.targetType !== type) {
      return yield* new ProposalNotFound({ id });
    }
    const { row } = listing.value;
    yield* writerOf(row.targetId);
    if (row.status !== "pending") return yield* new ProposalClosed({ id, status: row.status });
    const head = yield* headOf(row.targetId);
    const { conflict } = yield* classify(row, head.version);
    return {
      proposal: row,
      baseState: Option.some(classifyProposalBase(row.baseVersion, head.version)),
      conflict,
    };
  });

  const accept = Effect.fn(`${type}.proposals.accept`)(function* (
    id: string,
    options: DecisionOptions = noNote,
  ) {
    const { row, account } = yield* pendingForDecision(id);
    const head = yield* headOf(row.targetId);
    const { validated, conflict } = yield* classify(row, head.version);
    if (conflict.state === "conflicting") {
      return yield* new ProposalConflict({
        id,
        attributes: conflict.conflictingAttributes,
        locales: conflict.conflictingLocales,
      });
    }
    // Through the target's own update (PUB-003), expecting the head it was
    // classified against: an edit landing in between fails StaleVersion.
    const written = yield* target.update({
      id: row.targetId,
      patch: validated.patch,
      locales: validated.locales,
      expectedVersion: head.version,
      proposedBy: Option.some(row.authorId),
    });
    yield* close(id, "accepted", account.id, options.note, Option.some(written.version));
    return written;
  });

  const reject = Effect.fn(`${type}.proposals.reject`)(function* (
    id: string,
    options: DecisionOptions = noNote,
  ) {
    const { account } = yield* pendingForDecision(id);
    yield* close(id, "rejected", account.id, options.note);
  });

  const withdraw = Effect.fn(`${type}.proposals.withdraw`)(function* (id: string) {
    const account = yield* signedIn;
    const row = yield* proposals.lock(id);
    if (Option.isNone(row) || row.value.targetType !== type) {
      return yield* new ProposalNotFound({ id });
    }
    if (row.value.authorId !== account.id) return yield* new Forbidden();
    if (row.value.status !== "pending") {
      return yield* new ProposalClosed({ id, status: row.value.status });
    }
    yield* close(id, "withdrawn", account.id, Option.none());
  });

  return { submit, get, list, review, accept, reject, withdraw };
};
