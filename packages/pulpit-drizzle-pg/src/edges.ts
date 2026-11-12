/**
 * @copyright Thomas Foster
 *
 * The kernel's `EdgeStore` (docs/seams.md → `EdgeStore`, pulpit#52) on
 * PostgreSQL (pulpit#356): one table per edge family, each end a node id
 * referencing the tree's identity table. Every read joins each end's
 * current-version view, with the owner joined in, under the end's alias, so
 * an edge whose end has no view row is never read and the family's
 * `ListFilter` reads `alias.column` as the end's column (`./filter`
 * renders it). `members` is that join as a subquery, the `Following` the
 * kernel's `memberFilter` / `nonMemberFilter` hand a leaf store's list, and
 * `closeValidity` sets an interval's end column alone (`EDGE-002`). Every
 * call runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { CloseValidity, EdgeRow, EdgeStore, EdgeValues } from "@thomasfosterau/pulpit/edges";
import { MAX_SET_VALUES, type ListFilter } from "@thomasfosterau/pulpit/filter";
import {
  and,
  eq,
  getTableColumns,
  sql,
  type AnyRelations,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  index,
  QueryBuilder,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
  type PgColumn,
  type AnyPgColumnBuilder,
  type PgSchema,
  type PgTable,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { renderListFilter, type FilterColumn, type FilterColumns } from "./filter.ts";
import { isNodeId } from "./internal/node-id.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import { leafRows } from "./internal/rows.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build one edge family's table (`name`): `id` (a random UUID) and
 * `createdAt` (`created_at`, `DEFAULT now()`), one indexed `uuid` column per
 * end in `ends` (field key → column name), each referencing the identity
 * row and cascading, the family's own `columns`, and, for a family that
 * resolves re-assertions, a unique key over `uniqueKey`'s field keys,
 * `NULLS NOT DISTINCT`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeEdgeTable } from "@thomasfosterau/pulpit-drizzle-pg/edges";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   work: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("core");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const derivedFrom = makeEdgeTable({
 *   schema,
 *   name: "derived_from",
 *   identity: tables.root.identity,
 *   ends: { workId: "work_id", sourceId: "source_id" },
 *   columns: { role: text("role") },
 *   uniqueKey: ["workId", "sourceId", "role"],
 * });
 * strictEqual(getTableName(derivedFrom), "derived_from");
 * ```
 *
 * @since 0.0.0
 */
export const makeEdgeTable = (options: {
  readonly schema: PgSchema;
  readonly name: string;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly ends: { readonly [field: string]: string };
  readonly columns?: { readonly [field: string]: AnyPgColumnBuilder };
  readonly uniqueKey?: ReadonlyArray<string>;
}) => {
  const endColumns = R.map(options.ends, (column) =>
    uuid(column)
      .notNull()
      .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
  );
  return options.schema.table(
    options.name,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      ...endColumns,
      ...options.columns,
    },
    (table) => {
      const column = (field: string) =>
        Option.getOrElse(
          Option.map(
            Arr.findFirst(R.toEntries(table), ([key]) => key === field),
            ([, built]) => built,
          ),
          () => {
            throw new DerivationError({
              message: `makeEdgeTable: "${options.name}" has no column "${field}"`,
            });
          },
        );
      const endIndexes = Arr.map(R.keys(options.ends), (field) =>
        index(`${options.name}_${options.ends[field] ?? field}`).on(column(field)),
      );
      const key = options.uniqueKey ?? [];
      return Arr.isReadonlyArrayNonEmpty(key)
        ? [
            ...endIndexes,
            unique(`${options.name}_unique`)
              .on(column(Arr.headNonEmpty(key)), ...Arr.map(Arr.tailNonEmpty(key), column))
              .nullsNotDistinct(),
          ]
        : endIndexes;
    },
  );
};

/**
 * One end of an edge family, as the store joins it: the edge column (field
 * key) holding the node id, and the endpoint leaf's current-version view.
 *
 * @since 0.0.0
 */
export interface EdgeStoreEnd {
  readonly column: string;
  readonly view: PgView;
}

/** A stored edge as the kernel's `EdgeRow`: an id, a creation instant, column values. */
const StoredEdge = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String, createdAt: Schema.Date }),
  [Schema.Record(Schema.String, Schema.Union([Schema.Json, Schema.Date, Schema.BigInt]))],
);
const isEdgeRow = Schema.is(StoredEdge);

