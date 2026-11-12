/**
 * The kernel's access seams against effect-auth's published spelling of the
 * same rules (pulpit#5): two implementations of one policy that must never
 * disagree.
 *
 * - The row predicate: `canViewOwned` over a policy and follower seam built
 *   from effect-auth's `Guard` / `IsFollower` agrees with `OwnedAccess.make`'s
 *   `canView` for every visibility × draft × viewer × follows cell.
 * - The read scope: `readScopeFor` agrees with `OwnedAccess`'s `readScope`,
 *   the follower set included.
 * - The serveability policy (`CACHE-AUTH-005`): on the two axes effect-auth's
 *   `OwnedAccess.serveableAxes` names (`visibility`, `draft`),
 *   `isPubliclyServeable` with `owned: true` gives the same answer as
 *   `Cacheability.publiclyServeable`, and on attributes carrying the kernel's
 *   further axes (`moderationState`, `deletedAt`) it is never more lenient.
 *
 * - The bridge: `accessPolicyFromGuards` (the guard kit's ladder) answers
 *   each of the four role axes exactly as the kit's own `decideRole` does,
 *   and fails closed off the ladder; `viewerFromGuards` is the kit's viewer.
 *
 * effect-auth is a required peer of the kernel (pulpit#5, option (c)), and
 * the kernel's read predicates, read scope and owned serveability axes now
 * delegate to it (`src/internal/delegated-access.ts`, `./publication`).
 * These matrices are the parity acceptance tests of that bridge: with an
 * audience seam (`IsMember` / `groups`) as well as without, for the
 * reference reading (`ReferenceAccess`) as well as the owned one, and for the
 * answers delegation changed (an empty id names nobody, effect-auth#661; the
 * stricter owned serveability axes).
 *
 * @module tests/effect-auth
 */

import {
  Cacheability,
  Guard,
  Ladder,
  OwnedAccess,
  ReferenceAccess,
} from "@thomasfosterau/effect-auth";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { ne, never } from "../src/filter.ts";
import { referenceRowOf } from "../src/internal/delegated-access.ts";
import { canViewReferenceRow } from "../src/internal/reference-columns.ts";
import { isPubliclyServeable } from "../src/publication.ts";
import {
  type AccessPolicy,
  accessPolicyFromGuards,
  canViewOwned,
  type FollowerSeam,
  ownedAccess,
  type ReadScope,
  readScopeFor,
  searchHeadFor,
  softDeleteFilter,
  type Viewer,
  type ViewerAccount,
  viewerFromGuards,
} from "../src/subtype.ts";

/** gardeneria's ladder and axes, as effect-auth spells them. */
const Roles = Ladder.make(["user", "contributor", "moderator", "admin"]);

class CurrentViewer extends Context.Service<CurrentViewer, Option.Option<ViewerAccount>>()(
  "@pulpit-test/CurrentViewer",
) {}

const guards = Guard.make({ ladder: Roles, viewer: CurrentViewer });
const owned = OwnedAccess.make({ guards, viewPrivate: "moderator" });
const reference = ReferenceAccess.make({ guards, viewPrivate: "moderator" });

/** gardeneria's four axes on that ladder. */
const axes = {
  viewPrivate: "moderator",
  viewDeleted: "moderator",
  moderate: "moderator",
  writeCorpus: "contributor",
} as const;

/** The kernel's `AccessPolicy` from the guards, through the exported helper (pulpit#5). */
const policy = accessPolicyFromGuards(guards, axes);

/** The same four questions asked of the guard kit's own role gate, `decideRole`. */
const decided: AccessPolicy = {
  canViewPrivate: (account) => guards.decideRole(account, axes.viewPrivate),
  canViewDeleted: (account) => guards.decideRole(account, axes.viewDeleted),
  canModerate: (account) => guards.decideRole(account, axes.moderate),
  canWriteCorpus: (account) => guards.decideRole(account, axes.writeCorpus),
};

/** The kernel's `Viewer`, read from the guards' viewer service. */
const viewerFrom: Effect.Effect<Viewer, never, CurrentViewer> = viewerFromGuards(guards);

const OWNER = "u-owner";
const accounts: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", Option.none()],
  ["owner", Option.some({ id: OWNER, role: "user" })],
  ["stranger", Option.some({ id: "u-stranger", role: "user" })],
  ["contributor", Option.some({ id: "u-contributor", role: "contributor" })],
  ["moderator", Option.some({ id: "u-moderator", role: "moderator" })],
  ["an unknown role", Option.some({ id: "u-unknown", role: "superuser" })],
  ["an empty id", Option.some({ id: "", role: "user" })],
  ["an empty-id moderator", Option.some({ id: "", role: "moderator" })],
];

