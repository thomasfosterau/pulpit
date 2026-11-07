/**
 * **Audiences** (pulpit#194) — named groups of accounts that a row can be
 * shared with, as the `group` visibility state. A membership family with its
 * own gates, and the audience seam built from it, so `group` rows work end to
 * end through `./subtype`, `./edges` and search.
 *
 * The behavioural spec is in-the-dark's groups (`group.ts`, `group-member.ts`,
 * `operations/groups.ts`, `operations/group-members.ts`: an owner plus
 * members with the role `member | admin`, admins manage members, members can
 * only leave) and gardeneria's `social.group_memberships`.
 *
 * ## The model (owner decisions on pulpit#194)
 *
 * - **A group is the application's**: the kernel never stores one. It reads
 *   a group's owner through {@link GroupOwnership} and keeps its memberships
 *   in a {@link MembershipStore}, keyed `(groupId, accountId)`.
 * - **The owner and the admins manage members**: add, remove and set a
 *   member's role. A member may only leave. The owner can't leave or be
 *   removed ({@link GroupOwnerMembership}).
 * - **Members are added directly**, by account id. Invitations and consent
 *   are a later slice (pulpit#227).
 * - **The audience is the membership rows.** {@link audienceSeam} answers
 *   from the store alone, so the owner reads a group's rows that others
 *   share only through a membership of their own: record one when the group
 *   is created.
 * - **Deleting a group** ({@link AudienceOps.removeGroup}) deletes every
 *   membership. Its rows then open to nobody but their owner and the
 *   view-private rung, so they read as `private`. The application clears the
 *   rows' group column too (in-the-dark's `ON DELETE SET NULL`); a column
 *   naming no group reads the same way.
 *
 * @copyright Thomas Foster
 * @module pulpit/audience
 * @since 0.2.0
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { nowDate, signedIn as signedInAs } from "./internal/plain-rows.ts";
import {
  Forbidden,
  MAX_PAGE_LIMIT,
  type Page,
  type Unauthorized,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * A member's role in a group: `admin` manages members, `member` only reads
 * and may leave.
 *
 * @since 0.2.0
 */
export const MembershipRole = Schema.Literals(["member", "admin"]);
/**
 * The {@link MembershipRole} literal union.
 *
 * @since 0.2.0
 */
export type MembershipRole = typeof MembershipRole.Type;

/**
 * One stored membership: `accountId` belongs to `groupId` with `role`, since `at`.
 *
 * @since 0.2.0
 */