/**
 * Bind the kernel's `EdgeStore` to one edge family's table, in the caller's
 * `CurrentTransaction`. `ends` is the family's ends by alias (the alias its
 * `ListFilter` prefixes, `alias.column`), each the edge column and the
 * endpoint leaf's view (`views.leaves[leaf]`); `uniqueKey` the family's
 * unique key (field keys), as `makeEdgeTable` was given it; `identity` the
 * tree's identity table, which `countAt` locks; `owners` the owner table,
 * joined into each end.
 *
 * - `get` / `delete` are by `id`; `insert` is `INSERT … ON CONFLICT DO
 *   NOTHING RETURNING id`; `existing` matches the unique key `IS NOT
 *   DISTINCT FROM` (always none without one).
 * - `list`, `countAt`, `members` and `countBy` read the edge table INNER
 *   JOINed with each end's rows on `alias.id = edge.<end column>`, the
 *   filter rendered over the edge's columns (bare) and each end's
 *   (`alias.column`). `list` orders `created_at, id` with the window total.
 * - `countAt` first locks the node: `SELECT 1 FROM <identity> WHERE id =
 *   $node FOR NO KEY UPDATE` (docs/seams.md: not `FOR UPDATE`, which would
 *   block every insert keyed to the node), under the caller's READ
 *   COMMITTED transaction.
 * - `members` builds that join as a subquery (`SELECT e.<column> … WHERE
 *   e.<other>::text IN ($ids) AND <where>`), reading nothing.
 * - `closeValidity(id, column, to)` updates that one column (`EDGE-002`).
 *
 * An id that is no canonical UUID names no edge and no node. Throws
 * effect-drizzle-ext's `DerivationError` at module load for a table
 * without `id` / `createdAt`, or an end or key column it lacks.
 *
 * @since 0.0.0
 */