/** One follower seam, handed to both sides: effect-auth's `IsFollower` service IS a `FollowerSeam`. */
const seamFor = (follows: boolean): FollowerSeam<OwnedAccess.FollowingSet, never> => {
  const following = OwnedAccess.subquery(`following(${String(follows)})`);
  return {
    isFollower: (_followerId, ownerId) => Effect.succeed(follows && ownerId === OWNER),
    following: () => following,
  };
};

const run = <A>(
  effect: Effect.Effect<A, never, CurrentViewer | OwnedAccess.IsFollower>,
  viewer: Viewer,
  seam: FollowerSeam<OwnedAccess.FollowingSet, never>,
): A =>
  Effect.runSync(
    effect.pipe(
      Effect.provideService(CurrentViewer, viewer),
      Effect.provideService(OwnedAccess.IsFollower, seam),
    ),
  );

describe("canViewOwned ≡ OwnedAccess.canView", () => {
  const cases = Arr.flatMap(accounts, ([name, viewer]) =>
    Arr.flatMap(["public", "followers", "private"] as const, (visibility) =>
      Arr.flatMap([false, true], (draft) =>
        Arr.map([false, true], (follows) => ({
          label: `${name} × ${visibility} × draft ${String(draft)} × follows ${String(follows)}`,
          viewer,
          visibility,
          draft,
          follows,
        })),
      ),
    ),
  );

  it.each(cases)("$label", ({ viewer, visibility, draft, follows }) => {
    const seam = seamFor(follows);
    const kernel = Effect.runSync(
      canViewOwned(viewer, policy, seam, { ownerId: OWNER, visibility, draft, unapproved: false }),
    );
    expect(kernel).toBe(run(owned.canView({ ownerId: OWNER, visibility, draft }), viewer, seam));
  });
});

/**
 * The kernel's read scope as effect-auth spells it. A member scope's `groups`
 * is absent when the follower seam has no audience pair (the kernel's
 * contract, `ReadScope`), where `OwnedAccess.readScope` (0.3.0+) always
 * carries one, `OwnedAccess.nobody` without an `IsMember` service: the same
 * set of rows, so the parity compares them as equal.
 */
const asAuthScope = <Following>(
  scope: ReadScope<Following>,
): ReadScope<Following | typeof OwnedAccess.nobody> =>
  scope.kind === "member" && scope.groups === undefined
    ? { ...scope, groups: OwnedAccess.nobody }
    : scope;

describe("readScopeFor ≡ OwnedAccess.readScope", () => {
  it.each(Arr.map(accounts, ([label, viewer]) => ({ label, viewer })))("$label", ({ viewer }) => {
    const seam = seamFor(true);
    const kernel = run(
      Effect.map(viewerFrom, (read) => readScopeFor(read, policy, seam)),
      viewer,
      seam,
    );
    expect(asAuthScope(kernel)).toEqual(run(owned.readScope, viewer, seam));
  });

  it("fails closed to nobody when no follower seam is provided", () => {
    const viewer: Viewer = Option.some({ id: "u-stranger", role: "user" });
    const auth = Effect.runSync(owned.readScope.pipe(Effect.provideService(CurrentViewer, viewer)));
    expect(auth).toEqual(
      asAuthScope(
        readScopeFor(viewer, policy, {
          isFollower: () => Effect.succeed(false),
          following: () => OwnedAccess.nobody,
        }),
      ),
    );
  });
});

