/**
 * **The moderation workflow** — the rules that move a leaf's row between
 * moderation states, the threshold grading of a classifier's scores, the
 * review-queue filter, and member reports.
 *
 * The behavioural spec is gardeneria's comment moderation
 * (`apps/api/src/operations/comments.ts`' `moderateCommentE`), its moderation
 * plane (`apps/api/src/operations/moderation.ts`) and its threshold grader
 * (`packages/jobs/src/moderation/thresholds.ts`), with their tests; a
 * `#NNN` here names a gardeneria issue.
 *
 * ## The model (owner decisions on pulpit#51)
 *
 * The kernel owns the rules; the transport (a queue, the classifier run, the
 * API-call ledger, moderator notifications) stays the application's.
 *
 * - **The state lives on the version row**, in the leaf's
 *   `moderationState` column ({@link ModerationState}): a decision is an
 *   appended version, so history shows who decided what, and when.
 * - **Transitions.** Every new row starts `pending`. Only the moderate rung
 *   changes the state: `pending → approved | rejected`, re-moderation
 *   between `approved` and `rejected`, and re-review back to `pending`
 *   ({@link isModerationTransition}). A write by anyone else that changes the
 *   state fails `WriteRejected`.
 * - **Re-review triggers are the leaf's**: an edit that changes one of its
 *   declared `reReviewOn` attributes sends an `approved` row back to
 *   `pending` ({@link ModerationDeclaration}).
 * - **Owners withdraw their own content** by deleting it: the owned write
 *   gate admits its owner in every moderation state, and a tombstone needs
 *   no decision.
 *
 * {@link moderationHook} enforces the rules as a before hook (`./subtype`'s
 * lifecycle seam), so every write path honours them, and
 * {@link defineModeration}'s `moderate` is the decision itself.
 *
 * ## Grading and the queue
 *
 * {@link gradeScores} turns a classifier's per-category scores (shaped like
 * effect-ai-ext's `ModerationModel` output; pulpit doesn't import it) into a
 * verdict against the application's thresholds. Classification itself runs
 * from an application's after hook. The review queue is the leaf's pending
 * rows ({@link reviewQueueFilter}) plus the open member reports
 * ({@link defineReports}), both the moderate rung's alone.
 *
 * @copyright Thomas Foster
 * @module pulpit/moderation
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { always, eq, never, type ListFilter } from "./filter.ts";
import { nowDate, plainRowQuery, signedIn as signedInAs } from "./internal/plain-rows.ts";
import { ModerationState } from "./publication.ts";
import {
  Forbidden,
  Unauthorized,
  WriteRejected,
  type AccessPolicy,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type Page,
  type SubtypeOps,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";
import type {
  ChainPatch,
  ChainWrite,
  ColumnValue,
  NodeNotFound,
  Precondition,
  StaleVersion,
  VersionConflict,
} from "./version-chain.ts";

// ── Transitions ───────────────────────────────────────────────────────

/**
 * Whether a row may move from `from` (none for a row being created) to
 * `to`: a new row only to `pending`; an existing one to any other state
 * (decision, re-moderation, re-review). Staying put is no transition.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Option from "effect/Option";
 * import { isModerationTransition } from "@thomasfosterau/pulpit/moderation";
 *
 * strictEqual(isModerationTransition(Option.none(), "pending"), true);
 * strictEqual(isModerationTransition(Option.none(), "approved"), false);
 * strictEqual(isModerationTransition(Option.some("pending"), "approved"), true);
 * strictEqual(isModerationTransition(Option.some("approved"), "approved"), false);
 * ```
 *
 * @since 0.1.0
 */
export const isModerationTransition = (
  from: Option.Option<ModerationState>,
  to: ModerationState,
): boolean =>
  Option.match(from, { onNone: () => to === "pending", onSome: (state) => state !== to });

/**
 * A leaf's moderation columns and its re-review triggers.
 *
 * @since 0.1.0
 */
