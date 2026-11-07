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
 * The bridge here (`policyFor`, `viewerFrom`) is how an application wires
 * effect-auth's guards into the kernel's seams; the kernel itself never
 * imports effect-auth (packages/pulpit/CLAUDE.md → Boundary).
 *
 * @module tests/effect-auth
 */

import { Cacheability, Guard, Ladder, OwnedAccess } from "@thomasfosterau/effect-auth";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import { isPubliclyServeable } from "../src/publication.ts";
import {
  type AccessPolicy,
  canViewOwned,
  type FollowerSeam,
  readScopeFor,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";

/** gardeneria's ladder and axes, as effect-auth spells them. */
const Roles = Ladder.make(["user", "contributor", "moderator", "admin"]);

class CurrentViewer extends Context.Service<CurrentViewer, Option.Option<ViewerAccount>>()(
  "@pulpit-test/CurrentViewer",
) {}

const guards = Guard.make({ ladder: Roles, viewer: CurrentViewer });
const owned = OwnedAccess.make({ guards, viewPrivate: "moderator" });

/** The kernel's `AccessPolicy`, each axis one of the guards' rungs. */
const policyFor = (axes: {
  readonly viewPrivate: Ladder.RungOf<typeof Roles>;
  readonly viewDeleted: Ladder.RungOf<typeof Roles>;
  readonly moderate: Ladder.RungOf<typeof Roles>;
  readonly writeCorpus: Ladder.RungOf<typeof Roles>;
}): AccessPolicy => ({
  canViewPrivate: (account) => guards.decideRole(account, axes.viewPrivate),
  canViewDeleted: (account) => guards.decideRole(account, axes.viewDeleted),
  canModerate: (account) => guards.decideRole(account, axes.moderate),
  canWriteCorpus: (account) => guards.decideRole(account, axes.writeCorpus),
});

const policy = policyFor({
  viewPrivate: "moderator",
  viewDeleted: "moderator",
  moderate: "moderator",
  writeCorpus: "contributor",
});

/** The kernel's `Viewer`, read from the guards' viewer service. */
const viewerFrom: Effect.Effect<Viewer, never, CurrentViewer> = guards.viewer;

const OWNER = "u-owner";
const accounts: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", Option.none()],
  ["owner", Option.some({ id: OWNER, role: "user" })],
  ["stranger", Option.some({ id: "u-stranger", role: "user" })],
  ["contributor", Option.some({ id: "u-contributor", role: "contributor" })],
  ["moderator", Option.some({ id: "u-moderator", role: "moderator" })],
  ["an unknown role", Option.some({ id: "u-unknown", role: "superuser" })],
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

describe("readScopeFor ≡ OwnedAccess.readScope", () => {
  it.each(Arr.map(accounts, ([label, viewer]) => ({ label, viewer })))("$label", ({ viewer }) => {
    const seam = seamFor(true);
    const kernel = run(
      Effect.map(viewerFrom, (read) => readScopeFor(read, policy, seam)),
      viewer,
      seam,
    );
    expect(kernel).toEqual(run(owned.readScope, viewer, seam));
  });

  it("fails closed to nobody when no follower seam is provided", () => {
    const viewer: Viewer = Option.some({ id: "u-stranger", role: "user" });
    const auth = Effect.runSync(owned.readScope.pipe(Effect.provideService(CurrentViewer, viewer)));
    expect(auth).toEqual(
      readScopeFor(viewer, policy, {
        isFollower: () => Effect.succeed(false),
        following: () => OwnedAccess.nobody,
      }),
    );
  });
});

describe("isPubliclyServeable ≡ Cacheability.publiclyServeable (CACHE-AUTH-005)", () => {
  const authServeable = Cacheability.publiclyServeable(OwnedAccess.serveableAxes);
  /* oxlint-disable effect/prefer-option-over-null -- a cached resource's attributes arrive as JSON: `null`, an explicit `undefined` and an absent key are three inputs the gate must each refuse or admit */
  /** An attribute value, or `ABSENT` for a key the attributes omit. */
  type Cell = string | boolean | null | undefined | typeof ABSENT;
  type Attributes = Record.ReadonlyRecord<string, string | boolean | null | undefined>;
  /* oxlint-enable effect/prefer-option-over-null */
  const ABSENT: unique symbol = Symbol("absent");
  const attributesOf = (entries: ReadonlyArray<readonly [string, Cell]>): Attributes =>
    Arr.reduce(entries, Record.empty<string, Attributes[string]>(), (acc, [key, value]) =>
      value === ABSENT ? acc : Record.set(acc, key, value),
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
