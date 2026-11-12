/**
 * @copyright Thomas Foster
 *
 * The reads every leaf-shaped seam shares (`LeafStore`, a gated leaf's
 * head store, `LiveView`, `SearchBranch`), over a **row source**: a subquery that yields one
 * kernel `LeafRow` per row (the leaf view's columns with the owner joined
 * in, a gated head's computed `draft`, a live row's pointed version), with
 * its columns by field key. Each read renders the kernel's filter and order
 * over the source's columns (`../filter.ts`), so every seam reads, pages
 * and counts the same way, in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import {
  always,
  LOCALE_COLUMN,
  MAX_SET_VALUES,
  type ListFilter,
} from "@thomasfosterau/pulpit/filter";
import type { BranchRequest, RankedHit, SearchBranch } from "@thomasfosterau/pulpit/search";
import {
  MAX_PAGE_LIMIT,
  type DistinctQuery,
  type LeafRow,
  type LeafStore,
  type ListOrder,
  type LocalisedListQuery,
  type Page,
} from "@thomasfosterau/pulpit/subtype";
import { VersionAction } from "@thomasfosterau/pulpit/version-chain";
import {
  and,
  Column,
  eq,
  getViewSelectedFields,
  is,
  isNotNull,
  SQL,
  sql,
  type AnyRelations,
  type SQLWrapper,
  type Subquery,
} from "drizzle-orm";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  distinctKey,
  renderListFilter,
  renderListOrder,
  type FilterColumn,
  type FilterColumns,
} from "../filter.ts";
import { isNodeId } from "./node-id.ts";
import { OWNER_COLUMN, type NodeOwnerTable, type StoreQueryError } from "./owners.ts";
import { PgColumn, QueryBuilder, type PgView } from "drizzle-orm/pg-core";

/**
 * A subquery of kernel rows and its columns, by field key, referenced
 * through the subquery's alias.
 *
 * @since 0.0.0
 */
export interface RowSource {
  readonly relation: Subquery;
  readonly columns: FilterColumns;
  readonly id: FilterColumn;
}

/**
 * A subquery's fields as a source's columns: each selected key, referenced
 * through the subquery (so a read against it names the alias).
 *
 * @since 0.0.0
 */
export const sourceOf = <Field>(
  relation: Subquery & { readonly [key: string]: Field },
  keys: ReadonlyArray<string>,
  leaf: string,
): RowSource => {
  // A subquery built from a `FilterColumns` selection exposes each selected
  // key as a field re-aliased to it; each is checked before it is kept.
  const columns = Arr.reduce(keys, R.empty<string, FilterColumn>(), (acc, key) =>
    Option.match(Option.liftPredicate(relation[key], isFilterColumn), {
      onNone: () => acc,
      onSome: (field) => ({ ...acc, [key]: field }),
    }),
  );
  const id = Option.getOrElse(R.get(columns, "id"), () => {
    throw new DerivationError({ message: `pulpit-drizzle-pg: leaf "${leaf}"'s rows have no id` });
  });
  return { relation, columns, id };
};

/** Whether a subquery field is one a filter can render over: a column or an aliased expression. */
const isFilterColumn = (field: unknown): field is FilterColumn =>
  is(field, Column) || is(field, SQL.Aliased);

/**
 * A row as the kernel reads it: `id` a uuid string, `version` the row's
 * `bigint`, `action` the root version table's CHECKed text, and every other
 * column a `ColumnValue`. Drizzle decodes each column through its own type,
 * so a row that fails this is a view outside the contract (a `bytea`
 * column, say): a defect.
 */
const isLeafRow = Schema.is(
  Schema.StructWithRest(
    Schema.Struct({ id: Schema.String, version: Schema.BigInt, action: VersionAction }),
    [Schema.Record(Schema.String, Schema.Union([Schema.Json, Schema.Date, Schema.BigInt]))],
  ),
);

/**
 * The reads over a {@link RowSource}, in the caller's transaction.
 *
 * @since 0.0.0
 */
