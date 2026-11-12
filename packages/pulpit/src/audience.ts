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
 * - **Members are added directly**, by account id, or **invited**
 *   (pulpit#227): an invitation is a pending membership that the invitee
 *   accepts or declines, and the owner or an admin revokes. A pending
 *   invitee is not a member: they read nothing the group's rows expose, a
 *   pending `admin` invitation manages nothing, and neither the member list
 *   nor any gate counts them until they accept.
 * - **The audience is the active membership rows.** {@link audienceSeam} answers
 *   from the store alone, so the owner reads a group's rows that others
 *   share only through a membership of their own: record one when the group
 *   is created.
 * - **Deleting a group** ({@link AudienceOps.removeGroup}) deletes every
 *   membership. Its rows then open to nobody but their owner and the
 *   view-private rung, so they read as `private`. The application clears the
 *   rows' group column too (in-the-dark's `ON DELETE SET NULL`); a column
 *   naming no group reads the same way.
 * - **Erasing a group's owner** (`./erasure`, owner decision on pulpit#274,
 *   2026-11-12): every group the erased account owns is reassigned to the
 *   application's tombstone account through a {@link GroupOwnerStore}, so
 *   its members keep reading its rows; then the account's own memberships
 *   go. The tombstone account holds no membership, so it reads nothing.
 *   The erasure definition's `disposeGroups` overrides the reassignment
 *   (deleting the groups, say, or handing them to an admin).
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#audience.
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

/**
 * One pending invitation (pulpit#227): `invitedBy` asked `accountId` to join
 * `groupId` with `role`, at `at`. It grants nothing until the invitee
 * accepts it, when it becomes a {@link Membership} with that role.
 *
 * @since 0.2.0
 */