export interface ModerationDeclaration {
  /** The state column ({@link ModerationState}); conventionally `moderationState`. */
  readonly column: string;
  /** The column a decision stamps with its instant, when the leaf has one. */
  readonly moderatedAtColumn: Option.Option<string>;
  /** The column a decision stamps with the deciding account's id, when the leaf has one. */
  readonly moderatedByColumn: Option.Option<string>;
  /**
   * The attributes whose change sends an `approved` row back to `pending`
   * (a comment's `body`, an image's file). Empty, an approval survives
   * every edit.
   */
  readonly reReviewOn: ReadonlyArray<string>;
}

/**
 * The declaration with the conventional column names.
 *
 * @since 0.1.0
 */
export const moderatedColumns = (reReviewOn: ReadonlyArray<string>): ModerationDeclaration => ({
  column: "moderationState",
  moderatedAtColumn: Option.some("moderatedAt"),
  moderatedByColumn: Option.some("moderatedBy"),
  reReviewOn,
});

const isModerationState = Schema.is(ModerationState);

/** A column's value in a state or patch, absent (or `undefined`) as none. */
const valueOf = (values: ChainPatch, column: string): Option.Option<ColumnValue> =>
  Option.fromUndefinedOr(values[column]);

/** The prior state's moderation state, or none (a create, or a value outside the vocabulary). */
const priorState = (event: BeforeWriteEvent, column: string): Option.Option<ModerationState> =>
  Option.flatMap(event.prior, (prior) =>
    Option.filter(valueOf(prior.state, column), isModerationState),
  );

/** The decision stamps for a patch, by the leaf's declared columns. */
const stamps = (
  declaration: ModerationDeclaration,
  account: ViewerAccount,
  now: Date,
): ChainPatch => ({
  ...Option.match(declaration.moderatedAtColumn, {
    onNone: () => ({}),
    onSome: (column) => Record.singleton(column, now),
  }),
  ...Option.match(declaration.moderatedByColumn, {
    onNone: () => ({}),
    onSome: (column) => Record.singleton(column, account.id),
  }),
});

/** The prior row's moderation columns, carried over a restored version's. */
const carried = (event: BeforeWriteEvent, declaration: ModerationDeclaration): ChainPatch =>
  Option.match(event.prior, {
    onNone: () => ({}),
    onSome: (prior) =>
      Record.fromEntries(
        Arr.map(
          [
            declaration.column,
            ...Option.toArray(declaration.moderatedAtColumn),
            ...Option.toArray(declaration.moderatedByColumn),
          ],
          (column) => [column, prior.state[column] ?? null] as const,
        ),
      ),
  });

/** Whether the patch changes a re-review attribute from its prior value. */
const touchesReview = (event: BeforeWriteEvent, declaration: ModerationDeclaration): boolean =>
  Arr.some(declaration.reReviewOn, (column) =>
    Option.match(valueOf(event.patch, column), {
      onNone: () => false,
      onSome: (next) =>
        !Option.exists(event.prior, (prior) =>
          Option.exists(valueOf(prior.state, column), (before) => Equal.equals(before, next)),
        ),
    }),
  );

/**
 * The moderation rules applied to one write: the patch the write should
 * apply, or the reason it is refused. Pure, so every case is testable
 * without a chain.
 *
 * - A **create** stores `pending`; a patch asking for another state is refused.
 * - A **delete** is untouched (withdrawal needs no decision).
 * - A **`restoreVersion`** by anyone but the moderate rung carries the
 *   prior row's moderation columns over the restored version's, so an old
 *   approval never comes back with old content.
 * - A patch that **changes the state** is a decision: refused below the
 *   moderate rung or outside {@link isModerationTransition}, and otherwise
 *   stamped (`moderatedAtColumn`, `moderatedByColumn`). A patch that sets
 *   the state it already has changes nothing.
 * - Otherwise, an edit that changes a `reReviewOn` attribute of an
 *   `approved` row sends it back to `pending`.
 *
 * @since 0.1.0
 */
