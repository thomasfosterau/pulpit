/**
 * **Write budgets** (pulpit#199): a declared ceiling on how many writes of
 * one kind an account may make in a rolling window, so a family that takes
 * user content (comments, proposals, reports, posts) throttles it without
 * every application re-adding the check.
 *
 * - **Declared once per family and action.** A {@link WriteBudget} names a
 *   limit and a window; {@link bindBudget} binds it to a family's type, a
 *   {@link BudgetCounter} and the access policy, and checks the declaration
 *   (a malformed one throws {@link BudgetDeclarationError} when it is bound).
 * - **Spent inside the write.** A chain write spends through
 *   {@link budgetHook}, a before hook, so a write over budget appends
 *   nothing; `./proposals`' `submit` and `./moderation`'s report `file` take
 *   the bound budget as an opt-in and spend it before their insert. Either
 *   way the refusal is `WriteRejected` with the reason {@link RATE_LIMITED},
 *   which {@link isRateLimited} tells apart from every other refusal (the
 *   wire's 429).
 * - **Exempt above a rung.** An account the budget's `exempt` rung admits
 *   (the moderate rung, by default) spends nothing.
 * - **One counter seam.** The owner's decision on #199: count within the
 *   write's transaction, with the seam shaped so an atomic counter can be
 *   plugged in later. {@link countingCounter} is the counting
 *   implementation, one indexed `count(*)` over the family's own rows; a
 *   counter that holds its own state (a Durable Object, a locked row)
 *   implements {@link BudgetCounter.take} directly.
 *
 * @copyright Thomas Foster
 * @module pulpit/budgets
 * @since 0.1.0
 */

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  WriteRejected,
  type AccessPolicy,
  type BeforeWriteHook,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";

/**
 * The `WriteRejected` reason a write over its budget carries, so the wire
 * can answer 429 rather than 422.
 *
 * @since 0.1.0
 */
export const RATE_LIMITED = "rate-limited";

/**
 * Whether a refusal is a write budget's ({@link RATE_LIMITED}), not another
 * hook's.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { isRateLimited, RATE_LIMITED } from "@thomasfosterau/pulpit/budgets";
 * import { WriteRejected } from "@thomasfosterau/pulpit/subtype";
 *
 * const refusal = new WriteRejected({ type: "comments", id: "c-1", action: "create", reason: RATE_LIMITED });
 * strictEqual(isRateLimited(refusal), true);
 * ```
 *
 * @since 0.1.0
 */
export const isRateLimited = (error: WriteRejected): boolean => error.reason === RATE_LIMITED;

/**
 * A write budget: at most `limit` writes per account in any window of
 * `windowSeconds`, for every account the `exempt` rung doesn't admit.
 *
 * @since 0.1.0
 */
