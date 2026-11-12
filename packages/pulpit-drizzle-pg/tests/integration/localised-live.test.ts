/**
 * A publish-gated localised leaf against PostgreSQL (pulpit#343), checked
 * against the kernel's `makeInMemoryPublication` over a localised
 * `makeInMemoryLeafStore` with the same writes: the live view's `list`,
 * `distinct` and `listLocalised` over one row per locale of the version
 * each node is read at (its head for `headFor`, read off the shared head,
 * else its live version), and the gated store's locale rows with `draft`
 * computed as "no live row".
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, eq, locale, never, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { LeafRow, ListOrder } from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryLeafStore,
  makeInMemoryPublication,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import type { LocalePatch, LocaleStates } from "@thomasfosterau/pulpit/version-chain";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makePublications } from "../../src/publication.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitLocalisedLiveDatabase" });
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
const gated = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  keyed: { views: views.keyed, live: views.pointers.live.keyed },
  owners,
  CurrentTransaction,
}).notes;

const memoryChain = makeInMemoryVersionChain("notes");
const memoryLeaves = makeInMemoryLeafStore(memoryChain, {
  columns: ["title", "body", "summary", "heading"],
  localised: true,
});
const memory = makeInMemoryPublication({ chain: memoryChain, leaves: memoryLeaves });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const PAST = instant("2020-01-01T00:00:00.000Z");
const FUTURE = instant("2100-01-01T00:00:00.000Z");
const RECORDED = instant("2019-06-01T00:00:00.000Z");

/** Each note: owner, its first version's locales then each later version's locale patch, and the fact recorded (version, at). */
const notes: ReadonlyArray<
  readonly [
    number,
    string,
    readonly [LocaleStates, ...ReadonlyArray<LocalePatch>],
    Option.Option<readonly [version: bigint, at: Date]>,
  ]
> = [
  // Live at v0 (en, fr); its head v1 edits en and drops fr.
  [
    1,
    "u-1",
    [
      { en: { heading: "One" }, fr: { heading: "Un" } },
      { en: { heading: "One!" }, fr: null },
    ],
    Option.some([0n, PAST]),
  ],
  // Never published.
  [2, "u-1", [{ fr: { heading: "Deux" } }], Option.none()],
  // Live, carrying no locale.
  [3, "u-2", [{}], Option.some([0n, PAST])],
  // Live at its head v1 (de, en).
  [
    4,
    "u-2",
    [{ de: { heading: "Vier" }, en: { heading: "Four" } }, { en: { heading: "Four!" } }],
    Option.some([1n, PAST]),
  ],
  // Only scheduled: not live yet.
  [5, "u-3", [{ "en-AU": { heading: "Five" } }], Option.some([0n, FUTURE])],
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
    Effect.forEach(
      notes,
      ([n, owner, versions, fact]) =>
        Effect.gen(function* () {
          const [first, ...rest] = versions;
          const create = {
            id: Option.some(id(n)),
            state: { title: `note ${String(n)}`, body: null, summary: null },
            locales: first,
            actorId: Option.some(owner),
          };
          yield* chains.notes.create(create);
          yield* memoryChain.create(create);
          yield* gated.leaves.stampOwner(id(n), owner);
          yield* memoryLeaves.stampOwner(id(n), owner);
          yield* Effect.forEach(
            rest,
            (locales) => {
              const update = { id: id(n), patch: {}, locales, actorId: Option.some(owner) };
              return Effect.andThen(chains.notes.update(update), memoryChain.update(update));
            },
            { concurrency: 1 },
          );
          yield* Effect.forEach(
            Option.toArray(fact),
            ([version, at]) => {
              const recorded = {
                id: id(n),
                version: Option.some(version),
                at,
                actorId: Option.some(owner),
                recordedAt: RECORDED,
              };
              return Effect.andThen(gated.facts.record(recorded), memory.facts.record(recorded));
            },
            { concurrency: 1 },
          );
        }),
      { concurrency: 1 },
    ),
  );
});

const decodeText = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));

/** The fields both stores carry for a locale row. */
const agreed = (row: LeafRow) => ({
  id: row.id,
  version: row.version,
  draft: row["draft"],
  locale: decodeText(row["locale"] ?? null),
  heading: decodeText(row["heading"] ?? null),
});

const byIdThenLocale = Order.combine(
  Order.mapInput(Str.Order, (row: ReturnType<typeof agreed>) => row.id),
  Order.mapInput(Str.Order, (row: ReturnType<typeof agreed>) => row.locale ?? ""),
);
/** Rows compared as a set when no key orders them (the two tie a node's locale rows differently). */
const rowsOf = (page: { readonly rows: ReadonlyArray<LeafRow> }, ordered: boolean) =>
  ordered ? Arr.map(page.rows, agreed) : Arr.sort(Arr.map(page.rows, agreed), byIdThenLocale);

const heads: ReadonlyArray<readonly [string, ListFilter<never>]> = [
  ["a reader (no heads)", never],
  ["u-1's heads", eq("ownerId", "u-1")],
  ["every head", always],
];

