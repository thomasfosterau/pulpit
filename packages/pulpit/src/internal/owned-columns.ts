/**
 * **The owned leaf's row reading**, shared by `./subtype` and `./edges` so
 * the two cannot read the same view or row differently: the declared-column
 * check (pulpit#79) and the facts `canViewOwned` reads off a row (pulpit#80).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`.
 *
 * @internal
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Visibility } from "../content.ts";
import type { ColumnValue } from "../version-chain.ts";

/** The owned access declaration's column names, structurally (`./subtype`'s owned `LeafAccess` fits). */
interface OwnedColumns {
  readonly ownerColumn: string;
  readonly visibilityColumn: string;
  readonly draftColumn: Option.Option<string>;
}

/** The facts `canViewOwned` reads off an owned row, structurally (`./subtype`'s `OwnedFacts`). */
interface OwnedRowFacts {
  readonly ownerId: string;
  readonly visibility: Visibility;
  readonly draft: boolean;
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
 * axis reads `draft: false`. The owner is the column's value through
 * `String`, so a `NULL` owner reads as `"null"` (see pulpit#75). Callers
 * check {@link declaresColumns} first. Never throws.
 *
 * @internal
 */
export const ownedFacts = (
  access: OwnedColumns,
  row: { readonly [column: string]: ColumnValue },
): OwnedRowFacts => ({
  ownerId: String(row[access.ownerColumn]),
  visibility: Option.getOrElse(
    Option.liftPredicate(row[access.visibilityColumn], isVisibility),
    (): Visibility => "private",
  ),
  draft: Option.match(access.draftColumn, {
    onNone: () => false,
    onSome: (column) => row[column] !== false,
  }),
});