describe("isPubliclyServeable ≡ Cacheability.publiclyServeable (CACHE-AUTH-005)", () => {
  const authServeable = Cacheability.publiclyServeable(OwnedAccess.serveableAxes);
  /* oxlint-disable effect/prefer-option-over-null -- a cached resource's attributes arrive as JSON: `null`, an explicit `undefined` and an absent key are three inputs the gate must each refuse or admit */
  /** An attribute value, or `ABSENT` for a key the attributes omit. */
  type Cell = string | boolean | null | undefined | typeof ABSENT;
  type Attributes = R.ReadonlyRecord<string, string | boolean | null | undefined>;
  /* oxlint-enable effect/prefer-option-over-null */
  const ABSENT: unique symbol = Symbol("absent");
  const attributesOf = (entries: ReadonlyArray<readonly [string, Cell]>): Attributes =>
    Arr.reduce(entries, R.empty<string, Attributes[string]>(), (acc, [key, value]) =>
      value === ABSENT ? acc : R.set(acc, key, value),
    );

  const draftValues: ReadonlyArray<Cell> = [ABSENT, undefined, false, true, null];
  const axisCases = Arr.flatMap(
    [ABSENT, undefined, "public", "followers", "private", null] satisfies ReadonlyArray<Cell>,
    (visibility) =>
      Arr.map(draftValues, (draft) => ({
        label: `visibility ${String(visibility)} × draft ${String(draft)}`,
        attributes: attributesOf([
          ["visibility", visibility],
          ["draft", draft],
        ]),
      })),
  );

  it.each(axisCases)("$label", ({ attributes }) => {
    expect(isPubliclyServeable({ attributes }, { owned: true })).toBe(authServeable(attributes));
  });

  it("is never more lenient on the kernel's further axes", () => {
    const rows = Arr.flatMap(
      [ABSENT, "approved", "pending", null] satisfies ReadonlyArray<Cell>,
      (moderationState) =>
        Arr.flatMap(
          [ABSENT, null, "2026-01-01T00:00:00.000Z"] satisfies ReadonlyArray<Cell>,
          (deletedAt) =>
            Arr.map(draftValues, (draft) =>
              attributesOf([
                ["visibility", "public"],
                ["draft", draft],
                ["moderationState", moderationState],
                ["deletedAt", deletedAt],
              ]),
            ),
        ),
    );
    const kernelServes = Arr.filter(rows, (attributes) =>
      isPubliclyServeable({ attributes }, { owned: true }),
    );
    expect(kernelServes.length).toBeGreaterThan(0);
    expect(Arr.filter(kernelServes, (attributes) => !authServeable(attributes))).toEqual([]);
  });
});

