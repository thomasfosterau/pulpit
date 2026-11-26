/**
 * The social store against PostgreSQL, checked against the
 * kernel's `makeInMemorySocialStore` over the same calls: `add`,
 * `addFollow`'s `added` / `present` / `blocked`, `addBlock` dropping both
 * follows, `remove`, `has`, `isFollowing`, `list` by either side with its
 * total, the `followingOf` / `silencedBy` subqueries and `eraseAccount` in
 * bounded batches. Beyond the fake, a block racing a follow in two real
 * transactions never leaves the follow standing (the pair lock), and
 * deleting an account cascades.
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/Query";
import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
import type { Relationship } from "@thomasfosterau/pulpit/Social";
import { makeInMemorySocialStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql, type SQL } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeSocialStore } from "../../src/Social.ts";
import { accounts, relationships } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitSocialDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 4 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const store = makeSocialStore({ table: relationships, CurrentTransaction });
const memory = makeInMemorySocialStore();

const at = (minute: number) =>
  DateTime.toDate(DateTime.makeUnsafe(`2026-11-01T12:${String(minute).padStart(2, "0")}:00.000Z`));
const rel = (
  kind: Relationship["kind"],
  from: string,
  to: string,
  minute: number,
): Relationship => ({
  kind,
  from,
  to,
  at: at(minute),
});

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(sql.raw(`TRUNCATE pulpit_test.${getTableName(accounts)} CASCADE`));
      yield* tx
        .insert(accounts)
        .values(Arr.map(["ana", "ben", "cy", "dee", "eve", "fay", "gus"], (id) => ({ id })));
    }),
  ),
);

const both = <A, E>(
  fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
  fromMemory: Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    return { sql: yield* run(fromSql), memory: yield* fromMemory };
  });

/** Each call in turn against both stores, every answer kept. */
const sequence = <A, E>(
  calls: ReadonlyArray<{
    readonly sql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>;
    readonly memory: Effect.Effect<A>;
  }>,
) => Effect.forEach(calls, (call) => both(call.sql, call.memory), { concurrency: 1 });

const byKey = Order.combine(
  Order.combine(
    Order.mapInput(Str.Order, (row: Relationship) => row.kind),
    Order.mapInput(Str.Order, (row: Relationship) => row.from),
  ),
  Order.mapInput(Str.Order, (row: Relationship) => row.to),
);
const stored = () =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return yield* tx
        .select({
          kind: relationships.kind,
          from: relationships.fromId,
          to: relationships.toId,
          at: relationships.at,
        })
        .from(relationships);
    }),
  );
const ids = (set: SQL) =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* executeRows(
        tx,
        sql`SELECT to_id AS id FROM ${set} AS s(to_id) ORDER BY to_id`,
        Schema.Struct({ id: Schema.String }),
      );
      return Arr.map(rows, (row) => row.id);
    }),
  );
const sorted = (set: HashSet.HashSet<string>) => Arr.sort(Arr.fromIterable(set), Str.Order);

