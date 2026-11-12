/**
 * **The reference leaf's privacy arm** (`PUB-009`), shared by `./subtype`
 * and `./edges` so a reference row is read one way: as a list filter
 * ({@link referenceListFilter}, behind `referencePrivacyFilter`, the subtype
 * `list` and `./edges`' `endpointFilter`) and as a row predicate
 * ({@link canViewReferenceRow}, behind `defineSubtype`'s `visibleRow` and
 * `./edges`' `canViewEndpoint`). Before pulpit#92 each module spelled the
 * predicate for itself.
 *
 * The row's facts are read by `ownedFacts`, so an owner-like value that is
 * not a string reads as no owner and never reaches the follower seam
 * (pulpit#85, pulpit#100).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { always, and, eq, isIn, never, or, type ListFilter } from "../filter.ts";
import type { ColumnValue } from "../version-chain.ts";
import {
  inGroupAudience,
  ownedFacts,
  type Account,
  type IsFollower,
  type PrivateRung,
} from "./owned-columns.ts";

/** The reference access declaration, structurally (`./subtype`'s reference `LeafAccess` fits). */
interface ReferenceColumns {
  readonly followersOfColumn?: string;
  readonly groupColumn?: string;
}

/** The read scope the arm reads, structurally (`./subtype`'s `ReadScope` fits). */
type Scope<Following> =
  | { readonly kind: "all" }
  | { readonly kind: "public" }
  | {
      readonly kind: "member";
      readonly userId: string;
      readonly following: Following;
      readonly groups?: Following;
    };

/** The reference axis's one column; a view without it rides no privacy axis. */
const VISIBILITY = "visibility";

/**
 * The column whose followers may read a `followers` row, when the leaf
 * declares one and the view carries it. A declared column the view lacks
 * reads as none: the followers arm then matches nothing (fail closed).
 */
const followersColumn = (
  access: ReferenceColumns,
  viewColumns: HashSet.HashSet<string>,
): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(access.followersOfColumn), (column) =>
    HashSet.has(viewColumns, column),
  );

/**
 * The column naming a `group` row's group, when the leaf declares one and
 * the view carries it (pulpit#194). A declared column the view lacks reads
 * as none: the group arm then matches nothing (fail closed).
 */
const groupColumnOf = (
  access: ReferenceColumns,
  viewColumns: HashSet.HashSet<string>,
): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(access.groupColumn), (column) =>
    HashSet.has(viewColumns, column),
  );

/**
 * The group arm of a member's list (pulpit#194): `<visibility> = 'group' AND
 * <groupColumn> IN (<groups>)`, when the column is there and the read scope
 * carries the viewer's groups; otherwise `never`. Shared by the owned and
 * reference list filters.
 *
 * @internal
 */
export const groupArm = <Following>(
  visibilityColumn: string,
  groupColumn: Option.Option<string>,
  groups: Option.Option<Following>,
): ListFilter<Following> =>
  Option.match(Option.all([groupColumn, groups]), {
    onNone: (): ListFilter<Following> => never,
    onSome: ([column, set]) => and<Following>(eq(visibilityColumn, "group"), isIn(column, set)),
  });

/**
 * The reference privacy arm as a list filter: `always` over a view without a
 * `visibility` column or for the view-private rung (`scope.kind === "all"`);
 * otherwise `visibility = 'public'`, and for a signed-in viewer also
 * `visibility = 'followers' AND (<followersOfColumn> = <viewer> OR
 * <followersOfColumn> IN (<following>))` when the leaf declares that column
 * and the view carries it (pulpit#92): the account the column names and its
 * followers read its `followers` rows. Its `private` rows stay the
 * view-private rung's alone. A `group` row lists for the members of the
 * group its declared `groupColumn` names ({@link groupArm}, pulpit#194).
 * Never throws.
 *
 * @internal
 */
export const referenceListFilter = <Following>(
  access: ReferenceColumns,
  viewColumns: HashSet.HashSet<string>,
  scope: Scope<Following>,
): ListFilter<Following> => {
  if (!HashSet.has(viewColumns, VISIBILITY)) return always;
  const column = followersColumn(access, viewColumns);
  return Match.value(scope).pipe(
    Match.discriminatorsExhaustive("kind")({
      all: (): ListFilter<Following> => always,
      public: (): ListFilter<Following> => eq(VISIBILITY, "public"),
      member: (member): ListFilter<Following> =>
        or<Following>(
          eq(VISIBILITY, "public"),
          Option.match(column, {
            onNone: (): ListFilter<Following> => never,
            onSome: (followed) =>
              and<Following>(
                eq(VISIBILITY, "followers"),
                or<Following>(eq(followed, member.userId), isIn(followed, member.following)),
              ),
          }),
          groupArm(
            VISIBILITY,
            groupColumnOf(access, viewColumns),
            Option.fromUndefinedOr(member.groups),
          ),
        ),
    }),
  );
};

/**
 * The reference privacy arm as a row predicate, the same facts as
 * {@link referenceListFilter}: a view without a `visibility` column shows
 * the row; otherwise it shows when its visibility is exactly `public`, to
 * the view-private rung, or, when it is exactly `followers` and the leaf
 * declares a followers column the view carries, to the signed-in account
 * that column names and to its followers, as the follower seam answers
 * (pulpit#92). A `group` row shows to the members of the group its
 * declared `groupColumn` (one the view carries) names, as the audience
 * seam's `isMember` answers (pulpit#194). That account's `private` rows stay the view-private rung's
 * alone. A column value that is not a string names no account, so it never
 * matches the viewer and the seam is never asked about it (pulpit#85,
 * pulpit#100). Anything else is hidden, which the
 * caller answers as `NodeNotFound` (`SEC-AUTH-ENUM-001`). The soft-delete
 * axis is the caller's. Never fails.
 *
 * @internal
 */
export const canViewReferenceRow = <A extends Account, R>(
  access: ReferenceColumns,
  viewColumns: HashSet.HashSet<string>,
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  followers: IsFollower<R>,
  row: { readonly [column: string]: ColumnValue },
): Effect.Effect<boolean, never, R> => {
  if (!HashSet.has(viewColumns, VISIBILITY)) return Effect.succeed(true);
  const visibility = row[VISIBILITY];
  if (visibility === "public") return Effect.succeed(true);
  if (Option.isNone(viewer)) return Effect.succeed(false);
  const account = viewer.value;
  if (policy.canViewPrivate(account)) return Effect.succeed(true);
  if (visibility === "group") {
    return inGroupAudience(
      followers,
      account.id,
      Option.flatMap(groupColumnOf(access, viewColumns), (column) =>
        Option.liftPredicate(row[column], P.isString),
      ),
    );
  }
  if (visibility !== "followers") return Effect.succeed(false);
  return Option.match(followersColumn(access, viewColumns), {
    onNone: () => Effect.succeed(false),
    onSome: (column) =>
      Option.match(
        ownedFacts(
          {
            ownerColumn: column,
            visibilityColumn: VISIBILITY,
            draftColumn: Option.none(),
            moderationColumn: Option.none(),
          },
          row,
        ).ownerId,
        {
          onNone: () => Effect.succeed(false),
          onSome: (ownerId) =>
            ownerId === account.id
              ? Effect.succeed(true)
              : followers.isFollower(account.id, ownerId),
        },
      ),
  });
};
