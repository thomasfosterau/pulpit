/**
 * The membership family (pulpit#194) against the in-memory store: who may
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
import { describe, expect, it } from "vite-plus/test";
import { audienceSeam, defineAudience, type MembershipRole } from "../src/audience.ts";
import type { Viewer, ViewerAccount } from "../src/subtype.ts";
import { makeInMemoryMembershipStore } from "../src/testing.ts";
import { member, NOW, otherMember } from "./fixtures.ts";

const owner: ViewerAccount = { id: "u-owner", role: "user" };
const groupAdmin: ViewerAccount = { id: "u-admin", role: "user" };
const stranger: ViewerAccount = otherMember;
const GROUP = "g-1";

const tagOf = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Option.Option<string> => {
  const exit = Effect.runSyncExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

/** `g-1` is owned by `owner`, with `groupAdmin` as an admin and `member` as a member. */
const world = () => {
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
    Effect.runSync(
      store.add({
        groupId: GROUP,
        accountId,
        role,
        at: DateTime.toDate(DateTime.add(DateTime.makeUnsafe(NOW), { minutes: minute })),
      }),
    );
  // Joined in this order, which the member list's oldest-first order must keep.
  seed(owner.id, "admin", 0);
  seed(groupAdmin.id, "admin", 1);
  seed(member.id, "member", 2);
  const as = (who: Viewer) => {
    viewer = who;
    return audience;
  };
  const roleOf = (accountId: string) => Effect.runSync(store.roleOf(GROUP, accountId));
  return { store, as, roleOf };
};

describe("defineAudience — the managing writes", () => {
  const managers = [
    ["the owner", owner],
    ["an admin", groupAdmin],
  ] as const;

  it.each(managers)("%s adds, re-roles and removes a member", (_name, who) => {
    const { as, roleOf } = world();
    expect(Effect.runSync(as(Option.some(who)).addMember(GROUP, stranger.id))).toEqual({
      changed: true,
    });
    expect(roleOf(stranger.id)).toEqual(Option.some("member"));
    // Adding again changes nothing.
    expect(Effect.runSync(as(Option.some(who)).addMember(GROUP, stranger.id, "admin"))).toEqual({
      changed: false,
    });
    expect(Effect.runSync(as(Option.some(who)).setRole(GROUP, stranger.id, "admin"))).toEqual({
      changed: true,
    });
    expect(roleOf(stranger.id)).toEqual(Option.some("admin"));
    expect(Effect.runSync(as(Option.some(who)).setRole(GROUP, stranger.id, "admin"))).toEqual({
      changed: false,
    });
    expect(Effect.runSync(as(Option.some(who)).removeMember(GROUP, stranger.id))).toEqual({
      changed: true,
    });
    expect(Effect.runSync(as(Option.some(who)).removeMember(GROUP, stranger.id))).toEqual({
      changed: false,
    });
    expect(roleOf(stranger.id)).toEqual(Option.none());
  });

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
            (ops: ReturnType<ReturnType<typeof world>["as"]>) => ops.addMember(GROUP, "u-new"),
          ],
          [
            "removeMember",
            (ops: ReturnType<ReturnType<typeof world>["as"]>) => ops.removeMember(GROUP, member.id),
          ],
          [
            "setRole",
            (ops: ReturnType<ReturnType<typeof world>["as"]>) =>
              ops.setRole(GROUP, member.id, "admin"),
          ],
        ] as const,
        ([operation, call]) => ({ label: `${operation} by ${name}`, who, call, tag }),
      ),
  );

  it.each(refusals)("$label is refused, and writes nothing", ({ who, call, tag }) => {
    const { as, store } = world();
    const before = store.rows();
    expect(tagOf(call(as(who)))).toEqual(Option.some(tag));
    expect(store.rows()).toEqual(before);
  });

  it("an unknown group is GroupNotFound for every operation", () => {
    const { as } = world();
    const ops = as(Option.some(owner));
    expect(tagOf(ops.addMember("g-none", member.id))).toEqual(Option.some("GroupNotFound"));
    expect(tagOf(ops.removeMember("g-none", member.id))).toEqual(Option.some("GroupNotFound"));
    expect(tagOf(ops.setRole("g-none", member.id, "admin"))).toEqual(Option.some("GroupNotFound"));
    expect(tagOf(ops.leave("g-none"))).toEqual(Option.some("GroupNotFound"));
    expect(tagOf(ops.members("g-none", { limit: 10, offset: 0 }))).toEqual(
      Option.some("GroupNotFound"),
    );
    expect(tagOf(ops.removeGroup("g-none"))).toEqual(Option.some("GroupNotFound"));
  });

  it("the owner can't be removed or re-roled, even by an admin", () => {
    const { as, roleOf } = world();
    expect(tagOf(as(Option.some(groupAdmin)).removeMember(GROUP, owner.id))).toEqual(
      Option.some("GroupOwnerMembership"),
    );
    expect(tagOf(as(Option.some(owner)).setRole(GROUP, owner.id, "member"))).toEqual(
      Option.some("GroupOwnerMembership"),
    );
    expect(roleOf(owner.id)).toEqual(Option.some("admin"));
  });

  it("re-roling a non-member is MemberNotFound", () => {
    const { as } = world();
    expect(tagOf(as(Option.some(owner)).setRole(GROUP, stranger.id, "admin"))).toEqual(
      Option.some("MemberNotFound"),
    );
  });
});

