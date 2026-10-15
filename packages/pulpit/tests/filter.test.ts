/**
 * The in-memory reading of the list-filter rendering contract. `eq` and `ne`
 * are pinned against SQL's three-valued logic: a `NULL` or absent column
 * satisfies neither, because `NULL = $v` and `NULL <> $v` are both `NULL`
 * and a `WHERE` drops the row (pulpit#75). `in` is pinned the same way:
 * `NULL IN (…)` is `NULL`, so a `NULL` or absent column satisfies no `in`
 * and the follower seam is never asked about it (pulpit#94). The comparison
 * arms (`gt` / `gte` / `lt` / `lte`) and the literal sets (`anyOf` /
 * `noneOf`) follow the same rule (pulpit#113): `NULL > $v`, `NULL = ANY(…)`
 * and `NULL <> ALL(…)` are all `NULL`. Strings order by code point (SQL's
 * `"C"` collation), `±Infinity` equals itself, and an empty `<> ALL` is true
 * even for `NULL`. Outside the contract (a column of another type than the
 * comparand, `NaN`, an invalid `Date`) `evaluate` fails closed.
 *
 * @module tests/filter
 */

import { describe, expect, it } from "vite-plus/test";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as HashSet from "effect/HashSet";
import * as Predicate from "effect/Predicate";
import {
  always,
  and,
  anyOf,
  type Comparable,
  eq,
  evaluate,
  gt,
  gte,
  isIn,
  type EvaluationContext,
  type FilterRow,
  type ListFilter,
  lt,
  lte,
  MAX_SET_VALUES,
  ne,
  never,
  noneOf,
  notPublished,
  or,
  published,
  type Scalar,
} from "../src/filter.ts";
import type { ColumnValue } from "../src/version-chain.ts";

type Following = HashSet.HashSet<string>;

const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-09-18T12:00:00.000Z"));
const LATER = DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() + 1));

const context: EvaluationContext<Following> = {
  now: NOW,
  contains: (set, value) => Predicate.isString(value) && HashSet.has(set, value),
};

const run = (filter: ListFilter<Following>, row: FilterRow) => evaluate(filter, row, context);

describe("evaluate — eq / ne against SQL's three-valued reading", () => {
  it("eq matches the value and nothing else", () => {
    expect(run(eq("action", "delete"), { action: "delete" })).toBe(true);
    expect(run(eq("action", "delete"), { action: "update" })).toBe(false);
  });

  it("ne is satisfied by a different non-null value, not by the value itself", () => {
    expect(run(ne("action", "delete"), { action: "update" })).toBe(true);
    expect(run(ne("action", "delete"), { action: "delete" })).toBe(false);
    expect(run(ne("count", 1), { count: 2 })).toBe(true);
    expect(run(ne("flag", true), { flag: false })).toBe(true);
  });

  it("a NULL column satisfies neither eq nor ne (`NULL <> $v` is NULL)", () => {
    expect(run(eq("action", "delete"), { action: null })).toBe(false);
    expect(run(ne("action", "delete"), { action: null })).toBe(false);
  });

  it("an absent column satisfies neither eq nor ne", () => {
    expect(run(eq("action", "delete"), { other: "x" })).toBe(false);
    expect(run(ne("action", "delete"), { other: "x" })).toBe(false);
  });

  it("a NULL or absent column fails or(eq, ne), as in SQL", () => {
    const filter = or<Following>(eq("action", "delete"), ne("action", "delete"));
    expect(run(filter, { action: null })).toBe(false);
    expect(run(filter, {})).toBe(false);
    expect(run(filter, { action: "update" })).toBe(true);
  });

  it("NaN is outside the contract and fails closed: a NaN value is never, a NaN column satisfies neither", () => {
    // PostgreSQL's `'NaN' = 'NaN'` is true and `'NaN' <> 'NaN'` false, which JavaScript's NaN cannot mirror.
    expect([eq("c", Number.NaN), ne("c", Number.NaN)]).toEqual([never, never]);
    const handEq: ListFilter<Following> = { kind: "eq", column: "c", value: Number.NaN };
    const handNe: ListFilter<Following> = { kind: "ne", column: "c", value: Number.NaN };
    expect(
      Array.map([handEq, handNe], (filter) => [
        run(filter, { c: Number.NaN }),
        run(filter, { c: 1 }),
      ]),
    ).toEqual([
      [false, false],
      [false, false],
    ]);
    expect([run(eq("c", 1), { c: Number.NaN }), run(ne("c", 1), { c: Number.NaN })]).toEqual([
      false,
      false,
    ]);
    expect([run(eq("c", 1), { c: 1 }), run(ne("c", 1), { c: 2 })]).toEqual([true, true]);
  });
});

