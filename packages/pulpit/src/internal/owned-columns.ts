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
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Visibility } from "../content.ts";
import type { ColumnValue } from "../version-chain.ts";

/** The owned access declaration's column names, structurally (`./subtype`'s owned `LeafAccess` fits). */
interface OwnedColumns {
  readonly ownerColumn: string;
  readonly visibilityColumn: string;
  readonly draftColumn: Option.Option<string>;
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
}

/** The parts of `./subtype`'s viewer, policy and follower seam the predicate reads, structurally. */
interface Account {
  readonly id: string;
}
interface PrivateRung<A> {
  readonly canViewPrivate: (account: A) => boolean;
}
interface IsFollower<R> {
  readonly isFollower: (followerId: string, ownerId: string) => Effect.Effect<boolean, never, R>;
}

const isVisibility = Schema.is(Visibility);

/**
 * Whether the view carries every column an owned leaf declares (owner,
 * visibility and, when declared, draft). An owned leaf whose view lacks one
 * reads no row: `ownedListFilter` lists nothing, and `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint` show nothing. Fail
 * closed (`SEC-AUTH-ENUM-001`). Never throws.
 *
 * @internal
 */
export const declaresColumns = (access: OwnedColumns, viewColumns: ReadonlySet<string>): boolean =>
  [access.ownerColumn, access.visibilityColumn, ...Option.toArray(access.draftColumn)].every(
    (column) => viewColumns.has(column),
  );

/**
 * Read an owned row's facts for `canViewOwned`, in `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint`. Each reading fails
 * closed where `ownedListFilter` does (`SEC-AUTH-ENUM-001`): a visibility
 * outside the enum (a dropped projection, a schema drift) reads as
 * `private`, since the filter's `eq(visibility, "public")` arm lists only
 * `public`; a draft column holding anything but an explicit `false` (a
 * `NULL`, an absent key, a value outside the type) reads as a draft, since
 * its `eq(draft, false)` arms list only `false`. A leaf without the draft
 * axis reads `draft: false`. An owner column holding anything but a string
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
  ownerId: Option.liftPredicate(row[access.ownerColumn], Predicate.isString),
  visibility: Option.getOrElse(
    Option.liftPredicate(row[access.visibilityColumn], isVisibility),
    (): Visibility => "private",
  ),
  draft: Option.match(access.draftColumn, {
    onNone: () => false,
    onSome: (column) => row[column] !== false,
  }),
});

/**
 * The owned-material read predicate over {@link ownedFacts}: `canViewOwned`
 * in `./subtype` is this with a present owner, and `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint` call it directly. A
 * row with no owner skips the owner arm and the follower check, so no
 * viewer's id matches it and the follower seam is never asked about it:
 * it is visible only when it is `public` and not a draft, or to the
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
  if (!row.draft && row.visibility === "public") return Effect.succeed(true);
  if (Option.isNone(viewer)) return Effect.succeed(false);
  const account = viewer.value;
  if (Option.contains(row.ownerId, account.id)) return Effect.succeed(true);
  if (policy.canViewPrivate(account)) return Effect.succeed(true);
  // Not the owner, not privileged: a draft is hidden whatever its visibility.
  if (row.draft) return Effect.succeed(false);
  if (row.visibility === "private") return Effect.succeed(false);
  return Option.match(row.ownerId, {
    onNone: () => Effect.succeed(false),
    onSome: (ownerId) => followers.isFollower(account.id, ownerId),
  });
};
