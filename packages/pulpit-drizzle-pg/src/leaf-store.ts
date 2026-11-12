/**
 * @copyright Thomas Foster
 *
 * The kernel's `LeafStore` (README → Seams → `LeafStore`) over the
 * fail-closed current-version views effect-drizzle-ext's `makeTreeViews`
 * derives from a tree (pulpit#247), plus the owner table the kernel's owned
 * leaves stamp (`core.node_owner` in the applications), which is pulpit's
 * vocabulary and so lives here, not in effect-drizzle-ext.
 *
 * Each row is the leaf view's row (`id`, the head's `version` and `action`,
 * the identity extras, every level's columns, `timestamp`, `createdAt`) with
 * the node's owner LEFT JOINed in as `ownerId`. `list` renders the kernel's
 * `ListFilter` and list order (`./filter`) and returns the unpaged total as
 * a window column; `distinct` reads one column's distinct string values
 * over the same rows. Every read and write runs in the caller's ambient
 * `CurrentTransaction`, as the version chain does: no store opens a
 * connection or a transaction of its own.
 *
 * @since 0.0.0
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { ChainTree } from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import type { LeafRow, LeafStore } from "@thomasfosterau/pulpit/subtype";
import { getTableColumns, type AnyRelations, type SQLWrapper } from "drizzle-orm";
import type { PgTable, PgView } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Owners from "./internal/owners.ts";
import { leafRows, localisedStoreOver, storeOver } from "./internal/rows.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * The owner column a leaf store joins in, under the key the kernel's
 * `ownedAccess` reads (`ownerColumn: "ownerId"`).
 *
 * @since 0.0.0
 */
export const OWNER_COLUMN = Owners.OWNER_COLUMN;

/**
 * Build the owner table (`node_owner` unless `name` says otherwise): one row
 * per owned node, `node_id` its primary key and a foreign key to the
 * identity table that cascades on delete (so `purge` takes it too), and
 * `owner_id` the owning account, indexed for the owner arm of a list.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeNodeOwnerTable } from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const schema = pgSchema("core");
 * const title = dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false });
 * const tree = defineTree({ post: { leaf: { title } } });
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * strictEqual(getTableName(makeNodeOwnerTable({ schema, identity: tables.root.identity })), "node_owner");
 * ```
 *
 * @since 0.0.0
 */
export const makeNodeOwnerTable = Owners.makeNodeOwnerTable;

/**
 * The owner table a leaf store reads and stamps: {@link makeNodeOwnerTable}'s.
 *
 * @since 0.0.0
 */
export type NodeOwnerTable = Owners.NodeOwnerTable;

/**
 * The query failure a leaf store reports: the driver's own error, as the
 * application's `CurrentTransaction` raises it.
 *
 * @since 0.0.0
 */
export type StoreQueryError<Relations extends AnyRelations> = Owners.StoreQueryError<Relations>;

/**
 * Every leaf's {@link LeafStore}, keyed by leaf name: rows are the kernel's
 * `LeafRow`, `Following` a SQL subquery (`SQLWrapper`).
 *
 * @since 0.0.0
 */
export type LeafStores<Leaf extends string, E, I> = {
  readonly [K in Leaf]: LeafStore<LeafRow, SQLWrapper, E, I>;
};

/** The keys one level of a path contributes to its view: its version columns past `(id, version)`. */
const levelKeys = (table: PgTable): ReadonlyArray<string> =>
  Arr.filter(R.keys(getTableColumns(table)), (key) => key !== "id" && key !== "version");

/**
 * The keys a leaf view's own projection supplies beside the path's columns
 * (the head, the tail, the joined owner), which no other source may reuse.
 */
const PROJECTED = ["id", "version", "action", "timestamp", "createdAt", OWNER_COLUMN] as const;

/**
 * The view merges its sources by key (`{ ...identityExtras, ...levels,
 * timestamp, createdAt }`), so two sources sharing a key would silently keep
 * the later one: an identity extra `slug` shadowed by a level's `slug`, or a
 * level column named `createdAt` shadowed by the birth timestamp (the trap
 * gardeneria hit in its hand-written current-version view). Refuse such a
 * tree at module load instead, naming both sources.
 */
