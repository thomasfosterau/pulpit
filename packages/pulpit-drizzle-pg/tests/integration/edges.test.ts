/**
 * The edge store against PostgreSQL (pulpit#356), checked against the
 * kernel's `makeInMemoryEdgeStore` over the same writes. Edge ids differ
 * between the two (a random UUID, `edge-000n`), so edges are compared by
 * their columns, in the list's order (both insert-ordered here).
 *
 * - `list`, `countAt` and `countBy` under filters over the edge's columns and
 *   each end's (`subject.ownerId`, `object.action`), each end's view INNER
 *   JOINed: an edge whose end has no view row is never read.
 * - `members` as a subquery a leaf store's list renders (`memberFilter` /
 *   `nonMemberFilter`'s `in` / `not in`), against the in-memory set.
 * - The unique key (`NULLS NOT DISTINCT`), `existing`, `delete` and
 *   `closeValidity` (`EDGE-002`).
 * - `countAt`'s `FOR NO KEY UPDATE`: a second lock on the node waits, an
 *   insert keyed to it does not.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { EdgeEnds, EdgeRow, EdgeValues } from "@thomasfosterau/pulpit/edges";
import {
  always,
  and,
  eq,
  isIn,
  isNotIn,
  isNull,
  lt,
  type ListFilter,
} from "@thomasfosterau/pulpit/filter";
import { ownedAccess } from "@thomasfosterau/pulpit/subtype";
import type { ColumnValue } from "@thomasfosterau/pulpit/version-chain";
import {
  makeInMemoryEdgeStore,
  makeInMemoryLeafStore,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeEdgeStore } from "../../src/edges.ts";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { owners, relations, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitEdgeDatabase" });
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
  runtime.runPromise(transact(effect));

/** The second transaction's probe could not run at all (its promise rejected). */
class ProbeFailed extends Schema.TaggedError<ProbeFailed, { readonly brand: unique symbol }>()(
  "ProbeFailed",
  {},
) {}

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const stores = makeLeafStores({ tree, tables, views, owners, CurrentTransaction });
const uniqueKey = ["subjectId", "objectId", "role"];
const store = makeEdgeStore({
  table: relations,
  ends: {
    subject: { column: "subjectId", view: views.leaves.posts },
    object: { column: "objectId", view: views.leaves.posts },
  },
  uniqueKey,
  identity: tables.root.identity,
  owners,
  CurrentTransaction,
});

const memoryChain = makeInMemoryVersionChain("posts");
const memoryPosts = makeInMemoryLeafStore(memoryChain, {
  columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
});
const end = (column: string) => ({
  column,
  type: "posts",
  access: ownedAccess({ draft: true }),
  nodes: memoryPosts,
});
const ends: EdgeEnds<never, never> = { subject: end("subjectId"), object: end("objectId") };
const memory = makeInMemoryEdgeStore({ ends, uniqueKey });

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const EARLY = instant("2020-01-01T00:00:00.000Z");
const LATE = instant("2024-01-01T00:00:00.000Z");
const CLOSE = instant("2025-06-01T00:00:00.000Z");
/** A note: a node in the identity table with no row in the posts view. */
const NOTE = node(90);

const postState = {
  title: "post",
  visibility: "public",
  draft: false,
  groupId: null,
  rank: null,
  score: null,
  publishedAt: null,
};

/** One edge's columns. */
const edge = (
  subject: string,
  object: string,
  role: ColumnValue,
  validFrom: ColumnValue = null,
): EdgeValues => ({ subjectId: subject, objectId: object, role, validFrom, validTo: null });

