/**
 * **The publication axis, the moderation state, and the cache serveability
 * policy.**
 *
 * Ported from gardeneria's `packages/database/src/publication.ts`
 * (`isPublished` / `isNotPublished` / `publishedFilter`) and the
 * `isPubliclyServeable` gate of its `apps/api/src/cache.ts`, with its tests
 * (`apps/api/tests/resource-cache-readthrough.test.ts`). A `#NNN` here names
 * a gardeneria issue.
 *
 * ## Published means stamped AND arrived
 *
 * A publication stamp (`publishedAt`) is a datetime the author controls, so
 * an author may set a FUTURE one, and that is what scheduling is (#1121): the
 * row exists, it is stamped, and it is not out yet. `IS NOT NULL` and "live"
 * are therefore different predicates, and every reader of the axis gets the
 * two-part answer from here. The unpublished predicate is the exact
 * complement — an owner's "unpublished" list is their drafts AND their
 * scheduled rows. In SQL the clock is the database's (`now()`, one per
 * query); the list filter node carries that contract (`./filter`).
 *
 * ## The serveability policy (`CACHE-AUTH-005`)
 *
 * The KV read-through cache is populated by writes — a privileged editor's
 * save included — so it CAN hold a resource only some viewers may read, and
 * it serves anonymous readers. {@link isPubliclyServeable} is the gate on
 * both of its paths (serving a hit, and populating on a miss, where a
 * non-serveable resource is evicted so a `public → private` flip
 * self-purges). **The rule: every publication axis the operation layer
 * gates on must be present in the cached attributes AND pass.** A present
 * axis whose value is not exactly the serveable literal is refused; an absent
 * axis means the resource does not ride it — except where the family's
 * options say absence is itself a refusal:
 *
 * - `owned` — an owned family whose `visibility` attribute is absent refuses:
 *   the projection dropped the one attribute that decides who may see the
 *   row, and reading that as public is a fail-open (#1096, #1092);
 * - `publishGated` — a family gated by its stamp refuses a missing,
 *   unparseable or future `publishedAt`.
 *
 * What the predicate structurally cannot express is a gate that depends on
 * state outside the cached resource (a comment's inherited target gate,
 * #1475); a family with one closes it on the write path (evict on the
 * target's mutation) with the cache TTL floor as the backstop.
 *
 * @copyright Thomas Foster
 * @module pulpit/publication
 * @since 0.1.0
 */

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { always, and, gt, lte, notPublished, published, type ListFilter } from "./filter.ts";

/**
 * A moderated family's review state (`PUB-005`): only `approved` is
 * serveable from the cache. A `pending` / `rejected` row is still readable by
 * its author at the operation layer — it is refused from the cache because
 * only SOME viewers may read it.
 *
 * @since 0.1.0
 */
export const ModerationState = Schema.Literals(["pending", "approved", "rejected"]);
/**
 * The {@link ModerationState} literal union: `"pending" | "approved" | "rejected"`.
 *
 * @since 0.1.0
 */
export type ModerationState = typeof ModerationState.Type;

/**
 * Stamped, and the stamp has arrived at `now`.
 *
 * @since 0.1.0
 */
export const isPublishedAt = (publishedAt: Option.Option<Date>, now: Date): boolean =>
  Option.exists(publishedAt, (stamp) => stamp.getTime() <= now.getTime());

/**
 * Not out at `now`: unstamped, or stamped in the future — the exact complement of {@link isPublishedAt}.
 *
 * @since 0.1.0
 */
export const isNotPublishedAt = (publishedAt: Option.Option<Date>, now: Date): boolean =>
  !isPublishedAt(publishedAt, now);

/**
 * The axis as one list-filter arm, for a `?filter[published]=` that may be
 * absent: none in, `always` out (no predicate) — so a list reads one line per
 * axis.
 *
 * @since 0.1.0
 */
export const publishedFilter = <Following = never>(
  column: string,
  wanted: Option.Option<boolean>,
): ListFilter<Following> =>
  Option.match(wanted, {
    onNone: (): ListFilter<Following> => always,
    onSome: (isWanted) => (isWanted ? published(column) : notPublished(column)),
  });

