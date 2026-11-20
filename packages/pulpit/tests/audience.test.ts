/**
 * The membership family against the in-memory store: who may
 * add, remove and re-role a member (the group's owner and its admins), who
 * may leave (any member but the owner), who may read the member list (the
 * owner and the members; anyone else gets `GroupNotFound`), the group's
 * deletion (the owner alone), and the audience seam built from the store.
 * The `group` rows' read paths are pinned in `tests/subtype.test.ts` and
 * `tests/edges.test.ts`.
 *
 * @module tests/audience
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { audienceSeam, defineAudience, type MembershipRole } from "../src/Audience.ts";
import type { Viewer, ViewerAccount } from "../src/Subtype.ts";
import { makeInMemoryMembershipStore } from "../src/testing.ts";
import { member, NOW, otherMember } from "./fixtures.ts";

const owner: ViewerAccount = { id: "u-owner", role: "user" };
const groupAdmin: ViewerAccount = { id: "u-admin", role: "user" };
const stranger: ViewerAccount = otherMember;
const GROUP = "g-1";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

/** `g-1` is owned by `owner`, with `groupAdmin` as an admin and `member` as a member. */
const world = () =>
  Effect.gen(function* () {
    const store = makeInMemoryMembershipStore();
    let viewer: Viewer = Option.none();
    const audience = defineAudience({
      store,
      groups: {
        ownerOf: (groupId) =>
          Effect.succeed(groupId === GROUP ? Option.some(owner.id) : Option.none()),
      },
      viewer: Effect.sync(() => viewer),
    });
    const seed = (accountId: string, role: MembershipRole, minute: number) =>
      store.add({
        groupId: GROUP,
        accountId,
        role,
        at: DateTime.toDate(DateTime.add(DateTime.makeUnsafe(NOW), { minutes: minute })),
      });
    // Joined in this order, which the member list's oldest-first order must keep.
    yield* seed(owner.id, "admin", 0);
    yield* seed(groupAdmin.id, "admin", 1);
    yield* seed(member.id, "member", 2);
    const as = (who: Viewer) => {
      viewer = who;
      return audience;
    };
    const roleOf = (accountId: string) => store.roleOf(GROUP, accountId);
    return { store, as, roleOf };
  });

describe("defineAudience — the managing writes", () => {
  const managers = [
    ["the owner", owner],
    ["an admin", groupAdmin],
  ] as const;

  it.effect.each(managers)("%s adds, re-roles and removes a member", ([_name, who]) =>
    Effect.gen(function* () {
      const { as, roleOf } = yield* world();
      expect(yield* as(Option.some(who)).addMember(GROUP, stranger.id)).toEqual({
        changed: true,
      });
      expect(yield* roleOf(stranger.id)).toEqual(Option.some("member"));
      // Adding again changes nothing.
      expect(yield* as(Option.some(who)).addMember(GROUP, stranger.id, "admin")).toEqual({
        changed: false,
      });
      expect(yield* as(Option.some(who)).setRole(GROUP, stranger.id, "admin")).toEqual({
        changed: true,
      });
      expect(yield* roleOf(stranger.id)).toEqual(Option.some("admin"));
      expect(yield* as(Option.some(who)).setRole(GROUP, stranger.id, "admin")).toEqual({
        changed: false,
      });
      expect(yield* as(Option.some(who)).removeMember(GROUP, stranger.id)).toEqual({
        changed: true,
      });
      expect(yield* as(Option.some(who)).removeMember(GROUP, stranger.id)).toEqual({
        changed: false,
      });
      expect(yield* roleOf(stranger.id)).toEqual(Option.none());
    }),
  );

  const refusals = Arr.flatMap(
    [
      ["anonymous", Option.none(), "Unauthorized"],
      ["a member", Option.some(member), "Forbidden"],
      ["a stranger", Option.some(stranger), "Forbidden"],
    ] as const,
    ([name, who, tag]) =>
      Arr.map(
        [
          [
            "addMember",
            (ops: ReturnType<Effect.Success<ReturnType<typeof world>>["as"]>) =>
              ops.addMember(GROUP, "u-new"),
          ],
          [
            "removeMember",
            (ops: ReturnType<Effect.Success<ReturnType<typeof world>>["as"]>) =>
              ops.removeMember(GROUP, member.id),
          ],
          [
            "setRole",
            (ops: ReturnType<Effect.Success<ReturnType<typeof world>>["as"]>) =>
              ops.setRole(GROUP, member.id, "admin"),
          ],
        ] as const,
        ([operation, call]) => ({ label: `${operation} by ${name}`, who, call, tag }),
      ),
  );

  it.effect.each(refusals)("$label is refused, and writes nothing", ({ who, call, tag }) =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      const before = store.rows();
      expect(yield* tagOf(call(as(who)))).toEqual(Option.some(tag));
      expect(store.rows()).toEqual(before);
    }),
  );

  it.effect("an unknown group is GroupNotFound for every operation", () =>
    Effect.gen(function* () {
      const { as } = yield* world();
      const ops = as(Option.some(owner));
      expect(yield* tagOf(ops.addMember("g-none", member.id))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(ops.removeMember("g-none", member.id))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(ops.setRole("g-none", member.id, "admin"))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(ops.leave("g-none"))).toEqual(Option.some("GroupNotFound"));
      expect(yield* tagOf(ops.members("g-none", { limit: 10, offset: 0 }))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(ops.removeGroup("g-none"))).toEqual(Option.some("GroupNotFound"));
    }),
  );

  it.effect("the owner can't be removed or re-roled, even by an admin", () =>
    Effect.gen(function* () {
      const { as, roleOf } = yield* world();
      expect(yield* tagOf(as(Option.some(groupAdmin)).removeMember(GROUP, owner.id))).toEqual(
        Option.some("GroupOwnerMembership"),
      );
      expect(yield* tagOf(as(Option.some(owner)).setRole(GROUP, owner.id, "member"))).toEqual(
        Option.some("GroupOwnerMembership"),
      );
      expect(yield* roleOf(owner.id)).toEqual(Option.some("admin"));
    }),
  );

  it.effect("re-roling a non-member is MemberNotFound", () =>
    Effect.gen(function* () {
      const { as } = yield* world();
      expect(yield* tagOf(as(Option.some(owner)).setRole(GROUP, stranger.id, "admin"))).toEqual(
        Option.some("MemberNotFound"),
      );
    }),
  );
});

