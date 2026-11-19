/**
 * The report store against PostgreSQL, checked against the
 * kernel's `makeInMemoryReportStore` over the same writes: `get` with the
 * target's type joined in, `list` under every filter column newest first
 * with the unpaged total (a page past the end included), `close` only on an
 * open row, `closeOpen` on one target's open rows alone, `eraseReporter` in
 * `limit`-sized batches, `lock` holding the row `FOR UPDATE` against a
 * second transaction, the CHECKs on a closed row, and the purge cascade.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, and, eq, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { ReportRow } from "@thomasfosterau/pulpit/moderation";
import { makeInMemoryReportStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeReportStore } from "../../src/reports.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
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

/** The second transaction's probe could not even run (its promise rejected). */
class LockProbeFailed extends Schema.TaggedError<
  LockProbeFailed,
  { readonly brand: unique symbol }
>()("LockProbeFailed", {}) {}

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromise(transact(effect));

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

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
    }),
  );
  await run(
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
  await run(
    Effect.forEach(rows, (row) => Effect.andThen(store.insert(row), memory.insert(row)), {
      concurrency: 1,
    }),
  );
});

const listBoth = async (where: ListFilter<never>, limit = 100, offset = 0) => {
  const query = { where, limit, offset };
  return {
    sql: await run(store.list(query)),
    memory: await Effect.runPromise(memory.list(query)),
  };
};

