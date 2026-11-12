/**
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#filter.
 *
 * @copyright Thomas Foster
 *
 * The kernel's read predicates and list order, rendered to SQL (pulpit#247):
 * a `ListFilter` as a Drizzle `WHERE`, and a checked `ListOrder` as an
 * `ORDER BY`, over the columns of a view. The contract is the kernel's
 * (docs/content-model.md → `./filter`, and docs/seams.md → `LeafStore`), which its in-memory
 * `evaluate` and `makeInMemoryLeafStore` read too, so a SQL store and the
 * fakes agree row for row:
 *
 * - `always` is no predicate; `never`, and any node over a column the view
 *   lacks, is `false` (fail closed).
 * - `eq` / `ne` / `anyOf` / `noneOf` / the comparisons bind their values
 *   through the column, so a `NULL` column satisfies none of them; a `NaN`
 *   or invalid `Date` comparand, and a set past `MAX_SET_VALUES`, is `never`.
 * - `in` is `col IN (<subquery>)` over the follower or edge seam's
 *   subquery, never a materialised array; `notIn` its exact complement,
 *   `(col IS NULL OR col NOT IN (<subquery>))`.
 * - A string compares and sorts by code point: `col::text COLLATE "C"`.
 * - `published` / `notPublished` use the database's `now()`, parenthesised.
 * - An order is `<key> ASC|DESC NULLS LAST, …, id ASC`.
 *
 * @since 0.0.0
 */

