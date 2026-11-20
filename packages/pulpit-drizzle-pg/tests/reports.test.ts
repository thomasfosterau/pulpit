/**
 * The report store with no database (a canned transaction): what each
 * method asks of the transaction, the decode of a stored row (its `NULL`s as
 * options), the recount of a page past the end, and a malformed id reading
 * nothing. The SQL runs against PostgreSQL in `tests/integration/reports.test.ts`.
 */

import { always } from "@thomasfosterau/pulpit/Filter";
import type { ReportRow } from "@thomasfosterau/pulpit/Moderation";
import { getTableName } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeReportStore } from "../src/Reports.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, reports, tables } from "./fixtures/tree.ts";

const store = makeReportStore({
  table: reports,
  identity: tables.root.identity,
  CurrentTransaction: database.CurrentTransaction,
});

const ID = "00000000-0000-4000-a000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000001";
const AT = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

const stored = {
  id: ID,
  targetId: TARGET,
  targetType: "posts",
  reporterId: "u-1",
  reason: "spam",
  details: null,
  status: "open",
  filedAt: AT,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
};
const row: ReportRow = {
  ...stored,
  details: Option.none(),
  status: "open",
  resolvedAt: Option.none(),
  resolvedBy: Option.none(),
  resolutionNote: Option.none(),
};
const resolution = {
  status: "dismissed" as const,
  resolvedAt: AT,
  resolvedBy: "u-2",
  resolutionNote: Option.some("not spam"),
};

const runWith = <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => {
  const { tx, calls } = cannedTransaction(rows);
  return Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
    value,
    calls,
  }));
};

describe("makeReportStore over canned rows", () => {
  it("the table is named report by default", () => {
    expect(getTableName(reports)).toBe("report");
  });

  it.effect("get decodes the row, its NULLs as options", () =>
    Effect.gen(function* () {
      const { value, calls } = yield* runWith([stored], store.get(ID));
      expect(value).toEqual(Option.some(row));
      expect(calls).toEqual(["select", "from", "innerJoin", "where", "limit"]);
      const closed = {
        ...stored,
        details: "x",
        status: "resolved",
        resolvedAt: AT,
        resolvedBy: "u-2",
      };
      expect((yield* runWith([closed], store.get(ID))).value).toEqual(
        Option.some({
          ...row,
          details: Option.some("x"),
          status: "resolved",
          resolvedAt: Option.some(AT),
          resolvedBy: Option.some("u-2"),
        }),
      );
      expect((yield* runWith([], store.get(ID))).value).toEqual(Option.none());
    }),
  );

  it.effect("a malformed id reads nothing and writes nothing", () =>
    Effect.gen(function* () {
      expect(yield* runWith([stored], store.get("x"))).toEqual({ value: Option.none(), calls: [] });
      expect(yield* runWith([stored], store.lock("x"))).toEqual({
        value: Option.none(),
        calls: [],
      });
      expect((yield* runWith([], store.close("x", resolution))).calls).toEqual([]);
    }),
  );

  it.effect("lock reads the row FOR UPDATE; close updates; insert inserts", () =>
    Effect.gen(function* () {
      const locked = yield* runWith([stored], store.lock(ID));
      expect(locked.value).toEqual(Option.some(row));
      expect(locked.calls).toContain("for");
      expect((yield* runWith([], store.close(ID, resolution))).calls).toEqual([
        "update",
        "set",
        "where",
        "returning",
      ]);
      expect((yield* runWith([], store.insert(row))).calls).toEqual(["insert", "values"]);
    }),
  );

  it.effect("closeOpen answers how many open rows it closed; a malformed target closes none", () =>
    Effect.gen(function* () {
      const closed = yield* runWith([{ id: ID }, { id: ID }], store.closeOpen(TARGET, resolution));
      expect(closed).toEqual({ value: 2, calls: ["update", "set", "where", "returning"] });
      expect(yield* runWith([{ id: ID }], store.closeOpen("x", resolution))).toEqual({
        value: 0,
        calls: [],
      });
    }),
  );

  it.effect("list pages the decoded rows with the window total", () =>
    Effect.gen(function* () {
      const page = yield* runWith(
        [{ ...stored, pageTotal: 7 }],
        store.list({ where: always, limit: 5, offset: 0 }),
      );
      expect(page.value).toEqual({ rows: [row], total: 7 });
      const empty = yield* runWith([], store.list({ where: always, limit: 5, offset: 0 }));
      expect(empty.value).toEqual({ rows: [], total: 0 });
      // An empty first page is an empty result: nothing to count again.
      expect(empty.calls.filter((call) => call === "select")).toHaveLength(1);
    }),
  );

  it.effect("a page past the end counts the matching rows again", () =>
    Effect.gen(function* () {
      const { value, calls } = yield* runWith(
        [],
        store.list({ where: always, limit: 5, offset: 10 }),
      );
      expect(value).toEqual({ rows: [], total: 0 });
      expect(calls.filter((call) => call === "select")).toHaveLength(2);
    }),
  );

  it.effect("eraseReporter answers the changed count, and reads nothing for a zero limit", () =>
    Effect.gen(function* () {
      const query = { accountId: "u-1", replacement: "gone", limit: 10 };
      expect((yield* runWith([{ changed: 3 }], store.eraseReporter(query))).value).toBe(3);
      expect((yield* runWith([], store.eraseReporter(query))).value).toBe(0);
      expect(yield* runWith([{ changed: 3 }], store.eraseReporter({ ...query, limit: 0 }))).toEqual(
        {
          value: 0,
          calls: [],
        },
      );
    }),
  );

  it.effect("mintId reads a generated UUID", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ id: ID }], store.mintId)).value).toBe(ID);
    }),
  );

  it.effect("a stored row outside the contract is a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provideService(
          store.get(ID),
          database.CurrentTransaction,
          cannedTransaction([{ ...stored, status: "lost" }]).tx,
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
