/**
 * The live pointer against PostgreSQL, checked against the kernel's
 * `makeInMemoryPublication` over the same writes: the publication log
 * (`effective`, `facts`), the live view (`get` / `getMany`, and `list` /
 * `distinct` choosing the head for `headFor` and the live row for every
 * other node), the gated current-version store (`draft` as "no live
 * row"), and `scheduled` (#325) against the facts' own rule.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, eq, isNull, never, ne, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { LeafRow, ListOrder, PublicationFact } from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryLeafStore,
  makeInMemoryPublication,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import type { ChainState } from "@thomasfosterau/pulpit/version-chain";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makePublications } from "../../src/publication.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitPublicationDatabase" });
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
const stores = makeLeafStores({ tree, tables, views, owners, CurrentTransaction });
const gated = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  owners,
  CurrentTransaction,
}).posts;

const memoryChain = makeInMemoryVersionChain("posts");
const memoryLeaves = makeInMemoryLeafStore(memoryChain, {
  columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
});
const memory = makeInMemoryPublication({ chain: memoryChain, leaves: memoryLeaves });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const PAST = instant("2020-01-01T00:00:00.000Z");
const LATER_PAST = instant("2021-01-01T00:00:00.000Z");
const FUTURE = instant("2100-01-01T00:00:00.000Z");
const FURTHER = instant("2200-01-01T00:00:00.000Z");
const RECORDED = instant("2019-06-01T00:00:00.000Z");

/** What a node goes through: its owner, its versions' titles, its facts, and its fate. */
interface Story {
  readonly n: number;
  readonly owner: string;
  readonly titles: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [version: Option.Option<bigint>, at: Date]>;
  readonly deleted: boolean;
}

const story = (
  n: number,
  owner: string,
  titles: ReadonlyArray<string>,
  facts: Story["facts"],
  deleted = false,
): Story => ({ n, owner, titles, facts, deleted });
const v = (version: bigint) => Option.some(version);
const unpublish = Option.none<bigint>();

const stories: ReadonlyArray<Story> = [
  story(1, "u-1", ["one", "one edited"], [[v(0n), PAST]]),
  story(
    2,
    "u-1",
    ["two", "two edited"],
    [
      [v(1n), PAST],
      [unpublish, LATER_PAST],
    ],
  ),
  story(3, "u-2", ["three"], [[v(0n), FUTURE]]),
  story(
    4,
    "u-2",
    ["four", "four next"],
    [
      [v(0n), PAST],
      [v(1n), FUTURE],
    ],
  ),
  story(5, "u-2", ["five"], []),
  story(6, "u-3", ["six"], [[v(0n), PAST]], true),
  story(
    7,
    "u-3",
    ["seven"],
    [
      [v(0n), FUTURE],
      [v(0n), PAST],
    ],
  ),
  story(
    8,
    "u-3",
    ["eight"],
    [
      [v(0n), FURTHER],
      [unpublish, FUTURE],
    ],
  ),
];

/** A post's full state at one of its versions. */
const stateOf = (title: string): ChainState => ({
  title,
  visibility: "public",
  draft: false,
  groupId: null,
  rank: null,
  score: null,
  publishedAt: null,
});

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
      yield* Effect.forEach(
        stories,
        (node) =>
          Effect.gen(function* () {
            const actorId = Option.some(node.owner);
            const [first = "", ...rest] = node.titles;
            const input = { id: Option.some(id(node.n)), state: stateOf(first), actorId };
            yield* chains.posts.create(input);
            yield* memoryChain.create(input);
            yield* stores.posts.stampOwner(id(node.n), node.owner);
            yield* memoryLeaves.stampOwner(id(node.n), node.owner);
            yield* Effect.forEach(
              rest,
              (title) => {
                const update = { id: id(node.n), patch: { title }, actorId };
                return Effect.andThen(chains.posts.update(update), memoryChain.update(update));
              },
              { concurrency: 1 },
            );
            yield* Effect.forEach(
              node.facts,
              ([version, at]) => {
                const fact: PublicationFact = {
                  id: id(node.n),
                  version,
                  at,
                  actorId,
                  recordedAt: RECORDED,
                };
                return Effect.andThen(gated.facts.record(fact), memory.facts.record(fact));
              },
              { concurrency: 1 },
            );
            if (node.deleted) {
              yield* chains.posts.delete(id(node.n), actorId);
              yield* memoryChain.delete(id(node.n), actorId);
            }
          }),
        { concurrency: 1 },
      );
    }),
  );
});

const ids = Arr.map(stories, (node) => id(node.n));

/** The fields a live or gated row carries that the two stores must agree on. */
const agreed = (row: LeafRow) => ({
  id: row["id"],
  version: row["version"],
  action: row["action"],
  title: row["title"],
  draft: row["draft"],
  publishedAt: row["publishedAt"] ?? null,
  ownerId: row["ownerId"],
});

