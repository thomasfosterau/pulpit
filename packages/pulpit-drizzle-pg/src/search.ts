/**
 * @copyright Thomas Foster
 *
 * The kernel's `SearchBranch` (README → Seams → `SearchBranch`, pulpit#204)
 * over a tree's views: one ranked statement per branch that renders the
 * leaf's read scope (`searchScopeFilter`) through `./filter` beside the rank,
 * so a row outside the scope is never ranked and never shifts another hit's
 * rank (`SEC-AUTH-ENUM-001`). A publish-gated leaf's branch is
 * `./publication`'s `searchBranch`, over the rows `LiveView.list` reads for
 * the request's `headFor` (pulpit#346).
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { SearchBranch } from "@thomasfosterau/pulpit/search";
import { sql, type AnyRelations, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PgView } from "drizzle-orm/pg-core";
import type * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { FilterColumns } from "./filter.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import * as Rows from "./internal/rows.ts";

/**
 * How a branch ranks a row for a query: `matches`, the predicate every hit
 * satisfies, and `score`, best (highest) first, ties by id; none when the
 * query can match nothing, so the branch reads nothing (a literal-id branch
 * handed a query that is no identifier, say). `columns` are the branch's
 * row source's, by field key: the view's, a branch view's `project`
 * columns among them, and `ownerId`.
 *
 * @since 0.0.0
 */
export type SearchRank = Rows.SearchRank;

/**
 * A branch's name (the key `FusedHit.ranks` reports it under), its fusion
 * weight (`1` when omitted) and its rank.
 *
 * @since 0.0.0
 */
export interface SearchBranchOptions {
  readonly name: string;
  readonly weight?: number;
  readonly rank: SearchRank;
}

/**
 * Bind the kernel's `SearchBranch` to one view of a tree: a leaf view
 * (`views.leaves[leaf]`), or a branch view (`views.branches[marker]`, a
 * `UNION ALL` over the marker's leaves with its `project` columns), the
 * owner joined in as `ownerId` as `./leaf-store` reads it.
 *
 * `search({ query, scope, limit })` is one statement: `SELECT id … WHERE
 * rank.matches AND scope ORDER BY rank.score DESC NULLS LAST, id LIMIT
 * limit`, `scope` rendered by `renderListFilter` over the same columns
 * `./leaf-store`'s `list` renders it over, so the leaf's
 * `searchScopeFilter` scopes the ranking itself. A scope node over a column
 * the view lacks is `false`, so a branch view without a leaf's access
 * columns ranks none of its rows. `limit` is clamped to `[0,
 * MAX_PAGE_LIMIT]`. `request.headFor` is ignored: a leaf or branch view
 * has no live pointer (a gated leaf's branch is `./publication`'s
 * `searchBranch`). Applies no other policy, never opens a transaction, and
 * fails only with the driver's query error. The hits are ids for
 * `hydrateSearchHits`, which re-reads each through the leaf's gated
 * `getMany`.
 *
 * Throws effect-drizzle-ext's `DerivationError` at module load for a view
 * with no `id` column.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
 * import { makeNodeOwnerTable } from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
 * import { fullTextRank, makeSearchBranch } from "@thomasfosterau/pulpit-drizzle-pg/search";
 * import { sql } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   post: {
 *     leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) },
 *   },
 * });
 * const schema = pgSchema("content");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const views = makeTreeViews(tree, tables, { schema });
 * const owners = makeNodeOwnerTable({ schema, identity: tables.root.identity });
 * const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });
 *
 * const text_ = makeSearchBranch({
 *   view: views.leaves.post,
 *   owners,
 *   name: "text",
 *   rank: fullTextRank({
 *     vector: (columns) => sql`to_tsvector('simple', coalesce(${columns["title"]}, ''))`,
 *   }),
 *   CurrentTransaction,
 * });
 * strictEqual(text_.name, "text");
 * ```
 *
 * @since 0.0.0
 */
export const makeSearchBranch = <I, Relations extends AnyRelations>(
  config: SearchBranchOptions & {
    readonly view: PgView;
    readonly owners: NodeOwnerTable;
    readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
  },
): SearchBranch<SQLWrapper, StoreQueryError<Relations>, I> => {
  const rows = Rows.leafRows(config.name, config.view, config.owners, `${config.name}_search_rows`);
  return Rows.searchOver(() => rows, config, config.CurrentTransaction);
};

/**
 * The full-text {@link SearchRank} the seam describes: `matches` is
 * `vector @@ websearch_to_tsquery(config, query)` and `score`
 * `ts_rank_cd(vector, websearch_to_tsquery(config, query))`, where `vector`
 * is the row's `tsvector` (a branch view's `project` column, say
 * `setweight(to_tsvector(…), 'A') || …`, or one built from the columns).
 * `config` is the text-search configuration (`'simple'` when omitted). A
 * blank query matches nothing.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { fullTextRank } from "@thomasfosterau/pulpit-drizzle-pg/search";
 * import { sql } from "drizzle-orm";
 * import * as Option from "effect/Option";
 *
 * const rank = fullTextRank({ vector: () => sql`to_tsvector('simple', 'tomato')` });
 * strictEqual(Option.isNone(rank({}, "  ")), true);
 * strictEqual(Option.isSome(rank({}, "tomato")), true);
 * ```
 *
 * @since 0.0.0
 */
export const fullTextRank =
  (options: {
    readonly vector: (columns: FilterColumns) => SQL;
    readonly config?: string;
  }): SearchRank =>
  (columns, query) => {
    const vector = options.vector(columns);
    const tsquery = sql`websearch_to_tsquery(${options.config ?? "simple"}::regconfig, ${query})`;
    return Str.isEmpty(Str.trim(query))
      ? Option.none()
      : Option.some({
          matches: sql`(${vector}) @@ ${tsquery}`,
          score: sql`ts_rank_cd(${vector}, ${tsquery})`,
        });
  };