export const readsOver = <I, Relations extends AnyRelations>(
  leaf: string,
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
) => {
  /** The rows as the kernel's `LeafRow`s, or a defect naming the leaf. */
  const asLeafRows = (rows: ReadonlyArray<unknown>) =>
    Arr.every(rows, isLeafRow)
      ? Effect.succeed<ReadonlyArray<LeafRow>>(rows)
      : Effect.die(
          new DerivationError({
            message: `pulpit-drizzle-pg: leaf "${leaf}" read a row outside the kernel's LeafRow (a column type ColumnValue cannot hold)`,
          }),
        );

  /** The source's rows under `where`, at most `limit` of them. */
  const where = (source: RowSource, predicate: SQL, limit: number) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select(source.columns)
        .from(source.relation)
        .where(predicate)
        .limit(limit);
      return yield* asLeafRows(rows);
    });

  /** The source's rows with these ids (canonical UUIDs, deduplicated by the caller). */
  const byIds = (source: RowSource, ids: Arr.NonEmptyReadonlyArray<string>) =>
    where(source, sql`${source.id} IN ${ids}`, ids.length);

  /** A page under the kernel's filter and order, with the unpaged total (`count(*) OVER ()`). */
  const page = (
    source: RowSource,
    query: {
      readonly where: ListFilter<SQLWrapper>;
      readonly orderBy: ReadonlyArray<ListOrder>;
      readonly limit: number;
      readonly offset: number;
    },
  ) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ ...source.columns, pageTotal: sql<number>`(count(*) over ())::int` })
        .from(source.relation)
        .where(Option.getOrUndefined(renderListFilter(query.where, source.columns)))
        .orderBy(...renderListOrder(query.orderBy, source.columns, source.id))
        .limit(query.limit)
        .offset(query.offset);
      return {
        rows: yield* asLeafRows(Arr.map(rows, ({ pageTotal: _total, ...row }) => row)),
        total: Option.getOrElse(
          Option.map(Arr.head(rows), (row) => row.pageTotal),
          () => 0,
        ),
      };
    });

  /** One column's distinct string values under the filter, by code point, with the distinct count. */
  const distinct = (source: RowSource, query: DistinctQuery<SQLWrapper>) =>
    Option.match(
      Option.flatMap(R.get(source.columns, query.column), (column) =>
        Option.map(distinctKey(column), (key) => ({ column, key })),
      ),
      {
        onNone: () => Effect.succeed<Page<string>>({ rows: [], total: 0 }),
        onSome: ({ column, key }) =>
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const values = tx
              .selectDistinct({ value: sql<string>`${key}`.as("value") })
              .from(source.relation)
              .where(
                and(
                  Option.getOrUndefined(renderListFilter(query.where, source.columns)),
                  isNotNull(column),
                ),
              )
              .as("distinct_values");
            const rows = yield* tx
              .select({ value: values.value, total: sql<number>`(count(*) over ())::int` })
              .from(values)
              .orderBy(values.value)
              .limit(query.limit)
              .offset(query.offset);
            return {
              rows: Arr.map(rows, (row) => row.value),
              total: Option.getOrElse(
                Option.map(Arr.head(rows), (row) => row.total),
                () => 0,
              ),
            };
          }),
      },
    );

  /** `get` / `getMany` over a source: an id that is no canonical UUID names no row. */
  const byId = (source: RowSource) => ({
    get: (nodeId: string) =>
      isNodeId(nodeId)
        ? Effect.map(where(source, sql`${source.id} = ${nodeId}`, 1), Arr.head)
        : Effect.succeedNone,
    getMany: (ids: ReadonlyArray<string>) => {
      const valid = Arr.dedupe(Arr.filter(ids, isNodeId));
      return Arr.isReadonlyArrayNonEmpty(valid) ? byIds(source, valid) : Effect.succeed([]);
    },
  });

  return { where, byIds, byId, page, distinct };
};

/** A view's own columns, by field key, referenced through the view. */
const viewColumns = (view: PgView): FilterColumns =>
  Arr.reduce(
    R.toEntries(getViewSelectedFields(view)),
    R.empty<string, FilterColumn>(),
    (acc, [key, field]) => (isFilterColumn(field) ? { ...acc, [key]: field } : acc),
  );

/**
 * A leaf view's id column, or a thrown `DerivationError` for a view that has
 * none.
 *
 * @since 0.0.0
 */
export const viewId = (leaf: string, view: PgView): PgColumn =>
  Option.getOrElse(
    Option.liftPredicate(R.get(viewColumns(view), "id").pipe(Option.getOrUndefined), (field) =>
      is(field, PgColumn),
    ),
    () => {
      throw new DerivationError({
        message: `pulpit-drizzle-pg: leaf "${leaf}"'s view has no id column`,
      });
    },
  );