export const moderatePatch = (
  event: BeforeWriteEvent,
  declaration: ModerationDeclaration,
  policy: AccessPolicy,
  now: Date,
): Result.Result<ChainPatch, string> => {
  const moderator = Option.filter(event.viewer, policy.canModerate);
  if (event.action === "delete") return Result.succeed(event.patch);
  if (event.action === "create") return created(event.patch, declaration.column);
  const patch =
    event.action === "restoreVersion" && Option.isNone(moderator)
      ? { ...event.patch, ...carried(event, declaration) }
      : event.patch;
  const from = priorState(event, declaration.column);
  const asked = Option.filter(
    valueOf(patch, declaration.column),
    (value) => !Option.exists(from, (state) => state === value),
  );
  return Option.isSome(asked)
    ? decided({ event, patch, from, asked: asked.value, moderator, declaration, now })
    : Result.succeed(reReviewed({ ...event, patch }, from, declaration));
};

/** A create's patch: `pending`, whatever it asked for, unless it asked for another state. */
const created = (patch: ChainPatch, column: string): Result.Result<ChainPatch, string> =>
  Option.exists(valueOf(patch, column), (asked) => asked !== "pending")
    ? Result.fail(`a new row starts pending; ${column} is the moderate rung's to change`)
    : Result.succeed({ ...patch, [column]: "pending" });

/** A patch that changes the state: the rung's decision, stamped (a restored version unstamped). */
const decided = (decision: {
  readonly event: BeforeWriteEvent;
  readonly patch: ChainPatch;
  readonly from: Option.Option<ModerationState>;
  readonly asked: ColumnValue;
  readonly moderator: Option.Option<ViewerAccount>;
  readonly declaration: ModerationDeclaration;
  readonly now: Date;
}): Result.Result<ChainPatch, string> => {
  const { patch, asked, moderator, declaration } = decision;
  const { column } = declaration;
  if (Option.isNone(moderator)) return Result.fail(`${column} is the moderate rung's to change`);
  if (!isModerationState(asked) || !isModerationTransition(decision.from, asked)) {
    return Result.fail(`${column} can't move to ${String(asked)}`);
  }
  return Result.succeed(
    decision.event.action === "restoreVersion"
      ? patch
      : { ...patch, ...stamps(declaration, moderator.value, decision.now) },
  );
};

/** An edit that leaves the state alone: back to `pending` when it touches a re-review attribute of an approved row. */
const reReviewed = (
  event: BeforeWriteEvent,
  from: Option.Option<ModerationState>,
  declaration: ModerationDeclaration,
): ChainPatch =>
  Option.exists(from, (state) => state === "approved") && touchesReview(event, declaration)
    ? { ...event.patch, [declaration.column]: "pending" }
    : event.patch;

/**
 * The moderation rules ({@link moderatePatch}) as a before hook for the
 * leaf's `LifecycleHooks`: every write applies them, and a refusal
 * fails the write with `WriteRejected`, appending nothing. Compose it first,
 * so later hooks see the state it settled.
 *
 * @since 0.1.0
 */
export const moderationHook = <E = never, R = never>(
  declaration: ModerationDeclaration,
  policy: AccessPolicy,
): BeforeWriteHook<E, R> => ({
  name: "moderation",
  run: (event) =>
    Effect.flatMap(nowDate, (now) => {
      return Result.match(moderatePatch(event, declaration, policy, now), {
        onSuccess: Effect.succeed,
        onFailure: (reason) =>
          Effect.fail(
            new WriteRejected({ type: event.type, id: event.id, action: event.action, reason }),
          ),
      });
    }),
});

// ── The decision ──────────────────────────────────────────────────────

/**
 * The operations {@link defineModeration} produces.
 *
 * @since 0.1.0
 */
export interface ModerationOps<E, R> {
  /**
   * Record a decision: append the state through the target's own `update`,
   * which runs the {@link moderationHook} (stamping it). Fails
   * `Unauthorized` when anonymous and `Forbidden` below the moderate rung,
   * before anything is read, then as the target's `update` does
   * (`NodeNotFound` for a missing or tombstoned row, `StaleVersion`, and
   * `WriteRejected` from its hooks).
   */
  readonly moderate: (
    id: string,
    decision: ModerationState,
    precondition?: Precondition,
  ) => Effect.Effect<
    ChainWrite,
    Unauthorized | Forbidden | NodeNotFound | StaleVersion | VersionConflict | WriteRejected | E,
    R
  >;
}