export interface WriteBudget {
  /** The most writes one account may make in a window: a positive safe integer. */
  readonly limit: number;
  /** The window's length, in seconds: a positive safe integer. */
  readonly windowSeconds: number;
  /**
   * The rung that spends nothing, read from the access policy (as
   * `./edges`' `rungGate` reads one). Absent, the moderate rung.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the optional-field convention (AGENTS.md → Conventions); absent is the moderate rung
  readonly exempt?: ((policy: AccessPolicy) => (account: ViewerAccount) => boolean) | undefined;
}

/**
 * A budget declaration that can never admit a write as intended (a limit or
 * window that is not a positive safe integer), thrown by {@link bindBudget}
 * when the budget is bound, never as an Effect failure.
 *
 * @since 0.1.0
 */
export class BudgetDeclarationError extends Schema.TaggedError<BudgetDeclarationError>()(
  "BudgetDeclarationError",
  { type: Schema.String, reason: Schema.String },
) {}

/**
 * What a {@link BudgetCounter} is asked: whether the account may make one
 * more write of `action` on the family `type`, given the window that
 * started at `since` and the budget's `limit`.
 *
 * @since 0.1.0
 */
export interface BudgetRequest {
  readonly type: string;
  readonly action: string;
  readonly accountId: string;
  readonly since: Date;
  readonly now: Date;
  readonly limit: number;
}

/**
 * The counter seam: spend one write against the budget, answering whether
 * it was within it. Runs in the caller's transaction. A counting
 * implementation ({@link countingCounter}) reads the writes already made,
 * which the write itself then adds to; an atomic one (a Durable Object, a
 * row taken `FOR UPDATE`) records the spend itself, and must spend nothing
 * when it answers `false`. See the package README → Seams.
 *
 * @since 0.1.0
 */
export interface BudgetCounter<E, R> {
  readonly take: (request: BudgetRequest) => Effect.Effect<boolean, E, R>;
}

/**
 * The read {@link countingCounter} counts with: how many writes of `action`
 * on `type` the account made at or after `since`, as one indexed
 * `count(*)` over the family's own rows (`author_id`, `created_at`).
 *
 * @since 0.1.0
 */
export interface WriteCountStore<E, R> {
  readonly countSince: (query: {
    readonly type: string;
    readonly action: string;
    readonly accountId: string;
    readonly since: Date;
  }) => Effect.Effect<number, E, R>;
}

/**
 * The count-within-the-transaction counter (gardeneria's
 * `assertNotRateLimitedE`): a write is within budget while fewer than
 * `limit` writes were made in the window. It spends nothing itself: the
 * write's own row is the spend, and a write that rolls back took none.
 * **It is exact but not atomic:** two concurrent transactions can both
 * count `limit - 1` and both write. A family that must hold its limit under
 * concurrency fills {@link BudgetCounter} with an atomic counter instead.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { countingCounter } from "@thomasfosterau/pulpit/budgets";
 *
 * const counter = countingCounter({ countSince: () => Effect.succeed(2) });
 * const request = {
 *   type: "comments",
 *   action: "create",
 *   accountId: "u-1",
 *   since: new Date(0),
 *   now: new Date(60_000),
 *   limit: 3,
 * };
 * strictEqual(Effect.runSync(counter.take(request)), true);
 * strictEqual(Effect.runSync(counter.take({ ...request, limit: 2 })), false);
 * ```
 *
 * @since 0.1.0
 */
export const countingCounter = <E, R>(store: WriteCountStore<E, R>): BudgetCounter<E, R> => ({
  take: (request) =>
    Effect.map(
      store.countSince({
        type: request.type,
        action: request.action,
        accountId: request.accountId,
        since: request.since,
      }),
      (count) => count < request.limit,
    ),
});

/**
 * A budget bound to its family: {@link BoundBudget.spend} spends one write.
 *
 * @since 0.1.0
 */
export interface BoundBudget<E, R> {
  readonly type: string;
  readonly budget: WriteBudget;
  /**
   * Spend one write of `action` by `viewer` on the node `id`. An anonymous
   * viewer spends nothing (the write's own gate refuses it), nor does one
   * the exempt rung admits. Over budget it fails `WriteRejected` with
   * {@link RATE_LIMITED}.
   */
  readonly spend: (
    viewer: Viewer,
    action: string,
    id: string,
  ) => Effect.Effect<void, WriteRejected | E, R>;
}

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

/**
 * Bind a {@link WriteBudget} to a family's type, its counter and the access
 * policy. Throws {@link BudgetDeclarationError} for a limit or window that
 * is not a positive safe integer.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Exit from "effect/Exit";
 * import * as Option from "effect/Option";
 * import { bindBudget } from "@thomasfosterau/pulpit/budgets";
 * import { makeInMemoryBudgetCounter } from "@thomasfosterau/pulpit/testing";
 *
 * const policy = {
 *   canViewPrivate: () => false,
 *   canViewDeleted: () => false,
 *   canModerate: () => false,
 *   canWriteCorpus: () => false,
 * };
 * const comments = bindBudget({
 *   type: "comments",
 *   budget: { limit: 1, windowSeconds: 60 },
 *   counter: makeInMemoryBudgetCounter(),
 *   policy,
 * });
 * const member = Option.some({ id: "u-1", role: "member" });
 * const twice = Effect.gen(function* () {
 *   yield* comments.spend(member, "create", "c-1");
 *   return yield* Effect.exit(comments.spend(member, "create", "c-2"));
 * });
 * strictEqual(Exit.isFailure(Effect.runSync(twice)), true);
 * ```
 *
 * @since 0.1.0
 */
export const bindBudget = <E, R>(definition: {
  readonly type: string;
  readonly budget: WriteBudget;
  readonly counter: BudgetCounter<E, R>;
  readonly policy: AccessPolicy;
}): BoundBudget<E, R> => {
  const { type, budget, counter, policy } = definition;
  if (!positiveSafeInteger(budget.limit)) {
    throw new BudgetDeclarationError({ type, reason: "limit must be a positive safe integer" });
  }
  if (!positiveSafeInteger(budget.windowSeconds)) {
    throw new BudgetDeclarationError({
      type,
      reason: "windowSeconds must be a positive safe integer",
    });
  }
  const exempt = (budget.exempt ?? ((rungs: AccessPolicy) => rungs.canModerate))(policy);
  const windowMillis = budget.windowSeconds * 1000;

  const spend = (viewer: Viewer, action: string, id: string) =>
    Option.match(
      Option.filter(viewer, (account) => !exempt(account)),
      {
        onNone: () => Effect.void,
        onSome: (account) =>
          Effect.flatMap(Clock.currentTimeMillis, (millis) =>
            Effect.flatMap(
              counter.take({
                type,
                action,
                accountId: account.id,
                since: DateTime.toDate(DateTime.makeUnsafe(millis - windowMillis)),
                now: DateTime.toDate(DateTime.makeUnsafe(millis)),
                limit: budget.limit,
              }),
              (within) =>
                within
                  ? Effect.void
                  : Effect.fail(new WriteRejected({ type, id, action, reason: RATE_LIMITED })),
            ),
          ),
      },
    );

  return { type, budget, spend };
};

/**
 * A bound budget as a before hook for a chain write (`./subtype`'s
 * `hooks.before`), spending one write on each of the `actions` it lists
 * (`create`, by default) and passing the patch through. A localised write
 * spends once: the hook's `locales` pass spends nothing.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { bindBudget, budgetHook } from "@thomasfosterau/pulpit/budgets";
 * import { makeInMemoryBudgetCounter } from "@thomasfosterau/pulpit/testing";
 *
 * const policy = {
 *   canViewPrivate: () => false,
 *   canViewDeleted: () => false,
 *   canModerate: () => false,
 *   canWriteCorpus: () => false,
 * };
 * const hook = budgetHook(
 *   bindBudget({
 *     type: "comments",
 *     budget: { limit: 10, windowSeconds: 3600 },
 *     counter: makeInMemoryBudgetCounter(),
 *     policy,
 *   }),
 * );
 * strictEqual(hook.name, "comments.budget");
 * ```
 *
 * @since 0.1.0
 */
export const budgetHook = <E, R>(
  bound: BoundBudget<E, R>,
  actions: ReadonlyArray<string> = ["create"],
): BeforeWriteHook<E, R> => ({
  name: `${bound.type}.budget`,
  run: (event) =>
    actions.includes(event.action)
      ? Effect.as(bound.spend(event.viewer, event.action, event.id), event.patch)
      : Effect.succeed(event.patch),
  locales: (event) => Effect.succeed(event.locales ?? {}),
});
