/**
 * The report store against PostgreSQL, checked against the
 * kernel's `makeInMemoryReportStore` over the same writes: `get` with the
 * target's type joined in, `list` under every filter column newest first
 * with the unpaged total (a page past the end included), `close` only on an
 * open row, `closeOpen` on one target's open rows alone, `eraseReporter` in
 * `limit`-sized batches, `lock` holding the row `FOR UPDATE` against a
 * second transaction, the CHECKs on a closed row, and the purge cascade.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
import { always, and, eq, type ListFilter } from "@thomasfosterau/pulpit/Filter";
import type { ReportRow } from "@thomasfosterau/pulpit/Moderation";
import { makeInMemoryReportStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeReportStore } from "../../src/Reports.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { reports, tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitReportDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 3 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const store = makeReportStore({
  table: reports,
  identity: tables.root.identity,
  CurrentTransaction,
});
const memory = makeInMemoryReportStore();

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reportId = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const at = (minute: number) =>
  DateTime.toDate(DateTime.makeUnsafe(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`));

const postState = {
  title: "post",
  visibility: "public",
  draft: false,
  groupId: null,
  rank: null,
  score: null,
  publishedAt: null,
};
const noteState = { body: "note", visibility: "public", draft: false };

/** One open report on `target` (of `type`) by `reporter`, filed at minute `minute`. */
const report = (
  n: number,
  target: number,
  type: string,
  reporter: string,
  minute: number,
): ReportRow => ({
  id: reportId(n),
  targetId: node(target),
  targetType: type,
  reporterId: reporter,
  reason: n % 2 === 0 ? "spam" : "harassment",
  details: n === 1 ? Option.some("see the second paragraph") : Option.none(),
  status: "open",
  filedAt: at(minute),
  resolvedAt: Option.none(),
  resolvedBy: Option.none(),
  resolutionNote: Option.none(),
});

// Insert order is id order, so a `limit`-sized erase picks the same rows in both.
const rows: ReadonlyArray<ReportRow> = [
  report(1, 1, "posts", "u-2", 5),
  report(2, 1, "posts", "u-3", 7),
  report(3, 2, "posts", "u-2", 7),
  report(4, 3, "notes", "u-3", 1),
  report(5, 3, "notes", "u-2", 9),
  report(6, 1, "posts", "u-4", 3),
  report(7, 4, "posts", "u-5", 2),
];

beforeAll(() =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
        );
      }),
    );
    yield* run(
      Effect.gen(function* () {
        const actorId = Option.none<string>();
        yield* Effect.forEach(
          [1, 2, 4],
          (n) => chains.posts.create({ id: Option.some(node(n)), state: postState, actorId }),
          { concurrency: 1 },
        );
        yield* chains.notes.create({ id: Option.some(node(3)), state: noteState, actorId });
      }),
    );
    yield* run(
      Effect.forEach(rows, (row) => Effect.andThen(store.insert(row), memory.insert(row)), {
        concurrency: 1,
      }),
    );
  }),
);

const listBoth = (where: ListFilter<never>, limit = 100, offset = 0) =>
  Effect.gen(function* () {
    const query = { where, limit, offset };
    return {
      sql: yield* run(store.list(query)),
      memory: yield* memory.list(query),
    };
  });

