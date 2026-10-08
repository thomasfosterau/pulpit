/**
 * **The owned leaf's declared-column check**, shared by `./subtype` and
 * `./edges` so the two cannot read the same view differently (pulpit#79).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Option from "effect/Option";

/**
 * Whether the view carries every column an owned leaf declares (owner,
 * visibility and, when declared, draft). An owned leaf whose view lacks one
 * reads no row: `ownedListFilter` lists nothing, and `defineSubtype`'s
 * `get` / `getMany` and `./edges`' `canViewEndpoint` show nothing. Fail
 * closed (`SEC-AUTH-ENUM-001`). Never throws.
 *
 * @internal
 */
export const declaresColumns = (
  access: {
    readonly ownerColumn: string;
    readonly visibilityColumn: string;
    readonly draftColumn: Option.Option<string>;
  },
  viewColumns: ReadonlySet<string>,
): boolean =>
  [access.ownerColumn, access.visibilityColumn, ...Option.toArray(access.draftColumn)].every(
    (column) => viewColumns.has(column),
  );