describe("defineAudience — leaving", () => {
  it.effect("a member leaves; leaving again is MemberNotFound", () =>
    Effect.gen(function* () {
      const { as, roleOf } = yield* world();
      yield* as(Option.some(member)).leave(GROUP);
      expect(yield* roleOf(member.id)).toEqual(Option.none());
      expect(yield* tagOf(as(Option.some(member)).leave(GROUP))).toEqual(
        Option.some("MemberNotFound"),
      );
    }),
  );

  it.effect("the owner can't leave; the anonymous are Unauthorized", () =>
    Effect.gen(function* () {
      const { as } = yield* world();
      expect(yield* tagOf(as(Option.some(owner)).leave(GROUP))).toEqual(
        Option.some("GroupOwnerMembership"),
      );
      expect(yield* tagOf(as(Option.none()).leave(GROUP))).toEqual(Option.some("Unauthorized"));
    }),
  );
});

describe("defineAudience — the member list", () => {
  it.effect.each([
    ["the owner", owner],
    ["an admin", groupAdmin],
    ["a member", member],
  ] as const)("%s reads it, oldest first, the page clamped", ([_name, who]) =>
    Effect.gen(function* () {
      const { as } = yield* world();
      const page = yield* as(Option.some(who)).members(GROUP, { limit: 0, offset: -3 });
      expect(page.total).toBe(3);
      expect(page.rows.map((row) => row.accountId)).toEqual([owner.id]);
      const all = yield* as(Option.some(who)).members(GROUP, { limit: 1e9, offset: 0 });
      expect(all.rows.map((row) => [row.accountId, row.role])).toEqual([
        [owner.id, "admin"],
        [groupAdmin.id, "admin"],
        [member.id, "member"],
      ]);
    }),
  );

  it.effect("a stranger gets GroupNotFound, never Forbidden (SEC-AUTH-ENUM-001)", () =>
    Effect.gen(function* () {
      const { as } = yield* world();
      expect(
        yield* tagOf(as(Option.some(stranger)).members(GROUP, { limit: 10, offset: 0 })),
      ).toEqual(Option.some("GroupNotFound"));
    }),
  );
});