describe("defineAudience — leaving", () => {
  it("a member leaves; leaving again is MemberNotFound", () => {
    const { as, roleOf } = world();
    Effect.runSync(as(Option.some(member)).leave(GROUP));
    expect(roleOf(member.id)).toEqual(Option.none());
    expect(tagOf(as(Option.some(member)).leave(GROUP))).toEqual(Option.some("MemberNotFound"));
  });

  it("the owner can't leave; the anonymous are Unauthorized", () => {
    const { as } = world();
    expect(tagOf(as(Option.some(owner)).leave(GROUP))).toEqual(Option.some("GroupOwnerMembership"));
    expect(tagOf(as(Option.none()).leave(GROUP))).toEqual(Option.some("Unauthorized"));
  });
});

describe("defineAudience — the member list", () => {
  it.each([
    ["the owner", owner],
    ["an admin", groupAdmin],
    ["a member", member],
  ] as const)("%s reads it, oldest first, the page clamped", (_name, who) => {
    const { as } = world();
    const page = Effect.runSync(as(Option.some(who)).members(GROUP, { limit: 0, offset: -3 }));
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.accountId)).toEqual([owner.id]);
    const all = Effect.runSync(as(Option.some(who)).members(GROUP, { limit: 1e9, offset: 0 }));
    expect(all.rows.map((row) => [row.accountId, row.role])).toEqual([
      [owner.id, "admin"],
      [groupAdmin.id, "admin"],
      [member.id, "member"],
    ]);
  });

  it("a stranger gets GroupNotFound, never Forbidden (SEC-AUTH-ENUM-001)", () => {
    const { as } = world();
    expect(tagOf(as(Option.some(stranger)).members(GROUP, { limit: 10, offset: 0 }))).toEqual(
      Option.some("GroupNotFound"),
    );
  });
});

describe("defineAudience — deleting the group", () => {
  it("the owner deletes every membership, and the group's rows open to no member", () => {
    const { as, store } = world();
    const seam = audienceSeam(store);
    expect(Effect.runSync(seam.isMember(member.id, GROUP))).toBe(true);
    expect(Effect.runSync(as(Option.some(owner)).removeGroup(GROUP))).toBe(3);
    expect(store.rows()).toEqual([]);
    expect(Effect.runSync(seam.isMember(member.id, GROUP))).toBe(false);
    expect(HashSet.size(seam.groups(member.id))).toBe(0);
  });

  it.each([
    ["an admin", groupAdmin],
    ["a member", member],
  ] as const)("%s can't delete it", (_name, who) => {
    const { as, store } = world();
    expect(tagOf(as(Option.some(who)).removeGroup(GROUP))).toEqual(Option.some("Forbidden"));
    expect(store.rows()).toHaveLength(3);
  });
});

describe("the audience seam and the store", () => {
  it("answers membership one row at a time and as a set", () => {
    const { store } = world();
    const seam = audienceSeam(store);
    expect(Effect.runSync(seam.isMember(member.id, GROUP))).toBe(true);
    expect(Effect.runSync(seam.isMember(stranger.id, GROUP))).toBe(false);
    expect(seam.groups(member.id)).toEqual(HashSet.make(GROUP));
    expect(seam.groups(stranger.id)).toEqual(HashSet.empty());
  });

  it("erases an account's memberships (pulpit#207)", () => {
    const { store } = world();
    Effect.runSync(store.add({ groupId: "g-2", accountId: member.id, role: "member", at: NOW }));
    expect(Effect.runSync(store.eraseAccount(member.id))).toBe(2);
    expect(store.rows().map((row) => row.accountId)).toEqual([owner.id, groupAdmin.id]);
  });
});
