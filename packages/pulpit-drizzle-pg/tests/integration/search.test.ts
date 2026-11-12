/**
 * The search branches against PostgreSQL, checked against the kernel's
 * `makeInMemorySearchBranch` (the branch contract's reference semantics)
 * over the same writes:
 *
 * - a leaf view's branch under every viewer × `includeDeleted` through the
 *   kernel's own read scope (`searchScopeFilter`), so the scope is applied
 *   in the ranking statement exactly as `list` applies it;
 * - a publish-gated leaf's branch over the rows `LiveView.list` reads for
 *   each `headFor`;
 * - the full-text rank over the fixture's `entry` branch view, whose
 *   `project` adds the `search` vector, failing closed for a scope over
 *   columns the union lacks.
 *
 * The rank is a substring match scored by title length, so the in-memory
 * reference can compute it exactly.
 */

import { pgClientFromUrl, makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, eq, never, type FilterRow, type ListFilter } from "@thomasfosterau/pulpit/filter";
import {
  ownedAccess,
  searchScopeFilter,
  type AccessPolicy,
  type FollowerSeam,
  type Viewer,
} from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryLeafStore,
  makeInMemoryPublication,
  makeInMemorySearchBranch,
  makeInMemoryVersionChain,
  type InMemoryFollowing,
} from "@thomasfosterau/pulpit/testing";
import type { ChainState } from "@thomasfosterau/pulpit/version-chain";
import { getTableName, sql, type SQLWrapper } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makePublications } from "../../src/publication.ts";
import { fullTextRank, makeSearchBranch, type SearchRank } from "../../src/search.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { owners, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitSearchDatabase" });
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const PAST = instant("2020-01-01T00:00:00.000Z");
const FUTURE = instant("2100-01-01T00:00:00.000Z");
/** The in-memory reference's clock; no fixture instant lies between it and the database's `now()`. */
const NOW = instant("2030-01-01T00:00:00.000Z");
const RECORDED = instant("2019-06-01T00:00:00.000Z");

/** Case-sensitive substring match, scored by the title's length (longest first). */
const substring: SearchRank = (columns, query) =>
  Option.map(Option.fromNullishOr(columns["title"]), (title) => ({
    matches: sql`strpos(${title}, ${query}) > 0`,
    score: sql`char_length(${title})`,
  }));
const decodeTitle = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));
const substringScore = (row: FilterRow, query: string) =>
  Option.flatMap(Option.fromNullishOr(decodeTitle(row["title"] ?? null)), (title) =>
    title.includes(query) ? Option.some(title.length) : Option.none(),
  );

const truncate = Effect.fn("truncate")(function* () {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(
    sql.raw(
      `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.follows CASCADE`,
    ),
  );
});

const queries = ["a", "e", "Z", "zzz"] as const;

