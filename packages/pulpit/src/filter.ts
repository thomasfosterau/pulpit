/**
 * **The list-filter vocabulary** — the kernel's read predicates as data.
 *
 * Every visibility, soft-delete and publication rule the kernel owns has two
 * readings: a per-row answer (may this viewer see this row?) and a set-shaped
 * answer a LIST turns into its `WHERE`. In the apps the second is Drizzle SQL
 * built inline (`ownedListFilterE`, `loadListVisibilityFilters`,
 * `publishedFilter`), which ties the rule to one database layer and makes the
 * two readings impossible to compare. Here the set-shaped answer is a small
 * predicate tree, {@link ListFilter}: a Drizzle renderer (the seam
 * effect-drizzle-ext / effect-auth-drizzle fill, see the package README →
 * Seams) turns it into SQL, and
 * {@link evaluate} runs it against an in-memory row — which is what lets the
 * unit suite prove the list filter and the row predicate never disagree.
 *
 * `Following` is whatever the follower seam hands the `in` node: a subquery
 * (`SQLWrapper`) for SQL, a set for the in-memory evaluator.
 *
 * Rendering contract a SQL renderer must honour:
 *
 * | node | SQL |
 * | --- | --- |
 * | `always` | no predicate (`undefined` to Drizzle's `.where`) |
 * | `never` | a predicate no row satisfies (the apps: `id = '00000000-…'`) |
 * | `eq` / `ne` | `col = $v` / `col <> $v` — a `NULL` column satisfies neither |
 * | `in` | `col IN (<following subquery>)` — a subquery, never a materialised array (#1107); a `NULL` column satisfies none |
 * | `gt` / `gte` / `lt` / `lte` | `col > $v` / `col >= $v` / `col < $v` / `col <= $v` — a string compared with `COLLATE "C"` (code-point order), a `Date` as a timestamp, a number numerically (`±Infinity` included); a `NULL` column satisfies none |
 * | `anyOf` | `col = ANY($values)` — a `NULL` column satisfies none; empty is `never`; never a `NULL` element |
 * | `noneOf` | `col <> ALL($values)` — a `NULL` column satisfies none; empty is `always` (`<> ALL` over no values is true); never a `NULL` element (`<> ALL('{1,NULL}')` is `NULL` for every row outside the set) |
 * | `isNull` | `col IS NULL` — the one node a `NULL` column satisfies by itself |
 * | `published` | `(col IS NOT NULL AND col <= now())` — the database's clock, one per query |
 * | `notPublished` | `(col IS NULL OR col > now())` — parenthesised, so it cannot bind to a surrounding `AND` |
 * | `and` / `or` | `AND` / `OR` over the parts |
 *
 * An `anyOf` / `noneOf` node carrying more than {@link MAX_SET_VALUES} values,
 * duplicates counted, is `never`, in the renderer as in {@link evaluate}
 * (`SEC-INPUT-003`); the constructors already fold it so.
 *
 * Outside the contract, where SQL and {@link evaluate} cannot be made to
 * agree, `evaluate` fails closed:
 *
 * - **A column of another type than the comparand** (or than any of a
 *   literal set's values) is a caller or schema error. SQL may coerce the
 *   parameter (an `integer` column against `'1'`) or raise (against
 *   `'abc'`); `evaluate` reads every such row as satisfying no `eq`, `ne`,
 *   comparison, `anyOf` or `noneOf`.
 * - **`NaN`** (and an invalid `Date`). PostgreSQL's `float8` / `numeric` hold
 *   `NaN` equal to itself and above every number, an order JavaScript's
 *   `NaN` does not have. The constructors fold a `NaN` comparand, or a set
 *   holding one, to `never`; `evaluate` reads a `NaN` comparand or column as
 *   satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`; and a renderer
 *   must never bind `NaN`, rendering a hand-built node carrying one as `never`.
 * - **Sub-millisecond instants.** A PostgreSQL timestamp keeps microseconds,
 *   a JavaScript `Date` milliseconds, so two instants within one millisecond
 *   can compare unequal in SQL and equal in `evaluate`.
 *
 * @copyright Thomas Foster
 * @module pulpit/filter
 * @since 0.1.0
 */