export interface Membership {
  readonly groupId: string;
  readonly accountId: string;
  readonly role: MembershipRole;
  readonly at: Date;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * No such group, or one the viewer may not see the members of: the wire's
 * 404. A stranger asking for a group's members gets this, never `Forbidden`,
 * so the answer confirms no group (`SEC-AUTH-ENUM-001`).
 *
 * @since 0.2.0
 */
export class GroupNotFound extends Schema.TaggedError<
  GroupNotFound,
  { readonly brand: unique symbol }
>()("GroupNotFound", { groupId: Schema.String }) {}

/**
 * The account is not a member of the group: the wire's 404.
 *
 * @since 0.2.0
 */
export class MemberNotFound extends Schema.TaggedError<
  MemberNotFound,
  { readonly brand: unique symbol }
>()("MemberNotFound", { groupId: Schema.String, accountId: Schema.String }) {}

/**
 * The group's owner can't leave it, be removed from it or have their role
 * changed: the wire's 409. Delete the group instead.
 *
 * @since 0.2.0
 */
export class GroupOwnerMembership extends Schema.TaggedError<
  GroupOwnerMembership,
  { readonly brand: unique symbol }
>()("GroupOwnerMembership", { groupId: Schema.String }) {}

// ── The seams ─────────────────────────────────────────────────────────

/**
 * The membership table an application supplies (in-the-dark's
 * `group_members`, gardeneria's `social.group_memberships`), keyed
 * `(group_id, account_id)` with a `role` column and both foreign keys
 * cascading. A store seam: no policy, never opens a transaction, fails only
 * with its `E`. `Following` is the list filter's `in` set (a subquery in
 * SQL). See the package README → Seams.
 *
 * @since 0.2.0
 */
export interface MembershipStore<Following, E, R> {
  /** Insert the membership (`ON CONFLICT DO NOTHING`); whether a row was written. */
  readonly add: (membership: Membership) => Effect.Effect<boolean, E, R>;
  /** Set a member's role; whether a row changed (false for no such member, or the same role). */
  readonly setRole: (
    groupId: string,
    accountId: string,
    role: MembershipRole,
  ) => Effect.Effect<boolean, E, R>;
  /** Delete the membership; whether a row went. */
  readonly remove: (groupId: string, accountId: string) => Effect.Effect<boolean, E, R>;
  /** The account's role in the group, or none when it isn't a member. */
  readonly roleOf: (
    groupId: string,
    accountId: string,
  ) => Effect.Effect<Option.Option<MembershipRole>, E, R>;
  /** One page of a group's members, oldest first (`at ASC`, then the account id), with the unpaged total. */
  readonly list: (query: {
    readonly groupId: string;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<Omit<Membership, "groupId">>, E, R>;
  /** Delete every membership of the group; how many went. */
  readonly removeGroup: (groupId: string) => Effect.Effect<number, E, R>;
  /** Whether `accountId` is a member of `groupId`, as the audience seam asks it (never fails). */
  readonly isMember: (accountId: string, groupId: string) => Effect.Effect<boolean, never, R>;
  /**
   * The groups `accountId` is a member of, as the list filter's `in` set (a
   * subquery: `select group_id from memberships where account_id = $1`,
   * never an array).
   */
  readonly groupsOf: (accountId: string) => Following;
  /** Delete every membership of the account (account erasure, pulpit#207); how many went. */
  readonly eraseAccount: (accountId: string) => Effect.Effect<number, E, R>;
}

/**
 * The application's groups: who owns one. None for a group that doesn't
 * exist (never created, or deleted).
 *
 * @since 0.2.0
 */
export interface GroupOwnership<E, R> {
  readonly ownerOf: (groupId: string) => Effect.Effect<Option.Option<string>, E, R>;
}

/**
 * The audience half of `./subtype`'s `FollowerSeam`: its `isMember` /
 * `groups` pair, both present.
 *
 * @since 0.2.0
 */
export interface AudienceSeam<Following, R> {
  /** Whether `accountId` is a member of `groupId`. */
  readonly isMember: (accountId: string, groupId: string) => Effect.Effect<boolean, never, R>;
  /** The groups `accountId` is a member of, as the list filter's `in` set. */
  readonly groups: (accountId: string) => Following;
}

/**
 * The audience half of `./subtype`'s `FollowerSeam`, built from a
 * membership store: spread it into the follower seam a leaf or an edge
 * family takes, so a `group` row is readable by the members of the group it
 * names.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { audienceSeam } from "@thomasfosterau/pulpit/audience";
 * import { makeInMemoryFollowers, makeInMemoryMembershipStore } from "@thomasfosterau/pulpit/testing";
 *
 * const store = makeInMemoryMembershipStore();
 * Effect.runSync(store.add({ groupId: "g-1", accountId: "u-1", role: "member", at: new Date(0) }));
 * const seam = { ...makeInMemoryFollowers([]), ...audienceSeam(store) };
 * strictEqual(Effect.runSync(seam.isMember("u-1", "g-1")), true);
 * strictEqual(Effect.runSync(seam.isMember("u-2", "g-1")), false);
 * ```
 *
 * @since 0.2.0
 */
export const audienceSeam = <Following, E, R>(
  store: Pick<MembershipStore<Following, E, R>, "isMember" | "groupsOf">,
): AudienceSeam<Following, R> => ({
  isMember: store.isMember,
  groups: store.groupsOf,
});

// ── The operations ────────────────────────────────────────────────────

/**
 * The membership family's declaration.
 *
 * @since 0.2.0
 */
export interface AudienceDefinition<Following, E, R> {
  readonly store: MembershipStore<Following, E, R>;
  readonly groups: GroupOwnership<E, R>;
  /** The request's viewer. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
}

/**
 * A page request: clamped to `[1, MAX_PAGE_LIMIT]` and an offset `≥ 0`.
 *
 * @since 0.2.0
 */
export interface MembersPageRequest {
  readonly limit: number;
  readonly offset: number;
}

/**
 * The operations {@link defineAudience} produces. Every operation fails
 * `Unauthorized` when anonymous and {@link GroupNotFound} for a group the
 * application doesn't know. The managing writes (`addMember`,
 * `removeMember`, `setRole`) fail `Forbidden` unless the viewer is the
 * group's owner or one of its admins.
 *
 * @since 0.2.0
 */
export interface AudienceOps<E, R> {
  /** Add `accountId` to the group with `role` (default `member`). Adding a member again changes nothing. */
  readonly addMember: (
    groupId: string,
    accountId: string,
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional parameter is `?: T | undefined` (AGENTS.md → Conventions); the omitted value is `member`
    role?: MembershipRole | undefined,
  ) => Effect.Effect<
    { readonly changed: boolean },
    Unauthorized | Forbidden | GroupNotFound | E,
    R
  >;
  /**
   * Remove `accountId` from the group. Fails {@link GroupOwnerMembership}
   * for the group's owner; removing a non-member changes nothing.
   */
  readonly removeMember: (
    groupId: string,
    accountId: string,
  ) => Effect.Effect<
    { readonly changed: boolean },
    Unauthorized | Forbidden | GroupNotFound | GroupOwnerMembership | E,
    R
  >;
  /**
   * Set a member's role. Fails {@link MemberNotFound} for a non-member and
   * {@link GroupOwnerMembership} for the group's owner.
   */
  readonly setRole: (
    groupId: string,
    accountId: string,
    role: MembershipRole,
  ) => Effect.Effect<
    { readonly changed: boolean },
    Unauthorized | Forbidden | GroupNotFound | MemberNotFound | GroupOwnerMembership | E,
    R
  >;
  /**
   * Leave the group. Fails {@link MemberNotFound} when the viewer isn't a
   * member and {@link GroupOwnerMembership} for its owner.
   */
  readonly leave: (
    groupId: string,
  ) => Effect.Effect<
    void,
    Unauthorized | GroupNotFound | MemberNotFound | GroupOwnerMembership | E,
    R
  >;
  /**
   * One page of the group's members, oldest first. Only its owner and its
   * members may read it; anyone else gets {@link GroupNotFound}.
   */
  readonly members: (
    groupId: string,
    request: MembersPageRequest,
  ) => Effect.Effect<Page<Omit<Membership, "groupId">>, Unauthorized | GroupNotFound | E, R>;
  /**
   * The group's deletion: delete every membership, so its `group` rows read
   * as `private`. The owner only (`Forbidden` for anyone else); how many
   * memberships went. Call it in the transaction that deletes the group.
   */
  readonly removeGroup: (
    groupId: string,
  ) => Effect.Effect<number, Unauthorized | Forbidden | GroupNotFound | E, R>;
}

const window = (request: MembersPageRequest) => ({
  limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
  offset: Math.max(0, Math.trunc(request.offset)),
});

/**
 * Bind the membership family's operations. Every operation is traced as
 * `audience.<operation>`, and the writes run in the caller's transaction.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { defineAudience } from "@thomasfosterau/pulpit/audience";
 * import { makeInMemoryMembershipStore } from "@thomasfosterau/pulpit/testing";
 *
 * const audience = defineAudience({
 *   store: makeInMemoryMembershipStore(),
 *   groups: { ownerOf: (groupId) => Effect.succeed(groupId === "g-1" ? Option.some("u-1") : Option.none()) },
 *   viewer: Effect.succeedSome({ id: "u-1", role: "user" }),
 * });
 * const program = Effect.gen(function* () {
 *   yield* audience.addMember("g-1", "u-2");
 *   return yield* audience.members("g-1", { limit: 10, offset: 0 });
 * });
 * strictEqual(Effect.runSync(program).total, 1);
 * ```
 *
 * @since 0.2.0
 */
export const defineAudience = <Following, E, R>(
  definition: AudienceDefinition<Following, E, R>,
): AudienceOps<E, R> => {
  const { store, groups } = definition;
  const signedIn = signedInAs(definition.viewer);

  /** The group's owner, or {@link GroupNotFound}. */
  const ownerOf = (groupId: string) =>
    Effect.flatMap(groups.ownerOf(groupId), (owner) =>
      Effect.fromOption(owner, () => new GroupNotFound({ groupId })),
    );

  /** The signed-in viewer, if they own the group or are one of its admins; else `Forbidden`. */
  const manager = (groupId: string) =>
    Effect.gen(function* () {
      const account = yield* signedIn;
      const owner = yield* ownerOf(groupId);
      if (account.id === owner) return { account, owner };
      const role = yield* store.roleOf(groupId, account.id);
      if (Option.contains(role, "admin")) return { account, owner };
      return yield* new Forbidden();
    });

  const notOwner = (groupId: string, owner: string, accountId: string) =>
    accountId === owner ? Effect.fail(new GroupOwnerMembership({ groupId })) : Effect.void;

  const addMember = Effect.fn("audience.addMember")(function* (
    groupId: string,
    accountId: string,
    // oxlint-disable-next-line effect/prefer-option-over-null -- `AudienceOps.addMember`'s optional parameter, defaulted here
    role: MembershipRole | undefined = "member",
  ) {
    yield* manager(groupId);
    const at = yield* nowDate;
    return { changed: yield* store.add({ groupId, accountId, role, at }) };
  });

  const removeMember = Effect.fn("audience.removeMember")(function* (
    groupId: string,
    accountId: string,
  ) {
    const { owner } = yield* manager(groupId);
    yield* notOwner(groupId, owner, accountId);
    return { changed: yield* store.remove(groupId, accountId) };
  });

  const setRole = Effect.fn("audience.setRole")(function* (
    groupId: string,
    accountId: string,
    role: MembershipRole,
  ) {
    const { owner } = yield* manager(groupId);
    yield* notOwner(groupId, owner, accountId);
    if (Option.isNone(yield* store.roleOf(groupId, accountId))) {
      return yield* new MemberNotFound({ groupId, accountId });
    }
    return { changed: yield* store.setRole(groupId, accountId, role) };
  });

  const leave = Effect.fn("audience.leave")(function* (groupId: string) {
    const account: ViewerAccount = yield* signedIn;
    const owner = yield* ownerOf(groupId);
    yield* notOwner(groupId, owner, account.id);
    if (!(yield* store.remove(groupId, account.id))) {
      return yield* new MemberNotFound({ groupId, accountId: account.id });
    }
  });

  const members = Effect.fn("audience.members")(function* (
    groupId: string,
    request: MembersPageRequest,
  ) {
    const account = yield* signedIn;
    const owner = yield* ownerOf(groupId);
    if (account.id !== owner && Option.isNone(yield* store.roleOf(groupId, account.id))) {
      return yield* new GroupNotFound({ groupId });
    }
    return yield* store.list({ groupId, ...window(request) });
  });

  const removeGroup = Effect.fn("audience.removeGroup")(function* (groupId: string) {
    const account = yield* signedIn;
    const owner = yield* ownerOf(groupId);
    if (account.id !== owner) return yield* new Forbidden();
    return yield* store.removeGroup(groupId);
  });

  return { addMember, removeMember, setRole, leave, members, removeGroup };
};