/**
 * Bind a leaf's moderation decision. The leaf's hooks must include
 * {@link moderationHook} with the same declaration: it is what admits the
 * decision and stamps it.
 *
 * @since 0.1.0
 */
export const defineModeration = <Resource, E, R>(definition: {
  readonly target: SubtypeOps<Resource, E, R>;
  readonly declaration: ModerationDeclaration;
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
}): ModerationOps<E, R> => ({
  moderate: Effect.fn(`${definition.target.type}.moderate`)(function* (
    id: string,
    decision: ModerationState,
    precondition: Precondition = {},
  ) {
    const viewer = yield* definition.viewer;
    if (Option.isNone(viewer)) return yield* new Unauthorized();
    if (!definition.policy.canModerate(viewer.value)) return yield* new Forbidden();
    return yield* definition.target.update({
      id,
      patch: { [definition.declaration.column]: decision },
      expectedVersion: precondition.expectedVersion,
    });
  }),
});

/**
 * The review queue's leaf half as a list filter: the `pending` rows, for
 * the moderate rung only (`never` for anyone else). Pass it as a list
 * request's `where`; the leaf's own read arms still apply.
 *
 * @since 0.1.0
 */
export const reviewQueueFilter = (
  viewer: Viewer,
  policy: AccessPolicy,
  column: string = "moderationState",
): ListFilter<never> => (Option.exists(viewer, policy.canModerate) ? eq(column, "pending") : never);

// ── Threshold grading ─────────────────────────────────────────────────

/**
 * A classifier's report, shaped like effect-ai-ext's `ModerationModel`
 * output: its own flag, and a score in `[0, 1]` per category it assessed.
 * A category it didn't assess is absent, never `0`.
 *
 * @since 0.1.0
 */
export interface ModerationScores {
  readonly flagged: boolean;
  readonly categoryScores: { readonly [category: string]: number };
}

/**
 * The band a flagged row lands in, from its worst breach.
 *
 * @since 0.1.0
 */
export const ModerationPriority = Schema.Literals(["low", "medium", "high", "urgent"]);
/**
 * The {@link ModerationPriority} literal union.
 *
 * @since 0.1.0
 */
export type ModerationPriority = typeof ModerationPriority.Type;

/**
 * A graded report.
 *
 * @since 0.1.0
 */
export interface ModerationGrade {
  /** The classifier's own flag, or a threshold breach. */
  readonly isFlagged: boolean;
  /** The categories that cleared their threshold, sorted. */
  readonly exceeded: ReadonlyArray<string>;
  /** The highest score across every category, or `0` when none was scored. */
  readonly topScore: number;
  readonly priority: ModerationPriority;
}

/**
 * The bar a category with no configured threshold is graded against;
 * strictly above it flags. A starting point to tune, not a measured value.
 *
 * @since 0.1.0
 */
export const DEFAULT_MODERATION_THRESHOLD = 0.5;

/** The band for a breach: round cut points, a starting policy. */
const bandFor = (score: number): ModerationPriority =>
  score >= 0.9 ? "urgent" : score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";

/**
 * Grade a classifier's scores against the leaf's thresholds (a category
 * missing from `thresholds` grades against `defaultThreshold`). A category
 * breaches when its score is strictly above its bar; an unassessed one is
 * absent and can't breach. The classifier's own flag is never overridden
 * downward, only added to (raise a category's bar to `1` to ignore it). The
 * band is the worst breaching score's, or the top score's for a flag with
 * no breach. Pure.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { gradeScores } from "@thomasfosterau/pulpit/moderation";
 *
 * deepStrictEqual(
 *   gradeScores({ flagged: false, categoryScores: { hate: 0.8, spam: 0.3 } }, { spam: 0.2 }),
 *   { isFlagged: true, exceeded: ["hate", "spam"], topScore: 0.8, priority: "high" },
 * );
 * ```
 *
 * @since 0.1.0
 */