/**
 * A view's columns plus the owner, LEFT JOINed in as `ownerId`, and
 * `extra` (computed or overriding columns): the selection a row source
 * subquery takes.
 *
 * @since 0.0.0
 */
export const ownedSelection = (
  view: PgView,
  owners: NodeOwnerTable,
  extra: FilterColumns = {},
): FilterColumns => ({ ...viewColumns(view), [OWNER_COLUMN]: owners.ownerId, ...extra });

/**
 * A leaf view's rows as a row source: the view's own columns, with the
 * node's owner LEFT JOINed in as `ownerId`.
 *
 * @since 0.0.0
 */
export const leafRows = (
  leaf: string,
  view: PgView,
  owners: NodeOwnerTable,
  name = `${leaf}_rows`,
): RowSource => {
  const id = viewId(leaf, view);
  const selection = ownedSelection(view, owners);
  const relation = new QueryBuilder()
    .select(selection)
    .from(view)
    .leftJoin(owners, eq(owners.nodeId, sql`${id}`))
    .as(name);
  return sourceOf(relation, R.keys(selection), leaf);
};

/** A source's key set, as `LeafStore.columns`. */
const columnSet = (columns: FilterColumns): HashSet.HashSet<string> =>
  HashSet.fromIterable(R.keys(columns));

/**
 * One row per node of a localised source (pulpit#272): of the node's rows
 * matching `where` whose locale is one of `locales`, the one whose locale
 * comes first, as `LocalisedListQuery` spells it (`DISTINCT ON (id) …
 * ORDER BY id, array_position($locales, locale)`). `locales` is non-empty
 * and within `MAX_SET_VALUES`; the caller answers none otherwise.
 */
const localeChoice = (
  leaf: string,
  source: RowSource,
  locales: Arr.NonEmptyReadonlyArray<string>,
  where: ListFilter<SQLWrapper>,
): RowSource => {
  const locale = Option.getOrElse(R.get(source.columns, LOCALE_COLUMN), () => {
    throw new DerivationError({
      message: `pulpit-drizzle-pg: leaf "${leaf}"'s localised rows have no locale`,
    });
  });
  const preference = sql`ARRAY[${sql.join(
    Arr.map(locales, (tag) => sql`${tag}`),
    sql`, `,
  )}]::text[]`;
  const relation = new QueryBuilder()
    .selectDistinctOn([source.id], source.columns)
    .from(source.relation)
    .where(
      and(
        Option.getOrUndefined(renderListFilter(where, source.columns)),
        sql`${locale} = ANY(${preference})`,
      ),
    )
    .orderBy(source.id, sql`array_position(${preference}, ${locale})`)
    .as(`${leaf}_chosen_locale`);
  return sourceOf(relation, R.keys(source.columns), leaf);
};

/**
 * The kernel's localised `LeafStore` (docs/seams.md → `LeafStore` → "A
 * localised leaf's view", pulpit#56, pulpit#272): `get` / `getMany` and the
 * owner stamp over the shared rows, `list` / `distinct` over the
 * `(id, locale)` rows (`columns` includes `locale`), and `listLocalised` one
 * row per node in its most preferred locale.
 *
 * @since 0.0.0
 */
export const localisedStoreOver = <I, Relations extends AnyRelations>(
  leaf: string,
  shared: RowSource,
  keyed: RowSource,
  owners: NodeOwnerTable,
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
): LeafStore<LeafRow, SQLWrapper, StoreQueryError<Relations>, I> => {
  const reads = readsOver(leaf, CurrentTransaction);
  return {
    ...storeOver(leaf, shared, owners, CurrentTransaction),
    columns: columnSet(keyed.columns),
    list: (query) => reads.page(keyed, query),
    distinct: (query) => reads.distinct(keyed, query),
    listLocalised: (query) => localisedPage(leaf, keyed, query, CurrentTransaction),
  };
};

/**
 * One page of a localised source's rows, one per node in its most preferred
 * carried locale of `query.locales` ({@link localeChoice}), then the filter,
 * order and page; none for an empty `locales` or one past `MAX_SET_VALUES`.
 * The read `LeafStore.listLocalised` and a gated leaf's
 * `LiveView.listLocalised` share.
 *
 * @since 0.0.0
 */