describe("accessPolicyFromGuards ≡ the guard kit's decideRole", () => {
  const questions = ["canViewPrivate", "canViewDeleted", "canModerate", "canWriteCorpus"] as const;
  // The policy answers the ladder alone; an empty-id viewer is anonymous
  // before any rung is asked (the read paths' `knownViewer`), so the
  // empty-id accounts are not ladder questions.
  const cases = Arr.flatMap(
    Arr.filterMap(accounts, ([name, viewer]) =>
      Option.match(
        Option.filter(viewer, (account) => account.id !== ""),
        {
          onNone: () => Result.failVoid,
          onSome: (account) => Result.succeed({ name, account }),
        },
      ),
    ),
    ({ name, account }) =>
      Arr.map(questions, (question) => ({ label: `${name} × ${question}`, account, question })),
  );

  it.each(cases)("$label", ({ account, question }) => {
    expect(policy[question](account)).toBe(decided[question](account));
  });

  it("fails closed for a role outside the ladder", () => {
    const outsider = { id: "u-outsider", role: "superuser" };
    expect(Arr.map(questions, (question) => policy[question](outsider))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

/**
 * The audience seam (pulpit#194): the kernel's `FollowerSeam` with its
 * `isMember` / `groups` pair, and the same answers as effect-auth's
 * `IsFollower` and `IsMember` services.
 */
const GROUP = "g-club";
const audienceFor = (follows: boolean, member: boolean) => {
  const following = OwnedAccess.subquery(`following(${String(follows)})`);
  const groups = OwnedAccess.subquery(`groups(${String(member)})`);
  const isFollower = (_followerId: string, ownerId: string) =>
    Effect.succeed(follows && ownerId === OWNER);
  const isMember = (_accountId: string, groupId: string) =>
    Effect.succeed(member && groupId === GROUP);
  return {
    kernel: {
      isFollower,
      following: () => following,
      isMember,
      groups: () => groups,
    } satisfies FollowerSeam<OwnedAccess.FollowingSet, never>,
    follower: { isFollower, following: () => following },
    member: { isMember, groupsOf: () => groups },
  };
};

const runWithAudience = <A>(
  effect: Effect.Effect<A, never, CurrentViewer | OwnedAccess.IsFollower | OwnedAccess.IsMember>,
  viewer: Viewer,
  audience: ReturnType<typeof audienceFor>,
): A =>
  Effect.runSync(
    effect.pipe(
      Effect.provideService(CurrentViewer, viewer),
      Effect.provideService(OwnedAccess.IsFollower, audience.follower),
      Effect.provideService(OwnedAccess.IsMember, audience.member),
    ),
  );

const audiences = Arr.flatMap([false, true], (follows) =>
  Arr.map([false, true], (member) => ({ follows, member })),
);

describe("canViewOwned ≡ OwnedAccess.canView, with an audience seam", () => {
  const cases = Arr.flatMap(accounts, ([name, viewer]) =>
    Arr.flatMap(["public", "followers", "group", "private"] as const, (visibility) =>
      Arr.flatMap([false, true], (published) =>
        Arr.flatMap([Option.none<string>(), Option.some(GROUP), Option.some("g-other")], (group) =>
          Arr.map(audiences, ({ follows, member }) => ({
            label: `${name} × ${visibility} × published ${String(published)} × group ${Option.getOrElse(group, () => "none")} × follows ${String(follows)} × member ${String(member)}`,
            viewer,
            visibility,
            published,
            group,
            follows,
            member,
          })),
        ),
      ),
    ),
  );

  it.each(cases)("$label", ({ viewer, visibility, published, group, follows, member }) => {
    const audience = audienceFor(follows, member);
    const facts = { ownerId: OWNER, visibility, draft: !published, unapproved: false };
    const kernel = Effect.runSync(
      canViewOwned(
        viewer,
        policy,
        audience.kernel,
        Option.match(group, { onNone: () => facts, onSome: (groupId) => ({ ...facts, groupId }) }),
      ),
    );
    const auth = runWithAudience(
      owned.canView({
        ownerId: OWNER,
        visibility,
        draft: !published,
        unapproved: false,
        groupId: Option.getOrUndefined(group),
      }),
      viewer,
      audience,
    );
    expect(kernel).toBe(auth);
  });

  it.each([false, true])("reads unapproved %s as effect-auth does", (unapproved) => {
    const audience = audienceFor(true, true);
    const viewer: Viewer = Option.some({ id: "u-stranger", role: "user" });
    const row = { ownerId: OWNER, visibility: "group", draft: false, groupId: GROUP } as const;
    expect(
      Effect.runSync(canViewOwned(viewer, policy, audience.kernel, { ...row, unapproved })),
    ).toBe(runWithAudience(owned.canView({ ...row, unapproved }), viewer, audience));
  });
});

describe("readScopeFor ≡ OwnedAccess.readScope ≡ ReferenceAccess.readScope, with an audience seam", () => {
  it.each(Arr.map(accounts, ([label, viewer]) => ({ label, viewer })))("$label", ({ viewer }) => {
    const audience = audienceFor(true, true);
    const kernel = readScopeFor(viewer, policy, audience.kernel);
    const auth = runWithAudience(owned.readScope, viewer, audience);
    expect(kernel).toEqual(auth);
    expect(runWithAudience(reference.readScope, viewer, audience)).toEqual(auth);
  });
});

describe("canViewReferenceRow ≡ ReferenceAccess.canView", () => {
  const FOLLOWED = OWNER;
  const access = { followersOfColumn: "followersOf", groupColumn: "groupId" };
  const scoped = HashSet.make("visibility", "followersOf", "groupId");
  const unscoped = HashSet.make("followersOf", "groupId");
  const visibilities = ["public", "followers", "group", "private", null, "secret"] as const;
  const cases = Arr.flatMap(accounts, ([name, viewer]) =>
    Arr.flatMap(visibilities, (visibility) =>
      Arr.flatMap([FOLLOWED, "u-stranger", ""], (followersOf) =>
        Arr.flatMap(audiences, ({ follows, member }) =>
          Arr.map([true, false], (hasAxis) => ({
            label: `${name} × ${String(visibility)} × followers-of "${followersOf}" × axis ${String(hasAxis)} × follows ${String(follows)} × member ${String(member)}`,
            viewer,
            visibility,
            followersOf,
            hasAxis,
            follows,
            member,
          })),
        ),
      ),
    ),
  );

  it.each(cases)("$label", ({ viewer, visibility, followersOf, hasAxis, follows, member }) => {
    const audience = audienceFor(follows, member);
    const kernel = Effect.runSync(
      canViewReferenceRow(access, hasAxis ? scoped : unscoped, viewer, policy, audience.kernel, {
        visibility,
        followersOf,
        groupId: GROUP,
      }),
    );
    // The row as effect-auth reads it: no axis on a view without the column; a
    // value outside the enum (NULL included) is `private`; `""` names nobody.
    const row: ReferenceAccess.ReferenceRow = hasAxis
      ? {
          visibility: visibility === null || visibility === "secret" ? "private" : visibility,
          groupId: GROUP,
          followersOf: followersOf === "" ? undefined : followersOf,
        }
      : {};
    expect(kernel).toBe(runWithAudience(reference.canView(row), viewer, audience));
  });
});

describe("a NULL visibility reaches effect-auth as private, never as no axis (PUB-009)", () => {
  const anonymous: Viewer = Option.none();
  const nullVisibility = Option.some<null>(null);

  it("the bridge reads it as `private`", () => {
    expect(
      referenceRowOf({
        visibility: nullVisibility,
        followersOf: Option.none(),
        groupId: Option.none(),
      }),
    ).toEqual({ visibility: "private", followersOf: undefined, groupId: undefined });
  });

  it("so the anonymous viewer never reads the row, where an absent axis would show it", () => {
    const seam = seamFor(false);
    expect(
      Effect.runSync(
        canViewReferenceRow({}, HashSet.make("visibility"), anonymous, policy, seam, {
          visibility: null,
        }),
      ),
    ).toBe(false);
    // The fail-open the bridge must never produce: an omitted axis is unscoped.
    expect(run(reference.canView({ visibility: undefined }), anonymous, seam)).toBe(true);
  });
});

describe("an empty id names nobody (effect-auth#661)", () => {
  const seam: FollowerSeam<OwnedAccess.FollowingSet, never> = {
    isFollower: () => Effect.succeed(true),
    following: () => OwnedAccess.nobody,
  };
  const emptyId: Viewer = Option.some({ id: "", role: "user" });
  const emptyModerator: Viewer = Option.some({ id: "", role: "moderator" });
  const stranger: Viewer = Option.some({ id: "u-stranger", role: "user" });
  const facts = (ownerId: string, visibility: "followers" | "private") => ({
    ownerId,
    visibility,
    draft: false,
    unapproved: false,
  });
  const view = (viewer: Viewer, row: ReturnType<typeof facts>) =>
    Effect.runSync(canViewOwned(viewer, policy, seam, row));

  it("an empty-id viewer reads as anonymous", () => {
    expect(readScopeFor(emptyId, policy, seam)).toEqual({ kind: "public" });
    expect(readScopeFor(emptyModerator, policy, seam)).toEqual({ kind: "public" });
    expect(view(emptyId, facts("", "private"))).toBe(false);
    expect(view(emptyModerator, facts(OWNER, "private"))).toBe(false);
  });

  it("an empty owner is nobody's, and never reaches the follower seam", () => {
    expect(view(stranger, facts("", "followers"))).toBe(false);
    expect(view(Option.some({ id: "u-moderator", role: "moderator" }), facts("", "private"))).toBe(
      true,
    );
  });

  it("no rung outside the predicates admits an empty-id viewer", () => {
    expect(softDeleteFilter(emptyModerator, policy, true)).toEqual(ne("action", "delete"));
    expect(searchHeadFor({ access: ownedAccess(), policy }, emptyModerator)).toEqual(never);
    expect(searchHeadFor({ access: ownedAccess(), policy }, emptyId)).toEqual(never);
  });

  it("an empty followers-of account names nobody", () => {
    expect(
      Effect.runSync(
        canViewReferenceRow(
          { followersOfColumn: "followersOf" },
          HashSet.make("visibility", "followersOf"),
          emptyId,
          policy,
          seam,
          { visibility: "followers", followersOf: "" },
        ),
      ),
    ).toBe(false);
  });
});

describe("the owned serveability axes are effect-auth's (CACHE-AUTH-005)", () => {
  const serve = Cacheability.publiclyServeable(OwnedAccess.serveableAxes);
  const tightened = [
    { label: "unapproved: true", attributes: { visibility: "public", unapproved: true } },
    { label: "unapproved: null", attributes: { visibility: "public", unapproved: null } },
    { label: "deletedAt: undefined", attributes: { visibility: "public", deletedAt: undefined } },
  ];

  it.each(tightened)("refuses $label, as effect-auth does", ({ attributes }) => {
    expect(isPubliclyServeable({ attributes }, { owned: true })).toBe(false);
    expect(serve(attributes)).toBe(false);
  });

  it("still serves a public, published, approved, live row", () => {
    const attributes = {
      visibility: "public",
      draft: false,
      unapproved: false,
      moderationState: "approved",
    };
    expect(isPubliclyServeable({ attributes }, { owned: true })).toBe(true);
    expect(serve(attributes)).toBe(true);
  });
});