describe("the localised live view agrees with the in-memory one", () => {
  const lists: ReadonlyArray<readonly [string, ListFilter<never>, ReadonlyArray<ListOrder>]> = [
    ["every locale row", always, []],
    ["the locale arm", locale(["en", "fr"]), []],
    ["a translated column", eq("heading", "Four!"), []],
    ["ordered by the translated column", always, [{ column: "heading", direction: "asc" }]],
  ];
  const listCases = Arr.flatMap(heads, ([who, headFor]) =>
    Arr.map(lists, ([what, where, orderBy]) => [who, what, headFor, where, orderBy] as const),
  );
  it.each(listCases)("list, %s: %s", async (_who, _what, headFor, where, orderBy) => {
    const query = { headFor, where, orderBy, limit: 100, offset: 0 };
    const fromSql = await run(gated.live.list(query));
    const fromMemory = await Effect.runPromise(memory.live.list(query));
    const ordered = Arr.isReadonlyArrayNonEmpty(orderBy);
    expect({ total: fromSql.total, rows: rowsOf(fromSql, ordered) }).toEqual({
      total: fromMemory.total,
      rows: rowsOf(fromMemory, ordered),
    });
  });

  const preferences: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["French first", ["fr", "en"]],
    ["English first", ["en", "fr"]],
    ["German, then English", ["de", "en"]],
    ["an exact tag only", ["en-AU"]],
    ["none", []],
  ];
  const localisedCases = Arr.flatMap(heads, ([who, headFor]) =>
    Arr.map(preferences, ([what, locales]) => [who, what, headFor, locales] as const),
  );
  it.each(localisedCases)("listLocalised, %s: %s", async (_who, _what, headFor, locales) => {
    const query = { headFor, where: always, orderBy: [], limit: 100, offset: 0, locales };
    const fromSql = await run(gated.live.listLocalised(query));
    const fromMemory = await Effect.runPromise(memory.live.listLocalised(query));
    expect({ total: fromSql.total, rows: Arr.map(fromSql.rows, agreed) }).toEqual({
      total: fromMemory.total,
      rows: Arr.map(fromMemory.rows, agreed),
    });
  });

  it.each(heads)("distinct over the translated column, %s", async (_who, headFor) => {
    const query = { column: "heading", where: always, limit: 100, offset: 0, headFor };
    expect(await run(gated.live.distinct(query))).toEqual(
      await Effect.runPromise(memory.live.distinct(query)),
    );
  });

  it("reads the live locales for a reader and the head's for its owner (so agreement is not vacuous)", async () => {
    const chosen = (headFor: ListFilter<never>) =>
      Effect.map(
        gated.live.listLocalised({
          headFor,
          where: always,
          orderBy: [],
          limit: 100,
          offset: 0,
          locales: ["fr", "en"],
        }),
        (page) => Arr.map(page.rows, (row) => [row.id, row["locale"], row["heading"]]),
      );
    expect(await run(chosen(never))).toEqual([
      [id(1), "fr", "Un"],
      [id(4), "en", "Four!"],
    ]);
    expect(await run(chosen(eq("ownerId", "u-1")))).toEqual([
      [id(1), "en", "One!"],
      [id(2), "fr", "Deux"],
      [id(4), "en", "Four!"],
    ]);
  });

  it("get / getMany read the shared live row, one per node", async () => {
    const shown = await run(gated.live.getMany([id(1), id(2), id(3), id(5)]));
    expect(
      Arr.sort(
        Arr.map(shown, (row) => row.id),
        Str.Order,
      ),
    ).toEqual([id(1), id(3)]);
  });
});

describe("a localised gated leaf's search branch", () => {
  it("ranks one hit per node over the shared rows a live list reads", async () => {
    const branch = gated.searchBranch({
      name: "title",
      rank: (columns, query) =>
        Option.map(Option.fromNullishOr(columns["title"]), (title) => ({
          matches: sql`strpos(${title}, ${query}) > 0`,
          score: sql`0`,
        })),
    });
    const hits = (headFor: ListFilter<never>) =>
      run(branch.search({ query: "note", scope: always, headFor, limit: 10 }));
    // A reader: the live nodes only, each once whatever its locales.
    expect(await hits(never)).toEqual([{ id: id(1) }, { id: id(3) }, { id: id(4) }]);
    // u-1's heads add their unpublished node.
    expect(await hits(eq("ownerId", "u-1"))).toEqual([
      { id: id(1) },
      { id: id(2) },
      { id: id(3) },
      { id: id(4) },
    ]);
  });
});

describe("the localised gated store agrees with the in-memory one", () => {
  it("list reads the head's locale rows, draft computed as no live row", async () => {
    const query = { where: always, orderBy: [], limit: 100, offset: 0 };
    const fromSql = await run(gated.leaves.list(query));
    const fromMemory = await Effect.runPromise(memory.leaves.list(query));
    expect({ total: fromSql.total, rows: rowsOf(fromSql, false) }).toEqual({
      total: fromMemory.total,
      rows: rowsOf(fromMemory, false),
    });
  });

  it("listLocalised chooses among the head's locales", async () => {
    const query = { where: always, orderBy: [], limit: 100, offset: 0, locales: ["fr", "en"] };
    const fromSql = await run(gated.leaves.listLocalised(query));
    const fromMemory = await Effect.runPromise(memory.leaves.listLocalised(query));
    expect(Arr.map(fromSql.rows, agreed)).toEqual(Arr.map(fromMemory.rows, agreed));
  });
});