export const localisedPage = <I, Relations extends AnyRelations>(
  leaf: string,
  source: RowSource,
  query: LocalisedListQuery<SQLWrapper>,
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
): Effect.Effect<Page<LeafRow>, StoreQueryError<Relations>, I> =>
  Arr.isReadonlyArrayNonEmpty(query.locales) && query.locales.length <= MAX_SET_VALUES
    ? readsOver(leaf, CurrentTransaction).page(
        localeChoice(leaf, source, query.locales, query.where),
        { ...query, where: always },
      )
    : Effect.succeed({ rows: [], total: 0 });

/**
 * The kernel's `LeafStore` over one row source: id reads, the page, the
 * distinct values and the owner stamp, in the caller's transaction.
 *
 * @since 0.0.0
 */
export const storeOver = <I, Relations extends AnyRelations>(
  leaf: string,
  source: RowSource,
  owners: NodeOwnerTable,
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
): LeafStore<LeafRow, SQLWrapper, StoreQueryError<Relations>, I> => {
  const reads = readsOver(leaf, CurrentTransaction);
  return {
    columns: columnSet(source.columns),
    ...reads.byId(source),
    list: (query) => reads.page(source, query),
    distinct: (query) => reads.distinct(source, query),
    // A leaf view has no locale level (the localised store reads the keyed
    // view instead), so it carries no locale rows to choose among.
    listLocalised: () => Effect.succeed({ rows: [], total: 0 }),
    ownerOf: (nodeId) =>
      isNodeId(nodeId)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ ownerId: owners.ownerId })
              .from(owners)
              .where(eq(owners.nodeId, nodeId))
              .limit(1);
            return Option.map(Arr.head(rows), (row) => row.ownerId);
          })
        : Effect.succeedNone,
    stampOwner: (nodeId, ownerId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.insert(owners).values({ nodeId, ownerId });
      }),
  };
};

/**
 * How a search branch ranks a source's rows for a query (docs/seams.md →
 * `SearchBranch`): `matches`, the predicate a hit satisfies, and `score`, a
 * number read as `double precision`, higher first; none when the query can match nothing (a literal-id branch
 * handed a query that is no identifier, say).
 *
 * @since 0.0.0
 */
export type SearchRank = (
  columns: FilterColumns,
  query: string,
) => Option.Option<{ readonly matches: SQL; readonly score: SQL }>;

/**
 * The kernel's `SearchBranch` over the row source `sourceFor` picks for a
 * request (one source for every request on an ungated leaf; a gated leaf's
 * chosen rows for `request.headFor`): one statement that ranks the rows
 * matching the query and the scope together (never rank, then filter), best
 * score first, ties by id, at most `request.limit` (clamped to `[0,
 * MAX_PAGE_LIMIT]`).
 *
 * @since 0.0.0
 */
export const searchOver = <I, Relations extends AnyRelations>(
  sourceFor: (request: BranchRequest<SQLWrapper>) => RowSource,
  options: {
    readonly name: string;
    readonly weight?: number;
    readonly rank: SearchRank;
  },
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
): SearchBranch<SQLWrapper, StoreQueryError<Relations>, I> => {
  const branch: SearchBranch<SQLWrapper, StoreQueryError<Relations>, I> = {
    name: options.name,
    search: (request) => {
      const limit = Math.max(0, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT));
      const source = sourceFor(request);
      const ranked = limit > 0 ? options.rank(source.columns, request.query) : Option.none();
      return Option.match(ranked, {
        onNone: () => Effect.succeed([]),
        onSome: ({ matches, score }) =>
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            // The score is read as a `double precision`: a cast, so even a
            // constant score (`0`) is an expression, never an `ORDER BY`
            // column position.
            const rows = yield* tx
              .select({ id: sql<string>`${source.id}::text` })
              .from(source.relation)
              .where(
                and(
                  matches,
                  Option.getOrUndefined(renderListFilter(request.scope, source.columns)),
                ),
              )
              .orderBy(
                sql`(${score})::float8 DESC NULLS LAST`,
                ...renderListOrder([], source.columns, source.id),
              )
              .limit(limit);
            return Arr.map(rows, ({ id }): RankedHit => ({ id }));
          }),
      });
    },
  };
  return options.weight === undefined ? branch : { ...branch, weight: options.weight };
};