import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { byCodePoint } from "./internal/list-order.ts";
import type { ColumnValue } from "./version-chain.ts";

/**
 * A value an `eq` / `ne` node compares against. No `null`: `col = NULL` is
 * never true in SQL, so a null comparison would read differently in the
 * renderer and the evaluator.
 *
 * @since 0.1.0
 */
export type Scalar = string | number | boolean;

/**
 * A value a `gt` / `gte` / `lt` / `lte` node compares against. A `string`
 * orders by code point (SQL's `"C"` collation), a `number` numerically and a
 * `Date` by its instant. Kept apart from {@link Scalar}, which `eq` / `ne`
 * test by identity and so cannot hold a `Date`; a `boolean` has no order a
 * filter needs.
 *
 * @since 0.1.0
 */
export type Comparable = string | number | Date;

/**
 * The most values an `anyOf` / `noneOf` node carries (`SEC-INPUT-003`): a
 * literal set past it is `never`, so no request drives an unbounded
 * `= ANY($values)` parameter. An application's own bound sits below it:
 * `@thomasfosterau/pulpit-wordpress` caps each list parameter at 100, a cap
 * WordPress core itself doesn't set (pulpit#86).
 *
 * @since 0.1.0
 */
export const MAX_SET_VALUES = 1000;

/**
 * A row as {@link evaluate} reads it: the view's columns by name.
 *
 * @since 0.1.0
 */
export type FilterRow = { readonly [column: string]: ColumnValue };

/**
 * A read predicate over a current-version view's columns.
 *
 * @since 0.1.0
 */