describe("ReportStore over PostgreSQL agrees with the in-memory store", () => {
  it("get reads the row with its target's type; an unknown or malformed id none", async () => {
    const ids = Arr.map([1, 2, 3, 4, 5, 6, 7], reportId);
    expect(await run(Effect.forEach(ids, store.get, { concurrency: 1 }))).toEqual(
      await Effect.runPromise(Effect.forEach(ids, memory.get, { concurrency: 1 })),
    );
    expect(Option.map(await run(store.get(reportId(4))), (row) => row.targetType)).toEqual(
      Option.some("notes"),
    );
    expect(await run(store.get(reportId(99)))).toEqual(Option.none());
    expect(await run(store.get("not-a-uuid"))).toEqual(Option.none());
  });

  const filters: ReadonlyArray<readonly [string, ListFilter<never>]> = [
    ["every row", always],
    ["a reporter", eq("reporterId", "u-2")],
    ["a target", eq("targetId", node(1))],
    ["a target type", eq("targetType", "notes")],
    ["open", eq("status", "open")],
    ["an id", eq("id", reportId(3))],
    ["a conjunction", and(eq("reporterId", "u-3"), eq("targetType", "posts"))],
  ];
  it.each(filters)("list, newest first with the total: %s", async (_name, where) => {
    const both = await listBoth(where);
    expect(both.sql).toEqual(both.memory);
  });

  it("list pages, the total unpaged, a page past the end counted again", async () => {
    const page = await listBoth(always, 2, 1);
    expect(page.sql).toEqual(page.memory);
    expect(page.sql.total).toBe(7);
    const past = await listBoth(eq("reporterId", "u-2"), 2, 10);
    expect(past.sql).toEqual(past.memory);
    expect(past.sql).toEqual({ rows: [], total: 3 });
    // Newest first, `id DESC` on the 00:07 tie.
    const all = await run(store.list({ where: always, limit: 100, offset: 0 }));
    expect(Arr.map(all.rows, (row) => row.id)).toEqual(Arr.map([5, 3, 2, 1, 6, 7, 4], reportId));
  });

  it("close writes an open row's resolution once; a closed row stays as it was", async () => {
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
    await run(Effect.forEach(resolutions, ([id, r]) => store.close(id, r), { concurrency: 1 }));
    await Effect.runPromise(
      Effect.forEach(resolutions, ([id, r]) => memory.close(id, r), { concurrency: 1 }),
    );
    const both = await listBoth(always);
    expect(both.sql).toEqual(both.memory);
    expect(Option.map(await run(store.get(reportId(1))), (row) => row.status)).toEqual(
      Option.some("resolved"),
    );
    const open = await listBoth(eq("status", "open"));
    expect(open.sql).toEqual(open.memory);
    expect(open.sql.total).toBe(4);
  });

  it("closeOpen closes a target's open reports alone, and counts them", async () => {
    const settle = {
      status: "resolved" as const,
      resolvedAt: at(25),
      resolvedBy: "u-8",
      resolutionNote: Option.some("content rejected"),
    };
    const targets = [node(3), node(3), node(2), "not-a-uuid"];
    const counts = {
      sql: await run(
        Effect.forEach(targets, (target) => store.closeOpen(target, settle), { concurrency: 1 }),
      ),
      memory: await Effect.runPromise(
        Effect.forEach(targets, (target) => memory.closeOpen(target, settle), {
          concurrency: 1,
        }),
      ),
    };
    expect(counts.sql).toEqual(counts.memory);
    expect(counts.sql).toEqual([2, 0, 1, 0]);
    const both = await listBoth(always);
    expect(both.sql).toEqual(both.memory);
    // The report closed earlier on node 1 keeps its own resolution; node 1's open one stays open.
    expect(Option.map(await run(store.get(reportId(6))), (row) => row.status)).toEqual(
      Option.some("open"),
    );
  });

  it("the CHECKs refuse a status outside the three, and a closed row with no resolver", async () => {
    const insert = (row: ReportRow) => runtime.runPromiseExit(transact(store.insert(row)));
    const base = report(90, 1, "posts", "u-6", 30);
    const lost = await runtime.runPromiseExit(
      transact(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(
            sql`INSERT INTO ${reports} (id, target_node_id, reporter_id, reason, status) VALUES (${reportId(91)}, ${node(1)}, 'u-6', 'spam', 'lost')`,
          );
        }),
      ),
    );
    expect(Exit.isFailure(lost)).toBe(true);
    expect(Exit.isFailure(await insert({ ...base, status: "resolved" }))).toBe(true);
    expect(Exit.isFailure(await insert({ ...base, resolvedAt: Option.some(at(31)) }))).toBe(true);
  });

  it("lock holds the row FOR UPDATE against a second transaction", async () => {
    // Run once the first transaction holds the lock: `NOWAIT` fails on a locked row.
    const lockElsewhere = () =>
      runtime.runPromiseExit(
        transact(
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.execute(
              sql`SELECT 1 FROM ${reports} WHERE ${reports.id} = ${reportId(3)} FOR UPDATE NOWAIT`,
            );
          }),
        ),
      );
    const outcome = await run(
      Effect.gen(function* () {
        const locked = yield* store.lock(reportId(3));
        const elsewhere = yield* Effect.tryPromise({
          try: lockElsewhere,
          catch: () => new LockProbeFailed(),
        });
        return { locked, elsewhere };
      }),
    );
    expect(outcome.locked).toEqual(await Effect.runPromise(memory.lock(reportId(3))));
    expect(Option.map(outcome.locked, (row) => row.id)).toEqual(Option.some(reportId(3)));
    expect(Exit.isFailure(outcome.elsewhere)).toBe(true);
    // Once the first transaction commits, the row is free again.
    expect(Exit.isSuccess(await lockElsewhere())).toBe(true);
  });

  it("eraseReporter deletes the account's reports, rewrites its resolutions, in batches of limit", async () => {
    // u-2 filed 3 and 5 (deleted) and dismissed 2 (rewritten); 1 is u-2's own, deleted too.
    const query = { accountId: "u-2", replacement: "erased", limit: 1 };
    const counts = {
      sql: await run(
        Effect.forEach(Arr.range(1, 5), () => store.eraseReporter(query), { concurrency: 1 }),
      ),
      memory: await Effect.runPromise(
        Effect.forEach(Arr.range(1, 5), () => memory.eraseReporter(query), { concurrency: 1 }),
      ),
    };
    expect(counts.sql).toEqual(counts.memory);
    expect(counts.sql).toEqual([1, 1, 1, 1, 0]);
    const both = await listBoth(always);
    expect(both.sql).toEqual(both.memory);
    expect(Option.flatMap(await run(store.get(reportId(2))), (row) => row.resolvedBy)).toEqual(
      Option.some("erased"),
    );
    // A resolver who filed nothing keeps the reports, their name rewritten.
    const resolver = { accountId: "u-1", replacement: "gone", limit: 10 };
    expect(await run(store.eraseReporter(resolver))).toBe(
      await Effect.runPromise(memory.eraseReporter(resolver)),
    );
    const after = await listBoth(always);
    expect(after.sql).toEqual(after.memory);
  });

  it("purging a node takes its reports with it", async () => {
    await run(chains.posts.purge(node(4)));
    expect(await run(store.get(reportId(7)))).toEqual(Option.none());
  });

  it("mintId mints a fresh UUID", async () => {
    const [a, b] = await run(Effect.all([store.mintId, store.mintId], { concurrency: 1 }));
    expect(a).toMatch(/^[0-9a-f-]{36}$/u);
    expect(a).not.toBe(b);
  });
});
