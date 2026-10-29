/**
 * **The social graph** (pulpit#195) — follow, mute and block between
 * accounts, as relationship facts with their own gates, the follower and
 * following lists, a {@link FollowerSeam} built from the graph so
 * `followers` rows work end to end, and an opt-in read filter over the
 * accounts a viewer silenced.
 *
 * The behavioural spec is gardeneria's `social.follows` and its operations
 * (`apps/api/src/operations/follows.ts`), with their tests.
 *
 * ## The model (owner decisions on pulpit#195)
 *
 * - **A relationship is a fact**, keyed `(kind, from, to)` for the kinds
 *   `follow`, `mute` and `block`: no history; asserting one twice is a
 *   no-op, removing it hard-deletes it. Only the actor writes their own
 *   (`from` is always the viewer).
 * - **Following is immediate.** There are no follow requests (a later
 *   slice).
 * - **A block suppresses interaction only.** Neither side may follow the
 *   other while either blocks the other ({@link InteractionBlocked}), a
 *   block removes both accounts' follows of each other, and other modules
 *   gate an interaction (a reaction, a reply, a mention) on
 *   {@link SocialOps.interactionAllowed}. It hides no content by itself:
 *   {@link SocialOps.silencedFilter} is the opt-in read filter that drops
 *   the authors a viewer muted or blocked from a feed or a thread.
 * - **A mute is one-way and private**: it only feeds that read filter.
 *
 * Mute and block lists are their owner's alone; the follower and following
 * lists are public, filtered through the application's account visibility
 * ({@link AccountVisibility}).
 *
 * @copyright Thomas Foster
 * @module pulpit/social
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { always, isNotIn, type ListFilter } from "./filter.ts";
import { nowDate, signedIn as signedInAs } from "./internal/plain-rows.ts";
import {
  MAX_PAGE_LIMIT,
  type FollowerSeam,
  type Page,
  type Unauthorized,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * The relationship kinds.
 *
 * @since 0.1.0
 */
export const RelationshipKind = Schema.Literals(["follow", "mute", "block"]);
/**
 * The {@link RelationshipKind} literal union.
 *
 * @since 0.1.0
 */
export type RelationshipKind = typeof RelationshipKind.Type;

/**
 * One stored relationship: `from` follows, mutes or blocks `to`.
 *
 * @since 0.1.0
 */
