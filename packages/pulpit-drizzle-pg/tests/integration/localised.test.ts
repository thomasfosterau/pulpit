/**
 * The localised leaf store against PostgreSQL (pulpit#56, pulpit#272),
 * checked against the kernel's `makeInMemoryLeafStore({ localised: true })`
 * over the same writes: `list` over the `(id, locale)` rows (a node with no
 * locale is one `NULL`-locale row), the `locale` filter arm, `distinct`
 * over the locale rows, `listLocalised` choosing each node's most preferred
 * carried locale, and `get` / `getMany` over the shared rows.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, eq, locale, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { LeafRow, ListOrder } from "@thomasfosterau/pulpit/subtype";
import { makeInMemoryLeafStore, makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";
import type { LocaleStates } from "@thomasfosterau/pulpit/version-chain";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitLocalisedDatabase" });
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
const store = makeLeafStores({ tree, tables, views, owners, CurrentTransaction }).notes;

const memoryChain = makeInMemoryVersionChain("notes");
const memory = makeInMemoryLeafStore(memoryChain, {
  columns: ["title", "body", "summary", "heading"],
  localised: true,
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Each note: its shared title, and its locale level (`{}` for none). */
const notes: ReadonlyArray<readonly [number, string, LocaleStates]> = [
  [1, "one", { en: { heading: "One" }, fr: { heading: "Un" } }],
  [2, "two", { fr: { heading: "Deux" } }],
  [3, "three", {}],
  [4, "four", { de: { heading: "Vier" }, en: { heading: "Four" } }],
  [5, "five", { "en-AU": { heading: "Five, mate" } }],
];

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
      yield* Effect.forEach(
        notes,
        ([n, title, locales]) => {
          const input = {
            id: Option.some(id(n)),
            state: { title, body: null, summary: null },
            locales,
            actorId: Option.none(),
          };
          return Effect.andThen(chains.notes.create(input), memoryChain.create(input));
        },
        { concurrency: 1 },
      );
      // A later version drops note 1's French and edits its English.
      const update = {
        id: id(1),
        patch: { title: "one, edited" },
        locales: { en: { heading: "One!" }, fr: null },
        actorId: Option.none<string>(),
      };
      yield* Effect.andThen(chains.notes.update(update), memoryChain.update(update));
    }),
  );
});

const decodeLocale = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));

/** The fields both stores carry for a locale row, absent and `NULL` alike. */
const agreed = (row: LeafRow) => ({
  id: row.id,
  version: row.version,
  title: row["title"],
  locale: decodeLocale(row["locale"] ?? null),
  heading: row["heading"] ?? null,
});

const byIdThenLocale = Order.combine(
  Order.mapInput(Str.Order, (row: ReturnType<typeof agreed>) => row.id),
  Order.mapInput(Str.Order, (row: ReturnType<typeof agreed>) => row.locale ?? ""),
);

describe("the localised LeafStore agrees with the in-memory one", () => {
  const lists: ReadonlyArray<readonly [string, ListFilter<never>, ReadonlyArray<ListOrder>]> = [
    ["every locale row, a node with none as one", always, []],
    ["the locale arm", locale(["en", "fr"]), []],
    ["a translated column", eq("heading", "Four"), []],
    ["ordered by the translated column", always, [{ column: "heading", direction: "asc" }]],
  ];
  it.each(lists)("list: %s", async (_name, where, orderBy) => {
    const query = { where, orderBy, limit: 100, offset: 0 };
    const fromSql = await run(store.list(query));
    const fromMemory = await Effect.runPromise(memory.list(query));
    // The two order ties within a node (its locale rows) differently past the
    // closing id, so the rows are compared as a set when no key orders them.
    const rows = (page: { readonly rows: ReadonlyArray<LeafRow> }) =>
      Arr.isReadonlyArrayNonEmpty(orderBy)
        ? Arr.map(page.rows, agreed)
        : Arr.sort(Arr.map(page.rows, agreed), byIdThenLocale);
    expect({ total: fromSql.total, rows: rows(fromSql) }).toEqual({
      total: fromMemory.total,
      rows: rows(fromMemory),
    });
  });

  const preferences: ReadonlyArray<readonly [string, ReadonlyArray<string>, ListFilter<never>]> = [
    ["English first", ["en", "fr"], always],
    ["French first", ["fr", "en"], always],
    ["German, then English", ["de", "en"], always],
    ["an exact tag only", ["en-AU"], always],
    ["none", [], always],
    ["a filter over the chosen rows", ["fr", "en"], eq("title", "four")],
  ];
  it.each(preferences)("listLocalised: %s", async (_name, locales, where) => {
    const query = { where, orderBy: [], limit: 100, offset: 0, locales };
    const fromSql = await run(store.listLocalised(query));
    const fromMemory = await Effect.runPromise(memory.listLocalised(query));
    expect({ total: fromSql.total, rows: Arr.map(fromSql.rows, agreed) }).toEqual({
      total: fromMemory.total,
      rows: Arr.map(fromMemory.rows, agreed),
    });
  });

  it("pins the fixture's shape, so agreement is never two empty pages", async () => {
    const all = await run(store.list({ where: always, orderBy: [], limit: 100, offset: 0 }));
    // Note 1's French was dropped; note 3 has no locale (one NULL row); note 4 has two.
    expect(all.total).toBe(6);
    const chosen = await run(
      store.listLocalised({
        where: always,
        orderBy: [],
        limit: 100,
        offset: 0,
        locales: ["fr", "en"],
      }),
    );
    expect(Arr.map(chosen.rows, (row) => [row.id, row["locale"]])).toEqual([
      [id(1), "en"],
      [id(2), "fr"],
      [id(4), "en"],
    ]);
  });

  it("distinct reads over the locale rows", async () => {
    const query = { column: "heading", where: always, limit: 100, offset: 0 };
    expect(await run(store.distinct(query))).toEqual(
      await Effect.runPromise(memory.distinct(query)),
    );
  });

  it("get / getMany read the shared rows, one per node", async () => {
    const fromSql = await run(store.getMany([id(1), id(2), id(3)]));
    expect(
      Arr.sort(
        Arr.map(fromSql, (row) => row.id),
        Str.Order,
      ),
    ).toEqual([id(1), id(2), id(3)]);
    expect(Option.map(await run(store.get(id(4))), (row) => row["title"])).toEqual(
      Option.some("four"),
    );
    expect(store.columns.has("locale")).toBe(true);
  });
});