export const makeEdgeStore = <I, Relations extends AnyRelations>(config: {
  readonly table: PgTable;
  readonly ends: { readonly [alias: string]: EdgeStoreEnd };
  readonly uniqueKey?: ReadonlyArray<string>;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): EdgeStore<EdgeRow, SQLWrapper, StoreQueryError<Relations>, I> & {
  readonly closeValidity: CloseValidity<StoreQueryError<Relations>, I>;
} => {
  const { table, identity, owners, CurrentTransaction } = config;
  const qb = new QueryBuilder();
  const columns: { readonly [field: string]: PgColumn } = getTableColumns(table);
  const column = (field: string): PgColumn =>
    Option.getOrElse(R.get(columns, field), () => {
      throw new DerivationError({
        message: `makeEdgeStore: the edge table has no column "${field}"`,
      });
    });
  const id = column("id");
  const uniqueKey = Arr.map(config.uniqueKey ?? [], (field) => [field, column(field)] as const);

  /** Each end's rows (its view, the owner joined in) under its alias, and the edge column it joins on. */
  const ends = Arr.map(R.toEntries(config.ends), ([alias, end]) => ({
    alias,
    rows: leafRows(alias, end.view, owners, `edge_end_${alias}`),
    on: column(end.column),
  }));
  /**
   * The join every read goes through: the edge table INNER JOINed with each
   * end's rows on `end.id = edge.<end column>`, one `FROM` clause.
   */
  const joinedFrom: SQL = sql`${table} ${sql.join(
    Arr.map(ends, ({ rows, on }) => sql`INNER JOIN ${rows.relation} ON ${rows.id} = ${on}`),
    sql` `,
  )}`;
  /** The columns a family's filter reads: the edge's bare, each end's as `alias.column`. */
  const joinedColumns: FilterColumns = Arr.reduce(ends, { ...columns }, (acc, { alias, rows }) => ({
    ...acc,
    ...R.fromEntries(
      Arr.map(R.toEntries(rows.columns), ([key, field]) => [`${alias}.${key}`, field] as const),
    ),
  }));
  /** One of the join's columns by key: the edge's (bare) or an end's (`alias.column`). */
  const joinedColumn = (field: string): Option.Option<FilterColumn> => R.get(joinedColumns, field);
  const createdAt = column("createdAt");
  /** A filter over the join, `true` for `always`. */
  const predicate = (where: ListFilter<SQLWrapper>): SQL =>
    Option.getOrElse(renderListFilter(where, joinedColumns), () => sql`true`);

  /** The distinct ids a set read names: none for no id, or more than `MAX_SET_VALUES`. */
  const namedIds = (ids: ReadonlyArray<string>): Option.Option<Arr.NonEmptyReadonlyArray<string>> =>
    Option.filter(
      Option.liftPredicate(Arr.dedupe(ids), (named): named is Arr.NonEmptyArray<string> =>
        Arr.isArrayNonEmpty(named),
      ),
      (named) => named.length <= MAX_SET_VALUES,
    );
  /** Node ids as the `IN` list a `uuid` column compares as text. */
  const textIn = (field: FilterColumn, ids: Arr.NonEmptyReadonlyArray<string>): SQL =>
    sql`${field}::text IN (${sql.join(
      Arr.map(ids, (value) => sql`${value}`),
      sql`, `,
    )})`;

  /** The rows as the kernel's `EdgeRow`s, or a defect (a column type `ColumnValue` cannot hold). */
  const asEdgeRows = (rows: ReadonlyArray<unknown>) =>
    Arr.every(rows, isEdgeRow)
      ? Effect.succeed<ReadonlyArray<EdgeRow>>(rows)
      : Effect.die(
          new DerivationError({
            message:
              "pulpit-drizzle-pg: an edge row holds a column outside the kernel's ColumnValue",
          }),
        );

  /**
   * The edge's own columns as a read selects them: each an expression over
   * its column (a raw `FROM` admits no bare column), decoded as the column
   * decodes, under its field key.
   */
  const edgeFields = {
    ...R.map(columns, (field, key) => sql`${field}`.mapWith(field).as(key)),
    id: sql<string>`${id}::text`.as("id"),
  };
  /** The values the edge table holds, by field key; a key it lacks is not written. */
  const stored = (values: EdgeValues) => R.filter(values, (_, field) => R.has(columns, field));

  return {
    get: (edgeId) =>
      isNodeId(edgeId)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx.select(edgeFields).from(table).where(eq(id, edgeId)).limit(1);
            return Arr.head(yield* asEdgeRows(rows));
          })
        : Effect.succeedNone,
    list: ({ where, limit, offset }) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({
            ...edgeFields,
            pageTotal: sql<number>`(count(*) over ())::int`.as("page_total"),
          })
          .from(joinedFrom)
          .where(predicate(where))
          .orderBy(sql`${createdAt} ASC`, sql`${id} ASC`)
          .limit(Math.max(0, limit))
          .offset(Math.max(0, offset));
        const total = Option.getOrElse(
          Option.map(Arr.head(rows), (row) => row.pageTotal),
          () => 0,
        );
        return {
          rows: yield* asEdgeRows(Arr.map(rows, ({ pageTotal: _total, ...row }) => row)),
          total,
        };
      }),
    countAt: ({ column: field, nodeId, where }) =>
      Option.match(isNodeId(nodeId) ? joinedColumn(field) : Option.none(), {
        onNone: () => Effect.succeed(0),
        onSome: (at) =>
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            // Serialise creates at this node (docs/seams.md → EdgeStore.countAt).
            yield* tx.execute(
              sql`SELECT 1 FROM ${identity} WHERE ${identity.id} = ${nodeId} FOR NO KEY UPDATE`,
            );
            const rows = yield* tx
              .select({ counted: sql<number>`count(*)::int`.as("counted") })
              .from(joinedFrom)
              .where(and(sql`${at} = ${nodeId}`, predicate(where)));
            return Option.getOrElse(
              Option.map(Arr.head(rows), (row) => row.counted),
              () => 0,
            );
          }),
      }),
    existing: (values) =>
      Arr.isReadonlyArrayNonEmpty(uniqueKey)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ id: sql<string>`${id}::text`.as("id") })
              .from(table)
              .where(
                and(
                  ...Arr.map(
                    uniqueKey,
                    ([field, keyColumn]) =>
                      sql`${keyColumn} IS NOT DISTINCT FROM ${values[field] ?? null}`,
                  ),
                ),
              )
              .limit(1);
            return Option.map(Arr.head(rows), (row) => row.id);
          })
        : Effect.succeedNone,
    insert: (values) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .insert(table)
          .values(stored(values))
          .onConflictDoNothing()
          .returning({ id: sql<string>`${id}::text` });
        return Option.map(Arr.head(rows), (row) => row.id);
      }),
    delete: (edgeId) =>
      isNodeId(edgeId)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx.delete(table).where(eq(id, edgeId)).returning({ id });
            return Arr.isReadonlyArrayNonEmpty(rows);
          })
        : Effect.succeed(false),
    closeValidity: (edgeId, field, to) =>
      isNodeId(edgeId) && R.has(columns, field) && field !== "id"
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            // The one statement that updates an edge: the interval's end column alone (EDGE-002).
            const rows = yield* executeRows<{ readonly id: string }>(
              tx,
              sql`UPDATE ${table} SET ${sql.identifier(column(field).name)} = ${to} WHERE ${id} = ${edgeId} RETURNING ${id}::text AS id`,
            );
            return Arr.isReadonlyArrayNonEmpty(rows);
          })
        : Effect.succeed(false),
    members: ({ column: field, otherColumn, ids, where }) =>
      Effect.succeed<SQLWrapper>(
        Option.match(
          Option.all({
            named: namedIds(ids),
            member: joinedColumn(field),
            other: joinedColumn(otherColumn),
          }),
          {
            // No named node (or no such column), so no member: an empty set, never a failed query.
            onNone: () =>
              qb
                .select({ member: id })
                .from(table)
                .where(sql`false`),
            onSome: ({ named, member, other }) =>
              qb
                .select({ member: sql`${member}`.as("member") })
                .from(joinedFrom)
                .where(and(textIn(other, named), predicate(where))),
          },
        ),
      ),
    countBy: ({ column: field, ids, where }) =>
      Option.match(Option.all({ named: namedIds(ids), at: joinedColumn(field) }), {
        onNone: () => Effect.succeed(HashMap.empty<string, number>()),
        onSome: ({ named, at }) =>
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({
                node: sql<string>`${at}::text`.as("node"),
                counted: sql<number>`count(*)::int`.as("counted"),
              })
              .from(joinedFrom)
              .where(and(textIn(at, named), predicate(where)))
              .groupBy(sql`${at}`);
            return HashMap.fromIterable(Arr.map(rows, (row) => [row.node, row.counted] as const));
          }),
      }),
  };
};