export interface Relationship {
  readonly kind: RelationshipKind;
  readonly from: string;
  readonly to: string;
  readonly at: Date;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Either account blocks the other, so the interaction is refused: the
 * wire's 403. It tells the actor a block exists between the two, as every
 * social network's refusal does.
 *
 * @since 0.1.0
 */
export class InteractionBlocked extends Schema.TaggedError<InteractionBlocked>()(
  "InteractionBlocked",
  { accountId: Schema.String },
) {}

/**
 * A relationship with oneself: the wire's 422.
 *
 * @since 0.1.0
 */
export class SelfRelationship extends Schema.TaggedError<SelfRelationship>()("SelfRelationship", {
  kind: RelationshipKind,
}) {}

// ── The seams ─────────────────────────────────────────────────────────

/**
 * The relationship table an application supplies (gardeneria's
 * `social.follows`, widened by a `kind` column), keyed
 * `(kind, from_id, to_id)` with both account foreign keys cascading. A store
 * seam: no policy, never opens a transaction, fails only with its `E`.
 * `Following` is the follower seam's set (a subquery in SQL). See the
 * package README → Seams.
 *
 * @since 0.1.0
 */
export interface SocialStore<Following, E, R> {
  /** Insert the relationship (`ON CONFLICT DO NOTHING`); whether a row was written. */
  readonly add: (relationship: Relationship) => Effect.Effect<boolean, E, R>;
  /** Delete the relationship; whether a row went. */
  readonly remove: (
    kind: RelationshipKind,
    from: string,
    to: string,
  ) => Effect.Effect<boolean, E, R>;
  /** Whether the relationship is stored. */
  readonly has: (kind: RelationshipKind, from: string, to: string) => Effect.Effect<boolean, E, R>;
  /**
   * One page of an account's relationships of `kind`, newest first
   * (`at DESC`, then the other account's id): by `from` (whom it follows,
   * mutes or blocks) or by `to` (who follows it), with the unpaged total.
   */
  readonly list: (query: {
    readonly kind: RelationshipKind;
    readonly side: "from" | "to";
    readonly accountId: string;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<{ readonly accountId: string; readonly at: Date }>, E, R>;
  /** Whether `follower` follows `followed`, as the follower seam asks it (never fails). */
  readonly isFollowing: (follower: string, followed: string) => Effect.Effect<boolean, never, R>;
  /** The accounts `follower` follows, as the list filter's `in` set (a subquery, never an array). */
  readonly followingOf: (follower: string) => Following;
  /** The accounts `viewer` muted or blocked, as the list filter's set (a subquery). */
  readonly silencedBy: (viewer: string) => Following;
  /** Delete every relationship from or to the account (account erasure, pulpit#207); how many went. */
  readonly eraseAccount: (accountId: string) => Effect.Effect<number, E, R>;
}

/**
 * Which accounts a viewer may see in a follower or following list: the
 * application's own account visibility (a private profile, a suspended
 * account). Given a page's account ids, the ones to show.
 *
 * @since 0.1.0
 */
export interface AccountVisibility<R> {
  readonly visible: (
    viewer: Viewer,
    accountIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashSet.HashSet<string>, never, R>;
}

/**
 * The follower seam a social store fills (`./subtype`'s
 * {@link FollowerSeam}), so a `followers` row is readable by the accounts
 * that follow its owner.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { socialFollowers } from "@thomasfosterau/pulpit/social";
 * import { makeInMemorySocialStore } from "@thomasfosterau/pulpit/testing";
 *
 * const store = makeInMemorySocialStore();
 * Effect.runSync(store.add({ kind: "follow", from: "u-1", to: "u-2", at: new Date(0) }));
 * const followers = socialFollowers(store);
 * strictEqual(Effect.runSync(followers.isFollower("u-1", "u-2")), true);
 * strictEqual(Effect.runSync(followers.isFollower("u-2", "u-1")), false);
 * ```
 *
 * @since 0.1.0
 */
export const socialFollowers = <Following, E, R>(
  store: Pick<SocialStore<Following, E, R>, "isFollowing" | "followingOf">,
): FollowerSeam<Following, R> => ({
  isFollower: store.isFollowing,
  following: store.followingOf,
});

// ── The operations ────────────────────────────────────────────────────

/**
 * The social graph's declaration.
 *
 * @since 0.1.0
 */
export interface SocialDefinition<Following, E, R> {
  readonly store: SocialStore<Following, E, R>;
  /** The request's viewer. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /** Which accounts the follower and following lists show; omitted, every one. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key shows every account
  readonly accounts?: AccountVisibility<R> | undefined;
}

/**
 * A page request: clamped to `[1, MAX_PAGE_LIMIT]` and an offset `≥ 0`.
 *
 * @since 0.1.0
 */
export interface SocialPageRequest {
  readonly limit: number;
  readonly offset: number;
}

/**
 * One account on a list, and when the relationship began.
 *
 * @since 0.1.0
 */
export interface Related {
  readonly accountId: string;
  readonly at: Date;
}

/**
 * The operations {@link defineSocial} produces. Every write is the
 * viewer's own and fails `Unauthorized` when anonymous; asserting a
 * relationship again, or removing one that isn't there, changes nothing
 * (`changed: false`).
 *
 * @since 0.1.0
 */
export interface SocialOps<Following, E, R> {
  /**
   * Follow `accountId`. Fails {@link SelfRelationship} for oneself and
   * {@link InteractionBlocked} when either account blocks the other.
   */
  readonly follow: (
    accountId: string,
  ) => Effect.Effect<
    { readonly changed: boolean },
    Unauthorized | SelfRelationship | InteractionBlocked | E,
    R
  >;
  readonly unfollow: (
    accountId: string,
  ) => Effect.Effect<{ readonly changed: boolean }, Unauthorized | E, R>;
  /** Mute `accountId` (one-way and private). Fails {@link SelfRelationship} for oneself. */
  readonly mute: (
    accountId: string,
  ) => Effect.Effect<{ readonly changed: boolean }, Unauthorized | SelfRelationship | E, R>;
  readonly unmute: (
    accountId: string,
  ) => Effect.Effect<{ readonly changed: boolean }, Unauthorized | E, R>;
  /**
   * Block `accountId`: also removes each account's follow of the other.
   * Fails {@link SelfRelationship} for oneself.
   */
  readonly block: (
    accountId: string,
  ) => Effect.Effect<{ readonly changed: boolean }, Unauthorized | SelfRelationship | E, R>;
  readonly unblock: (
    accountId: string,
  ) => Effect.Effect<{ readonly changed: boolean }, Unauthorized | E, R>;
  /** The accounts following `accountId`, newest first, as the application's account visibility shows them. */
  readonly followers: (
    accountId: string,
    request: SocialPageRequest,
  ) => Effect.Effect<Page<Related>, E, R>;
  /** The accounts `accountId` follows, newest first, as the application's account visibility shows them. */
  readonly following: (
    accountId: string,
    request: SocialPageRequest,
  ) => Effect.Effect<Page<Related>, E, R>;
  /** The viewer's own mutes, newest first. Fails `Unauthorized` when anonymous. */
  readonly muted: (request: SocialPageRequest) => Effect.Effect<Page<Related>, Unauthorized | E, R>;
  /** The viewer's own blocks, newest first. Fails `Unauthorized` when anonymous. */
  readonly blocked: (
    request: SocialPageRequest,
  ) => Effect.Effect<Page<Related>, Unauthorized | E, R>;
  /** Whether `a` and `b` may interact: neither blocks the other. Always true for one account with itself. */
  readonly interactionAllowed: (a: string, b: string) => Effect.Effect<boolean, E, R>;
  /**
   * The opt-in read filter that drops what the viewer silenced:
   * `column` (an author column) not in the accounts the viewer muted or
   * blocked, through `./filter`'s `notIn` (a `NULL` author is kept). The
   * anonymous have silenced nobody: `always`.
   */
  readonly silencedFilter: (column: string) => Effect.Effect<ListFilter<Following>, never, R>;
}

/** A page request clamped as every list's is (`SEC-INPUT-003`). */
const window = (request: SocialPageRequest) => ({
  limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
  offset: Math.max(0, Math.trunc(request.offset)),
});

/**
 * Bind the social graph's operations. Every operation is traced as
 * `social.<operation>`, and the writes run in the caller's transaction.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { defineSocial } from "@thomasfosterau/pulpit/social";
 * import { makeInMemorySocialStore } from "@thomasfosterau/pulpit/testing";
 *
 * const social = defineSocial({
 *   store: makeInMemorySocialStore(),
 *   viewer: Effect.succeedSome({ id: "u-1", role: "user" }),
 * });
 * const program = Effect.gen(function* () {
 *   yield* social.follow("u-2");
 *   return yield* social.following("u-1", { limit: 10, offset: 0 });
 * });
 * strictEqual(Effect.runSync(program).total, 1);
 * ```
 *
 * @since 0.1.0
 */
export const defineSocial = <Following, E, R>(
  definition: SocialDefinition<Following, E, R>,
): SocialOps<Following, E, R> => {
  const { store } = definition;
  const signedIn = signedInAs(definition.viewer);

  const assert = (kind: RelationshipKind, account: ViewerAccount, to: string) =>
    Effect.flatMap(nowDate, (at) =>
      Effect.map(store.add({ kind, from: account.id, to, at }), (changed) => ({ changed })),
    );
  const retract = (kind: RelationshipKind, operation: string) =>
    Effect.fn(`social.${operation}`)(function* (to: string) {
      const account = yield* signedIn;
      return { changed: yield* store.remove(kind, account.id, to) };
    });
  const notSelf = (kind: RelationshipKind, account: ViewerAccount, to: string) =>
    account.id === to ? Effect.fail(new SelfRelationship({ kind })) : Effect.void;

  const interactionAllowed = Effect.fn("social.interactionAllowed")(function* (
    a: string,
    b: string,
  ) {
    if (a === b) return true;
    return !(yield* store.has("block", a, b)) && !(yield* store.has("block", b, a));
  });

  const follow = Effect.fn("social.follow")(function* (to: string) {
    const account = yield* signedIn;
    yield* notSelf("follow", account, to);
    if (!(yield* interactionAllowed(account.id, to))) {
      return yield* new InteractionBlocked({ accountId: to });
    }
    return yield* assert("follow", account, to);
  });

  const mute = Effect.fn("social.mute")(function* (to: string) {
    const account = yield* signedIn;
    yield* notSelf("mute", account, to);
    return yield* assert("mute", account, to);
  });

  const block = Effect.fn("social.block")(function* (to: string) {
    const account = yield* signedIn;
    yield* notSelf("block", account, to);
    const written = yield* assert("block", account, to);
    // A block ends both follows between the two accounts.
    yield* store.remove("follow", to, account.id);
    yield* store.remove("follow", account.id, to);
    return written;
  });

  const visibleOnly = (viewer: Viewer, page: Page<Related>) =>
    definition.accounts === undefined || !Arr.isReadonlyArrayNonEmpty(page.rows)
      ? Effect.succeed(page)
      : Effect.map(
          definition.accounts.visible(
            viewer,
            Arr.map(page.rows, (row) => row.accountId),
          ),
          (shown) => ({
            rows: Arr.filter(page.rows, (row) => HashSet.has(shown, row.accountId)),
            total: page.total,
          }),
        );

  const publicList = (side: "from" | "to", operation: string) =>
    Effect.fn(`social.${operation}`)(function* (accountId: string, request: SocialPageRequest) {
      const viewer = yield* definition.viewer;
      const page = yield* store.list({ kind: "follow", side, accountId, ...window(request) });
      return yield* visibleOnly(viewer, page);
    });

  const ownList = (kind: RelationshipKind, operation: string) =>
    Effect.fn(`social.${operation}`)(function* (request: SocialPageRequest) {
      const account = yield* signedIn;
      return yield* store.list({ kind, side: "from", accountId: account.id, ...window(request) });
    });

  const silencedFilter = (column: string) =>
    Effect.map(definition.viewer, (viewer) =>
      Option.match(viewer, {
        onNone: (): ListFilter<Following> => always,
        onSome: (account): ListFilter<Following> => isNotIn(column, store.silencedBy(account.id)),
      }),
    );

  return {
    follow,
    unfollow: retract("follow", "unfollow"),
    mute,
    unmute: retract("mute", "unmute"),
    block,
    unblock: retract("block", "unblock"),
    followers: publicList("to", "followers"),
    following: publicList("from", "following"),
    muted: ownList("mute", "muted"),
    blocked: ownList("block", "blocked"),
    interactionAllowed,
    silencedFilter,
  };
};