/**
 * The rows whose publication stamp arrived in the window `(since, now]`:
 * `since < column AND column <= now`, as a list filter for an application's
 * cron to drive a scheduled-publication sweep (pulpit#45). A write fires its
 * lifecycle events when it is made, so a version stamped for the future
 * emits nothing when its stamp arrives; a sweep that passes each run's `now`
 * as the next run's `since` sees every such row exactly once, since the
 * windows are half-open and abut. Pass it as a list request's `where`, read
 * as a viewer who may see the rows the sweep is for (the list still applies
 * the leaf's access and soft-delete arms). An unordered instant (an invalid
 * `Date`) matches nothing. `column` defaults to `publishedAt`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { evaluate } from "@thomasfosterau/pulpit/filter";
 * import { duePublications } from "@thomasfosterau/pulpit/publication";
 *
 * const due = duePublications(new Date("2026-10-22T00:00:00Z"), new Date("2026-10-22T01:00:00Z"));
 * const context = { now: new Date("2026-10-22T01:00:00Z"), contains: () => false };
 * strictEqual(evaluate(due, { publishedAt: new Date("2026-10-22T00:30:00Z") }, context), true);
 * strictEqual(evaluate(due, { publishedAt: new Date("2026-10-22T00:00:00Z") }, context), false);
 * ```
 *
 * @since 0.1.0
 */
export const duePublications = <Following = never>(
  since: Date,
  now: Date,
  column: string = "publishedAt",
): ListFilter<Following> => and<Following>(gt(column, since), lte(column, now));

/* oxlint-disable effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such by every reader, so there is no value to model as an `Option` */
/**
 * A family's cache posture: which absent axes are refusals.
 *
 * @since 0.1.0
 */
export interface ServeabilityOptions {
  /** An owned family: a missing `visibility` refuses (#1096). */
  readonly owned?: boolean | undefined;
  /** A stamp-gated family: a missing, unparseable or future `publishedAt` refuses. */
  readonly publishGated?: boolean | undefined;
  /** The instant a stamp must have arrived by; the wall clock when omitted. */
  readonly now?: Date | undefined;
}
/* oxlint-enable effect/prefer-option-over-null */

/* oxlint-disable effect/no-unknown-parameters, effect/no-unknown-returns -- the cache's security gate must accept whatever the KV hands back, including a value that fails to parse: refusing malformed input IS its contract, so the untyped value is the boundary itself */
/**
 * Whether a serialised `publishedAt` names an instant that has arrived. The
 * value crosses KV as JSON, so it arrives as a string on a hit and as a
 * `Date` on populate; anything that does not parse to a finite instant is
 * refused rather than guessed at.
 */
const hasArrivedStamp = (publishedAt: unknown, now: Date): boolean => {
  const instant =
    publishedAt instanceof Date
      ? publishedAt.getTime()
      : Predicate.isString(publishedAt)
        ? Option.match(DateTime.make(publishedAt), {
            onNone: () => Number.NaN,
            onSome: DateTime.toEpochMillis,
          })
        : Number.NaN;
  return Number.isFinite(instant) && instant <= now.getTime();
};

/**
 * Whether a cached resource may be served from the cache to a viewer who
 * reaches the cache at all (a viewer who bypasses it for freshness reads the
 * database directly). See the module doc for the rule.
 *
 * @since 0.1.0
 */
export const isPubliclyServeable = (
  resource: unknown,
  options: ServeabilityOptions = {},
): boolean => {
  if (!Predicate.isObject(resource)) return false;
  const attributes = resource["attributes"];
  // No attributes block to inspect: refuse rather than guess.
  if (!Predicate.isObject(attributes)) return false;
  const read = (key: string): unknown => attributes[key];
  const visibility = read("visibility");
  if (options.owned === true && visibility === undefined) return false;
  if (
    options.publishGated === true &&
    !hasArrivedStamp(read("publishedAt"), options.now ?? DateTime.toDate(DateTime.nowUnsafe()))
  ) {
    return false;
  }
  if (visibility !== undefined && visibility !== "public") return false;
  const moderationState = read("moderationState");
  if (moderationState !== undefined && moderationState !== "approved") return false;
  // The draft axis: a draft is a gate wherever it is present, and a present
  // value that is not exactly `false` (`null` included) reads as a draft, as
  // the operation layer's row predicate reads it (SEC-AUTH-ENUM-001).
  const draft = read("draft");
  if (draft !== undefined && draft !== false) return false;
  // A tombstone is an admin-only read, and emitters omit the key while live
  // (#691): present at all — `null` included — refuses.
  return read("deletedAt") === undefined;
};

/**
 * The `serveable` hook the application's resource cache takes, bound to a
 * family's posture: `(resource) => boolean`. The cache, which the application
 * owns (no library is expected to provide one; effect-web#33), applies it on
 * both its read and write paths and evicts on a non-serveable write.
 *
 * @since 0.1.0
 */
export const serveablePolicy =
  (options: Omit<ServeabilityOptions, "now"> = {}) =>
  (resource: unknown): boolean =>
    isPubliclyServeable(resource, options);
/* oxlint-enable effect/no-unknown-parameters, effect/no-unknown-returns */