export type ListFilter<Following> =
  | { readonly kind: "always" }
  | { readonly kind: "never" }
  | { readonly kind: "eq"; readonly column: string; readonly value: Scalar }
  | { readonly kind: "ne"; readonly column: string; readonly value: Scalar }
  | { readonly kind: "in"; readonly column: string; readonly set: Following }
  | { readonly kind: "gt"; readonly column: string; readonly value: Comparable }
  | { readonly kind: "gte"; readonly column: string; readonly value: Comparable }
  | { readonly kind: "lt"; readonly column: string; readonly value: Comparable }
  | { readonly kind: "lte"; readonly column: string; readonly value: Comparable }
  | { readonly kind: "anyOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  | { readonly kind: "noneOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  | { readonly kind: "isNull"; readonly column: string }
  | { readonly kind: "published"; readonly column: string }
  | { readonly kind: "notPublished"; readonly column: string }
  | { readonly kind: "and"; readonly filters: ReadonlyArray<ListFilter<Following>> }
  | { readonly kind: "or"; readonly filters: ReadonlyArray<ListFilter<Following>> };

/**
 * No predicate: every row.
 *
 * @since 0.1.0
 */
export const always = { kind: "always" } as const;

/**
 * Fail closed: no row.
 *
 * @since 0.1.0
 */
export const never = { kind: "never" } as const;

/**
 * A `NaN`, or an invalid `Date`: a value with no place in the order SQL and
 * {@link evaluate} share (see the module's "Outside the contract").
 */
const isUnordered = (value: ColumnValue): boolean =>
  (Predicate.isNumber(value) && Number.isNaN(value)) ||
  (Predicate.isDate(value) && Number.isNaN(value.getTime()));

/**
 * `column = value`. A `NaN` value is {@link never}: PostgreSQL's `NaN = NaN`
 * is true where JavaScript's is not, so it fails closed.
 *
 * @since 0.1.0
 */
export const eq = (column: string, value: Scalar) =>
  isUnordered(value) ? never : ({ kind: "eq", column, value } as const);

/**
 * `column <> value`. A `NULL` or absent column satisfies it no more than it
 * satisfies {@link eq}: SQL's `NULL <> $v` is `NULL`, not true. A `NaN`
 * value is {@link never}, failing closed.
 *
 * @since 0.1.0
 */
export const ne = (column: string, value: Scalar) =>
  isUnordered(value) ? never : ({ kind: "ne", column, value } as const);

/**
 * `column IN (following)`. A `NULL` or absent column satisfies none, whatever
 * `following` holds: SQL's `NULL IN (…)` is `NULL`, not true.
 *
 * @since 0.1.0
 */
export const isIn = <Following>(column: string, set: Following) =>
  ({ kind: "in", column, set }) as const;

/**
 * `column > value`. A `NULL` or absent column satisfies it no more than SQL's
 * `NULL > $v` (which is `NULL`); `evaluate` reads a column holding another
 * type than `value` as satisfying none, too. A `NaN` or invalid-`Date` value
 * is {@link never}. See {@link Comparable} for the orders.
 *
 * @since 0.1.0
 */
export const gt = (column: string, value: Comparable) =>
  isUnordered(value) ? never : ({ kind: "gt", column, value } as const);

/**
 * `column >= value`; equality satisfies it, `Infinity` against `Infinity`
 * included. A `NULL` or absent column satisfies none (SQL's `NULL >= $v` is
 * `NULL`); `evaluate` reads a column holding another type than `value` as
 * satisfying none, too. A `NaN` or invalid-`Date` value is {@link never}.
 *
 * @since 0.1.0
 */
export const gte = (column: string, value: Comparable) =>
  isUnordered(value) ? never : ({ kind: "gte", column, value } as const);

/**
 * `column < value`. A `NULL` or absent column satisfies none (SQL's
 * `NULL < $v` is `NULL`); `evaluate` reads a column holding another type than
 * `value` as satisfying none, too. A `NaN` or invalid-`Date` value is
 * {@link never}.
 *
 * @since 0.1.0
 */
export const lt = (column: string, value: Comparable) =>
  isUnordered(value) ? never : ({ kind: "lt", column, value } as const);

/**
 * `column <= value`; equality satisfies it, `-Infinity` against `-Infinity`
 * included. A `NULL` or absent column satisfies none (SQL's `NULL <= $v` is
 * `NULL`); `evaluate` reads a column holding another type than `value` as
 * satisfying none, too. A `NaN` or invalid-`Date` value is {@link never}.
 *
 * @since 0.1.0
 */
export const lte = (column: string, value: Comparable) =>
  isUnordered(value) ? never : ({ kind: "lte", column, value } as const);

/**
 * `column = ANY(values)`: the column equals one of a literal set, each tested
 * as {@link eq} tests its value. A `NULL` or absent column is in no set. No
 * values is {@link never}, and so are more than {@link MAX_SET_VALUES}
 * (duplicates counted, `SEC-INPUT-003`) and a set holding a `NaN`, so
 * {@link and} / {@link or} fold each. This is a literal set; a follower
 * subquery is {@link isIn}'s.
 *
 * @since 0.1.0
 */
export const anyOf = (column: string, values: ReadonlyArray<Scalar>) =>
  Array.isReadonlyArrayEmpty(values) || values.length > MAX_SET_VALUES || values.some(isUnordered)
    ? never
    : ({ kind: "anyOf", column, values: [...values] } as const);

/**
 * `column <> ALL(values)`: the column equals none of a literal set, each
 * tested as {@link ne} tests its value. A `NULL` or absent column satisfies it
 * no more than it satisfies `ne` (SQL's `NULL <> ALL(…)` is `NULL`). No values
 * is {@link always}; more than {@link MAX_SET_VALUES} (duplicates counted) is
 * {@link never}, failing closed rather than excluding only some
 * (`SEC-INPUT-003`), and so is a set holding a `NaN`.
 *
 * @since 0.1.0
 */
export const noneOf = (column: string, values: ReadonlyArray<Scalar>) =>
  Array.isReadonlyArrayEmpty(values)
    ? always
    : values.length > MAX_SET_VALUES || values.some(isUnordered)
      ? never
      : ({ kind: "noneOf", column, values: [...values] } as const);

/**
 * `column IS NULL`: the column holds no value (`evaluate` reads an absent
 * column so, too). The one node a `NULL` column satisfies on its own, so
 * `or(isNull(column), noneOf(column, values))` is the exclusion that keeps an
 * unset column, which a bare {@link noneOf} drops (pulpit#170).
 *
 * @since 0.1.0
 */
export const isNull = (column: string) => ({ kind: "isNull", column }) as const;

/**
 * Stamped, and the stamp has arrived.
 *
 * @since 0.1.0
 */
export const published = (column: string) => ({ kind: "published", column }) as const;

/**
 * Not out: unstamped, or stamped in the future — the exact complement of {@link published}.
 *
 * @since 0.1.0
 */
export const notPublished = (column: string) => ({ kind: "notPublished", column }) as const;

/** No parts → the identity; one part → that part, bare; more → the combined node. */
const collapse = <Following>(
  parts: ReadonlyArray<ListFilter<Following>>,
  identity: ListFilter<Following>,
  combine: (parts: ReadonlyArray<ListFilter<Following>>) => ListFilter<Following>,
): ListFilter<Following> =>
  Array.match(parts, {
    onEmpty: () => identity,
    onNonEmpty: (nonEmpty) =>
      Array.isReadonlyArrayNonEmpty(Array.tailNonEmpty(nonEmpty))
        ? combine(nonEmpty)
        : Array.headNonEmpty(nonEmpty),
  });

/**
 * Conjunction. `always` parts drop out, a `never` part makes the whole
 * `never`, and a single remaining part is returned bare — so composing
 * optional filters reads as one call, the shape the apps' `combine` had.
 *
 * @since 0.1.0
 */
export const and = <Following>(
  ...filters: ReadonlyArray<ListFilter<Following>>
): ListFilter<Following> => {
  if (filters.some((filter) => filter.kind === "never")) return never;
  return collapse(
    Array.filter(filters, (filter) => filter.kind !== "always"),
    always,
    (parts) => ({ kind: "and", filters: parts }),
  );
};

/**
 * Disjunction. `never` parts drop out, an `always` part makes the whole
 * `always`, and a single remaining part is returned bare.
 *
 * @since 0.1.0
 */
export const or = <Following>(
  ...filters: ReadonlyArray<ListFilter<Following>>
): ListFilter<Following> => {
  if (filters.some((filter) => filter.kind === "always")) return always;
  return collapse(
    Array.filter(filters, (filter) => filter.kind !== "never"),
    never,
    (parts) => ({ kind: "or", filters: parts }),
  );
};

/**
 * What {@link evaluate} needs besides the row: the query's clock and the `in` test.
 *
 * @since 0.1.0
 */
export interface EvaluationContext<Following> {
  /** The instant `published` / `notPublished` compare against — the query's `now()`. */
  readonly now: Date;
  /**
   * Whether `value` is a member of the follower seam's `set`. {@link evaluate}
   * never asks it about a `null` or absent column: such a row satisfies no
   * `in`, whatever this would answer.
   */
  readonly contains: (set: Following, value: ColumnValue) => boolean;
}

/**
 * Numbers by `<` / `>`, never by subtraction: `Infinity - Infinity` is `NaN`,
 * which would read `Infinity >= Infinity` as false. Either side `NaN` (or an
 * invalid `Date`'s instant) is `NaN`, which every relational test reads as false.
 */
const byNumber = (column: number, value: number): number =>
  Number.isNaN(column) || Number.isNaN(value) ? Number.NaN : Order.Number(column, value);

/**
 * Compare a column with a {@link Comparable}: negative, zero or positive, or
 * `NaN` when the column is `NULL`, absent, of another type or unordered
 * (`NaN`, an invalid `Date`), which every relational test then reads as
 * false, as SQL's `NULL` is.
 */
const compareTo = (column: ColumnValue, value: Comparable): number => {
  if (Predicate.isDate(value)) {
    return Predicate.isDate(column) ? byNumber(column.getTime(), value.getTime()) : Number.NaN;
  }
  if (Predicate.isString(value)) {
    return Predicate.isString(column) ? byCodePoint(column, value) : Number.NaN;
  }
  return Predicate.isNumber(column) ? byNumber(column, value) : Number.NaN;
};

/**
 * `column <> value` as SQL reads it where the two readings agree: a `NULL`
 * column differs from nothing (`NULL <> $v` is `NULL`), and outside the
 * contract — a column of another type than `value`, or a `NaN` on either
 * side — it fails closed rather than answer true.
 */
const differs = (column: ColumnValue, value: Scalar): boolean =>
  sameKind(column, value) && !isUnordered(column) && !isUnordered(value) && column !== value;

/** Whether `column` holds the same kind of {@link Scalar} as `value`. */
const sameKind = (column: ColumnValue, value: Scalar): boolean =>
  Predicate.isString(value)
    ? Predicate.isString(column)
    : Predicate.isNumber(value)
      ? Predicate.isNumber(column)
      : Predicate.isBoolean(column);

/** Read a timestamp column the way the publication axis does: a `Date`, or nothing. */
const instantOf = (value: ColumnValue): number =>
  value instanceof Date ? value.getTime() : Number.NaN;

/**
 * Run a filter against one row — the in-memory reading of the rendering
 * contract above. A column that is `null` or that the row lacks matches no
 * `eq`, satisfies no `ne`, `in`, comparison, `anyOf` or non-empty `noneOf`,
 * and is unpublished: SQL reads `NULL = $v`, `NULL <> $v`, `NULL IN (…)`,
 * `NULL > $v` and `NULL <> ALL(…)` as `NULL`, which a `WHERE` drops, so `ne`
 * is not the complement of `eq`, nor `noneOf` of `anyOf`, over a nullable
 * column; {@link isNull} is the one node such a row satisfies. Such a row fails an `in` without `context.contains` being asked, so
 * the answer never depends on the seam (pulpit#94). A set past
 * {@link MAX_SET_VALUES} is `never`. Outside the contract it fails closed: a
 * column of another type than the comparand (or than any of a set's values),
 * and a `NaN` (or invalid `Date`) comparand, set element or column, satisfy
 * no `eq`, `ne`, comparison, `anyOf` or non-empty `noneOf`.
 *
 * @since 0.1.0
 */
export const evaluate = <Following>(
  filter: ListFilter<Following>,
  row: FilterRow,
  context: EvaluationContext<Following>,
): boolean => {
  const arrived = (column: string) => instantOf(row[column] ?? null) <= context.now.getTime();
  return Match.value(filter).pipe(
    Match.discriminatorsExhaustive("kind")({
      always: () => true,
      never: () => false,
      // `NaN === NaN` is false, so a `NaN` on either side already matches nothing.
      eq: (node) => row[node.column] === node.value,
      ne: (node) => differs(row[node.column] ?? null, node.value),
      in: (node) => {
        const value = row[node.column] ?? null;
        return value !== null && context.contains(node.set, value);
      },
      gt: (node) => compareTo(row[node.column] ?? null, node.value) > 0,
      gte: (node) => compareTo(row[node.column] ?? null, node.value) >= 0,
      lt: (node) => compareTo(row[node.column] ?? null, node.value) < 0,
      lte: (node) => compareTo(row[node.column] ?? null, node.value) <= 0,
      anyOf: (node) =>
        node.values.length <= MAX_SET_VALUES &&
        !node.values.some(isUnordered) &&
        node.values.some((value) => row[node.column] === value),
      noneOf: (node) => {
        if (node.values.length > MAX_SET_VALUES) return false;
        // `<> ALL` over no values is true, even for NULL; the constructor folds that to `always`.
        if (Array.isReadonlyArrayEmpty(node.values)) return true;
        const value = row[node.column] ?? null;
        return node.values.every((excluded) => differs(value, excluded));
      },
      isNull: (node) => (row[node.column] ?? null) === null,
      published: (node) => arrived(node.column),
      notPublished: (node) => !arrived(node.column),
      and: (node) => node.filters.every((part) => evaluate(part, row, context)),
      or: (node) => node.filters.some((part) => evaluate(part, row, context)),
    }),
  );
};