describe("defineAudience — deleting the group", () => {
  it.effect("the owner deletes every membership, and the group's rows open to no member", () =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      const seam = audienceSeam(store);
      expect(yield* seam.isMember(member.id, GROUP)).toBe(true);
      expect(yield* as(Option.some(owner)).removeGroup(GROUP)).toBe(3);
      expect(store.rows()).toEqual([]);
      expect(yield* seam.isMember(member.id, GROUP)).toBe(false);
      expect(HashSet.size(seam.groups(member.id))).toBe(0);
    }),
  );

  it.effect.each([
    ["an admin", groupAdmin],
    ["a member", member],
  ] as const)("%s can't delete it", ([_name, who]) =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      expect(yield* tagOf(as(Option.some(who)).removeGroup(GROUP))).toEqual(
        Option.some("Forbidden"),
      );
      expect(store.rows()).toHaveLength(3);
    }),
  );
});

describe("the audience seam and the store", () => {
  it.effect("answers membership one row at a time and as a set", () =>
    Effect.gen(function* () {
      const { store } = yield* world();
      const seam = audienceSeam(store);
      expect(yield* seam.isMember(member.id, GROUP)).toBe(true);
      expect(yield* seam.isMember(stranger.id, GROUP)).toBe(false);
      expect(seam.groups(member.id)).toEqual(HashSet.make(GROUP));
      expect(seam.groups(stranger.id)).toEqual(HashSet.empty());
    }),
  );

  it.effect("erases an account's memberships", () =>
    Effect.gen(function* () {
      const { store } = yield* world();
      yield* store.add({ groupId: "g-2", accountId: member.id, role: "member", at: NOW });
      expect(yield* store.eraseAccount(member.id, 10)).toBe(2);
      expect(store.rows().map((row) => row.accountId)).toEqual([owner.id, groupAdmin.id]);
    }),
  );

  it.effect(
    "erases at most `limit` rows, invitations to and from the account counted with its memberships",
    () =>
      Effect.gen(function* () {
        const { store } = yield* world();
        yield* store.add({ groupId: "g-2", accountId: member.id, role: "member", at: NOW });
        const invite = (groupId: string, accountId: string, invitedBy: string) =>
          store.invite({ groupId, accountId, role: "member", invitedBy, at: NOW });
        yield* invite("g-3", member.id, owner.id);
        yield* invite(GROUP, stranger.id, member.id);
        yield* invite("g-2", "u-other-invitee", owner.id);
        const erase = (limit: number) => store.eraseAccount(member.id, limit);
        // Two memberships and two invitations: batches of 3, then 1, then none.
        expect(yield* erase(3)).toBe(3);
        expect(store.rows().map((row) => row.accountId)).toEqual([owner.id, groupAdmin.id]);
        expect(store.pending()).toHaveLength(2);
        expect(yield* erase(3)).toBe(1);
        expect(store.pending().map((row) => row.accountId)).toEqual(["u-other-invitee"]);
        expect(yield* erase(3)).toBe(0);
        expect(yield* erase(0)).toBe(0);
      }),
  );
});

