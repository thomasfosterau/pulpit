/**
 * The leaf store against PostgreSQL, checked row by row against the
 * kernel's in-memory `makeInMemoryLeafStore` over the same writes: every
 * row × viewer through the kernel's own read scope (`searchScopeFilter`:
 * the soft-delete arm with and without the view-deleted rung, the owned
 * visibility / draft arms, and the follower and group arms over SQL
 * subqueries), every node of the filter contract, the list order (`NULLS
 * LAST`, code-point strings, the closing `id`), `distinct`, and the
 * id-keyed reads and the owner stamp.
 */

import { pgClientFromUrl, makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
import {
  always,
  and,
  anyOf,
  eq,
  gt,
  gte,
  isIn,
  isNotIn,
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
import {
  ownedAccess,
  searchScopeFilter,
  type AccessPolicy,
  type FollowerSeam,
  type ListOrder,
  type Viewer,
} from "@thomasfosterau/pulpit/Subtype";
import {
  makeInMemoryLeafStore,
  makeInMemoryVersionChain,
  type InMemoryFollowing,
} from "@thomasfosterau/pulpit/testing";
import type { ChainState } from "@thomasfosterau/pulpit/VersionChain";
import { getTableName, sql, type SQLWrapper } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeLeafStores } from "../../src/LeafStore.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitLeafStoreDatabase" });
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
const stores = makeLeafStores({ tree, tables, views, owners, CurrentTransaction });
const store = stores.posts;

const memoryChain = makeInMemoryVersionChain("posts");
const memory = makeInMemoryLeafStore(memoryChain, {
  columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const PAST = instant("2020-01-01T00:00:00.000Z");
const LATER = instant("2024-06-01T12:00:00.000Z");
const FUTURE = instant("2100-01-01T00:00:00.000Z");

/** One fixture post: its full state (every column, `null` when unset), owner and fate. */
interface Seed {
  readonly n: number;
  readonly state: ChainState;
  readonly owner: Option.Option<string>;
  readonly deleted: boolean;
}

/** A post's columns beside `visibility`; every one it leaves out is `null` (`draft`: `false`). */
const post = (
  n: number,
  owner: Option.Option<string>,
  state: ChainState,
  deleted = false,
): Seed => ({
  n,
  owner,
  state: {
    title: null,
    visibility: null,
    draft: false,
    groupId: null,
    rank: null,
    score: null,
    publishedAt: null,
    ...state,
  },
  deleted,
});
const some = Option.some;

const seeds: ReadonlyArray<Seed> = [
  post(1, some("u-1"), {
    visibility: "public",
    title: "apple",
    rank: 3,
    score: 1.5,
    publishedAt: PAST,
  }),
  post(2, some("u-1"), { visibility: "public", title: "Apple", rank: 1, draft: true }),
  post(3, some("u-2"), { visibility: "followers", title: "éclair", rank: 2, publishedAt: FUTURE }),
  post(4, some("u-2"), { visibility: "followers", title: "zebra", rank: null, draft: true }),
  post(5, some("u-2"), { visibility: "private", title: "Zebra", rank: 2, score: -2 }),
  post(6, some("u-3"), {
    visibility: "group",
    title: "a b",
    groupId: "g-1",
    rank: 5,
    publishedAt: LATER,
  }),
  post(7, some("u-3"), { visibility: "group", title: "a", groupId: "g-2", score: 0 }),
  post(8, some("u-3"), { visibility: "group", title: null, groupId: null, rank: 4 }),
  post(9, some("u-2"), { visibility: "PUBLIC", title: "ab" }),
  post(10, Option.none(), { visibility: "public", title: "orphan", rank: 3, draft: null }),
  post(11, some("u-1"), { visibility: null, title: "nothing" }),
  post(12, some("u-1"), { visibility: "public", title: "gone", rank: 9 }, true),
  post(13, some("u-2"), { visibility: "private", title: "gone private" }, true),
  post(14, some("u-3"), { visibility: "group", title: "g1 draft", groupId: "g-1", draft: true }),
];

/** The follower and membership seams, in their SQL and in-memory readings. */
const followsOf = {
  "u-1": ["u-2"],
  "u-3": ["u-1"],
} satisfies Readonly<Record<string, ReadonlyArray<string>>>;
const groupsOf = {
  "u-1": ["g-1"],
  "u-3": ["g-2"],
} satisfies Readonly<Record<string, ReadonlyArray<string>>>;

/** The accounts or groups `key` maps to in one of the tables above, none for an unknown key. */
const lookup = (
  table: Readonly<Record<string, ReadonlyArray<string>>>,
  key: string,
): ReadonlyArray<string> => R.get(table, key).pipe(Option.getOrElse(() => []));

const sqlSeam: FollowerSeam<SQLWrapper, unknown> = {
  isFollower: (follower, owner) => Effect.succeed(Arr.contains(lookup(followsOf, follower), owner)),
  following: (follower) =>
    sql`select owner_id from pulpit_test.follows where follower_id = ${follower}`,
  isMember: (account, group) => Effect.succeed(Arr.contains(lookup(groupsOf, account), group)),
  groups: (account) =>
    sql`select group_id from pulpit_test.memberships where account_id = ${account}`,
};
const memorySeam: FollowerSeam<InMemoryFollowing, unknown> = {
  isFollower: sqlSeam.isFollower,
  following: (follower) => HashSet.fromIterable(lookup(followsOf, follower)),
  isMember: (account, group) => Effect.succeed(Arr.contains(lookup(groupsOf, account), group)),
  groups: (account) => HashSet.fromIterable(lookup(groupsOf, account)),
};

const policy: AccessPolicy = {
  canViewPrivate: (account) => account.role === "admin",
  canViewDeleted: (account) => account.role === "admin",
  canModerate: (account) => account.role === "admin",
  canWriteCorpus: (account) => account.role === "admin",
};
const viewers: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", Option.none()],
  ["u-1", Option.some({ id: "u-1", role: "member" })],
  ["u-2", Option.some({ id: "u-2", role: "member" })],
  ["u-3", Option.some({ id: "u-3", role: "member" })],
  ["admin", Option.some({ id: "u-9", role: "admin" })],
];
const access = ownedAccess({ draft: true, group: true });

beforeAll(() =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql.raw(
            `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.follows, pulpit_test.memberships CASCADE`,
          ),
        );
        yield* Effect.forEach(
          R.toEntries(followsOf),
          ([follower, followed]) =>
            Effect.forEach(
              followed,
              (owner) =>
                tx.execute(
                  sql`INSERT INTO pulpit_test.follows (follower_id, owner_id) VALUES (${follower}, ${owner})`,
                ),
              { concurrency: 1 },
            ),
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          R.toEntries(groupsOf),
          ([account, groups]) =>
            Effect.forEach(
              groups,
              (group) =>
                tx.execute(
                  sql`INSERT INTO pulpit_test.memberships (account_id, group_id) VALUES (${account}, ${group})`,
                ),
              { concurrency: 1 },
            ),
          { concurrency: 1 },
        );
      }),
    );
    yield* run(
      Effect.forEach(
        seeds,
        (seed) =>
          Effect.gen(function* () {
            const input = { id: Option.some(id(seed.n)), state: seed.state, actorId: seed.owner };
            yield* chains.posts.create(input);
            yield* memoryChain.create(input);
            if (Option.isSome(seed.owner)) {
              yield* store.stampOwner(id(seed.n), seed.owner.value);
              yield* memory.stampOwner(id(seed.n), seed.owner.value);
            }
            if (seed.deleted) {
              yield* chains.posts.delete(id(seed.n), seed.owner);
              yield* memoryChain.delete(id(seed.n), seed.owner);
            }
          }),
        { concurrency: 1 },
      ),
    );
  }),
);

