/**
 * The SQL-rendered `ListFilter` and the kernel's `evaluate` agree on
 * generated rows and filters: each run writes a generated set of posts to
 * PostgreSQL and to `makeInMemoryLeafStore`, then lists both under generated
 * filters. Values stay inside the rendering contract (`./Filter`): a
 * comparand of its column's type, millisecond instants, no `NaN`.
 */

import { pgClientFromUrl, makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import {
  and,
  anyOf,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  ne,
  noneOf,
  notPublished,
  or,
  published,
  type ListFilter,
} from "@thomasfosterau/pulpit/Filter";
import { makeInMemoryLeafStore, makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeLeafStores } from "../../src/LeafStore.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitFilterParityDatabase" });
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
const store = makeLeafStores({ tree, tables, views, owners, CurrentTransaction }).posts;
const COLUMNS = ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"];

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Small domains, so generated rows and comparands collide. The strings stay
// in the BMP, where JavaScript's code-unit order is `COLLATE "C"`'s order.
const Text = Schema.Literals(["", "a", "A", "ab", "b", "z", "é"]);
const Rank = Schema.Int.check(Schema.isBetween({ minimum: -3, maximum: 3 }));
const Score = Schema.Literals([-2, -0.5, 0, 1.5, 3]);
// Far from now, so `published` cannot race the clock; two a millisecond apart.
const Instant = Schema.Literals([
  "2020-01-01T00:00:00.000Z",
  "2024-06-01T12:00:00.000Z",
  "2024-06-01T12:00:00.001Z",
  "2100-01-01T00:00:00.000Z",
]);
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));

const Row = Schema.Struct({
  title: Schema.NullOr(Text),
  visibility: Schema.NullOr(Text),
  draft: Schema.NullOr(Schema.Boolean),
  groupId: Schema.NullOr(Text),
  rank: Schema.NullOr(Rank),
  score: Schema.NullOr(Score),
  publishedAt: Schema.NullOr(Instant),
});
const Rows = Schema.Array(Row).check(Schema.isMinLength(3), Schema.isMaxLength(10));

const TextColumn = Schema.Literals(["title", "visibility", "groupId"]);
const Comparison = Schema.Literals(["eq", "ne", "gt", "gte", "lt", "lte"]);
const SetOp = Schema.Literals(["anyOf", "noneOf"]);
const set = <S extends Schema.Top>(value: S) => Schema.Array(value).check(Schema.isMaxLength(3));

const Leaf = Schema.Union([
  Schema.TaggedStruct("text", { column: TextColumn, op: Comparison, value: Text }),
  Schema.TaggedStruct("textSet", { column: TextColumn, op: SetOp, values: set(Text) }),
  Schema.TaggedStruct("rank", { op: Comparison, value: Rank }),
  Schema.TaggedStruct("rankSet", { op: SetOp, values: set(Rank) }),
  Schema.TaggedStruct("score", { op: Comparison, value: Score }),
  Schema.TaggedStruct("scoreSet", { op: SetOp, values: set(Score) }),
  Schema.TaggedStruct("draft", { op: Schema.Literals(["eq", "ne"]), value: Schema.Boolean }),
  Schema.TaggedStruct("draftSet", { op: SetOp, values: set(Schema.Boolean) }),
  Schema.TaggedStruct("instant", {
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Instant,
  }),
  Schema.TaggedStruct("publication", { op: Schema.Literals(["published", "notPublished"]) }),
  Schema.TaggedStruct("isNull", {
    column: Schema.Literals([...COLUMNS, "missing"]),
  }),
  // A column the view lacks is false, whatever the node.
  Schema.TaggedStruct("missing", { op: Comparison, value: Text }),
  Schema.TaggedStruct("id", { n: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })) }),
]);
type Leaf = typeof Leaf.Type;

/** A generated filter: a leaf, or an `and` / `or` of up to three filters. */
type Spec =
  | Leaf
  | { readonly _tag: "and"; readonly parts: ReadonlyArray<Spec> }
  | { readonly _tag: "or"; readonly parts: ReadonlyArray<Spec> };
const Parts = Schema.Array(Schema.suspend((): Schema.Codec<Spec> => Spec)).check(
  Schema.isMaxLength(3),
);
const Spec: Schema.Codec<Spec> = Schema.Union([
  Leaf,
  Schema.TaggedStruct("and", { parts: Parts }),
  Schema.TaggedStruct("or", { parts: Parts }),
]);

const compare = {
  eq: (column: string, value: string | number) => eq(column, value),
  ne: (column: string, value: string | number) => ne(column, value),
  gt,
  gte,
  lt,
  lte,
} as const;
const setOf = { anyOf, noneOf } as const;

/** The spec as the kernel's filter, built by its constructors. */
const toFilter = (spec: Spec): ListFilter<never> =>
  Match.valueTags(spec, {
    and: ({ parts }) => and(...Arr.map(parts, toFilter)),
    or: ({ parts }) => or(...Arr.map(parts, toFilter)),
    text: ({ column, op, value }) => compare[op](column, value),
    textSet: ({ column, op, values }) => setOf[op](column, values),
    rank: ({ op, value }) => compare[op]("rank", value),
    rankSet: ({ op, values }) => setOf[op]("rank", values),
    score: ({ op, value }) => compare[op]("score", value),
    scoreSet: ({ op, values }) => setOf[op]("score", values),
    draft: ({ op, value }) => (op === "eq" ? eq : ne)("draft", value),
    draftSet: ({ op, values }) => setOf[op]("draft", values),
    instant: ({ op, value }) => compare[op]("publishedAt", instant(value)),
    publication: ({ op }) => (op === "published" ? published : notPublished)("publishedAt"),
    isNull: ({ column }) => isNull(column),
    missing: ({ op, value }) => compare[op]("missing", value),
    id: ({ n }) => eq("id", id(n)),
  });

describe("the SQL filter agrees with the kernel's evaluate, by property", () => {
  it.live.prop(
    "every generated filter lists the same rows, in the same order, over the same generated rows",
    { rows: Rows, specs: Schema.Array(Spec).check(Schema.isMinLength(4), Schema.isMaxLength(10)) },
    ({ rows, specs }) =>
      Effect.gen(function* () {
        const memoryChain = makeInMemoryVersionChain("posts");
        const memory = makeInMemoryLeafStore(memoryChain, { columns: COLUMNS });
        yield* run(
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.execute(
              sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
            );
          }),
        );
        yield* Effect.forEach(
          rows,
          (row, index) => {
            const input = {
              id: Option.some(id(index)),
              state: {
                ...row,
                publishedAt: row.publishedAt === null ? null : instant(row.publishedAt),
              },
              actorId: Option.none(),
            };
            return Effect.andThen(run(chains.posts.create(input)), memoryChain.create(input));
          },
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          specs,
          (spec) =>
            Effect.gen(function* () {
              const page = { where: toFilter(spec), orderBy: [], limit: 100, offset: 0 };
              const fromSql = yield* run(store.list(page));
              const fromMemory = yield* memory.list(page);
              expect({
                ids: Arr.map(fromSql.rows, (row) => row.id),
                total: fromSql.total,
              }).toStrictEqual({
                ids: Arr.map(fromMemory.rows, (row) => row.id),
                total: fromMemory.total,
              });
            }),
          { concurrency: 1, discard: true },
        );
      }),
    { timeout: 120_000, arbitrary: { runs: 100 } },
  );
});