const edges: ReadonlyArray<EdgeValues> = [
  edge(node(1), node(2), "cites", EARLY),
  edge(node(1), node(3), null),
  edge(node(2), node(3), "cites", LATE),
  edge(node(3), node(1), "replies"),
  edge(node(4), node(1), null),
  edge(node(1), node(4), "cites"),
  // Its object is tombstoned: listed, with `object.action = 'delete'`.
  edge(node(2), node(5), "cites"),
  // Its object has no posts-view row: never read.
  edge(node(1), NOTE, "cites"),
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
      [
        [1, "u-1"],
        [2, "u-1"],
        [3, "u-2"],
        [4, "u-3"],
        [5, "u-2"],
      ] as const,
      ([n, owner]) =>
        Effect.gen(function* () {
          const create = {
            id: Option.some(node(n)),
            state: postState,
            actorId: Option.some(owner),
          };
          yield* chains.posts.create(create);
          yield* memoryChain.create(create);
          yield* stores.posts.stampOwner(node(n), owner);
          yield* memoryPosts.stampOwner(node(n), owner);
          if (n === 5) {
            yield* chains.posts.delete(node(n), Option.some(owner));
            yield* memoryChain.delete(node(n), Option.some(owner));
          }
        }),
      { concurrency: 1 },
    ),
  );
  await run(
    chains.notes.create({
      id: Option.some(NOTE),
      state: { title: "a note", body: null, summary: null },
      actorId: Option.none(),
    }),
  );
  // One transaction per insert, so each SQL edge has its own `created_at`.
  await Effect.runPromise(
    Effect.forEach(
      edges,
      (values) =>
        Effect.andThen(
          Effect.tryPromise({
            try: () => run(store.insert(values)),
            catch: () => new ProbeFailed(),
          }),
          memory.insert(values),
        ),
      { concurrency: 1 },
    ),
  );
});

/** An edge's columns, the id and creation instant left out (they differ by store). */
const columnsOf = (row: EdgeRow) => ({
  subjectId: row["subjectId"],
  objectId: row["objectId"],
  role: row["role"] ?? null,
  validFrom: row["validFrom"] ?? null,
  validTo: row["validTo"] ?? null,
});

const filters: ReadonlyArray<readonly [string, ListFilter<never>]> = [
  ["every edge", always],
  ["a role", eq("role", "cites")],
  ["no role", isNull("role")],
  ["a validity bound", lt("validFrom", LATE)],
  ["a subject's owner", eq("subject.ownerId", "u-1")],
  ["an end's liveness", eq("object.action", "delete")],
  ["a conjunction", and(eq("subject.ownerId", "u-1"), eq("role", "cites"))],
];

describe("EdgeStore over PostgreSQL agrees with the in-memory store", () => {
  it.each(filters)("list, in order with the window total: %s", async (_name, where) => {
    const query = { where, limit: 100, offset: 0 };
    const fromSql = await run(store.list(query));
    const fromMemory = await Effect.runPromise(memory.list(query));
    expect({ total: fromSql.total, rows: Arr.map(fromSql.rows, columnsOf) }).toEqual({
      total: fromMemory.total,
      rows: Arr.map(fromMemory.rows, columnsOf),
    });
  });

  it("list pages, and an empty page reports 0 (so agreement is not vacuous)", async () => {
    const page = await run(store.list({ where: always, limit: 2, offset: 1 }));
    expect(page.total).toBe(7);
    expect(Arr.map(page.rows, columnsOf)).toEqual(
      Arr.map(edges.slice(1, 3), (values) => columnsOf({ id: "", createdAt: EARLY, ...values })),
    );
    expect(await run(store.list({ where: always, limit: 5, offset: 50 }))).toEqual({
      rows: [],
      total: 0,
    });
  });

  it.each(filters)("countAt at each node: %s", async (_name, where) => {
    const nodes = Arr.map([1, 2, 3, 4], node);
    const count = (column: string, nodeId: string) => ({ column, nodeId, where });
    const queries = Arr.flatMap(nodes, (id) => [count("subjectId", id), count("objectId", id)]);
    expect(await run(Effect.forEach(queries, store.countAt, { concurrency: 1 }))).toEqual(
      await Effect.runPromise(Effect.forEach(queries, memory.countAt, { concurrency: 1 })),
    );
  });

  it.each(filters)("countBy, one grouped read: %s", async (_name, where) => {
    const query = { column: "subjectId", ids: Arr.map([1, 2, 3, 4, 9], node), where };
    const fromSql = await run(store.countBy(query));
    const fromMemory = await Effect.runPromise(memory.countBy(query));
    const byNode = Order.mapInput(Str.Order, ([id]: readonly [string, number]) => id);
    expect(Arr.sort(HashMap.toEntries(fromSql), byNode)).toEqual(
      Arr.sort(HashMap.toEntries(fromMemory), byNode),
    );
  });

  it.each(filters)(
    "members renders through a leaf store's list as memberFilter / nonMemberFilter do: %s",
    async (_name, where) => {
      const query = {
        column: "objectId",
        otherColumn: "subjectId",
        ids: [node(1), node(2)],
        where,
      };
      const sqlSet = await run(store.members(query));
      const memorySet = await Effect.runPromise(memory.members(query));
      const ids = (page: { readonly rows: ReadonlyArray<{ readonly id: string }> }) =>
        Arr.map(page.rows, (row) => row.id);
      const page = { orderBy: [], limit: 100, offset: 0 };
      const sqlPages = await run(
        Effect.forEach(
          [isIn("id", sqlSet), isNotIn("id", sqlSet)],
          (filter) => stores.posts.list({ ...page, where: filter }),
          { concurrency: 1 },
        ),
      );
      const memoryPages = await Effect.runPromise(
        Effect.forEach(
          [isIn("id", memorySet), isNotIn("id", memorySet)],
          (filter) => memoryPosts.list({ ...page, where: filter }),
          { concurrency: 1 },
        ),
      );
      expect(Arr.map(sqlPages, ids)).toEqual(Arr.map(memoryPages, ids));
    },
  );
});