describe("a leaf view's branch agrees with the in-memory branch under the read scope", () => {
  const memoryChain = makeInMemoryVersionChain("posts");
  const memory = makeInMemoryLeafStore(memoryChain, {
    columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
  });
  const branch = makeSearchBranch({
    view: views.leaves.posts,
    owners,
    name: "substring",
    rank: substring,
    CurrentTransaction,
  });

  /** One post: owner, the columns that differ, and whether it is deleted. */
  const seeds: ReadonlyArray<readonly [number, string, ChainState, boolean]> = [
    [1, "u-1", { visibility: "public", title: "apple" }, false],
    [2, "u-1", { visibility: "public", title: "Apple tart", draft: true }, false],
    [3, "u-2", { visibility: "followers", title: "éclair" }, false],
    [4, "u-2", { visibility: "followers", title: "zebra", draft: true }, false],
    [5, "u-2", { visibility: "private", title: "Zebra crossing" }, false],
    [6, "u-3", { visibility: "public", title: "banana" }, true],
    [7, "u-3", { title: "date" }, false],
    [8, "u-1", { visibility: "public", title: "grape" }, false],
    [9, "u-2", { visibility: "public", title: "agate" }, false],
  ];

  const followers: FollowerSeam<SQLWrapper, unknown> = {
    isFollower: (follower, owner) => Effect.succeed(follower === "u-1" && owner === "u-2"),
    following: (follower) =>
      sql`select owner_id from pulpit_test.follows where follower_id = ${follower}`,
  };
  const memoryFollowers: FollowerSeam<InMemoryFollowing, unknown> = {
    isFollower: followers.isFollower,
    following: (follower) => HashSet.fromIterable(follower === "u-1" ? ["u-2"] : []),
  };
  const policy: AccessPolicy = {
    canViewPrivate: (account) => account.role === "admin",
    canViewDeleted: (account) => account.role === "admin",
    canModerate: (account) => account.role === "admin",
    canWriteCorpus: (account) => account.role === "admin",
  };
  const access = ownedAccess({ draft: true });
  const viewers: ReadonlyArray<readonly [string, Viewer]> = [
    ["anonymous", Option.none()],
    ["u-1", Option.some({ id: "u-1", role: "member" })],
    ["u-2", Option.some({ id: "u-2", role: "member" })],
    ["admin", Option.some({ id: "u-9", role: "admin" })],
  ];

  beforeAll(async () => {
    await run(truncate());
    await run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql`INSERT INTO pulpit_test.follows (follower_id, owner_id) VALUES ('u-1', 'u-2')`,
        );
        yield* Effect.forEach(
          seeds,
          ([n, owner, columns, deleted]) =>
            Effect.gen(function* () {
              const input = {
                id: Option.some(id(n)),
                state: {
                  title: null,
                  visibility: null,
                  draft: false,
                  groupId: null,
                  rank: null,
                  score: null,
                  publishedAt: PAST,
                  ...columns,
                },
                actorId: Option.some(owner),
              };
              yield* chains.posts.create(input);
              yield* memoryChain.create(input);
              yield* stores.posts.stampOwner(id(n), owner);
              yield* memory.stampOwner(id(n), owner);
              if (deleted) {
                yield* chains.posts.delete(id(n), Option.some(owner));
                yield* memoryChain.delete(id(n), Option.some(owner));
              }
            }),
          { concurrency: 1 },
        );
      }),
    );
  });

  const matrix = Arr.flatMap(viewers, ([name, viewer]) =>
    Arr.flatMap([false, true], (includeDeleted) =>
      Arr.map(queries, (query) => [name, includeDeleted, query, viewer] as const),
    ),
  );
  it.each(matrix)(
    "%s, includeDeleted %s, query %j",
    async (_name, includeDeleted, query, viewer) => {
      const request = { includeDeleted, where: always };
      const rows = (
        await Effect.runPromise(memory.list({ where: always, orderBy: [], limit: 1000, offset: 0 }))
      ).rows;
      const reference = makeInMemorySearchBranch({
        name: "substring",
        rows: () => rows,
        score: substringScore,
        now: NOW,
      });
      const fromSql = await run(
        branch.search({
          query,
          scope: searchScopeFilter(
            { access, columns: stores.posts.columns, policy, followers },
            viewer,
            request,
          ),
          headFor: never,
          limit: 100,
        }),
      );
      const fromMemory = await Effect.runPromise(
        reference.search({
          query,
          scope: searchScopeFilter(
            { access, columns: memory.columns, policy, followers: memoryFollowers },
            viewer,
            request,
          ),
          headFor: never,
          limit: 100,
        }),
      );
      expect(fromSql).toEqual(fromMemory);
    },
  );

  it("ranks the expected hits, best first, and honours the limit (so agreement is not vacuous)", async () => {
    const admin = searchScopeFilter(
      { access, columns: stores.posts.columns, policy, followers },
      Option.some({ id: "u-9", role: "admin" }),
      { includeDeleted: false, where: always },
    );
    expect(
      await run(branch.search({ query: "a", scope: admin, headFor: never, limit: 100 })),
    ).toEqual(Arr.map([5, 2, 3, 1, 4, 8, 9, 7], (n) => ({ id: id(n) })));
    expect(
      await run(branch.search({ query: "a", scope: admin, headFor: never, limit: 2 })),
    ).toEqual([{ id: id(5) }, { id: id(2) }]);
    // The scope narrows the ranking, never the ranked page: the anonymous
    // reader's top hit is the best hit they can read.
    const anonymous = searchScopeFilter(
      { access, columns: stores.posts.columns, policy, followers },
      Option.none(),
      { includeDeleted: false, where: always },
    );
    expect(
      await run(branch.search({ query: "a", scope: anonymous, headFor: never, limit: 1 })),
    ).toEqual([{ id: id(1) }]);
  });
});