describe("SocialStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("add, addFollow and addBlock answer alike; a block drops both follows", () =>
    Effect.gen(function* () {
      const writes: ReadonlyArray<Relationship> = [
        rel("follow", "ana", "ben", 1),
        rel("follow", "ben", "ana", 2),
        rel("follow", "cy", "ana", 3),
        rel("follow", "dee", "ana", 3),
        rel("follow", "ana", "cy", 4),
      ];
      const follows = yield* sequence(
        Arr.map([...writes, rel("follow", "ana", "ben", 9)], (row) => ({
          sql: store.addFollow(row),
          memory: memory.addFollow(row),
        })),
      );
      expect(Arr.map(follows, (a) => a.sql)).toEqual(Arr.map(follows, (a) => a.memory));
      expect(follows.at(-1)?.sql).toBe("present");

      const block = rel("block", "ben", "ana", 5);
      const blocks = yield* sequence([
        { sql: store.addBlock(block), memory: memory.addBlock(block) },
        { sql: store.addBlock(block), memory: memory.addBlock(block) },
      ]);
      expect(Arr.map(blocks, (a) => a.sql)).toEqual([true, false]);
      expect(Arr.map(blocks, (a) => a.memory)).toEqual([true, false]);

      const after = yield* sequence([
        {
          sql: store.addFollow(rel("follow", "ana", "ben", 6)),
          memory: memory.addFollow(rel("follow", "ana", "ben", 6)),
        },
        {
          sql: store.addFollow(rel("follow", "ben", "ana", 6)),
          memory: memory.addFollow(rel("follow", "ben", "ana", 6)),
        },
      ]);
      expect(Arr.map(after, (a) => a.sql)).toEqual(["blocked", "blocked"]);
      expect(Arr.map(after, (a) => a.memory)).toEqual(["blocked", "blocked"]);

      const mutes = yield* sequence([
        {
          sql: store.add(rel("mute", "ana", "eve", 7)),
          memory: memory.add(rel("mute", "ana", "eve", 7)),
        },
        {
          sql: store.add(rel("mute", "ana", "eve", 8)),
          memory: memory.add(rel("mute", "ana", "eve", 8)),
        },
      ]);
      expect(Arr.map(mutes, (a) => a.sql)).toEqual([true, false]);
      expect(Arr.map(mutes, (a) => a.memory)).toEqual([true, false]);
      expect(Arr.sort(yield* stored(), byKey)).toEqual(Arr.sort(memory.rows(), byKey));
    }),
  );

  it.live("has, isFollowing and remove", () =>
    Effect.gen(function* () {
      const answers = yield* sequence([
        { sql: store.has("follow", "cy", "ana"), memory: memory.has("follow", "cy", "ana") },
        { sql: store.has("follow", "ana", "ben"), memory: memory.has("follow", "ana", "ben") },
        { sql: store.isFollowing("ana", "cy"), memory: memory.isFollowing("ana", "cy") },
        { sql: store.isFollowing("cy", "ana"), memory: memory.isFollowing("cy", "ana") },
        { sql: store.isFollowing("eve", "ana"), memory: memory.isFollowing("eve", "ana") },
      ]);
      expect(Arr.map(answers, (a) => a.sql)).toEqual(Arr.map(answers, (a) => a.memory));
      expect(Arr.map(answers, (a) => a.sql)).toEqual([true, false, true, true, false]);
      const removed = yield* sequence([
        {
          sql: store.remove("follow", "ana", "cy"),
          memory: memory.remove("follow", "ana", "cy"),
        },
        {
          sql: store.remove("follow", "ana", "cy"),
          memory: memory.remove("follow", "ana", "cy"),
        },
      ]);
      expect(Arr.map(removed, (a) => a.sql)).toEqual([true, false]);
      expect(Arr.map(removed, (a) => a.memory)).toEqual([true, false]);
    }),
  );

  it.live("list is one page by either side, newest first then by account, with the total", () =>
    Effect.gen(function* () {
      const queries = [
        { kind: "follow", side: "to", accountId: "ana", limit: 10, offset: 0 },
        { kind: "follow", side: "to", accountId: "ana", limit: 1, offset: 0 },
        { kind: "follow", side: "to", accountId: "ana", limit: 1, offset: 1 },
        { kind: "follow", side: "to", accountId: "ana", limit: 5, offset: 7 },
        { kind: "follow", side: "from", accountId: "cy", limit: 5, offset: 0 },
        { kind: "block", side: "from", accountId: "ben", limit: 5, offset: 0 },
        { kind: "mute", side: "to", accountId: "nobody", limit: 5, offset: 0 },
      ] as const;
      const pages = yield* sequence(
        Arr.map(queries, (query) => ({ sql: store.list(query), memory: memory.list(query) })),
      );
      expect(Arr.map(pages, (p) => p.sql)).toEqual(Arr.map(pages, (p) => p.memory));
      expect(pages[0]?.sql.rows.map((row) => row.accountId)).toEqual(["cy", "dee"]);
      expect(pages[3]?.sql).toEqual({ rows: [], total: 2 });
    }),
  );

  it.live("followingOf and silencedBy are subqueries over the same sets", () =>
    Effect.gen(function* () {
      yield* both(
        store.add(rel("mute", "cy", "gus", 10)),
        memory.add(rel("mute", "cy", "gus", 10)),
      );
      yield* both(
        store.addBlock(rel("block", "cy", "fay", 11)),
        memory.addBlock(rel("block", "cy", "fay", 11)),
      );
      expect(yield* ids(store.followingOf("cy"))).toEqual(sorted(memory.followingOf("cy")));
      expect(yield* ids(store.followingOf("cy"))).toEqual(["ana"]);
      expect(yield* ids(store.silencedBy("cy"))).toEqual(sorted(memory.silencedBy("cy")));
      expect(yield* ids(store.silencedBy("cy"))).toEqual(["fay", "gus"]);
    }),
  );

  it.live(
    "eraseAccount deletes at most limit of the rows from or to the account, until none is left",
    () =>
      Effect.gen(function* () {
        const counts = yield* sequence([
          { sql: store.eraseAccount("cy", 2), memory: memory.eraseAccount("cy", 2) },
          { sql: store.eraseAccount("cy", 2), memory: memory.eraseAccount("cy", 2) },
          { sql: store.eraseAccount("cy", 2), memory: memory.eraseAccount("cy", 2) },
        ]);
        expect(Arr.map(counts, (c) => c.sql)).toEqual(Arr.map(counts, (c) => c.memory));
        expect(Arr.map(counts, (c) => c.sql)).toEqual([2, 1, 0]);
        expect(Arr.sort(yield* stored(), byKey)).toEqual(Arr.sort(memory.rows(), byKey));
        expect(yield* run(store.eraseAccount("ana", 0))).toBe(0);
      }),
  );
});

describe("beyond the in-memory fake", () => {
  it.live("a block racing a follow never leaves the follow standing (the pair lock)", () =>
    Effect.gen(function* () {
      // The block's transaction holds the pair lock while it sleeps; the
      // follow's waits on it, then sees the block.
      const blocking = run(
        Effect.gen(function* () {
          const written = yield* store.addBlock(rel("block", "fay", "gus", 20));
          const tx = yield* CurrentTransaction;
          yield* tx.execute(sql`SELECT pg_sleep(0.3)`);
          return written;
        }),
      );
      yield* Effect.sleep("50 millis");
      const following = run(store.addFollow(rel("follow", "gus", "fay", 21)));
      expect(yield* Effect.all([blocking, following], { concurrency: "unbounded" })).toEqual([
        true,
        "blocked",
      ]);
      expect(yield* run(store.has("follow", "gus", "fay"))).toBe(false);
    }),
  );

  it.live("deleting an account takes its relationships (the foreign keys cascade)", () =>
    Effect.gen(function* () {
      yield* run(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(sql`DELETE FROM ${accounts}`);
        }),
      );
      expect(yield* stored()).toEqual([]);
    }),
  );
});
