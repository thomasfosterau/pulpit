/**
 * **The owned leaf's row reading**, shared by `./subtype` and `./edges` so
 * the two cannot read the same view or row differently: the declared-column
 * check (pulpit#79), the facts read off a row (pulpit#80), and the predicate
 * over those facts, which `canViewOwned` delegates to (pulpit#85) and which
 * itself delegates to effect-auth's `OwnedAccess.canView` (pulpit#5).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`.
 *
 * @internal
 */
import type * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Visibility } from "../content.ts";
import type { ColumnValue } from "../version-chain.ts";
import {
  canViewOwnedDelegated,
  type Account,
  type PrivateRung,
  type Seam,
} from "./delegated-access.ts";

/** The owned access declaration's column names, structurally (`./subtype`'s owned `LeafAccess` fits). */
interface OwnedColumns {
  readonly ownerColumn: string;
  readonly visibilityColumn: string;
  readonly draftColumn: Option.Option<string>;
  readonly moderationColumn: Option.Option<string>;
  /** The group column a `group` row's audience is read from (pulpit#194); absent, no `group` row opens beyond the owner and the rung. */
  readonly groupColumn?: string;
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
 * string, or none declared, names no group (pulpit#194). An owner column holding anything but a
 * non-empty string (a `NULL`, an absent key, a value outside the type, or
 * `""`, which names nobody as in effect-auth, effect-auth#661) reads as no owner,
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
  ownerId: Option.filter(Option.liftPredicate(row[access.ownerColumn], P.isString), Str.isNonEmpty),
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
 * `get` / `getMany` and `./edges`' `canViewEndpoint` call it directly. The
 * decision is effect-auth's `OwnedAccess.canView` (pulpit#5), through the
 * bridge in `./delegated-access.ts`: a `public` row that is neither a draft
 * nor unapproved shows to everyone; otherwise its owner and the view-private
 * rung read it, and, when published, the owner's followers a `followers`
 * row and the members of the group it names a `group` row (pulpit#194). A
 * row with no owner skips the owner arm and the follower check, so no
 * viewer's id matches it and the follower seam is never asked about it: it
 * is visible only when it is `public`, not a draft and not unapproved, or to
 * the view-private rung, as `ownedListFilter` lists it
 * (`SEC-AUTH-ENUM-001`). A viewer whose id is empty reads as anonymous
 * (effect-auth#661). Never fails.
 *
 * @internal
 */
export const canViewOwnedRow = <A extends Account, R>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  followers: Seam<R>,
  row: OwnedRowFacts,
): Effect.Effect<boolean, never, R> =>
  canViewOwnedDelegated(viewer, policy, followers, {
    ownerId: Option.getOrUndefined(row.ownerId),
    visibility: row.visibility,
    draft: row.draft,
    unapproved: row.unapproved,
    groupId: Option.getOrUndefined(row.groupId),
  });