export const gradeScores = (
  scores: ModerationScores,
  thresholds: { readonly [category: string]: number },
  defaultThreshold: number = DEFAULT_MODERATION_THRESHOLD,
): ModerationGrade => {
  const entries = Record.toEntries(scores.categoryScores);
  const breaches = Arr.filter(
    entries,
    ([category, score]) => score > (thresholds[category] ?? defaultThreshold),
  );
  const top = (values: ReadonlyArray<readonly [string, number]>) =>
    Arr.reduce(values, 0, (worst, [, score]) => Math.max(worst, score));
  const topScore = top(entries);
  const topExceeded = top(breaches);
  return {
    isFlagged: scores.flagged || Arr.isReadonlyArrayNonEmpty(breaches),
    exceeded: Arr.sort(
      Arr.map(breaches, ([category]) => category),
      Order.String,
    ),
    topScore,
    priority: bandFor(topExceeded > 0 ? topExceeded : scores.flagged ? topScore : 0),
  };
};

// ── Member reports ────────────────────────────────────────────────────

/**
 * A report's status: `open` until the moderate rung resolves it (acted on)
 * or dismisses it.
 *
 * @since 0.1.0
 */
export const ReportStatus = Schema.Literals(["open", "resolved", "dismissed"]);
/**
 * The {@link ReportStatus} literal union.
 *
 * @since 0.1.0
 */
export type ReportStatus = typeof ReportStatus.Type;

/**
 * One member report, filed against a node.
 *
 * @since 0.1.0
 */
export interface ReportRow {
  readonly id: string;
  readonly targetId: string;
  readonly targetType: string;
  readonly reporterId: string;
  /** The application's reason code (`spam`, `harassment`, …). */
  readonly reason: string;
  readonly details: Option.Option<string>;
  readonly status: ReportStatus;
  readonly filedAt: Date;
  readonly resolvedAt: Option.Option<Date>;
  readonly resolvedBy: Option.Option<string>;
  readonly resolutionNote: Option.Option<string>;
}

/**
 * The write that closes an open report.
 *
 * @since 0.1.0
 */
export interface ReportResolution {
  readonly status: Exclude<ReportStatus, "open">;
  readonly resolvedAt: Date;
  readonly resolvedBy: string;
  readonly resolutionNote: Option.Option<string>;
}

/**
 * The report table an application supplies. It applies no policy, never
 * opens a transaction, and fails only with its `E` (README → Seams).
 *
 * @since 0.1.0
 */