describe("ReportStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("get reads the row with its target's type; an unknown or malformed id none", () =>
    Effect.gen(function* () {
      const ids = Arr.map([1, 2, 3, 4, 5, 6, 7], reportId);
      expect(yield* run(Effect.forEach(ids, store.get, { concurrency: 1 }))).toEqual(
        yield* Effect.forEach(ids, memory.get, { concurrency: 1 }),
      );
      expect(Option.map(yield* run(store.get(reportId(4))), (row) => row.targetType)).toEqual(
        Option.some("notes"),
      );
      expect(yield* run(store.get(reportId(99)))).toEqual(Option.none());
      expect(yield* run(store.get("not-a-uuid"))).toEqual(Option.none());
    }),
  );

  const filters: ReadonlyArray<readonly [string, ListFilter<never>]> = [
    ["every row", always],
    ["a reporter", eq("reporterId", "u-2")],
    ["a target", eq("targetId", node(1))],
    ["a target type", eq("targetType", "notes")],
    ["open", eq("status", "open")],
    ["an id", eq("id", reportId(3))],
    ["a conjunction", and(eq("reporterId", "u-3"), eq("targetType", "posts"))],
  ];
  it.live.each(filters)("list, newest first with the total: %s", ([_name, where]) =>
    Effect.gen(function* () {
      const both = yield* listBoth(where);
      expect(both.sql).toEqual(both.memory);
    }),
  );

  it.live("list pages, the total unpaged, a page past the end counted again", () =>
    Effect.gen(function* () {
      const page = yield* listBoth(always, 2, 1);
      expect(page.sql).toEqual(page.memory);
      expect(page.sql.total).toBe(7);
      const past = yield* listBoth(eq("reporterId", "u-2"), 2, 10);
      expect(past.sql).toEqual(past.memory);
      expect(past.sql).toEqual({ rows: [], total: 3 });
      // Newest first, `id DESC` on the 00:07 tie.
      const all = yield* run(store.list({ where: always, limit: 100, offset: 0 }));
      expect(Arr.map(all.rows, (row) => row.id)).toEqual(Arr.map([5, 3, 2, 1, 6, 7, 4], reportId));
    }),
  );

  it.live("close writes an open row's resolution once; a closed row stays as it was", () =>
    Effect.gen(function* () {
      const resolve = {
        status: "resolved" as const,
        resolvedAt: at(20),
        resolvedBy: "u-1",
        resolutionNote: Option.some("removed"),
      };
      const dismiss = {
        status: "dismissed" as const,
        resolvedAt: at(21),
        resolvedBy: "u-2",
        resolutionNote: Option.none(),
      };
      const resolutions = [
        [reportId(1), resolve],
        [reportId(1), dismiss],
        [reportId(2), dismiss],
        [reportId(7), resolve],
      ] as const;
      yield* run(Effect.forEach(resolutions, ([id, r]) => store.close(id, r), { concurrency: 1 }));
      yield* Effect.forEach(resolutions, ([id, r]) => memory.close(id, r), { concurrency: 1 });
      const both = yield* listBoth(always);
      expect(both.sql).toEqual(both.memory);
      expect(Option.map(yield* run(store.get(reportId(1))), (row) => row.status)).toEqual(
        Option.some("resolved"),
      );
      const open = yield* listBoth(eq("status", "open"));
      expect(open.sql).toEqual(open.memory);
      expect(open.sql.total).toBe(4);
    }),
  );

  it.live("closeOpen closes a target's open reports alone, and counts them", () =>
    Effect.gen(function* () {
      const settle = {
        status: "resolved" as const,
        resolvedAt: at(25),
        resolvedBy: "u-8",
        resolutionNote: Option.some("content rejected"),
      };
      const targets = [node(3), node(3), node(2), "not-a-uuid"];
      const counts = {
        sql: yield* run(
          Effect.forEach(targets, (target) => store.closeOpen(target, settle), { concurrency: 1 }),
        ),
        memory: yield* Effect.forEach(targets, (target) => memory.closeOpen(target, settle), {
          concurrency: 1,
        }),
      };
      expect(counts.sql).toEqual(counts.memory);
      expect(counts.sql).toEqual([2, 0, 1, 0]);
      const both = yield* listBoth(always);
      expect(both.sql).toEqual(both.memory);
      // The report closed earlier on node 1 keeps its own resolution; node 1's open one stays open.
      expect(Option.map(yield* run(store.get(reportId(6))), (row) => row.status)).toEqual(
        Option.some("open"),
      );
    }),
  );

  it.live("the CHECKs refuse a status outside the three, and a closed row with no resolver", () =>
    Effect.gen(function* () {
      const insert = (row: ReportRow) =>
        Effect.exit(
          Effect.flatMap(runtime.contextEffect, (context) =>
            Effect.provide(transact(store.insert(row)), context),
          ),
        );
      const base = report(90, 1, "posts", "u-6", 30);
      const lost = yield* Effect.exit(
        Effect.provide(
          transact(
            Effect.gen(function* () {
              const tx = yield* CurrentTransaction;
              yield* tx.execute(
                sql`INSERT INTO ${reports} (id, target_node_id, reporter_id, reason, status) VALUES (${reportId(91)}, ${node(1)}, 'u-6', 'spam', 'lost')`,
              );
            }),
          ),
          yield* runtime.contextEffect,
        ),
      );
      expect(Exit.isFailure(lost)).toBe(true);
      expect(Exit.isFailure(yield* insert({ ...base, status: "resolved" }))).toBe(true);
      expect(Exit.isFailure(yield* insert({ ...base, resolvedAt: Option.some(at(31)) }))).toBe(
        true,
      );
    }),
  );

  it.live("lock holds the row FOR UPDATE against a second transaction", () =>
    Effect.gen(function* () {
      // Run once the first transaction holds the lock: `NOWAIT` fails on a locked row.
      /** The same lock on a connection of its own, outside the test's transaction. */
      const lockElsewhere = () =>
        Effect.exit(
          run(
            Effect.gen(function* () {
              const tx = yield* CurrentTransaction;
              yield* tx.execute(
                sql`SELECT 1 FROM ${reports} WHERE ${reports.id} = ${reportId(3)} FOR UPDATE NOWAIT`,
              );
            }),
          ),
        ).pipe(
          // A fresh context: no open transaction, so `run` takes a second connection.
          Effect.updateContext((_: Context.Context<never>) => Context.empty()),
        );
      const outcome = yield* run(
        Effect.gen(function* () {
          const locked = yield* store.lock(reportId(3));
          const elsewhere = yield* lockElsewhere();
          return { locked, elsewhere };
        }),
      );
      expect(outcome.locked).toEqual(yield* memory.lock(reportId(3)));
      expect(Option.map(outcome.locked, (row) => row.id)).toEqual(Option.some(reportId(3)));
      expect(Exit.isFailure(outcome.elsewhere)).toBe(true);
      // Once the first transaction commits, the row is free again.
      expect(Exit.isSuccess(yield* lockElsewhere())).toBe(true);
    }),
  );

  it.live(
    "eraseReporter deletes the account's reports, rewrites its resolutions, in batches of limit",
    () =>
      Effect.gen(function* () {
        // u-2 filed 3 and 5 (deleted) and dismissed 2 (rewritten); 1 is u-2's own, deleted too.
        const query = { accountId: "u-2", replacement: "erased", limit: 1 };
        const counts = {
          sql: yield* run(
            Effect.forEach(Arr.range(1, 5), () => store.eraseReporter(query), { concurrency: 1 }),
          ),
          memory: yield* Effect.forEach(Arr.range(1, 5), () => memory.eraseReporter(query), {
            concurrency: 1,
          }),
        };
        expect(counts.sql).toEqual(counts.memory);
        expect(counts.sql).toEqual([1, 1, 1, 1, 0]);
        const both = yield* listBoth(always);
        expect(both.sql).toEqual(both.memory);
        expect(Option.flatMap(yield* run(store.get(reportId(2))), (row) => row.resolvedBy)).toEqual(
          Option.some("erased"),
        );
        // A resolver who filed nothing keeps the reports, their name rewritten.
        const resolver = { accountId: "u-1", replacement: "gone", limit: 10 };
        expect(yield* run(store.eraseReporter(resolver))).toBe(
          yield* memory.eraseReporter(resolver),
        );
        const after = yield* listBoth(always);
        expect(after.sql).toEqual(after.memory);
      }),
  );

  it.live("purging a node takes its reports with it", () =>
    Effect.gen(function* () {
      yield* run(chains.posts.purge(node(4)));
      expect(yield* run(store.get(reportId(7)))).toEqual(Option.none());
    }),
  );

  it.live("mintId mints a fresh UUID", () =>
    Effect.gen(function* () {
      const [a, b] = yield* run(Effect.all([store.mintId, store.mintId], { concurrency: 1 }));
      expect(a).toMatch(/^[0-9a-f-]{36}$/u);
      expect(a).not.toBe(b);
    }),
  );
});