describe("the unique key, delete and closeValidity", () => {
  it("a re-assertion (NULL role included) is refused, and existing names the stored edge", async () => {
    const again = edge(node(1), node(3), null);
    expect(await run(store.insert(again))).toEqual(Option.none());
    expect(await Effect.runPromise(memory.insert(again))).toEqual(Option.none());
    const sqlExisting = await run(store.existing(again));
    expect(Option.isSome(sqlExisting)).toBe(true);
    expect(Option.isSome(await Effect.runPromise(memory.existing(again)))).toBe(true);
    expect(await run(store.existing(edge(node(3), node(3), null)))).toEqual(Option.none());
    expect(
      Option.map(await run(Effect.flatMap(Effect.fromOption(sqlExisting), store.get)), columnsOf),
    ).toEqual(Option.some(columnsOf({ id: "", createdAt: EARLY, ...again })));
  });

  it("closeValidity sets the end column alone; delete removes the edge", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const id = yield* Effect.flatMap(
          store.existing(edge(node(1), node(2), "cites")),
          Effect.fromOption,
        );
        const closed = yield* store.closeValidity(id, "validTo", CLOSE);
        const after = yield* store.get(id);
        const refused = [
          yield* store.closeValidity("not-a-uuid", "validTo", CLOSE),
          yield* store.closeValidity(id, "nope", CLOSE),
        ];
        const deleted = [yield* store.delete(id), yield* store.delete(id)];
        return { closed, after, refused, deleted, gone: yield* store.get(id) };
      }),
    );
    expect(outcome.closed).toBe(true);
    expect(Option.map(outcome.after, columnsOf)).toEqual(
      Option.some({
        ...columnsOf({ id: "", createdAt: EARLY, ...edge(node(1), node(2), "cites", EARLY) }),
        validTo: CLOSE,
      }),
    );
    expect(outcome.refused).toEqual([false, false]);
    expect(outcome.deleted).toEqual([true, false]);
    expect(outcome.gone).toEqual(Option.none());
  });
});

describe("countAt locks the node FOR NO KEY UPDATE", () => {
  it("a second lock on the node waits; an insert keyed to it does not", async () => {
    const elsewhere = (
      statement: Effect.Effect<unknown, unknown, typeof CurrentTransaction.Identifier>,
    ) =>
      Effect.tryPromise({
        try: () => runtime.runPromiseExit(transact(statement)),
        catch: () => new ProbeFailed(),
      });
    const lockAgain = Effect.fn("lockAgain")(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql`SELECT 1 FROM ${tables.root.identity} WHERE ${tables.root.identity.id} = ${node(4)} FOR NO KEY UPDATE NOWAIT`,
      );
    });
    const outcome = await run(
      Effect.gen(function* () {
        yield* store.countAt({ column: "subjectId", nodeId: node(4), where: always });
        return {
          lock: yield* elsewhere(lockAgain()),
          insert: yield* elsewhere(store.insert(edge(node(4), node(2), "cites"))),
        };
      }),
    );
    expect(Exit.isFailure(outcome.lock)).toBe(true);
    expect(Exit.isSuccess(outcome.insert)).toBe(true);
  });
});