describe("evaluate — in against SQL's `NULL IN (…)`", () => {
  type SpySet = HashSet.HashSet<ColumnValue>;

  /** A `contains` that would admit `null`, recording every value it is asked about. */
  const spying = () => {
    const asked: Array<ColumnValue> = [];
    const spy: EvaluationContext<SpySet> = {
      now: NOW,
      contains: (set, value) => {
        asked.push(value);
        return HashSet.has(set, value);
      },
    };
    const set: SpySet = HashSet.make<ReadonlyArray<ColumnValue>>(null, "a");
    // The seam really would admit `null`, so only `evaluate` can be what drops it.
    expect(HashSet.has(set, null)).toBe(true);
    const runSpy = (filter: ListFilter<SpySet>, row: FilterRow) => evaluate(filter, row, spy);
    return { asked, set, runSpy };
  };

  it("a NULL column satisfies no in, and contains is never asked", () => {
    const { asked, set, runSpy } = spying();
    expect(runSpy(isIn("owner", set), { owner: null })).toBe(false);
    expect(asked).toEqual([]);
  });

  it("an absent column satisfies no in, and contains is never asked", () => {
    const { asked, set, runSpy } = spying();
    expect(runSpy(isIn("owner", set), { other: "a" })).toBe(false);
    expect(asked).toEqual([]);
  });

  it("a non-null column still asks contains", () => {
    const { asked, set, runSpy } = spying();
    expect(runSpy(isIn("owner", set), { owner: "a" })).toBe(true);
    expect(runSpy(isIn("owner", set), { owner: "b" })).toBe(false);
    expect(asked).toEqual(["a", "b"]);
  });

  it("inside and / or, a NULL or absent column's in is false and contains is never asked", () => {
    const { asked, set, runSpy } = spying();
    const inOr = or<SpySet>(isIn("owner", set), eq("kind", "post"));
    const inAnd = and<SpySet>(isIn("owner", set), eq("kind", "page"));
    const rows: ReadonlyArray<FilterRow> = [{ owner: null, kind: "page" }, { kind: "page" }];
    expect(Array.map(rows, (row) => [runSpy(inOr, row), runSpy(inAnd, row)])).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(runSpy(inOr, { owner: null, kind: "post" })).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("evaluate — the other nodes", () => {
  it("always / never", () => {
    expect(run(always, {})).toBe(true);
    expect(run(never, {})).toBe(false);
  });

  it("in asks the follower seam", () => {
    const set = HashSet.make("a");
    expect(run(isIn("owner", set), { owner: "a" })).toBe(true);
    expect(run(isIn("owner", set), { owner: "b" })).toBe(false);
  });

  it("an absent or NULL stamp is unpublished", () => {
    const rows: ReadonlyArray<FilterRow> = [{}, { at: null }];
    expect(Array.map(rows, (row) => run(published("at"), row))).toEqual([false, false]);
    expect(Array.map(rows, (row) => run(notPublished("at"), row))).toEqual([true, true]);
    expect(run(published("at"), { at: NOW })).toBe(true);
    expect(run(notPublished("at"), { at: LATER })).toBe(true);
  });

  it("and / or combine their parts", () => {
    const row = { action: "update", kind: "page" };
    expect(run(and<Following>(ne("action", "delete"), eq("kind", "page")), row)).toBe(true);
    expect(run(and<Following>(ne("action", "delete"), eq("kind", "post")), row)).toBe(false);
    expect(run(or<Following>(eq("action", "delete"), eq("kind", "page")), row)).toBe(true);
  });
});

describe("evaluate — gt / gte / lt / lte against SQL's comparison", () => {
  /** Every operator's answer for one row against one comparand, in `gt, gte, lt, lte` order. */
  const answersFor = (row: FilterRow, value: Comparable) =>
    Array.map([gt, gte, lt, lte], (op) => run(op("c", value), row));
  const answers = (column: ColumnValue, value: Comparable) => answersFor({ c: column }, value);
  const NONE = [false, false, false, false];

  it("orders numbers, with equality satisfying only gte / lte", () => {
    expect(answers(2, 1)).toEqual([true, true, false, false]);
    expect(answers(1, 1)).toEqual([false, true, false, true]);
    expect(answers(0, 1)).toEqual([false, false, true, true]);
    expect(answers(-0, 0)).toEqual([false, true, false, true]);
  });

  it("orders Dates by instant, so an equal instant in another Date object is equal", () => {
    const sameInstant = DateTime.toDate(DateTime.makeUnsafe(NOW.getTime()));
    expect(sameInstant).not.toBe(NOW);
    expect(answers(LATER, NOW)).toEqual([true, true, false, false]);
    expect(answers(sameInstant, NOW)).toEqual([false, true, false, true]);
    expect(answers(NOW, LATER)).toEqual([false, false, true, true]);
  });

  it('orders strings by code point, as SQL\'s "C" collation does', () => {
    expect(answers("b", "a")).toEqual([true, true, false, false]);
    expect(answers("a", "a")).toEqual([false, true, false, true]);
    expect(answers("a", "ab")).toEqual([false, false, true, true]);
    expect(answers("", "a")).toEqual([false, false, true, true]);
    // Code point, not locale: every upper-case ASCII letter sorts before every lower-case one.
    expect(answers("Z", "a")).toEqual([false, false, true, true]);
    expect(answers("x\u{1F600}", "x\u{1F600}")).toEqual([false, true, false, true]);
  });

  it("orders an astral character above U+FFFF, where JavaScript's UTF-16 `<` would not", () => {
    const [astral, bmp] = ["\u{1F600}", "\uFF5E"];
    // The lead surrogate (0xD83D) is below 0xFF5E, so code-unit order is the reverse.
    expect([astral < bmp, astral.codePointAt(0)]).toEqual([true, 0x1f600]);
    expect(answers(astral, bmp)).toEqual([true, true, false, false]);
    expect(answers(bmp, astral)).toEqual([false, false, true, true]);
  });

  it("a NULL or absent column satisfies none (`NULL > $v` is NULL)", () => {
    const values: ReadonlyArray<Comparable> = [0, "", NOW];
    const rows: ReadonlyArray<FilterRow> = [{ c: null }, { other: 1 }, {}];
    expect(
      Array.flatMap(values, (value) => Array.map(rows, (row) => answersFor(row, value))),
    ).toEqual(Array.makeBy(values.length * rows.length, () => NONE));
  });

  it("a column of another type than the comparand satisfies none", () => {
    const mismatched: ReadonlyArray<readonly [ColumnValue, Comparable]> = [
      ["2", 1],
      [2, "1"],
      [NOW.toISOString(), NOW],
      [NOW, NOW.toISOString()],
      [NOW.getTime(), NOW],
      [NOW, NOW.getTime()],
      [1n, 0],
      [true, 0],
      [["a"], "a"],
      [{ at: 1 }, 1],
    ];
    expect(Array.map(mismatched, ([column, value]) => answers(column, value))).toEqual(
      Array.map(mismatched, () => NONE),
    );
  });

  it("±Infinity equals itself: gte / lte hold at Infinity / -Infinity, as in SQL", () => {
    const [inf, negInf] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    expect(answers(inf, inf)).toEqual([false, true, false, true]);
    expect(answers(negInf, negInf)).toEqual([false, true, false, true]);
    expect(answers(inf, Number.MAX_VALUE)).toEqual([true, true, false, false]);
    expect(answers(negInf, -Number.MAX_VALUE)).toEqual([false, false, true, true]);
    expect(answers(inf, negInf)).toEqual([true, true, false, false]);
    expect(answers(1, inf)).toEqual([false, false, true, true]);
  });

  it("a NaN or invalid-Date comparand is never, and a NaN or invalid-Date column satisfies none", () => {
    // oxlint-disable-next-line effect/use-clock-service -- an `Invalid Date` is the case under test, and DateTime refuses to make one
    const invalid = new Date(Number.NaN);
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    // PostgreSQL orders NaN above every number; outside the contract, so the constructors fail closed.
    expect(
      Array.flatMap([Number.NaN, invalid], (value) =>
        Array.map([gt, gte, lt, lte], (op) => op("c", value)),
      ),
    ).toEqual(Array.makeBy(8, () => never));
    const handBuilt = (value: Comparable): ReadonlyArray<ListFilter<Following>> =>
      Array.map(["gt", "gte", "lt", "lte"] as const, (kind) => ({ kind, column: "c", value }));
    expect(
      Array.flatMap(
        [
          [Number.NaN, Number.NaN],
          [1, Number.NaN],
          [Number.NaN, Number.POSITIVE_INFINITY],
          [invalid, NOW],
          [NOW, invalid],
        ] as const,
        ([column, value]) => Array.map(handBuilt(value), (filter) => run(filter, { c: column })),
      ),
    ).toEqual(Array.makeBy(20, () => false));
    expect([
      answers(invalid, NOW),
      answers(Number.NaN, 1),
      answers(Number.NaN, Number.NaN),
    ]).toEqual([NONE, NONE, NONE]);
  });

  it("over a non-null column of the comparand's type, gt and lte (and gte and lt) are complements", () => {
    const pairs: ReadonlyArray<readonly [ColumnValue, Comparable]> = [
      [1, 2],
      [2, 2],
      [3, 2],
      ["a", "b"],
      ["b", "b"],
      [NOW, NOW],
      [LATER, NOW],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 0],
    ];
    expect(
      Array.map(pairs, ([column, value]) => {
        const [isGt, isGte, isLt, isLte] = answers(column, value);
        return [isGt === !isLte, isGte === !isLt];
      }),
    ).toEqual(Array.map(pairs, () => [true, true]));
    // …and a NULL column satisfies neither half, so `or(gt, lte)` drops it as SQL does.
    expect(run(or<Following>(gt("c", 1), lte("c", 1)), { c: null })).toBe(false);
    expect(run(or<Following>(gt("c", 1), lte("c", 1)), { c: 7 })).toBe(true);
  });

  it("a range is the and of two comparisons", () => {
    const window = and<Following>(gte("at", NOW), lt("at", LATER));
    expect(run(window, { at: NOW })).toBe(true);
    expect(run(window, { at: LATER })).toBe(false);
    expect(run(window, { at: null })).toBe(false);
  });
});

describe("evaluate — anyOf / noneOf against `= ANY(…)` / `<> ALL(…)`", () => {
  const rows: ReadonlyArray<FilterRow> = [
    { c: "a" },
    { c: "b" },
    { c: "z" },
    { c: 1 },
    { c: "1" },
    { c: true },
    { c: null },
    {},
  ];
  const over = (filter: ListFilter<Following>) => Array.map(rows, (row) => run(filter, row));

  it("anyOf matches a member of the set by eq's identity, and nothing of another type", () => {
    expect(over(anyOf("c", ["a", "b", 1]))).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("noneOf matches a non-null value of the set's type outside it; a NULL or absent column satisfies it no more than anyOf", () => {
    expect(over(noneOf("c", ["a", "b"]))).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("a column of another type than the comparand satisfies no ne / noneOf: fail closed, where SQL coerces or raises", () => {
    expect(over(ne("c", 1))).toEqual([false, false, false, false, false, false, false, false]);
    expect(over(ne("c", "1"))).toEqual([true, true, true, false, false, false, false, false]);
    // A mixed set is itself a type mismatch for every column.
    expect(over(noneOf("c", ["a", 1]))).toEqual(Array.map(rows, () => false));
  });

  it("a one-value set reads as eq / ne over every row", () => {
    const values: ReadonlyArray<Scalar> = ["a", 1, true];
    expect(
      Array.map(values, (value) => [over(anyOf("c", [value])), over(noneOf("c", [value]))]),
    ).toEqual(Array.map(values, (value) => [over(eq("c", value)), over(ne("c", value))]));
  });

  it("an empty anyOf is never and an empty noneOf is always", () => {
    expect(anyOf("c", [])).toBe(never);
    expect(noneOf("c", [])).toBe(always);
  });

  it("and / or fold an empty set like never / always", () => {
    const kept = eq("kind", "post");
    expect(and<Following>(anyOf("c", []), kept)).toBe(never);
    expect(or<Following>(anyOf("c", []), kept)).toBe(kept);
    expect(and<Following>(noneOf("c", []), kept)).toBe(kept);
    expect(or<Following>(noneOf("c", []), kept)).toBe(always);
  });

  it("a hand-built empty node reads as SQL does: `= ANY('{}')` is false, `<> ALL('{}')` true even for NULL", () => {
    const emptyAny: ListFilter<Following> = { kind: "anyOf", column: "c", values: [] };
    const emptyNone: ListFilter<Following> = { kind: "noneOf", column: "c", values: [] };
    expect(over(emptyAny)).toEqual(Array.map(rows, () => false));
    expect(over(emptyNone)).toEqual(Array.map(rows, () => true));
  });

  it(`a set past MAX_SET_VALUES (${MAX_SET_VALUES}) is never, from the constructor and in evaluate`, () => {
    const atCap = Array.makeBy(MAX_SET_VALUES, (i) => `v${i}`);
    const pastCap = Array.makeBy(MAX_SET_VALUES + 1, (i) => `v${i}`);
    expect(anyOf("c", atCap).kind).toBe("anyOf");
    expect(noneOf("c", atCap).kind).toBe("noneOf");
    expect(run(anyOf("c", atCap), { c: "v0" })).toBe(true);
    expect(run(noneOf("c", atCap), { c: "x" })).toBe(true);
    expect(anyOf("c", pastCap)).toBe(never);
    // Fail closed: dropping some exclusions would widen the result.
    expect(noneOf("c", pastCap)).toBe(never);
    const handAny: ListFilter<Following> = { kind: "anyOf", column: "c", values: pastCap };
    const handNone: ListFilter<Following> = { kind: "noneOf", column: "c", values: pastCap };
    expect(run(handAny, { c: "v0" })).toBe(false);
    expect(run(handNone, { c: "x" })).toBe(false);
  });

  it("MAX_SET_VALUES counts duplicates", () => {
    const repeated = Array.makeBy(MAX_SET_VALUES + 1, () => "a");
    expect([anyOf("c", repeated), noneOf("c", repeated)]).toEqual([never, never]);
  });

  it("a set holding NaN is never, and a NaN column satisfies neither arm", () => {
    // PostgreSQL's `'NaN' <> ALL('{NaN}')` is false where JavaScript's `NaN !== NaN` is true: fail closed.
    expect([anyOf("c", [1, Number.NaN]), noneOf("c", [1, Number.NaN])]).toEqual([never, never]);
    const handAny: ListFilter<Following> = { kind: "anyOf", column: "c", values: [1, Number.NaN] };
    const handNone: ListFilter<Following> = {
      kind: "noneOf",
      column: "c",
      values: [1, Number.NaN],
    };
    const nanRows: ReadonlyArray<FilterRow> = [{ c: Number.NaN }, { c: 1 }, { c: 2 }];
    expect(
      Array.map([handAny, handNone], (filter) => Array.map(nanRows, (row) => run(filter, row))),
    ).toEqual([
      [false, false, false],
      [false, false, false],
    ]);
    expect([
      run(anyOf("c", [1]), { c: Number.NaN }),
      run(noneOf("c", [1]), { c: Number.NaN }),
    ]).toEqual([false, false]);
  });

  it("the node keeps its own copy of the values", () => {
    const values: Array<Scalar> = ["a"];
    const filter = anyOf("c", values);
    values.push("b");
    expect(run(filter, { c: "b" })).toBe(false);
  });

  it("a NULL or absent column fails or(anyOf, noneOf), as in SQL", () => {
    const filter = or<Following>(anyOf("c", ["a"]), noneOf("c", ["a"]));
    expect(run(filter, { c: null })).toBe(false);
    expect(run(filter, {})).toBe(false);
    expect(run(filter, { c: "q" })).toBe(true);
  });
});