describe("the publication log", () => {
  it.each(ids)("effective and facts agree for %s", async (node) => {
    expect(await run(gated.facts.effective(node))).toEqual(
      await Effect.runPromise(memory.facts.effective(node)),
    );
    expect(await run(gated.facts.facts(node, 100))).toEqual(
      await Effect.runPromise(memory.facts.facts(node, 100)),
    );
  });

  it("an id that is no UUID has no facts", async () => {
    expect(await run(gated.facts.effective("x"))).toEqual(Option.none());
    expect(await run(gated.facts.facts("x", 10))).toEqual([]);
  });

  it("scheduled is the latest pending publish no later record overtakes, in one read", async () => {
    const pending = await run(gated.facts.scheduled([...ids, ids[0] ?? "", "x"]));
    expect(
      Arr.map(
        Arr.sort(
          pending,
          Order.mapInput(Str.Order, (fact: PublicationFact) => fact.id),
        ),
        (fact) => [fact.id, fact.version, fact.at],
      ),
    ).toEqual([
      [id(3), v(0n), FUTURE],
      [id(4), v(1n), FUTURE],
    ]);
    expect(await run(gated.facts.scheduled([]))).toEqual([]);
  });
});

describe("the live view agrees with the in-memory one", () => {
  it("get / getMany read each node's live row, if it has one", async () => {
    const fromSql = await run(
      Effect.forEach(ids, (node) => Effect.map(gated.live.get(node), Option.map(agreed)), {
        concurrency: 1,
      }),
    );
    const fromMemory = await Effect.runPromise(
      Effect.forEach(ids, (node) => Effect.map(memory.live.get(node), Option.map(agreed)), {
        concurrency: 1,
      }),
    );
    expect(fromSql).toEqual(fromMemory);
    const many = await run(gated.live.getMany([...ids, "x"]));
    const memoryMany = await Effect.runPromise(memory.live.getMany(ids));
    const byId = (rows: ReadonlyArray<{ readonly id: string }>) =>
      Arr.sort(
        Arr.map(rows, (row) => row.id),
        Str.Order,
      );
    expect(byId(many)).toEqual(byId(memoryMany));
  });

  const cases: ReadonlyArray<
    readonly [string, ListFilter<never>, ListFilter<never>, ReadonlyArray<ListOrder>]
  > = [
    ["the anonymous: live rows only", never, always, []],
    ["u-1's own heads, everyone else live", eq("ownerId", "u-1"), always, []],
    ["every head", always, always, [{ column: "title", direction: "desc" }]],
    ["u-2's heads, live tombstones hidden", eq("ownerId", "u-2"), ne("action", "delete"), []],
    ["a filter over the chosen rows' draft", eq("ownerId", "u-3"), eq("draft", true), []],
    [
      "ordered by the publication stamp",
      never,
      always,
      [{ column: "publishedAt", direction: "desc" }],
    ],
    ["the unpublished heads by stamp", always, isNull("publishedAt"), []],
  ];
  it.each(cases)("list: %s", async (_name, headFor, where, orderBy) => {
    const query = { headFor, where, orderBy, limit: 100, offset: 0 };
    const fromSql = await run(gated.live.list(query));
    const fromMemory = await Effect.runPromise(memory.live.list(query));
    expect({ total: fromSql.total, rows: Arr.map(fromSql.rows, agreed) }).toEqual({
      total: fromMemory.total,
      rows: Arr.map(fromMemory.rows, agreed),
    });
  });

  it.each([
    ["the anonymous", never],
    ["u-1", eq("ownerId", "u-1")],
  ] as const)("distinct counts a node through the row %s would list", async (_name, headFor) => {
    const query = { column: "title", where: always, limit: 100, offset: 0, headFor };
    expect(await run(gated.live.distinct(query))).toEqual(
      await Effect.runPromise(memory.live.distinct(query)),
    );
  });
});

describe("the gated current-version store", () => {
  it("computes draft as 'no live row', ignoring the stored column", async () => {
    const query = { where: always, orderBy: [], limit: 100, offset: 0 };
    const fromSql = await run(gated.leaves.list(query));
    const fromMemory = await Effect.runPromise(memory.leaves.list(query));
    expect(Arr.map(fromSql.rows, agreed)).toEqual(Arr.map(fromMemory.rows, agreed));
    expect(
      Arr.map(
        Arr.filter(fromSql.rows, (row) => row["draft"] === false),
        (row) => row.id,
      ),
    ).toEqual([id(1), id(4), id(6), id(7)]);
  });

  it("get reads the head with the computed draft", async () => {
    expect(Option.map(await run(gated.leaves.get(id(3))), agreed)).toEqual(
      Option.map(await Effect.runPromise(memory.leaves.get(id(3))), agreed),
    );
  });
});