import { MAX_SET_VALUES, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { ListOrder } from "@thomasfosterau/pulpit/subtype";
import {
  and,
  Column,
  eq,
  gt,
  gte,
  inArray,
  is,
  lt,
  lte,
  ne,
  notInArray,
  or,
  SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";

/**
 * A view column as a filter or order reads it: a Drizzle column, or an
 * aliased expression the view projects (its `createdAt`).
 *
 * @since 0.0.0
 */
export type FilterColumn = PgColumn | SQL.Aliased;

/**
 * The columns a filter renders over, by the view's field key.
 *
 * @since 0.0.0
 */
export type FilterColumns = { readonly [column: string]: FilterColumn };

/** The column a field decodes through: itself, or an aliased expression's `mapWith` column. */
const decoderOf = (column: FilterColumn): Option.Option<Column> => {
  if (!is(column, SQL.Aliased)) return Option.some(column);
  const decoder = P.hasProperty(column.sql, "decoder") ? column.sql.decoder : undefined;
  return is(decoder, Column) ? Option.some(decoder) : Option.none();
};

/** A value a filter node compares a column with. */
type Operand = string | number | boolean | Date;

/** A binary comparison over a column, an aliased expression or a cast. */
const binary = (operator: typeof eq, left: FilterColumn | SQL, right: Operand): SQL =>
  is(left, SQL.Aliased)
    ? operator(left, right)
    : is(left, SQL)
      ? operator(left, right)
      : operator(left, right);

/** `left IN (…values)`, or `NOT IN` when `negate`, over a column, an aliased expression or a cast. */
const inSet = (left: FilterColumn | SQL, values: ReadonlyArray<Operand>, negate: boolean): SQL => {
  const list = [...values];
  if (is(left, SQL.Aliased)) return negate ? notInArray(left, list) : inArray(left, list);
  if (is(left, SQL)) return negate ? notInArray(left, list) : inArray(left, list);
  return negate ? notInArray(left, list) : inArray(left, list);
};

/** The JavaScript type a column decodes to (drizzle's `dataType`, first word). */
const dataTypeOf = (column: FilterColumn): Option.Option<string> => {
  return Option.flatMap(decoderOf(column), (decoder) => Arr.head(decoder.dataType.split(" ")));
};

/** Whether a column decodes to a string, and so compares and sorts by code point. */
const isStringColumn = (column: FilterColumn): boolean =>
  Option.contains(dataTypeOf(column), "string");

/**
 * The operand an equality or set test reads: a `uuid` column as its text, so
 * a value that is no UUID compares unequal instead of failing the query
 * (the kernel's ids are strings; a wire id may be anything).
 */
const operand = (column: FilterColumn): FilterColumn | SQL => {
  return Option.exists(decoderOf(column), (decoder) => decoder.getSQLType() === "uuid")
    ? sql`(${column})::text`
    : column;
};

/** A column's code-point form: `col::text COLLATE "C"`. */
const codePoint = (column: FilterColumn) => sql`(${column})::text COLLATE "C"`;

/** The predicate no row satisfies. */
const never = sql`false`;

/** A comparand outside the contract: `NaN`, or an invalid `Date`. */
const isUnorderable = (value: Operand): boolean =>
  (P.isNumber(value) && Number.isNaN(value)) || (P.isDate(value) && Number.isNaN(value.getTime()));

type Comparison = "gt" | "gte" | "lt" | "lte";

const comparisons = { gt, gte, lt, lte } as const;
const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** `col <op> $v`: a string by code point, anything else through the column's own encoding. */
const compare = (op: Comparison, column: FilterColumn, value: string | number | Date): SQL => {
  if (isUnorderable(value)) return never;
  if (P.isString(value)) return sql`${codePoint(column)} ${sql.raw(operators[op])} ${value}`;
  if (P.isNumber(value) && !Number.isFinite(value)) {
    return sql`${column} ${sql.raw(operators[op])} ${sql.raw(value > 0 ? "'Infinity'" : "'-Infinity'")}::float8`;
  }
  return binary(comparisons[op], column, value);
};

/** A literal set's values, or none when the set is outside the contract (too large, or holding a `NaN`). */
const boundedSet = <A extends Operand>(values: ReadonlyArray<A>): Option.Option<ReadonlyArray<A>> =>
  values.length > MAX_SET_VALUES || Arr.some(values, isUnorderable)
    ? Option.none()
    : Option.some(values);

/**
 * Render a `ListFilter` over `columns` as a Drizzle `WHERE` predicate, or
 * none for `always` (no predicate: `Option.getOrUndefined` is what Drizzle's
 * `.where` takes).
 * `Following` is a SQL subquery (a `SQLWrapper`): the follower seam's
 * `following`, or an edge family's members. A node over a column `columns`
 * lacks renders as `false`, and so does a `locale` node over a view with no
 * `locale` column (an unlocalised view).
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { and, eq } from "@thomasfosterau/pulpit/filter";
 * import { renderListFilter } from "@thomasfosterau/pulpit-drizzle-pg/filter";
 * import { getTableColumns } from "drizzle-orm";
 * import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
 * import * as Option from "effect/Option";
 *
 * const posts = pgTable("posts", { visibility: text("visibility"), ownerId: text("owner_id") });
 * const where = renderListFilter(
 *   and(eq("visibility", "public"), eq("ownerId", "u-1")),
 *   getTableColumns(posts),
 * );
 * const query = new PgDialect().sqlToQuery(Option.getOrThrow(where));
 * strictEqual(query.sql, '(("posts"."visibility" = $1) and ("posts"."owner_id" = $2))');
 * ```
 *
 * @since 0.0.0
 */
export const renderListFilter = (
  filter: ListFilter<SQLWrapper>,
  columns: FilterColumns,
): Option.Option<SQL> =>
  filter.kind === "always" ? Option.none() : Option.some(render(filter, columns));

/** One node, `always` included (as `true`, inside a combinator). */
const render = (filter: ListFilter<SQLWrapper>, columns: FilterColumns): SQL => {
  const withColumn = (name: string, f: (column: FilterColumn) => SQL): SQL =>
    Option.match(R.get(columns, name), { onNone: () => never, onSome: f });
  return Match.value(filter).pipe(
    Match.discriminatorsExhaustive("kind")({
      always: () => sql`true`,
      never: () => never,
      eq: ({ column, value }) =>
        withColumn(column, (c) => (isUnorderable(value) ? never : binary(eq, operand(c), value))),
      ne: ({ column, value }) =>
        withColumn(column, (c) => (isUnorderable(value) ? never : binary(ne, operand(c), value))),
      in: ({ column, set }) => withColumn(column, (c) => sql`${c} IN (${set})`),
      notIn: ({ column, set }) =>
        withColumn(column, (c) => sql`(${c} IS NULL OR ${c} NOT IN (${set}))`),
      gt: ({ column, value }) => withColumn(column, (c) => compare("gt", c, value)),
      gte: ({ column, value }) => withColumn(column, (c) => compare("gte", c, value)),
      lt: ({ column, value }) => withColumn(column, (c) => compare("lt", c, value)),
      lte: ({ column, value }) => withColumn(column, (c) => compare("lte", c, value)),
      anyOf: ({ column, values }) =>
        withColumn(column, (c) =>
          Option.match(boundedSet(values), {
            onNone: () => never,
            onSome: (bounded) =>
              Arr.isReadonlyArrayNonEmpty(bounded) ? inSet(operand(c), bounded, false) : never,
          }),
        ),
      noneOf: ({ column, values }) =>
        withColumn(column, (c) =>
          Option.match(boundedSet(values), {
            onNone: () => never,
            // `NULL <> ALL(…)` is `NULL`, so a `NULL` column satisfies a
            // non-empty `noneOf`; over no values every row does.
            onSome: (bounded) =>
              Arr.isReadonlyArrayNonEmpty(bounded) ? inSet(operand(c), bounded, true) : sql`true`,
          }),
        ),
      isNull: ({ column }) => withColumn(column, (c) => sql`${c} IS NULL`),
      published: ({ column }) =>
        withColumn(column, (c) => sql`(${c} IS NOT NULL AND ${c} <= now())`),
      notPublished: ({ column }) => withColumn(column, (c) => sql`(${c} IS NULL OR ${c} > now())`),
      locale: ({ column, locales }) =>
        withColumn(column, (c) =>
          Arr.isReadonlyArrayNonEmpty(locales) && locales.length <= MAX_SET_VALUES
            ? inSet(c, locales, false)
            : never,
        ),
      and: ({ filters }) =>
        Option.getOrElse(
          Option.fromUndefinedOr(and(...Arr.map(filters, (f) => render(f, columns)))),
          () => sql`true`,
        ),
      or: ({ filters }) =>
        Option.getOrElse(
          Option.fromUndefinedOr(or(...Arr.map(filters, (f) => render(f, columns)))),
          () => never,
        ),
    }),
  );
};

/**
 * Render a checked list order over `columns` as `ORDER BY` terms: each key
 * `ASC|DESC NULLS LAST` (a string key by code point, `col::text COLLATE
 * "C"`), closed by `id ASC`. `orderBy` arrives checked by the kernel (every
 * column sortable, no column twice); a key `columns` lacks is skipped, which
 * never changes which rows a list reads.
 *
 * @since 0.0.0
 */
export const renderListOrder = (
  orderBy: ReadonlyArray<ListOrder>,
  columns: FilterColumns,
  id: FilterColumn,
): ReadonlyArray<SQL> => [
  ...Arr.flatMap(orderBy, ({ column, direction }) =>
    Option.toArray(
      Option.map(R.get(columns, column), (c) => {
        const key = isStringColumn(c) ? codePoint(c) : sql`${c}`;
        return direction === "asc" ? sql`${key} ASC NULLS LAST` : sql`${key} DESC NULLS LAST`;
      }),
    ),
  ),
  sql`${id} ASC`,
];

/**
 * A column's distinct-value key: its code-point form when it decodes to a
 * string, none otherwise (only a string is a distinct value, so a column of
 * any other type has none).
 *
 * @since 0.0.0
 */
export const distinctKey = (column: FilterColumn): Option.Option<SQL> =>
  isStringColumn(column) ? Option.some(codePoint(column)) : Option.none();
