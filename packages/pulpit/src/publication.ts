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
 * - `owned` — an owned family's axes are effect-auth's
 *   (`Cacheability.publiclyServeable` over `OwnedAccess.serveableAxes`,
 *   pulpit#5): a `visibility` that is absent refuses, since the projection
 *   dropped the one attribute that decides who may see the row and reading
 *   that as public is a fail-open (#1096, #1092); `draft` and `unapproved`,
 *   when present, must be exactly `false`, a `moderationState` exactly
 *   `approved`, and a `deletedAt` key must be absent, even holding
 *   `undefined`;
 * - `publishGated` — a family gated by its stamp refuses a missing,
 *   unparseable or future `publishedAt`. A leaf that declares `./subtype`'s
 *   live pointer is one: its live view supplies the stamp, and its
 *   handlers write the cache only from the anonymous (live) read
 *   (pulpit#46).
 *
 * What the predicate structurally cannot express is a gate that depends on
 * state outside the cached resource (a comment's inherited target gate,
 * #1475); a family with one closes it on the write path (evict on the
 * target's mutation) with the cache TTL floor as the backstop.
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#publication.
 *
 * @copyright Thomas Foster
 * @module pulpit/publication
 * @since 0.1.0
 */

import { Cacheability, OwnedAccess } from "@thomasfosterau/effect-auth";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
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

/**
 * A family's cache posture: which absent axes are refusals.
 *
 * @since 0.1.0
 */
export interface ServeabilityOptions {
  /** An owned family: a missing `visibility` refuses (#1096). */
  readonly owned?: boolean;
  /** A stamp-gated family: a missing, unparseable or future `publishedAt` refuses. */
  readonly publishGated?: boolean;
  /** The instant a stamp must have arrived by; the wall clock when omitted. */
  readonly now?: Date;
}

/**
 * Whether a serialised `publishedAt` names an instant that has arrived by
 * `options.now` (the wall clock when omitted). The value crosses KV as JSON,
 * so it arrives as a string on a hit and as a `Date` on populate; a string
 * that does not parse to a finite instant is refused rather than guessed at.
 */
const hasArrivedStamp = (publishedAt: Date | string, options: ServeabilityOptions): boolean => {
  const instant = P.isString(publishedAt)
    ? Option.match(DateTime.make(publishedAt), {
        onNone: () => Number.NaN,
        onSome: DateTime.toEpochMillis,
      })
    : publishedAt.getTime();
  const now = options.now ?? DateTime.toDate(DateTime.nowUnsafe());
  return Number.isFinite(instant) && instant <= now.getTime();
};

/**
 * An owned family's axes, as effect-auth decides them (pulpit#5):
 * `Cacheability.publiclyServeable` over `OwnedAccess.serveableAxes`, the
 * owned-read policy's one anonymous arm restated over the wire attributes.
 */
const ownedServeable = Cacheability.publiclyServeable(OwnedAccess.serveableAxes);

/** A serialised stamp's two forms: a string on a KV hit, a `Date` on populate. */
const isStamp = P.or(P.isDate, P.isString);

/**
 * What {@link isPubliclyServeable} has established of a resource it admits:
 * an object with an `attributes` object (whose axes it has read and found
 * serveable). A resource the cache holds as anything else is refused.
 *
 * @since 0.2.0
 */
export interface PubliclyServeableResource {
  readonly attributes: object;
}

/**
 * Whether a cached resource may be served from the cache to a viewer who
 * reaches the cache at all (a viewer who bypasses it for freshness reads the
 * database directly). See the module doc for the rule. It is the cache's
 * parser as well as its gate: the resource is whatever the KV hands back,
 * so anything that is not an object with an `attributes` object refuses,
 * and an admitted resource is narrowed to {@link PubliclyServeableResource}.
 *
 * @since 0.1.0
 */
export const isPubliclyServeable = (
  resource: unknown,
  options: ServeabilityOptions = {},
): resource is PubliclyServeableResource => {
  if (!P.isObject(resource)) return false;
  const attributes = resource["attributes"];
  // No attributes block to inspect: refuse rather than guess.
  if (!P.isObject(attributes)) return false;
  // A `publishedAt` that is neither a `Date` nor a string (absent included)
  // names no instant, so the publish gate refuses it.
  const stamp = Option.liftPredicate(attributes["publishedAt"], isStamp);
  if (
    options.publishGated === true &&
    !Option.exists(stamp, (publishedAt) => hasArrivedStamp(publishedAt, options))
  ) {
    return false;
  }
  if (options.owned === true) return ownedServeable(attributes);
  const visibility = attributes["visibility"];
  if (visibility !== undefined && visibility !== "public") return false;
  const moderationState = attributes["moderationState"];
  if (moderationState !== undefined && moderationState !== "approved") return false;
  // The draft axis: a draft is a gate wherever it is present, and a present
  // value that is not exactly `false` (`null` included) reads as a draft, as
  // the operation layer's row predicate reads it (SEC-AUTH-ENUM-001).
  const draft = attributes["draft"];
  if (draft !== undefined && draft !== false) return false;
  // A tombstone is an admin-only read, and emitters omit the key while live
  // (#691): present at all — `null` included — refuses.
  return attributes["deletedAt"] === undefined;
};

/**
 * The `serveable` hook the application's resource cache takes, bound to a
 * family's posture: `(resource) => boolean`, narrowing an admitted resource
 * as {@link isPubliclyServeable} does. The cache, which the application owns
 * (no library is expected to provide one; effect-web#33), applies it on
 * both its read and write paths and evicts on a non-serveable write.
 *
 * @since 0.1.0
 */
export const serveablePolicy =
  (options: Omit<ServeabilityOptions, "now"> = {}) =>
  (resource: unknown): resource is PubliclyServeableResource =>
    isPubliclyServeable(resource, options);
