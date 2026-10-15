/**
 * **The kernel's value and row orders**: the code-point string order that
 * `./filter`'s comparison arms share with SQL's `COLLATE "C"`, and the list
 * order the in-memory `LeafStore` fake sorts by (pulpit#112), so the fake and
 * the filter never compare a string two ways.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`.
 *
 * @internal
 */
import * as Array from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import type { ColumnValue } from "../version-chain.ts";

/**
 * Strings by code point, as SQL's `"C"` collation orders them over UTF-8.
 * JavaScript's `<` compares UTF-16 code units instead, which puts an astral
 * character (a surrogate pair, from U+D800) before U+E000–U+FFFF.
 */
export const byCodePoint: Order.Order<string> = Order.mapInput(
  Order.Array(Order.Number),
  (text: string) => Array.map(Array.fromIterable(text), (char) => char.codePointAt(0) ?? 0),
);

/**
 * Numbers as PostgreSQL's `float8` sorts them: `NaN` equal to itself and
 * after every number, where Effect's `Order.Number` puts it first.
 */
const byNumber: Order.Order<number> = Order.make((self, that) => {
  if (Number.isNaN(self)) return Number.isNaN(that) ? 0 : 1;
  return Number.isNaN(that) ? -1 : Order.Number(self, that);
});

/**
 * One kind of sort-key value: its guard and its order, the order lifted to
 * every {@link ColumnValue} (two values the guard doesn't both admit tie).
 */
const kind = <A extends ColumnValue>(
  is: (value: ColumnValue) => value is A,
  order: Order.Order<A>,
) => ({
  is,
  order: Order.make<ColumnValue>((self, that) => (is(self) && is(that) ? order(self, that) : 0)),
});

/**
 * The kinds of sort-key value, each sorted as PostgreSQL sorts its type: a
 * boolean `false` first, a number numerically, a `bigint` by value, a
 * string by code point, a `Date` by its instant (an invalid one as `NaN`).
 */
const kinds = [
  kind(Predicate.isBoolean, Order.Boolean),
  kind(Predicate.isNumber, byNumber),
  kind(Predicate.isBigInt, Order.BigInt),
  kind(Predicate.isString, byCodePoint),
  kind(
    Predicate.isDate,
    Order.mapInput(byNumber, (date: Date) => date.getTime()),
  ),
];

/**
 * A value's place in {@link kinds}; a JSON object or array comes after
 * them all. Two values of different kinds sort by it, which is outside the
 * contract (a SQL column has one type), so it only keeps the fake's order
 * total and deterministic.
 */
const kindOf = (value: ColumnValue): number => {
  const index = kinds.findIndex((each) => each.is(value));
  return index === -1 ? kinds.length : index;
};

/**
 * Two non-`NULL` sort-key values: by kind, then by that kind's order. Two
 * JSON objects or arrays tie, leaving the order to the next key.
 */
const byValue: Order.Order<ColumnValue> = Order.make((self, that) => {
  const left = kindOf(self);
  const right = kindOf(that);
  if (left !== right) return Order.Number(left, right);
  const same = kinds[left];
  return same === undefined ? 0 : same.order(self, that);
});

/** One order key, structurally (`./subtype`'s `ListOrder` fits). */
interface OrderKey {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

/** A row as the order reads it: its `id` and its columns by name. */
type SortRow = { readonly id: string; readonly [column: string]: ColumnValue };

/** One key: its column's values in its direction, a `NULL` or absent column last in both. */
const byKey = (key: OrderKey): Order.Order<SortRow> => {
  const values = key.direction === "desc" ? Order.flip(byValue) : byValue;
  return Order.make((self, that) => {
    const left = self[key.column] ?? null;
    const right = that[key.column] ?? null;
    if (left === null) return right === null ? 0 : 1;
    return right === null ? -1 : values(left, right);
  });
};

/** The closing key every list order ends with: `id` ascending, by code point. */
const byId: Order.Order<SortRow> = Order.mapInput(byCodePoint, (row: SortRow) => row.id);

/**
 * The total order a list renders as `ORDER BY <key> <direction> NULLS LAST,
 * …, id ASC`: each key in turn, a `NULL` (or absent) column after every
 * value in either direction, then `id` ascending, so no two rows tie.
 */
export const rowOrder = (keys: ReadonlyArray<OrderKey>): Order.Order<SortRow> =>
  Order.combineAll([...Array.map(keys, byKey), byId]);
