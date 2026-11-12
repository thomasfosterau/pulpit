/**
 * The reaction store against PostgreSQL (pulpit#363), checked against the
 * kernel's `makeInMemoryReactionStore` over the same calls: `upsert`
 * answering the kind it replaced, `delete`, `tally` per node and kind,
 * `byAccount` newest first then by node, one page, and `eraseAccount` in
 * bounded batches. Beyond the fake, a malformed node id names no node, and
 * purging a node or deleting an account cascades.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { ReactionRow } from "@thomasfosterau/pulpit/reactions";
import { makeInMemoryReactionStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeReactionStore } from "../../src/reactions.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { accounts, reactions, tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitReactionDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 2 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromise(transact(effect));

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const store = makeReactionStore({ table: reactions, CurrentTransaction });
const memory = makeInMemoryReactionStore();

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [n1 = "", n2 = "", n3 = "", n4 = ""] = Arr.map([1, 2, 3, 4], node);
const at = (minute: number) =>
  DateTime.toDate(DateTime.makeUnsafe(`2026-11-01T12:${String(minute).padStart(2, "0")}:00.000Z`));

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(
          `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.${getTableName(accounts)} CASCADE`,
        ),
      );
      yield* tx.insert(accounts).values([{ id: "ana" }, { id: "ben" }, { id: "cy" }]);
      yield* Effect.forEach(
        [1, 2, 3, 4],
        (n) =>
          chains.links.create({
            id: Option.some(node(n)),
            state: { title: `link ${String(n)}`, href: null },
            actorId: Option.none(),
          }),
        { concurrency: 1 },
      );
    }),
  );
});

const both = async <A, E>(
  fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
  fromMemory: Effect.Effect<A>,
) => ({ sql: await run(fromSql), memory: await Effect.runPromise(fromMemory) });

const upsertBoth = (row: ReactionRow) => both(store.upsert(row), memory.upsert(row));

const byKey = Order.combine(
  Order.mapInput(Str.Order, (row: ReactionRow) => row.nodeId),
  Order.mapInput(Str.Order, (row: ReactionRow) => row.accountId),
);
const stored = () =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return yield* tx
        .select({
          nodeId: sql<string>`${reactions.nodeId}::text`,
          accountId: reactions.accountId,
          kind: reactions.kind,
          reactedAt: reactions.reactedAt,
        })
        .from(reactions);
    }),
  );
const tallies = (map: HashMap.HashMap<string, { readonly [kind: string]: number }>) =>
  Arr.sort(
    HashMap.toEntries(map),
    Order.mapInput(Str.Order, ([id]: readonly [string, unknown]) => id),
  );

describe("ReactionStore over PostgreSQL agrees with the in-memory store", () => {
  it("upsert answers none for a first reaction and the replaced kind after", async () => {
    const calls: ReadonlyArray<ReactionRow> = [
      { nodeId: n1, accountId: "ana", kind: "like", reactedAt: at(1) },
      { nodeId: n1, accountId: "ben", kind: "love", reactedAt: at(2) },
      { nodeId: n2, accountId: "ana", kind: "like", reactedAt: at(3) },
      { nodeId: n1, accountId: "ana", kind: "love", reactedAt: at(4) },
      { nodeId: n3, accountId: "ana", kind: "like", reactedAt: at(4) },
      { nodeId: n4, accountId: "ben", kind: "like", reactedAt: at(5) },
    ];
    const answers = await Arr.reduce(
      calls,
      Promise.resolve<ReadonlyArray<{ sql: unknown; memory: unknown }>>([]),
      (previous, row) => previous.then(async (done) => [...done, await upsertBoth(row)]),
    );
    expect(Arr.map(answers, (answer) => answer.sql)).toEqual(
      Arr.map(answers, (answer) => answer.memory),
    );
    expect(answers[3]?.sql).toEqual(Option.some("like"));
    expect(Arr.sort(await stored(), byKey)).toEqual(Arr.sort(memory.rows(), byKey));
  });

  it("tally counts each node's reactions per kind; a node with none has no key", async () => {
    const tally = await both(store.tally([n1, n2, n3, n4]), memory.tally([n1, n2, n3, n4]));
    expect(tallies(tally.sql)).toEqual(tallies(tally.memory));
    expect(HashMap.get(tally.sql, n1)).toEqual(Option.some({ love: 2 }));
    const none = await both(store.tally([node(99)]), memory.tally([node(99)]));
    expect(HashMap.size(none.sql)).toBe(0);
    expect(HashMap.size(none.memory)).toBe(0);
  });

  it("byAccount is newest first, then by node, one page", async () => {
    const pages = [
      { limit: 10, offset: 0 },
      { limit: 1, offset: 0 },
      { limit: 2, offset: 1 },
      { limit: 5, offset: 9 },
    ];
    const reads = await Arr.reduce(
      pages,
      Promise.resolve<ReadonlyArray<{ sql: unknown; memory: unknown }>>([]),
      (previous, page) =>
        previous.then(async (done) => {
          const query = { accountId: "ana", ...page };
          return [...done, await both(store.byAccount(query), memory.byAccount(query))];
        }),
    );
    expect(Arr.map(reads, (read) => read.sql)).toEqual(Arr.map(reads, (read) => read.memory));
    const all = await run(store.byAccount({ accountId: "ana", limit: 10, offset: 0 }));
    expect(Arr.map(all, (row) => row.nodeId)).toEqual([n1, n3, n2]);
  });

  it("delete answers whether a row went", async () => {
    expect(await both(store.delete(n2, "ana"), memory.delete(n2, "ana"))).toEqual({
      sql: true,
      memory: true,
    });
    expect(await both(store.delete(n2, "ana"), memory.delete(n2, "ana"))).toEqual({
      sql: false,
      memory: false,
    });
  });

  it("eraseAccount deletes at most limit of the account's rows, until none is left", async () => {
    expect(await both(store.eraseAccount("ana", 1), memory.eraseAccount("ana", 1))).toEqual({
      sql: 1,
      memory: 1,
    });
    expect(await both(store.eraseAccount("ana", 5), memory.eraseAccount("ana", 5))).toEqual({
      sql: 1,
      memory: 1,
    });
    expect(await both(store.eraseAccount("ana", 5), memory.eraseAccount("ana", 5))).toEqual({
      sql: 0,
      memory: 0,
    });
    expect(Arr.sort(await stored(), byKey)).toEqual(Arr.sort(memory.rows(), byKey));
  });
});

describe("beyond the in-memory fake", () => {
  it("a malformed node id names no node; a limit below one reads and deletes nothing", async () => {
    const row = { nodeId: "nope", accountId: "cy", kind: "like", reactedAt: at(9) };
    expect(await run(store.upsert(row))).toEqual(Option.none());
    expect(await run(store.delete("nope", "cy"))).toBe(false);
    expect(HashMap.size(await run(store.tally(["nope"])))).toBe(0);
    expect(await run(store.byAccount({ accountId: "ben", limit: 0, offset: 0 }))).toEqual([]);
    expect(await run(store.eraseAccount("ben", 0))).toBe(0);
  });

  it("purging a node or deleting an account takes its reactions (the foreign keys cascade)", async () => {
    await run(store.upsert({ nodeId: n2, accountId: "cy", kind: "like", reactedAt: at(10) }));
    await run(chains.links.purge(n1));
    expect(Arr.map(await stored(), (row) => row.nodeId)).not.toContain(n1);
    await run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(sql`DELETE FROM ${accounts} WHERE ${accounts.id} IN ('ben', 'cy')`);
      }),
    );
    expect(await stored()).toEqual([]);
  });
});