export interface ReportStore<E, R> {
  readonly mintId: Effect.Effect<string, E, R>;
  readonly insert: (row: ReportRow) => Effect.Effect<void, E, R>;
  readonly get: (id: string) => Effect.Effect<Option.Option<ReportRow>, E, R>;
  /** One row, `FOR UPDATE`, so two resolutions serialise. */
  readonly lock: (id: string) => Effect.Effect<Option.Option<ReportRow>, E, R>;
  readonly close: (id: string, resolution: ReportResolution) => Effect.Effect<void, E, R>;
  /**
   * The page under `where`, newest first (`filed_at DESC, id DESC`), with
   * the unpaged total. `where` reads `reporterId`, `targetId`, `targetType`
   * and `status`.
   */
  readonly list: (query: {
    readonly where: ListFilter<never>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<ReportRow>, E, R>;
}

/**
 * No report at that id the viewer may read: the wire's 404.
 *
 * @since 0.1.0
 */
export class ReportNotFound extends Schema.TaggedError<ReportNotFound>()("ReportNotFound", {
  id: Schema.String,
}) {}

/**
 * The report is already resolved or dismissed: the wire's 409.
 *
 * @since 0.1.0
 */
export class ReportClosed extends Schema.TaggedError<ReportClosed>()("ReportClosed", {
  id: Schema.String,
  status: ReportStatus,
}) {}

/**
 * The operations {@link defineReports} produces.
 *
 * @since 0.1.0
 */
export interface ReportOps<E, R> {
  /**
   * File a report against `targetId`. Fails `Unauthorized` when anonymous
   * and `NodeNotFound` when the reporter can't `get` the target, never
   * `Forbidden` (`SEC-AUTH-ENUM-001`). The answer is the reporter's own
   * report: never whether others reported the same node.
   */
  readonly file: (input: {
    readonly targetId: string;
    readonly reason: string;
    readonly details: Option.Option<string>;
  }) => Effect.Effect<{ readonly id: string }, Unauthorized | NodeNotFound | E, R>;
  /** One report, for its reporter or the moderate rung; `ReportNotFound` otherwise. */
  readonly get: (id: string) => Effect.Effect<ReportRow, ReportNotFound | E, R>;
  /**
   * One page, newest first: every report for the moderate rung (the queue's
   * report half, by `status: open`), the viewer's own for anyone else.
   */
  readonly list: (request: {
    readonly targetId: Option.Option<string>;
    readonly status: Option.Option<ReportStatus>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<ReportRow>, E, R>;
  /**
   * Close an open report as `resolved` or `dismissed`. Fails `Unauthorized`
   * / `Forbidden` below the moderate rung, before the report is read, then
   * `ReportNotFound` and `ReportClosed`. Acting on the node is the target's
   * own operation (`moderate`, a delete), called separately.
   */
  readonly resolve: (
    id: string,
    outcome: Exclude<ReportStatus, "open">,
    note: Option.Option<string>,
  ) => Effect.Effect<void, Unauthorized | Forbidden | ReportNotFound | ReportClosed | E, R>;
}

/**
 * Bind member reports against one leaf: filed by a signed-in account that
 * can read the target, read by their reporter and the moderate rung, and
 * resolved by the moderate rung.
 *
 * @since 0.1.0
 */
export const defineReports = <Resource, E, R>(definition: {
  readonly target: SubtypeOps<Resource, E, R>;
  readonly reports: ReportStore<E, R>;
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
}): ReportOps<E, R> => {
  const { target, reports, policy } = definition;
  const type = target.type;

  const signedIn = signedInAs(definition.viewer);

  const file = Effect.fn(`${type}.reports.file`)(function* (input: {
    readonly targetId: string;
    readonly reason: string;
    readonly details: Option.Option<string>;
  }) {
    const account = yield* signedIn;
    // A target the reporter can't read is missing to them (SEC-AUTH-ENUM-001).
    yield* target.get(input.targetId);
    const id = yield* reports.mintId;
    yield* reports.insert({
      id,
      targetId: input.targetId,
      targetType: type,
      reporterId: account.id,
      reason: input.reason,
      details: input.details,
      status: "open",
      filedAt: yield* nowDate,
      resolvedAt: Option.none(),
      resolvedBy: Option.none(),
      resolutionNote: Option.none(),
    });
    return { id };
  });

  const readable = (viewer: Viewer, row: ReportRow) =>
    row.targetType === type &&
    Option.exists(
      viewer,
      (account) => policy.canModerate(account) || account.id === row.reporterId,
    );

  const get = Effect.fn(`${type}.reports.get`)(function* (id: string) {
    const viewer = yield* definition.viewer;
    const row = yield* reports.get(id);
    if (Option.isNone(row) || !readable(viewer, row.value)) {
      return yield* new ReportNotFound({ id });
    }
    return row.value;
  });

  const list = Effect.fn(`${type}.reports.list`)(function* (request: {
    readonly targetId: Option.Option<string>;
    readonly status: Option.Option<ReportStatus>;
    readonly limit: number;
    readonly offset: number;
  }) {
    const viewer = yield* definition.viewer;
    const scope = Option.match(viewer, {
      onNone: (): ListFilter<never> => never,
      onSome: (account): ListFilter<never> =>
        policy.canModerate(account) ? always : eq("reporterId", account.id),
    });
    return yield* reports.list(plainRowQuery(type, scope, request));
  });

  const resolve = Effect.fn(`${type}.reports.resolve`)(function* (
    id: string,
    outcome: Exclude<ReportStatus, "open">,
    note: Option.Option<string>,
  ) {
    const account = yield* signedIn;
    if (!policy.canModerate(account)) return yield* new Forbidden();
    const row = yield* reports.lock(id);
    if (Option.isNone(row) || row.value.targetType !== type) {
      return yield* new ReportNotFound({ id });
    }
    if (row.value.status !== "open") {
      return yield* new ReportClosed({ id, status: row.value.status });
    }
    yield* reports.close(id, {
      status: outcome,
      resolvedAt: yield* nowDate,
      resolvedBy: account.id,
      resolutionNote: note,
    });
  });

  return { file, get, list, resolve };
};
