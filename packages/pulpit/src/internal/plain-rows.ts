/**
 * The pieces `./proposals` and `./moderation`'s reports share: both are
 * plain-row families (not nodes) with a sign-in gate, a write clock and a
 * page query narrowed to one leaf type, an optional target and an
 * optional status.
 *
 * @module pulpit/internal/plain-rows
 */

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { always, and, eq, type ListFilter } from "../filter.ts";
import { MAX_PAGE_LIMIT, Unauthorized, type Viewer, type ViewerAccount } from "../subtype.ts";

/** The write clock: the current instant, as the `Date` a row stores. */
export const nowDate: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.toDate(DateTime.makeUnsafe(millis)),
);

/** The signed-in account, or `Unauthorized`. */
export const signedIn = <R>(
  viewer: Effect.Effect<Viewer, never, R>,
): Effect.Effect<ViewerAccount, Unauthorized, R> =>
  Effect.flatMap(viewer, (account) =>
    Option.match(account, {
      onNone: () => Effect.fail(new Unauthorized()),
      onSome: Effect.succeed,
    }),
  );

/**
 * A list request's store query: the leaf's rows under the viewer's `scope`,
 * narrowed by target and status when asked, the page clamped to
 * `MAX_PAGE_LIMIT` (`SEC-INPUT-003`).
 */
export const plainRowQuery = <Status extends string>(
  type: string,
  scope: ListFilter<never>,
  request: {
    readonly targetId: Option.Option<string>;
    readonly status: Option.Option<Status>;
    readonly limit: number;
    readonly offset: number;
  },
) => ({
  where: and<never>(
    eq("targetType", type),
    scope,
    Option.match(request.targetId, { onNone: () => always, onSome: (id) => eq("targetId", id) }),
    Option.match(request.status, {
      onNone: () => always,
      onSome: (status) => eq("status", status),
    }),
  ),
  limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
  offset: Math.max(0, Math.trunc(request.offset)),
});
