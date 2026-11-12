/**
 * **The owned leaf's row reading**, shared by `./subtype` and `./edges` so
 * the two cannot read the same view or row differently: the declared-column
 * check (pulpit#79), the facts read off a row (pulpit#80), and the predicate
 * over those facts, which `canViewOwned` delegates to (pulpit#85).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Visibility } from "../content.ts";
import type { ColumnValue } from "../version-chain.ts";

/** The owned access declaration's column names, structurally (`./subtype`'s owned `LeafAccess` fits). */
interface OwnedColumns {
  readonly ownerColumn: string;
  readonly visibilityColumn: string;
  readonly draftColumn: Option.Option<string>;
  readonly moderationColumn: Option.Option<string>;
  /** The group column a `group` row's audience is read from (pulpit#194); absent, no `group` row opens beyond the owner and the rung. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- mirrors `./subtype`'s owned `LeafAccess`, whose optional field is `?: T | undefined` (AGENTS.md → Conventions)
  readonly groupColumn?: string | undefined;
}

/**
 * The facts {@link canViewOwnedRow} reads off an owned row: `./subtype`'s
 * `OwnedFacts`, except that the owner may be absent. A row whose owner
 * column holds no string has no owner (pulpit#85).
 */
interface OwnedRowFacts {
  readonly ownerId: Option.Option<string>;
  readonly visibility: Visibility;
  readonly draft: boolean;
  /** Under review or rejected: a moderated row whose state is not exactly `approved` (pulpit#154). */
  readonly unapproved: boolean;
  /**
   * The group a `group` row is shared with (pulpit#194): the declared group
   * column's value when it holds a string, else none (no column declared, or
   * the group was deleted and the column cleared), so the row reads as
   * `private`.
   */
  readonly groupId: Option.Option<string>;
}

/**
 * The parts of `./subtype`'s viewer, policy and follower seam the owned and
 * reference readings read, structurally.
 *
 * @internal
 */
export interface Account {
  readonly id: string;
}
/** @internal */
export interface PrivateRung<A> {
  readonly canViewPrivate: (account: A) => boolean;
}
/** @internal */
export interface IsFollower<R> {
  readonly isFollower: (followerId: string, ownerId: string) => Effect.Effect<boolean, never, R>;
  /* oxlint-disable effect/prefer-option-over-null -- mirrors `./subtype`'s `FollowerSeam`, whose optional member is `?: T | undefined` (AGENTS.md → Conventions) */
  readonly isMember?:
    | ((accountId: string, groupId: string) => Effect.Effect<boolean, never, R>)
    | undefined;
  /* oxlint-enable effect/prefer-option-over-null */
}

/**
 * Whether a signed-in account is in a `group` row's audience: the member
 * check of the audience seam, asked only for a group the row names. A row
 * naming no group, or a seam without `isMember`, opens to nobody (fail
 * closed, pulpit#194).
 *
 * @internal
 */
export const inGroupAudience = <R>(
  seam: IsFollower<R>,
  accountId: string,
  groupId: Option.Option<string>,
): Effect.Effect<boolean, never, R> => {
  const { isMember } = seam;
  if (isMember === undefined || Option.isNone(groupId)) return Effect.succeed(false);
  return isMember(accountId, groupId.value);
};

const isVisibility = Schema.is(Visibility);

/**
 * Whether the view carries every column an owned leaf declares (owner,
 * visibility and, when declared, draft and moderation state). An owned leaf whose view lacks one
 * reads no row: `ownedListFilter` lists nothing, and `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint` show nothing. Fail
 * closed (`SEC-AUTH-ENUM-001`). Never throws.
 *
 * @internal
 */
export const declaresColumns = (
  access: OwnedColumns,
  viewColumns: HashSet.HashSet<string>,
): boolean =>
  [
    access.ownerColumn,
    access.visibilityColumn,
    ...Option.toArray(access.draftColumn),
    ...Option.toArray(access.moderationColumn),
    ...(access.groupColumn === undefined ? [] : [access.groupColumn]),
  ].every((column) => HashSet.has(viewColumns, column));

/**
 * Read an owned row's facts for `canViewOwned`, in `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint`. Each reading fails
 * closed where `ownedListFilter` does (`SEC-AUTH-ENUM-001`): a visibility
 * outside the enum (a dropped projection, a schema drift) reads as
 * `private`, since the filter's `eq(visibility, "public")` arm lists only
 * `public`; a draft column holding anything but an explicit `false` (a
 * `NULL`, an absent key, a value outside the type) reads as a draft, since
 * its `eq(draft, false)` arms list only `false`. A leaf without the draft
 * axis reads `draft: false`. A moderation column holding anything but
 * exactly `"approved"` reads as unapproved, since the filter's
 * `eq(moderation, "approved")` arms list only `approved`; a leaf without the
 * axis reads `unapproved: false`. A group column holding anything but a
 * string, or none declared, names no group (pulpit#194). An owner column holding anything but a string
 * (a `NULL`, an absent key, a value outside the type) reads as no owner,
 * never as its `String` form (pulpit#85; see pulpit#75): its `eq(owner, …)`
 * and `in(owner, following)` arms match no `NULL`. Callers check
 * {@link declaresColumns} first. Never throws.
 *
 * @internal
 */
export const ownedFacts = (
  access: OwnedColumns,
  row: { readonly [column: string]: ColumnValue },
): OwnedRowFacts => ({
  ownerId: Option.liftPredicate(row[access.ownerColumn], P.isString),
  visibility: Option.getOrElse(
    Option.liftPredicate(row[access.visibilityColumn], isVisibility),
    (): Visibility => "private",
  ),
  draft: Option.match(access.draftColumn, {
    onNone: () => false,
    onSome: (column) => row[column] !== false,
  }),
  unapproved: Option.match(access.moderationColumn, {
    onNone: () => false,
    onSome: (column) => row[column] !== "approved",
  }),
  groupId: Option.flatMap(Option.fromUndefinedOr(access.groupColumn), (column) =>
    Option.liftPredicate(row[column], P.isString),
  ),
});

/**
 * The owned-material read predicate over {@link ownedFacts}: `canViewOwned`
 * in `./subtype` is this with a present owner, and `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint` call it directly. A
 * `group` row is read by its owner, the rung and, when published, the
 * members of the group it names ({@link inGroupAudience}; pulpit#194). A
 * row with no owner skips the owner arm and the follower check, so no
 * viewer's id matches it and the follower seam is never asked about it:
 * it is visible only when it is `public`, not a draft and not unapproved, or to the
 * view-private rung, as `ownedListFilter` lists it (`SEC-AUTH-ENUM-001`).
 * Never fails.
 *
 * @internal
 */
export const canViewOwnedRow = <A extends Account, R>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  followers: IsFollower<R>,
  row: OwnedRowFacts,
): Effect.Effect<boolean, never, R> => {
  if (!row.draft && !row.unapproved && row.visibility === "public") return Effect.succeed(true);
  if (Option.isNone(viewer)) return Effect.succeed(false);
  const account = viewer.value;
  if (Option.contains(row.ownerId, account.id)) return Effect.succeed(true);
  if (policy.canViewPrivate(account)) return Effect.succeed(true);
  // Not the owner, not privileged: a draft, or a row not approved, is hidden whatever its visibility.
  if (row.draft || row.unapproved) return Effect.succeed(false);
  if (row.visibility === "private") return Effect.succeed(false);
  if (row.visibility === "group") return inGroupAudience(followers, account.id, row.groupId);
  return Option.match(row.ownerId, {
    onNone: () => Effect.succeed(false),
    onSome: (ownerId) => followers.isFollower(account.id, ownerId),
  });
};
