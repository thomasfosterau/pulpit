/**
 * The collection store against PostgreSQL, checked against
 * the kernel's `makeInMemoryCollectionStore` over the same calls: `replace`
 * rewriting a parent's whole order (a reorder, an append, a removal, an
 * emptying), `entries` by position then member id and at most `limit`, and
 * parents independent of each other. Beyond the fake, a member named twice
 * keeps its first entry, a malformed id names no node, and purging a member
 * or a parent cascades.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
import type { CollectionEntry } from "@thomasfosterau/pulpit/Collections";
import { makeInMemoryCollectionStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeCollectionStore } from "../../src/Collections.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { collection, tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitCollectionDatabase" });
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
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const store = makeCollectionStore({ table: collection, CurrentTransaction });
const memory = makeInMemoryCollectionStore();

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [listA, listB, m1, m2, m3, m4, m5] = Arr.map([1, 2, 3, 4, 5, 6, 7], node);

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
      yield* Effect.forEach(
        [1, 2, 3, 4, 5, 6, 7],
        (n) =>
          chains.links.create({
            id: Option.some(node(n)),
            state: { title: `link ${String(n)}`, href: null },
            actorId: Option.none(),
          }),
        { concurrency: 1 },
      );
    }),
  ),
);

const order = (...members: ReadonlyArray<string>): ReadonlyArray<CollectionEntry> =>
  Arr.map(members, (memberId, position) => ({ memberId, position }));

const replaceBoth = (parentId: string, entries: ReadonlyArray<CollectionEntry>) =>
  Effect.gen(function* () {
    yield* run(store.replace(parentId, entries));
    yield* memory.replace(parentId, entries);
  });
const entriesBoth = (parentId: string, limit: number) =>
  Effect.gen(function* () {
    return {
      sql: yield* run(store.entries(parentId, limit)),
      memory: yield* memory.entries(parentId, limit),
    };
  });

describe("CollectionStore over PostgreSQL agrees with the in-memory store", () => {
  it.live.each([
    { label: "a first order", entries: order(m1, m2, m3) },
    { label: "a reorder", entries: order(m3, m1, m2) },
    { label: "an append and a removal", entries: order(m1, m2, m4, m5) },
    {
      label: "a tie on position, broken by member id",
      entries: [
        { memberId: m4, position: 0 },
        { memberId: m2, position: 0 },
        { memberId: m1, position: 1 },
      ],
    },
    { label: "an emptying", entries: order() },
    { label: "a refill", entries: order(m5, m4) },
  ])("replace then entries: $label", ({ entries }) =>
    Effect.gen(function* () {
      yield* replaceBoth(listA, entries);
      const read = yield* entriesBoth(listA, 10);
      expect(read.sql).toEqual(read.memory);
      expect(read.sql).toHaveLength(entries.length);
    }),
  );

  it.live("entries is at most limit, and none for a limit below one or an unknown parent", () =>
    Effect.gen(function* () {
      yield* replaceBoth(listA, order(m1, m2, m3, m4));
      const two = yield* entriesBoth(listA, 2);
      expect(two.sql).toEqual(two.memory);
      expect(two.sql).toEqual(order(m1, m2));
      expect(yield* entriesBoth(listA, 0)).toEqual({ sql: [], memory: [] });
      expect(yield* entriesBoth(node(99), 5)).toEqual({ sql: [], memory: [] });
    }),
  );

  it.live("parents are independent: one member in two lists, each its own position", () =>
    Effect.gen(function* () {
      yield* replaceBoth(listB, order(m3, m5));
      yield* replaceBoth(listA, order(m5, m3));
      const [a, b] = [yield* entriesBoth(listA, 10), yield* entriesBoth(listB, 10)];
      expect(a.sql).toEqual(a.memory);
      expect(b.sql).toEqual(b.memory);
      expect(b.sql).toEqual(order(m3, m5));
    }),
  );
});

describe("beyond the in-memory fake", () => {
  it.live("a member named twice keeps its first entry; a malformed id names no node", () =>
    Effect.gen(function* () {
      yield* run(
        store.replace(listA, [
          { memberId: m2, position: 0 },
          { memberId: "nope", position: 1 },
          { memberId: m2, position: 2 },
          { memberId: m1, position: 3 },
        ]),
      );
      expect(yield* run(store.entries(listA, 10))).toEqual([
        { memberId: m2, position: 0 },
        { memberId: m1, position: 3 },
      ]);
      yield* run(store.replace("nope", order(m1)));
      expect(yield* run(store.entries("nope", 10))).toEqual([]);
    }),
  );

  it.live("purging a member or a parent takes its rows (the foreign keys cascade)", () =>
    Effect.gen(function* () {
      yield* run(store.replace(listA, order(m1, m2)));
      yield* run(store.replace(listB, order(m1)));
      yield* run(chains.links.purge(m1));
      expect(yield* run(store.entries(listA, 10))).toEqual([{ memberId: m2, position: 1 }]);
      expect(yield* run(store.entries(listB, 10))).toEqual([]);
      yield* run(chains.links.purge(listA));
      const rows = yield* run(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          return yield* tx.select({ member: collection.memberId }).from(collection);
        }),
      );
      expect(rows).toEqual([]);
    }),
  );
});