/** The ids `list` reads in both stores, under `where` and `orderBy`, and their totals. */
const listBoth = (
  sqlWhere: ListFilter<SQLWrapper>,
  memoryWhere: ListFilter<InMemoryFollowing>,
  orderBy: ReadonlyArray<ListOrder> = [],
  page: { readonly limit: number; readonly offset: number } = { limit: 100, offset: 0 },
) =>
  Effect.gen(function* () {
    const fromSql = yield* run(store.list({ where: sqlWhere, orderBy, ...page }));
    const fromMemory = yield* memory.list({ where: memoryWhere, orderBy, ...page });
    return {
      sql: { ids: Arr.map(fromSql.rows, (row) => row.id), total: fromSql.total },
      memory: { ids: Arr.map(fromMemory.rows, (row) => row.id), total: fromMemory.total },
    };
  });

/** A filter that names no seam set, in both readings at once. */
const plain = (filter: ListFilter<never>) => listBoth(filter, filter);

describe("LeafStore over PostgreSQL agrees with the in-memory store", () => {
  describe("every row × viewer through the kernel's read scope", () => {
    const matrix = Arr.flatMap(viewers, ([name, viewer]) =>
      Arr.map([false, true], (includeDeleted) => [name, includeDeleted, viewer] as const),
    );
    it.live.each(matrix)("%s, includeDeleted %s", (cell) =>
      Effect.gen(function* () {
        const [, includeDeleted, viewer] = cell;
        const searchScope = <F>(
          columns: HashSet.HashSet<string>,
          followers: FollowerSeam<F, unknown>,
        ) =>
          searchScopeFilter({ access, columns, policy, followers }, viewer, {
            includeDeleted,
            where: always,
          });
        const result = yield* listBoth(
          searchScope(store.columns, sqlSeam),
          searchScope(memory.columns, memorySeam),
        );
        expect(result.sql).toEqual(result.memory);
      }),
    );

    it.live("reads the expected rows at the extremes (so agreement is not vacuous)", () =>
      Effect.gen(function* () {
        const scope = (viewer: Viewer, includeDeleted: boolean) =>
          searchScopeFilter(
            { access, columns: store.columns, policy, followers: sqlSeam },
            viewer,
            {
              includeDeleted,
              where: always,
            },
          );
        const anonymous = yield* run(
          store.list({ where: scope(Option.none(), false), orderBy: [], limit: 100, offset: 0 }),
        );
        expect(Arr.map(anonymous.rows, (row) => row.id)).toEqual([id(1)]);
        const admin = yield* run(
          store.list({
            where: scope(Option.some({ id: "u-9", role: "admin" }), true),
            orderBy: [],
            limit: 100,
            offset: 0,
          }),
        );
        expect(admin.total).toBe(seeds.length);
        const member = yield* run(
          store.list({
            where: scope(Option.some({ id: "u-1", role: "member" }), false),
            orderBy: [],
            limit: 100,
            offset: 0,
          }),
        );
        // Own rows (1, 2, 11), u-2's published followers row (3), g-1's group row (6).
        expect(Arr.map(member.rows, (row) => row.id)).toEqual([id(1), id(2), id(3), id(6), id(11)]);
      }),
    );

    it.live("fails closed without the group seam: no group row lists by membership", () =>
      Effect.gen(function* () {
        const { groups: _sqlGroups, isMember: _sqlMember, ...noGroupsSql } = sqlSeam;
        const { groups: _memGroups, isMember: _memMember, ...noGroupsMemory } = memorySeam;
        const viewer: Viewer = Option.some({ id: "u-1", role: "member" });
        const result = yield* listBoth(
          searchScopeFilter(
            { access, columns: store.columns, policy, followers: noGroupsSql },
            viewer,
            {
              includeDeleted: false,
              where: always,
            },
          ),
          searchScopeFilter(
            { access, columns: memory.columns, policy, followers: noGroupsMemory },
            viewer,
            { includeDeleted: false, where: always },
          ),
        );
        expect(result.sql).toEqual(result.memory);
        expect(result.sql.ids).not.toContain(id(6));
      }),
    );
  });

  describe("every node of the filter contract", () => {
    const cases: ReadonlyArray<readonly [string, ListFilter<never>]> = [
      ["eq", eq("visibility", "public")],
      ["eq boolean", eq("draft", false)],
      ["eq number", eq("rank", 2)],
      ["ne (a NULL satisfies neither)", ne("visibility", "public")],
      ["ne number", ne("rank", 3)],
      ["gt string by code point", gt("title", "Zebra")],
      ["gte string", gte("title", "a")],
      ["lt string (é after z)", lt("title", "é")],
      ["lte number", lte("rank", 2)],
      ["gt float", gt("score", -1)],
      ["lt Infinity", lt("score", Number.POSITIVE_INFINITY)],
      ["gt -Infinity", gt("score", Number.NEGATIVE_INFINITY)],
      ["gt date", gt("publishedAt", PAST)],
      ["lte date", lte("publishedAt", LATER)],
      ["anyOf", anyOf("visibility", ["public", "group"])],
      ["anyOf numbers", anyOf("rank", [1, 2, 9])],
      ["noneOf (NULL satisfies none)", noneOf("visibility", ["public"])],
      ["noneOf empty is always", noneOf("visibility", [])],
      ["anyOf empty is never", anyOf("visibility", [])],
      ["isNull", isNull("groupId")],
      ["isNull of a boolean", isNull("draft")],
      ["published", published("publishedAt")],
      ["notPublished", notPublished("publishedAt")],
      ["eq id", eq("id", id(3))],
      ["eq id that is no uuid", eq("id", "not-a-uuid")],
      ["anyOf ids", anyOf("id", [id(1), id(2), "nope"])],
      ["eq ownerId", eq("ownerId", "u-2")],
      ["isNull ownerId (an ownerless node)", isNull("ownerId")],
      ["a column the view lacks", eq("missing", "x")],
      ["and / or", or(and(eq("visibility", "group"), isNull("groupId")), eq("rank", 9))],
      ["the tombstones", eq("action", "delete")],
    ];
    it.live.each(cases)("%s", ([_name, filter]) =>
      Effect.gen(function* () {
        const result = yield* plain(filter);
        expect(result.sql).toEqual(result.memory);
      }),
    );

    it.live("in / notIn over a subquery partition every row, a NULL column included", () =>
      Effect.gen(function* () {
        const both = yield* listBoth(
          isIn("groupId", sqlSeam.groups?.("u-1") ?? sql`select null`),
          isIn("groupId", memorySeam.groups?.("u-1") ?? HashSet.empty()),
        );
        const complement = yield* listBoth(
          isNotIn("groupId", sqlSeam.groups?.("u-1") ?? sql`select null`),
          isNotIn("groupId", memorySeam.groups?.("u-1") ?? HashSet.empty()),
        );
        expect(both.sql).toEqual(both.memory);
        expect(complement.sql).toEqual(complement.memory);
        expect(both.sql.total + complement.sql.total).toBe(seeds.length);
      }),
    );
  });

  describe("the list order contract", () => {
    const orders: ReadonlyArray<readonly [string, ReadonlyArray<ListOrder>]> = [
      ["no key: id alone", []],
      ["a string ascending, by code point", [{ column: "title", direction: "asc" }]],
      ["a string descending", [{ column: "title", direction: "desc" }]],
      ["a nullable integer descending", [{ column: "rank", direction: "desc" }]],
      [
        "two keys",
        [
          { column: "rank", direction: "asc" },
          { column: "title", direction: "desc" },
        ],
      ],
      ["a timestamp", [{ column: "publishedAt", direction: "asc" }]],
      ["a float", [{ column: "score", direction: "desc" }]],
      ["a boolean", [{ column: "draft", direction: "asc" }]],
      ["the joined owner", [{ column: "ownerId", direction: "desc" }]],
    ];
    it.live.each(orders)("%s, NULLS LAST and the closing id", ([_name, orderBy]) =>
      Effect.gen(function* () {
        const result = yield* listBoth(always, always, orderBy);
        expect(result.sql).toEqual(result.memory);
      }),
    );

    it.live("pages by LIMIT / OFFSET over the same order, with the unpaged total", () =>
      Effect.gen(function* () {
        const orderBy: ReadonlyArray<ListOrder> = [{ column: "rank", direction: "desc" }];
        const page = yield* listBoth(always, always, orderBy, {
          limit: 4,
          offset: 3,
        });
        expect(page.sql).toEqual(page.memory);
        expect(page.sql.total).toBe(seeds.length);
      }),
    );
  });

  describe("distinct", () => {
    it.live.each(["title", "visibility", "groupId", "ownerId", "rank", "missing"])(
      "over %s",
      (column) =>
        Effect.gen(function* () {
          const query = { column, where: ne("action", "delete"), limit: 100, offset: 0 } as const;
          const fromSql = yield* run(store.distinct(query));
          const fromMemory = yield* memory.distinct(query);
          expect(fromSql).toEqual(fromMemory);
        }),
    );

    it.live("pages the distinct values", () =>
      Effect.gen(function* () {
        const query = { column: "title", where: always, limit: 3, offset: 2 } as const;
        expect(yield* run(store.distinct(query))).toEqual(yield* memory.distinct(query));
      }),
    );
  });

  describe("the id-keyed reads and the owner stamp", () => {
    it.live("get reads one row with its owner, head version and action", () =>
      Effect.gen(function* () {
        const row = Option.getOrUndefined(yield* run(store.get(id(12))));
        expect(row).toMatchObject({
          id: id(12),
          version: 1n,
          action: "delete",
          ownerId: "u-1",
          rank: 9,
        });
        expect(Option.isNone(yield* run(store.get(id(99))))).toBe(true);
        expect(Option.isNone(yield* run(store.get("not-a-uuid")))).toBe(true);
      }),
    );

    it.live("getMany reads each node once, skipping unknown and malformed ids", () =>
      Effect.gen(function* () {
        const rows = yield* run(store.getMany([id(1), id(2), id(1), "nope", id(99)]));
        expect(
          Arr.sort(
            Arr.map(rows, (row) => row.id),
            Str.Order,
          ),
        ).toEqual([id(1), id(2)]);
        expect(yield* run(store.getMany([]))).toEqual([]);
      }),
    );

    it.live("ownerOf reads the stamp; an ownerless or malformed id has none", () =>
      Effect.gen(function* () {
        expect(yield* run(store.ownerOf(id(3)))).toEqual(Option.some("u-2"));
        expect(yield* run(store.ownerOf(id(10)))).toEqual(Option.none());
        expect(yield* run(store.ownerOf("x"))).toEqual(Option.none());
      }),
    );

    it.live("a store reads only its own leaf's nodes", () =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* run(stores.notes.get(id(1))))).toBe(true);
      }),
    );

    it.live("listLocalised over an unlocalised view reads none", () =>
      Effect.gen(function* () {
        expect(
          yield* run(
            store.listLocalised({
              where: always,
              orderBy: [],
              limit: 10,
              offset: 0,
              locales: ["en"],
            }),
          ),
        ).toEqual({ rows: [], total: 0 });
      }),
    );
  });
});