const checkMerge = (
  leaf: string,
  sources: ReadonlyArray<readonly [source: string, keys: ReadonlyArray<string>]>,
): void => {
  Arr.reduce(sources, R.empty<string, string>(), (seen, [source, keys]) =>
    Arr.reduce(keys, seen, (acc, key) =>
      Option.match(R.get(acc, key), {
        onNone: () => ({ ...acc, [key]: source }),
        onSome: (earlier) => {
          throw new DerivationError({
            message: `makeLeafStores: leaf "${leaf}"'s view takes "${key}" from both ${earlier} and ${source}; the later would silently shadow the earlier. Rename one.`,
          });
        },
      }),
    ),
  );
};

/**
 * Bind the kernel's `LeafStore` to every leaf view of a tree:
 * `views` from `makeTreeViews(tree, tables, …)` (its `leaves`, and its
 * `keyed` for a localised leaf), the owner table from
 * {@link makeNodeOwnerTable}, and the application's `CurrentTransaction`.
 *
 * - `columns` is the view's field keys plus `ownerId`.
 * - `get` / `getMany` are `id = $id` / `id IN (…)` reads with a `LIMIT`; an
 *   id that is no canonical UUID names no node (none, or omitted), never a
 *   query error.
 * - `list` renders its `ListFilter` (`renderListFilter`), orders by its
 *   checked `orderBy` then `id` (`renderListOrder`: `NULLS LAST` on every
 *   key, a string by code point), pages by `LIMIT` / `OFFSET`, and reads the
 *   unpaged total off `count(*) OVER ()` (so a page past the end reports
 *   `total: 0`).
 * - `distinct` reads one column's distinct non-`NULL` values over the rows
 *   `list` reads, by code point, with the distinct count; a column that
 *   decodes to no string has none.
 * - `ownerOf` / `stampOwner` read and insert the owner row.
 * - `listLocalised` reads none for a leaf with no keyed view (`views.keyed`).
 *
 * A keyed leaf (one in `views.keyed`, which `makeTreeViews` derives for a
 * leaf with a keyed level) reads its keyed view instead (README → Seams →
 * `LeafStore` → "A localised leaf's view", pulpit#56): `columns`, `list`
 * and `distinct` read its `(id, locale)` rows, one `NULL`-locale row for a
 * node with none, so the `locale` arm and the translated columns filter;
 * `get` / `getMany` read the shared row, one per node; and `listLocalised`
 * picks each node's most preferred carried locale of `query.locales`
 * (`DISTINCT ON (id) … ORDER BY id, array_position(…)`) before the filter,
 * order and page. A node carrying none of them is absent.
 *
 * Throws effect-drizzle-ext's `DerivationError` at module load when a leaf
 * view would take one key from two sources (an identity extra and a level
 * column, or either and a projected column: `timestamp`, `createdAt`,
 * `ownerId`), which the view's merge would otherwise resolve silently.
 *
 * @since 0.0.0
 */
export const makeLeafStores = <S, Leaf extends string, I, Relations extends AnyRelations>(config: {
  readonly tree: ChainTree<S>;
  readonly tables: VersionChainTables;
  readonly views: {
    readonly leaves: { readonly [K in Leaf]: PgView };
    readonly keyed?: { readonly [leaf: string]: PgView };
  };
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): LeafStores<Leaf, StoreQueryError<Relations>, I> => {
  const { tree, tables, owners, CurrentTransaction } = config;
  const identityExtras = Arr.filter(
    R.keys(getTableColumns(tables.root.identity)),
    (key) => key !== "id" && key !== "type",
  );

  const storeOf = (
    leaf: string,
    view: PgView,
  ): LeafStore<LeafRow, SQLWrapper, StoreQueryError<Relations>, I> => {
    const path = Option.match(
      Arr.findFirst(tree.levels, (level) => level.name === leaf),
      {
        onNone: () => [leaf],
        onSome: (level) => [...level.ancestors, leaf],
      },
    );
    checkMerge(leaf, [
      ["the view's own projection", PROJECTED],
      ["the identity table", identityExtras],
      ...Arr.flatMap(path, (name) =>
        Arr.fromOption(
          Option.map(
            R.get(tables.levels, name),
            (level) => [`level "${name}"`, levelKeys(level.version)] as const,
          ),
        ),
      ),
    ]);
    const shared = leafRows(leaf, view, owners);
    return Option.match(R.get(config.views.keyed ?? {}, leaf), {
      onNone: () => storeOver(leaf, shared, owners, CurrentTransaction),
      onSome: (keyedView) =>
        localisedStoreOver(
          leaf,
          shared,
          leafRows(leaf, keyedView, owners, `${leaf}_locale_rows`),
          owners,
          CurrentTransaction,
        ),
    });
  };

  return R.map(config.views.leaves, (view, leaf) => storeOf(leaf, view));
};