describe("defineAudience — invitations", () => {
  const invitee: ViewerAccount = { id: "u-invitee", role: "user" };
  const pageAll = { limit: 100, offset: 0 };

  const managers = [
    ["the owner", owner],
    ["an admin", groupAdmin],
  ] as const;

  it.effect.each(managers)(
    "%s invites; the invitee is pending, not a member, until they accept",
    ([_name, who]) =>
      Effect.gen(function* () {
        const { as, store, roleOf } = yield* world();
        const seam = audienceSeam(store);
        expect(yield* as(Option.some(who)).invite(GROUP, invitee.id, "admin")).toEqual({
          changed: true,
        });
        // Inviting again changes nothing.
        expect(yield* as(Option.some(who)).invite(GROUP, invitee.id)).toEqual({
          changed: false,
        });
        expect(yield* roleOf(invitee.id)).toEqual(Option.none());
        expect(yield* seam.isMember(invitee.id, GROUP)).toBe(false);
        expect(HashSet.size(seam.groups(invitee.id))).toBe(0);
        expect(
          (yield* as(Option.some(owner)).members(GROUP, pageAll)).rows.map((row) => row.accountId),
        ).not.toContain(invitee.id);
        expect(
          (yield* as(Option.some(who)).invitations(GROUP, pageAll)).rows.map((row) => [
            row.accountId,
            row.role,
            row.invitedBy,
          ]),
        ).toEqual([[invitee.id, "admin", who.id]]);

        yield* as(Option.some(invitee)).accept(GROUP);
        expect(yield* roleOf(invitee.id)).toEqual(Option.some("admin"));
        expect(yield* seam.isMember(invitee.id, GROUP)).toBe(true);
        expect(store.pending()).toEqual([]);
      }),
  );

  it.effect("a pending admin invitation manages nothing until accepted", () =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      yield* as(Option.some(owner)).invite(GROUP, invitee.id, "admin");
      const pendingOps = as(Option.some(invitee));
      expect(yield* tagOf(pendingOps.addMember(GROUP, "u-new"))).toEqual(Option.some("Forbidden"));
      expect(yield* tagOf(pendingOps.invite(GROUP, "u-new"))).toEqual(Option.some("Forbidden"));
      expect(yield* tagOf(pendingOps.revoke(GROUP, invitee.id))).toEqual(Option.some("Forbidden"));
      expect(yield* tagOf(pendingOps.members(GROUP, pageAll))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(pendingOps.invitations(GROUP, pageAll))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(pendingOps.leave(GROUP))).toEqual(Option.some("MemberNotFound"));
      expect(store.rows().map((row) => row.accountId)).not.toContain("u-new");
    }),
  );

  it.effect(
    "the invitee declines; the invitation is gone and accepting it is InvitationNotFound",
    () =>
      Effect.gen(function* () {
        const { as, store, roleOf } = yield* world();
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        yield* as(Option.some(invitee)).decline(GROUP);
        expect(store.pending()).toEqual([]);
        expect(yield* tagOf(as(Option.some(invitee)).accept(GROUP))).toEqual(
          Option.some("InvitationNotFound"),
        );
        expect(yield* tagOf(as(Option.some(invitee)).decline(GROUP))).toEqual(
          Option.some("InvitationNotFound"),
        );
        expect(yield* roleOf(invitee.id)).toEqual(Option.none());
      }),
  );

  it.effect.each(managers)(
    "%s revokes; accepting a revoked invitation is InvitationNotFound",
    ([_n, who]) =>
      Effect.gen(function* () {
        const { as, store } = yield* world();
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        yield* as(Option.some(who)).revoke(GROUP, invitee.id);
        expect(store.pending()).toEqual([]);
        expect(yield* tagOf(as(Option.some(invitee)).accept(GROUP))).toEqual(
          Option.some("InvitationNotFound"),
        );
        expect(yield* tagOf(as(Option.some(who)).revoke(GROUP, invitee.id))).toEqual(
          Option.some("InvitationNotFound"),
        );
      }),
  );

  const refusals = Arr.flatMap(
    [
      ["anonymous", Option.none(), "Unauthorized"],
      ["a member", Option.some(member), "Forbidden"],
      ["a stranger", Option.some(stranger), "Forbidden"],
    ] as const,
    ([name, who, tag]) =>
      Arr.map(
        [
          [
            "invite",
            (ops: ReturnType<Effect.Success<ReturnType<typeof world>>["as"]>) =>
              ops.invite(GROUP, invitee.id),
          ],
          [
            "revoke",
            (ops: ReturnType<Effect.Success<ReturnType<typeof world>>["as"]>) =>
              ops.revoke(GROUP, invitee.id),
          ],
        ] as const,
        ([operation, call]) => ({ label: `${operation} by ${name}`, who, call, tag }),
      ),
  );

  it.effect.each(refusals)("$label is refused, and writes nothing", ({ who, call, tag }) =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      yield* as(Option.some(owner)).invite(GROUP, invitee.id);
      const before = [store.rows(), store.pending()];
      expect(yield* tagOf<unknown, { readonly _tag: string }>(call(as(who)))).toEqual(
        Option.some(tag),
      );
      expect([store.rows(), store.pending()]).toEqual(before);
    }),
  );

  it.effect("refuses a self-invitation and an invitation for an active member", () =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      expect(yield* tagOf(as(Option.some(groupAdmin)).invite(GROUP, groupAdmin.id))).toEqual(
        Option.some("SelfInvitation"),
      );
      expect(yield* tagOf(as(Option.some(owner)).invite(GROUP, member.id))).toEqual(
        Option.some("AlreadyMember"),
      );
      expect(store.pending()).toEqual([]);
    }),
  );

  it.effect(
    "only the invitee accepts or declines: another account has no invitation to answer",
    () =>
      Effect.gen(function* () {
        const { as, store } = yield* world();
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        expect(yield* tagOf(as(Option.some(stranger)).accept(GROUP))).toEqual(
          Option.some("InvitationNotFound"),
        );
        expect(yield* tagOf(as(Option.some(stranger)).decline(GROUP))).toEqual(
          Option.some("InvitationNotFound"),
        );
        expect(yield* tagOf(as(Option.none()).accept(GROUP))).toEqual(Option.some("Unauthorized"));
        expect(store.pending()).toHaveLength(1);
      }),
  );

  it.effect("an unknown group is GroupNotFound for every invitation operation", () =>
    Effect.gen(function* () {
      const { as } = yield* world();
      const ops = as(Option.some(owner));
      expect(yield* tagOf(ops.invite("g-none", invitee.id))).toEqual(Option.some("GroupNotFound"));
      expect(yield* tagOf(ops.revoke("g-none", invitee.id))).toEqual(Option.some("GroupNotFound"));
      expect(yield* tagOf(ops.invitations("g-none", pageAll))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(as(Option.some(invitee)).accept("g-none"))).toEqual(
        Option.some("GroupNotFound"),
      );
      expect(yield* tagOf(as(Option.some(invitee)).decline("g-none"))).toEqual(
        Option.some("GroupNotFound"),
      );
    }),
  );

  it.effect(
    "the group's invitation list: managers read it, a member is Forbidden, a stranger GroupNotFound",
    () =>
      Effect.gen(function* () {
        const { as } = yield* world();
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        yield* as(Option.some(owner)).invite(GROUP, "u-second");
        const page = yield* as(Option.some(groupAdmin)).invitations(GROUP, { limit: 1, offset: 1 });
        expect(page.total).toBe(2);
        expect(page.rows).toHaveLength(1);
        expect(yield* tagOf(as(Option.some(member)).invitations(GROUP, pageAll))).toEqual(
          Option.some("Forbidden"),
        );
        expect(yield* tagOf(as(Option.some(stranger)).invitations(GROUP, pageAll))).toEqual(
          Option.some("GroupNotFound"),
        );
      }),
  );

  it.effect("the invitee reads their own invitations across groups", () =>
    Effect.gen(function* () {
      const { as, store } = yield* world();
      yield* as(Option.some(owner)).invite(GROUP, invitee.id);
      yield* store.invite({
        groupId: "g-2",
        accountId: invitee.id,
        role: "member",
        invitedBy: owner.id,
        at: NOW,
      });
      const mine = yield* as(Option.some(invitee)).myInvitations(pageAll);
      expect(mine.total).toBe(2);
      expect(mine.rows.map((row) => row.groupId).toSorted()).toEqual([GROUP, "g-2"]);
      expect((yield* as(Option.some(stranger)).myInvitations(pageAll)).total).toBe(0);
      expect(yield* tagOf(as(Option.none()).myInvitations(pageAll))).toEqual(
        Option.some("Unauthorized"),
      );
    }),
  );

  it.effect("a direct add supersedes a pending invitation", () =>
    Effect.gen(function* () {
      const { as, store, roleOf } = yield* world();
      yield* as(Option.some(owner)).invite(GROUP, invitee.id, "admin");
      expect(yield* as(Option.some(owner)).addMember(GROUP, invitee.id)).toEqual({
        changed: true,
      });
      expect(yield* roleOf(invitee.id)).toEqual(Option.some("member"));
      expect(store.pending()).toEqual([]);
    }),
  );

  it.effect(
    "removing a member leaves a pending invitation alone; deleting the group and erasure remove it",
    () =>
      Effect.gen(function* () {
        const { as, store } = yield* world();
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        expect(yield* as(Option.some(owner)).removeMember(GROUP, invitee.id)).toEqual({
          changed: false,
        });
        expect(store.pending()).toHaveLength(1);
        expect(yield* store.eraseAccount(invitee.id, 10)).toBe(1);
        expect(store.pending()).toEqual([]);
        yield* as(Option.some(groupAdmin)).invite(GROUP, invitee.id);
        // Erasing the inviter drops the invitations they sent.
        expect(yield* store.eraseAccount(groupAdmin.id, 10)).toBe(2);
        expect(store.pending()).toEqual([]);
        yield* as(Option.some(owner)).invite(GROUP, invitee.id);
        expect(yield* as(Option.some(owner)).removeGroup(GROUP)).toBe(3);
        expect(store.pending()).toEqual([]);
      }),
  );
});