describe("a gated leaf's branch agrees with the in-memory branch over the live rows", () => {
  const memoryChain = makeInMemoryVersionChain("posts");
  const memoryLeaves = makeInMemoryLeafStore(memoryChain, {
    columns: ["title", "visibility", "draft", "groupId", "rank", "score", "publishedAt"],
  });
  const memory = makeInMemoryPublication({ chain: memoryChain, leaves: memoryLeaves });
  const gated = makePublications({
    views,
    pointer: "live",
    log: tables.pointers.live,
    live: views.pointers.live.leaves,
    owners,
    CurrentTransaction,
  }).posts;
  const liveBranch = gated.searchBranch({ name: "substring", rank: substring });

  /** Each node: its owner, its versions' titles, and the version published now (if any). */
  const stories: ReadonlyArray<
    readonly [number, string, ReadonlyArray<string>, Option.Option<bigint>]
  > = [
    [1, "u-1", ["apple", "pear"], Option.some(0n)],
    [2, "u-1", ["fig", "grapefruit"], Option.some(1n)],
    [3, "u-2", ["banana"], Option.none()],
    [4, "u-2", ["peach", "apricot"], Option.some(0n)],
    [5, "u-3", ["plum"], Option.some(0n)],
  ];

  beforeAll(async () => {
    await run(truncate());
    await run(
      Effect.forEach(
        stories,
        ([n, owner, titles, live]) =>
          Effect.gen(function* () {
            const state = (title: string): ChainState => ({
              title,
              visibility: "public",
              draft: false,
              groupId: null,
              rank: null,
              score: null,
              publishedAt: null,
            });
            const create = {
              id: Option.some(id(n)),
              state: state(titles[0] ?? ""),
              actorId: Option.some(owner),
            };
            yield* chains.posts.create(create);
            yield* memoryChain.create(create);
            yield* gated.leaves.stampOwner(id(n), owner);
            yield* memoryLeaves.stampOwner(id(n), owner);
            yield* Effect.forEach(
              Arr.drop(titles, 1),
              (title) => {
                const update = { id: id(n), patch: { title }, actorId: Option.some(owner) };
                return Effect.andThen(chains.posts.update(update), memoryChain.update(update));
              },
              { concurrency: 1 },
            );
            if (Option.isSome(live)) {
              const fact = {
                id: id(n),
                version: live,
                at: PAST,
                actorId: Option.some(owner),
                recordedAt: RECORDED,
              };
              yield* gated.facts.record(fact);
              yield* memory.facts.record(fact);
            }
            // A schedule that is not live yet: never searched as live.
            const pending = {
              id: id(n),
              version: Option.some(0n),
              at: FUTURE,
              actorId: Option.none(),
              recordedAt: RECORDED,
            };
            if (n === 3) {
              yield* gated.facts.record(pending);
              yield* memory.facts.record(pending);
            }
          }),
        { concurrency: 1 },
      ),
    );
  });

  const heads: ReadonlyArray<readonly [string, ListFilter<never>]> = [
    ["no heads (a reader)", never],
    ["u-1's heads", eq("ownerId", "u-1")],
    ["every head", always],
  ];
  const matrix = Arr.flatMap(heads, ([name, headFor]) =>
    Arr.map(["a", "p", "e"] as const, (query) => [name, query, headFor] as const),
  );
  it.each(matrix)("%s, query %j", async (_name, query, headFor) => {
    const rows = (
      await Effect.runPromise(
        memory.live.list({ headFor, where: always, orderBy: [], limit: 1000, offset: 0 }),
      )
    ).rows;
    const reference = makeInMemorySearchBranch({
      name: "substring",
      rows: () => rows,
      score: substringScore,
      now: NOW,
    });
    const fromSql = await run(liveBranch.search({ query, scope: always, headFor, limit: 100 }));
    expect(fromSql).toEqual(
      await Effect.runPromise(reference.search({ query, scope: always, headFor, limit: 100 })),
    );
  });

  it("matches the live text for a reader and the head for its owner", async () => {
    // Node 1 is live at "apple" and headed at "pear"; node 2 the reverse.
    const reader = await run(
      liveBranch.search({ query: "pear", scope: always, headFor: never, limit: 10 }),
    );
    const owner = await run(
      liveBranch.search({ query: "pear", scope: always, headFor: eq("ownerId", "u-1"), limit: 10 }),
    );
    expect({ reader, owner }).toEqual({ reader: [], owner: [{ id: id(1) }] });
  });
});

describe("the full-text rank over the entry branch view", () => {
  const fullText = makeSearchBranch({
    view: views.branches.entry,
    owners,
    name: "full text",
    rank: fullTextRank({ vector: (columns) => sql`${columns["search"]}` }),
    CurrentTransaction,
  });

  beforeAll(async () => {
    await run(truncate());
    const create = (leaf: "notes" | "links" | "posts", n: number, state: ChainState) =>
      chains[leaf].create({ id: Option.some(id(n)), state, actorId: Option.none() });
    await run(
      Effect.all(
        [
          create("notes", 1, { title: "tomato soup recipe", body: null, summary: null }),
          create("links", 2, { title: "tomato", href: null }),
          create("posts", 3, {
            title: "potato salad",
            visibility: "public",
            draft: false,
            groupId: null,
            rank: null,
            score: null,
            publishedAt: null,
          }),
        ],
        { concurrency: 1 },
      ),
    );
  });

  it("ranks every leaf of the union by ts_rank_cd, ties by id", async () => {
    expect(
      await run(fullText.search({ query: "tomato", scope: always, headFor: never, limit: 10 })),
    ).toEqual([{ id: id(1) }, { id: id(2) }]);
    expect(
      await run(fullText.search({ query: "salad", scope: always, headFor: never, limit: 10 })),
    ).toEqual([{ id: id(3) }]);
    expect(
      await run(fullText.search({ query: "   ", scope: always, headFor: never, limit: 10 })),
    ).toEqual([]);
  });

  it("narrows by the identity's type and fails closed over a column the union lacks", async () => {
    expect(
      await run(
        fullText.search({ query: "tomato", scope: eq("type", "links"), headFor: never, limit: 10 }),
      ),
    ).toEqual([{ id: id(2) }]);
    expect(
      await run(
        fullText.search({
          query: "tomato",
          scope: eq("visibility", "public"),
          headFor: never,
          limit: 10,
        }),
      ),
    ).toEqual([]);
  });
});
