/**
 * The external-identifier store against PostgreSQL, checked
 * against the kernel's `makeInMemoryExternalIdStore` over the same calls:
 * `link`'s `"linked"` / `"present"` / `"taken"` on either unique key,
 * `lookup` as one bounded read, and `recordBaseline` replacing a baseline.
 * Beyond the fake, a node's purge cascades to its links.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { makeInMemoryExternalIdStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeExternalIdStore } from "../../src/ExternalIds.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { externalIds, tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitExternalIdDatabase" });
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
const store = makeExternalIdStore({ table: externalIds, CurrentTransaction });
const memory = makeInMemoryExternalIdStore();

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
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
  ),
);

const byId = Order.mapInput(Str.Order, ([id]: readonly [string, unknown]) => id);
const lookupBoth = (authority: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return {
      sql: Arr.sort(HashMap.toEntries(yield* run(store.lookup(authority, ids))), byId),
      memory: Arr.sort(HashMap.toEntries(yield* memory.lookup(authority, ids)), byId),
    };
  });

describe("ExternalIdStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("link answers linked, present and taken on either unique key", () =>
    Effect.gen(function* () {
      const calls = [
        ["wikidata", "Q1", node(1)],
        ["wikidata", "Q1", node(1)],
        ["wikidata", "Q1", node(2)],
        ["wikidata", "Q2", node(1)],
        ["wikidata", "Q2", node(2)],
        ["doi", "10.1/x", node(1)],
        ["doi", "10.1/x", node(3)],
        ["isbn", "978-0", node(3)],
      ] as const;
      const fromSql = yield* run(
        Effect.forEach(calls, ([authority, id, target]) => store.link(authority, id, target), {
          concurrency: 1,
        }),
      );
      const fromMemory = yield* Effect.forEach(
        calls,
        ([authority, id, target]) => memory.link(authority, id, target),
        {
          concurrency: 1,
        },
      );
      expect(fromSql).toEqual(fromMemory);
      expect(fromSql).toEqual([
        "linked",
        "present",
        "taken",
        "taken",
        "linked",
        "linked",
        "taken",
        "linked",
      ]);
    }),
  );

  it.live("lookup reads every named id of one authority, none for an unknown one", () =>
    Effect.gen(function* () {
      const cases = [
        ["wikidata", ["Q1", "Q2", "Q9"]],
        ["doi", ["10.1/x", "Q1"]],
        ["isbn", []],
        ["nope", ["Q1"]],
      ] as const;
      const both = yield* Effect.all(
        Arr.map(cases, ([authority, ids]) => lookupBoth(authority, ids)),
        { concurrency: "unbounded" },
      );
      expect(Arr.map(both, (pair) => pair.sql)).toEqual(Arr.map(both, (pair) => pair.memory));
      expect((yield* lookupBoth("wikidata", ["Q1", "Q2"])).sql).toHaveLength(2);
    }),
  );

  it.live("recordBaseline replaces a link's baseline; an unknown link stays absent", () =>
    Effect.gen(function* () {
      const baseline = { title: "Q1's title", year: 1999, tags: ["a"], note: null };
      const writes = [
        ["wikidata", "Q1", baseline],
        ["wikidata", "Q1", { title: "again" }],
        ["wikidata", "Q9", baseline],
      ] as const;
      yield* run(
        Effect.forEach(
          writes,
          ([authority, id, value]) => store.recordBaseline(authority, id, value),
          {
            concurrency: 1,
          },
        ),
      );
      yield* Effect.forEach(
        writes,
        ([authority, id, value]) => memory.recordBaseline(authority, id, value),
        {
          concurrency: 1,
        },
      );
      const both = yield* lookupBoth("wikidata", ["Q1", "Q2", "Q9"]);
      expect(both.sql).toEqual(both.memory);
      expect(
        Option.flatMap(
          HashMap.get(yield* run(store.lookup("wikidata", ["Q1"])), "Q1"),
          (l) => l.baseline,
        ),
      ).toEqual(Option.some({ title: "again" }));
    }),
  );

  it.live("a node's purge takes its links (the foreign key cascades)", () =>
    Effect.gen(function* () {
      yield* run(chains.links.purge(node(3)));
      expect(HashMap.size(yield* run(store.lookup("isbn", ["978-0"])))).toBe(0);
      expect(HashMap.size(yield* run(store.lookup("doi", ["10.1/x"])))).toBe(1);
    }),
  );
});
