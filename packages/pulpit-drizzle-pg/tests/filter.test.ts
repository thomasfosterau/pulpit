/**
 * The `ListFilter` → SQL renderer and the list order, as SQL text (no
 * database): every node of the kernel's contract table. The integration
 * suite runs the same filters against PostgreSQL and checks them against
 * the kernel's in-memory evaluation, row by row.
 */

import {
  always,
  and,
  anyOf,
  eq,
  gt,
  gte,
  isIn,
  isNotIn,
  isNull,
  locale,
  lt,
  lte,
  MAX_SET_VALUES,
  ne,
  never,
  noneOf,
  notPublished,
  or,
  published,
  type ListFilter,
} from "@thomasfosterau/pulpit/filter";
import { getTableColumns, sql, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { distinctKey, renderListFilter, renderListOrder } from "../src/filter.ts";
import { tables, views } from "./fixtures/tree.ts";

const dialect = new PgDialect();
const columns = getTableColumns(tables.levels.posts.version);
const all = { ...columns, id: tables.root.identity.id };
const following = sql`select owner_id from follows where follower_id = ${"u-1"}`;

/** A query's SQL without the fixture's schema qualifier. */
const unqualified = (query: { readonly sql: string; readonly params: ReadonlyArray<unknown> }) => ({
  sql: query.sql.replaceAll('"pulpit_test".', ""),
  params: query.params,
});

/** The rendered predicate's SQL and parameters, or `undefined` for no predicate. */
const text = (filter: ListFilter<SQLWrapper>) =>
  Option.map(renderListFilter(filter, all), (where) => unqualified(dialect.sqlToQuery(where))).pipe(
    Option.getOrUndefined,
  );

describe("renderListFilter — the contract table", () => {
  it("always is no predicate, never is false", () => {
    expect(text(always)).toBeUndefined();
    expect(text(never)?.sql).toBe("false");
  });

  it("eq / ne bind through the column; a uuid column compares as text", () => {
    expect(text(eq("visibility", "public"))).toEqual({
      sql: '"posts_version"."visibility" = $1',
      params: ["public"],
    });
    expect(text(ne("rank", 3))?.sql).toBe('"posts_version"."rank" <> $1');
    expect(text(eq("id", "not-a-uuid"))?.sql).toBe('("node"."id")::text = $1');
  });

  it("in / notIn embed the seam's subquery, never an array", () => {
    expect(text(isIn("groupId", following))).toEqual({
      sql: '"posts_version"."group_id" IN (select owner_id from follows where follower_id = $1)',
      params: ["u-1"],
    });
    expect(text(isNotIn("groupId", following))?.sql).toBe(
      '("posts_version"."group_id" IS NULL OR "posts_version"."group_id" NOT IN (select owner_id from follows where follower_id = $1))',
    );
  });

  it("a string compares by code point; numbers and dates through the column", () => {
    expect(text(gt("visibility", "m"))?.sql).toBe(
      '("posts_version"."visibility")::text COLLATE "C" > $1',
    );
    expect(text(gte("rank", 2))?.sql).toBe('"posts_version"."rank" >= $1');
    expect(
      text(lt("publishedAt", DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")))),
    ).toEqual({
      sql: '"posts_version"."published_at" < $1',
      params: ["2026-01-01T00:00:00.000Z"],
    });
    expect(text(lte("score", Number.POSITIVE_INFINITY))?.sql).toBe(
      '"posts_version"."score" <= \'Infinity\'::float8',
    );
    expect(text(gt("score", Number.NEGATIVE_INFINITY))?.sql).toBe(
      '"posts_version"."score" > \'-Infinity\'::float8',
    );
  });

  it("a NaN or invalid Date comparand is never; the constructors already fold one", () => {
    const nan = { kind: "gt", column: "score", value: Number.NaN } as const;
    const invalidDate = DateTime.toDate(DateTime.makeUnsafe(0));
    invalidDate.setTime(Number.NaN);
    const invalid = { kind: "lt", column: "publishedAt", value: invalidDate } as const;
    expect(text(nan)?.sql).toBe("false");
    expect(text(invalid)?.sql).toBe("false");
    expect(text({ kind: "eq", column: "score", value: Number.NaN })?.sql).toBe("false");
    expect(text({ kind: "ne", column: "score", value: Number.NaN })?.sql).toBe("false");
  });

  it("anyOf / noneOf: a set; empty, oversized or NaN-holding sets fail closed", () => {
    expect(text(anyOf("visibility", ["public", "followers"]))?.sql).toBe(
      '"posts_version"."visibility" in ($1, $2)',
    );
    expect(text(noneOf("visibility", ["private"]))?.sql).toBe(
      '"posts_version"."visibility" not in ($1)',
    );
    const many = Arr.makeBy(MAX_SET_VALUES + 1, (i) => `v${i}`);
    expect(text({ kind: "anyOf", column: "visibility", values: many })?.sql).toBe("false");
    expect(text({ kind: "noneOf", column: "visibility", values: many })?.sql).toBe("false");
    expect(text({ kind: "anyOf", column: "visibility", values: [] })?.sql).toBe("false");
    expect(text({ kind: "noneOf", column: "visibility", values: [] })?.sql).toBe("true");
    expect(text({ kind: "anyOf", column: "score", values: [1, Number.NaN] })?.sql).toBe("false");
  });

  it("isNull, published and notPublished (the database's clock, parenthesised)", () => {
    expect(text(isNull("groupId"))?.sql).toBe('"posts_version"."group_id" IS NULL');
    expect(text(published("publishedAt"))?.sql).toBe(
      '("posts_version"."published_at" IS NOT NULL AND "posts_version"."published_at" <= now())',
    );
    expect(text(notPublished("publishedAt"))?.sql).toBe(
      '("posts_version"."published_at" IS NULL OR "posts_version"."published_at" > now())',
    );
  });

  it("locale over a view without a locale column, or an empty set, is never", () => {
    expect(text(locale(["en"]))?.sql).toBe("false");
    expect(text({ kind: "locale", column: "visibility", locales: [] })?.sql).toBe("false");
    expect(text({ kind: "locale", column: "visibility", locales: ["en"] })?.sql).toBe(
      '"posts_version"."visibility" in ($1)',
    );
  });

  it("and / or combine, and a hand-built empty or always part keeps its identity", () => {
    expect(text(and(eq("rank", 1), or(isNull("groupId"), eq("draft", false))))?.sql).toBe(
      '(("posts_version"."rank" = $1) and ((("posts_version"."group_id" IS NULL) or ("posts_version"."draft" = $2))))',
    );
    expect(text({ kind: "and", filters: [] })?.sql).toBe("true");
    expect(text({ kind: "or", filters: [] })?.sql).toBe("false");
    expect(text({ kind: "and", filters: [always, eq("rank", 1)] })?.sql).toBe(
      '((true) and ("posts_version"."rank" = $1))',
    );
  });

  it("a node over a column the view lacks fails closed", () => {
    expect(text(eq("missing", "x"))?.sql).toBe("false");
    expect(text(noneOf("missing", ["x"]))?.sql).toBe("false");
    expect(text(isNull("missing"))?.sql).toBe("false");
  });
});

describe("renderListOrder — the list order contract", () => {
  const order = (orderBy: Parameters<typeof renderListOrder>[0]) =>
    Arr.map(
      renderListOrder(orderBy, all, all.id),
      (term) => unqualified(dialect.sqlToQuery(term)).sql,
    );

  it("closes every order with id ASC, and NULLS LAST on every key", () => {
    expect(order([])).toEqual(['"node"."id" ASC']);
    expect(
      order([
        { column: "rank", direction: "desc" },
        { column: "visibility", direction: "asc" },
      ]),
    ).toEqual([
      '"posts_version"."rank" DESC NULLS LAST',
      '("posts_version"."visibility")::text COLLATE "C" ASC NULLS LAST',
      '"node"."id" ASC',
    ]);
  });

  it("skips a key the view lacks", () => {
    expect(order([{ column: "missing", direction: "asc" }])).toEqual(['"node"."id" ASC']);
  });
});

describe("distinctKey", () => {
  it("is the code-point form of a string column, and none of any other", () => {
    expect(Option.isSome(distinctKey(columns.visibility))).toBe(true);
    expect(Option.isNone(distinctKey(columns.rank))).toBe(true);
  });

  it("reads an aliased view expression through its column", () => {
    expect(Option.isNone(distinctKey(views.leaves.posts.createdAt))).toBe(true);
  });
});
