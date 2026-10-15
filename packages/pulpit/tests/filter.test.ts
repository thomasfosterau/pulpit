/**
 * The in-memory reading of the list-filter rendering contract. `eq` and `ne`
 * are pinned against SQL's three-valued logic: a `NULL` or absent column
 * satisfies neither, because `NULL = $v` and `NULL <> $v` are both `NULL`
 * and a `WHERE` drops the row (pulpit#75). `in` is pinned the same way:
 * `NULL IN (…)` is `NULL`, so a `NULL` or absent column satisfies no `in`
 * and the follower seam is never asked about it (pulpit#94).
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
  eq,
  evaluate,
  isIn,
  type EvaluationContext,
  type FilterRow,
  type ListFilter,
  ne,
  never,
  notPublished,
  or,
  published,
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