export interface Invitation {
  readonly groupId: string;
  readonly accountId: string;
  readonly role: MembershipRole;
  readonly invitedBy: string;
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

/**
 * No pending invitation for the account to the group (never sent, already
 * accepted, declined or revoked): the wire's 404.
 *
 * @since 0.2.0
 */
export class InvitationNotFound extends Schema.TaggedError<
  InvitationNotFound,
  { readonly brand: unique symbol }
>()("InvitationNotFound", { groupId: Schema.String, accountId: Schema.String }) {}

/**
 * An invitation for an account that already is a member: the wire's 409.
 *
 * @since 0.2.0
 */
export class AlreadyMember extends Schema.TaggedError<
  AlreadyMember,
  { readonly brand: unique symbol }
>()("AlreadyMember", { groupId: Schema.String, accountId: Schema.String }) {}

/**
 * An invitation from an account to itself: the wire's 422.
 *
 * @since 0.2.0
 */
export class SelfInvitation extends Schema.TaggedError<
  SelfInvitation,
  { readonly brand: unique symbol }
>()("SelfInvitation", { groupId: Schema.String }) {}

// ── The seams ─────────────────────────────────────────────────────────

/**
 * The membership table an application supplies (in-the-dark's
 * `group_members`, gardeneria's `social.group_memberships`), keyed
 * `(group_id, account_id)` with a `role` column, a `status`
 * (`active | pending`, pulpit#227) and both foreign keys cascading. A
 * pending row is an invitation: only the invitation methods read or write
 * it, and every membership read (`roleOf`, `list`, `isMember`, `groupsOf`)
 * reads `status = 'active'` rows alone. A store seam: no policy, never
 * opens a transaction, fails only with its `E`. `Following` is the list
 * filter's `in` set (a subquery in SQL). See docs/seams.md.
 *
 * @since 0.2.0
 */
export interface MembershipStore<Following, E, R> {
  /**
   * Insert the active membership; whether a row was written. Over a pending
   * invitation for the same key it activates that row with this role (the
   * direct add supersedes the invitation); over an active one it changes
   * nothing.
   */
  readonly add: (membership: Membership) => Effect.Effect<boolean, E, R>;
  /** Set a member's role; whether a row changed (false for no such member, or the same role). */
  readonly setRole: (
    groupId: string,
    accountId: string,
    role: MembershipRole,
  ) => Effect.Effect<boolean, E, R>;
  /** Delete the active membership; whether a row went. A pending invitation is left alone. */
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
  /** Delete every membership of the group, pending invitations included; how many rows went. */
  readonly removeGroup: (groupId: string) => Effect.Effect<number, E, R>;
  /** Whether `accountId` is a member of `groupId`, as the audience seam asks it (never fails). */
  readonly isMember: (accountId: string, groupId: string) => Effect.Effect<boolean, never, R>;
  /**
   * The groups `accountId` is a member of, as the list filter's `in` set (a
   * subquery: `select group_id from memberships where account_id = $1`,
   * never an array).
   */
  readonly groupsOf: (accountId: string) => Following;
  /**
   * Delete at most `limit` rows of the account (account erasure, pulpit#207,
   * in bounded batches: `PERF-DB-001`, pulpit#274): its memberships, its
   * pending invitations and the pending invitations it sent, all counted
   * against the one `limit`; how many rows went. `./erasure` calls it again
   * until it deletes fewer than `limit`.
   */
  readonly eraseAccount: (accountId: string, limit: number) => Effect.Effect<number, E, R>;
  /**
   * Insert a pending invitation (pulpit#227); whether a row was written. Any
   * row already at the key, active or pending, makes it a no-op
   * (`ON CONFLICT DO NOTHING`).
   */
  readonly invite: (invitation: Invitation) => Effect.Effect<boolean, E, R>;
  /** The pending invitation at the key, or none. */
  readonly invitationOf: (
    groupId: string,
    accountId: string,
  ) => Effect.Effect<Option.Option<Invitation>, E, R>;
  /**
   * Turn the pending invitation at the key into an active membership with
   * the invitation's role, joined at `at`; whether a row changed (false when
   * there is no pending row).
   */
  readonly accept: (groupId: string, accountId: string, at: Date) => Effect.Effect<boolean, E, R>;
  /** Delete the pending invitation at the key; whether a row went. An active membership is left alone. */
  readonly removeInvitation: (groupId: string, accountId: string) => Effect.Effect<boolean, E, R>;
  /**
   * One page of pending invitations, oldest first (`at ASC`, then the other
   * key), with the unpaged total: a group's (`by: "group"`) or an account's
   * (`by: "account"`).
   */
  readonly invitations: (
    query: (
      | { readonly by: "group"; readonly groupId: string }
      | { readonly by: "account"; readonly accountId: string }
    ) & { readonly limit: number; readonly offset: number },
  ) => Effect.Effect<Page<Invitation>, E, R>;
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
 * The write half of the application's groups that account erasure needs
 * (pulpit#274): a bounded reassignment of the groups an account owns. The
 * same records {@link GroupOwnership} reads, so once a group is reassigned
 * its `ownerOf` answers the new owner. A store seam: no policy, never opens
 * a transaction, fails only with its `E`. See docs/seams.md.
 *
 * @since 0.2.0
 */
export interface GroupOwnerStore<E, R> {
  /**
   * Make `to` the owner of at most `limit` of the groups `accountId` owns
   * (`PERF-DB-001`); how many changed. A reassigned group no longer names
   * `accountId`, so a repeated call moves on to the rest and answers `0`
   * once none is left. Its memberships and invitations are left alone.
   */
  readonly reassignOwner: (
    accountId: string,
    to: string,
    limit: number,
  ) => Effect.Effect<number, E, R>;
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
 * `removeMember`, `setRole`, `invite`, `revoke`) fail `Forbidden` unless the
 * viewer is the group's owner or one of its active admins: a pending admin
 * invitation manages nothing.
 *
 * @since 0.2.0
 */
export interface AudienceOps<E, R> {
  /** Add `accountId` to the group with `role` (default `member`). Adding a member again changes nothing. */
  readonly addMember: (
    groupId: string,
    accountId: string,
    role?: MembershipRole,
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
   * Invite `accountId` to the group with `role` (default `member`), as a
   * pending membership (pulpit#227). Fails {@link SelfInvitation} for the
   * viewer themselves and {@link AlreadyMember} for an active member;
   * inviting an account already invited changes nothing.
   */
  readonly invite: (
    groupId: string,
    accountId: string,
    role?: MembershipRole,
  ) => Effect.Effect<
    { readonly changed: boolean },
    Unauthorized | Forbidden | GroupNotFound | SelfInvitation | AlreadyMember | E,
    R
  >;
  /**
   * Accept the viewer's own invitation: it becomes an active membership with
   * the invited role. Fails {@link InvitationNotFound} without one.
   */
  readonly accept: (
    groupId: string,
  ) => Effect.Effect<void, Unauthorized | GroupNotFound | InvitationNotFound | E, R>;
  /** Decline the viewer's own invitation. Fails {@link InvitationNotFound} without one. */
  readonly decline: (
    groupId: string,
  ) => Effect.Effect<void, Unauthorized | GroupNotFound | InvitationNotFound | E, R>;
  /** Withdraw `accountId`'s pending invitation. Fails {@link InvitationNotFound} without one. */
  readonly revoke: (
    groupId: string,
    accountId: string,
  ) => Effect.Effect<void, Unauthorized | Forbidden | GroupNotFound | InvitationNotFound | E, R>;
  /**
   * One page of the group's pending invitations, oldest first: its owner's
   * and admins'. A member gets `Forbidden`; anyone else (a pending invitee
   * included) {@link GroupNotFound}.
   */
  readonly invitations: (
    groupId: string,
    request: MembersPageRequest,
  ) => Effect.Effect<Page<Invitation>, Unauthorized | Forbidden | GroupNotFound | E, R>;
  /** One page of the viewer's own pending invitations, oldest first. */
  readonly myInvitations: (
    request: MembersPageRequest,
  ) => Effect.Effect<Page<Invitation>, Unauthorized | E, R>;
  /**
   * The group's deletion: delete every membership and invitation, so its `group` rows read
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
      return yield* new Forbidden({ message: "Only the group's owner or an admin may manage it." });
    });

  const notOwner = (groupId: string, owner: string, accountId: string) =>
    accountId === owner ? Effect.fail(new GroupOwnerMembership({ groupId })) : Effect.void;

  const addMember = Effect.fn("audience.addMember")(function* (
    groupId: string,
    accountId: string,
    role: MembershipRole = "member",
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
    yield* Effect.filterOrFail(
      store.remove(groupId, account.id),
      (done) => done,
      () => new MemberNotFound({ groupId, accountId: account.id }),
    );
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
    if (account.id !== owner) {
      return yield* new Forbidden({ message: "Only the group's owner may remove it." });
    }
    return yield* store.removeGroup(groupId);
  });

  const invite = Effect.fn("audience.invite")(function* (
    groupId: string,
    accountId: string,
    role: MembershipRole = "member",
  ) {
    const { account } = yield* manager(groupId);
    if (accountId === account.id) return yield* new SelfInvitation({ groupId });
    if (Option.isSome(yield* store.roleOf(groupId, accountId))) {
      return yield* new AlreadyMember({ groupId, accountId });
    }
    const at = yield* nowDate;
    return {
      changed: yield* store.invite({ groupId, accountId, role, invitedBy: account.id, at }),
    };
  });

  /** The signed-in invitee and an existing group, or the operation's failure. */
  const invitee = (groupId: string) => Effect.tap(signedIn, () => ownerOf(groupId));

  const accept = Effect.fn("audience.accept")(function* (groupId: string) {
    const account = yield* invitee(groupId);
    const at = yield* nowDate;
    yield* Effect.filterOrFail(
      store.accept(groupId, account.id, at),
      (done) => done,
      () => new InvitationNotFound({ groupId, accountId: account.id }),
    );
  });

  const decline = Effect.fn("audience.decline")(function* (groupId: string) {
    const account = yield* invitee(groupId);
    yield* Effect.filterOrFail(
      store.removeInvitation(groupId, account.id),
      (done) => done,
      () => new InvitationNotFound({ groupId, accountId: account.id }),
    );
  });

  const revoke = Effect.fn("audience.revoke")(function* (groupId: string, accountId: string) {
    yield* manager(groupId);
    yield* Effect.filterOrFail(
      store.removeInvitation(groupId, accountId),
      (done) => done,
      () => new InvitationNotFound({ groupId, accountId }),
    );
  });

  const invitations = Effect.fn("audience.invitations")(function* (
    groupId: string,
    request: MembersPageRequest,
  ) {
    const account = yield* signedIn;
    const owner = yield* ownerOf(groupId);
    const role =
      account.id === owner ? Option.some("admin") : yield* store.roleOf(groupId, account.id);
    if (Option.isNone(role)) return yield* new GroupNotFound({ groupId });
    if (role.value !== "admin")
      return yield* new Forbidden({
        message: "Only the group's owner or an admin may list its invitations.",
      });
    return yield* store.invitations({ by: "group", groupId, ...window(request) });
  });

  const myInvitations = Effect.fn("audience.myInvitations")(function* (
    request: MembersPageRequest,
  ) {
    const account = yield* signedIn;
    return yield* store.invitations({ by: "account", accountId: account.id, ...window(request) });
  });

  return {
    addMember,
    removeMember,
    setRole,
    leave,
    members,
    removeGroup,
    invite,
    accept,
    decline,
    revoke,
    invitations,
    myInvitations,
  };
};
