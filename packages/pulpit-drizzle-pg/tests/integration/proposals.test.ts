/**
 * The proposal store against PostgreSQL, checked against the
 * kernel's `makeInMemoryProposalStore` over the same writes: `get` with the
 * target's head version, `list` under every filter column (the target's
 * type and owner joined in) newest first with the unpaged total, `close`
 * only on a pending row, `eraseAuthor` in `limit`-sized batches, and `lock`
 * holding the row `FOR UPDATE` against a second transaction.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, and, eq, isNull, type ListFilter } from "@thomasfosterau/pulpit/Filter";
import type { ProposalRow } from "@thomasfosterau/pulpit/Proposals";
import {
  makeInMemoryLeafStore,
  makeInMemoryProposalStore,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeLeafStores } from "../../src/LeafStore.ts";
import { makeProposalStore } from "../../src/Proposals.ts";
import { makeVersionChains } from "../../src/VersionChain.ts";
import { owners, proposals, tables, tree, views } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitProposalDatabase" });
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
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const stores = makeLeafStores({ tree, tables, views, owners, CurrentTransaction });
const store = makeProposalStore({
  table: proposals,
  root: tables.root,
  owners,
  CurrentTransaction,
});

const memoryChain = makeInMemoryVersionChain("posts");
const memoryLeaves = makeInMemoryLeafStore(memoryChain, { columns: ["title"] });
const memory = makeInMemoryProposalStore({ chain: memoryChain, leaves: memoryLeaves });

const node = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proposalId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const at = (minute: number) =>
  DateTime.toDate(DateTime.makeUnsafe(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`));

const postState = {
  title: "post",
  visibility: "public",
  draft: false,
  groupId: null,
  rank: null,
  score: null,
  publishedAt: null,
};

/** One pending proposal on `target` by `author`, submitted at minute `minute`. */
const proposal = (n: number, target: number, author: string, minute: number): ProposalRow => ({
  id: proposalId(n),
  targetId: node(target),
  targetType: "posts",
  authorId: author,
  patch: n === 4 ? null : { title: `proposed ${String(n)}` },
  locales: n === 2 ? Option.some({ en: { heading: "Hi" } }) : Option.none(),
  rationale: n === 1 ? Option.some("typo") : Option.none(),
  baseVersion: 0n,
  status: "pending",
  submittedAt: at(minute),
  decidedAt: Option.none(),
  decidedBy: Option.none(),
  decisionNote: Option.none(),
  appliedVersion: Option.none(),
});

// Insert order is id order, so a `limit`-sized erase picks the same rows in both.
const rows: ReadonlyArray<ProposalRow> = [
  proposal(1, 1, "u-2", 5),
  proposal(2, 1, "u-3", 7),
  proposal(3, 2, "u-2", 7),
  proposal(4, 2, "u-3", 1),
  proposal(5, 3, "u-2", 9),
  proposal(6, 1, "u-4", 3),
];

beforeAll(() =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
        );
      }),
    );
    yield* run(
      Effect.forEach(
        [
          [1, Option.some("u-1"), 2],
          [2, Option.some("u-9"), 0],
          [3, Option.none<string>(), 1],
        ] as const,
        ([n, owner, updates]) =>
          Effect.gen(function* () {
            const create = { id: Option.some(node(n)), state: postState, actorId: owner };
            yield* chains.posts.create(create);
            yield* memoryChain.create(create);
            yield* Effect.forEach(
              Arr.range(1, updates),
              (version) => {
                const update = {
                  id: node(n),
                  patch: { title: `v${String(version)}` },
                  actorId: owner,
                };
                return Effect.andThen(chains.posts.update(update), memoryChain.update(update));
              },
              { concurrency: 1 },
            );
            yield* Effect.forEach(
              Option.toArray(owner),
              (ownerId) =>
                Effect.andThen(
                  stores.posts.stampOwner(node(n), ownerId),
                  memoryLeaves.stampOwner(node(n), ownerId),
                ),
              { concurrency: 1 },
            );
          }),
        { concurrency: 1 },
      ),
    );
    yield* run(
      Effect.forEach(rows, (row) => Effect.andThen(store.insert(row), memory.insert(row)), {
        concurrency: 1,
      }),
    );
  }),
);

const listBoth = (where: ListFilter<never>, limit = 100, offset = 0) =>
  Effect.gen(function* () {
    const query = { where, limit, offset };
    return {
      sql: yield* run(store.list(query)),
      memory: yield* memory.list(query),
    };
  });

describe("ProposalStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("get reads the row with its target's head version; an unknown or malformed id none", () =>
    Effect.gen(function* () {
      const ids = Arr.map([1, 2, 3, 4, 5], proposalId);
      expect(yield* run(Effect.forEach(ids, store.get, { concurrency: 1 }))).toEqual(
        yield* Effect.forEach(ids, memory.get, { concurrency: 1 }),
      );
      expect(Option.map(yield* run(store.get(proposalId(1))), (l) => l.targetVersion)).toEqual(
        Option.some(Option.some(2n)),
      );
      expect(yield* run(store.get(proposalId(99)))).toEqual(Option.none());
      expect(yield* run(store.get("not-a-uuid"))).toEqual(Option.none());
    }),
  );

  const filters: ReadonlyArray<readonly [string, ListFilter<never>]> = [
    ["every row", always],
    ["an author", eq("authorId", "u-2")],
    ["a target", eq("targetId", node(1))],
    ["the target type", eq("targetType", "posts")],
    ["pending", eq("status", "pending")],
    ["the target's owner", eq("targetOwnerId", "u-1")],
    ["an ownerless target", isNull("targetOwnerId")],
    ["a conjunction", and(eq("authorId", "u-3"), eq("targetOwnerId", "u-9"))],
  ];
  it.live.each(filters)("list, newest first with the total: %s", ([_name, where]) =>
    Effect.gen(function* () {
      const both = yield* listBoth(where);
      expect(both.sql).toEqual(both.memory);
    }),
  );

  it.live("list pages, the total unpaged (so agreement is not vacuous)", () =>
    Effect.gen(function* () {
      const both = yield* listBoth(always, 2, 1);
      expect(both.sql).toEqual(both.memory);
      expect(both.sql.total).toBe(6);
      // Newest first, `id DESC` on the 00:07 tie.
      const all = yield* run(store.list({ where: always, limit: 100, offset: 0 }));
      expect(Arr.map(all.rows, (l) => l.row.id)).toEqual(Arr.map([5, 3, 2, 1, 6, 4], proposalId));
    }),
  );

  it.live("close writes a pending row's decision once; a closed row stays as it was", () =>
    Effect.gen(function* () {
      const accept = {
        status: "accepted" as const,
        decidedAt: at(20),
        decidedBy: "u-1",
        decisionNote: Option.some("thanks"),
        appliedVersion: Option.some(2n),
      };
      const reject = {
        status: "rejected" as const,
        decidedAt: at(21),
        decidedBy: "u-2",
        decisionNote: Option.none(),
        appliedVersion: Option.none(),
      };
      const decisions = [
        [proposalId(1), accept],
        [proposalId(1), reject],
        [proposalId(3), reject],
      ] as const;
      yield* run(
        Effect.forEach(decisions, ([id, decision]) => store.close(id, decision), {
          concurrency: 1,
        }),
      );
      yield* Effect.forEach(decisions, ([id, decision]) => memory.close(id, decision), {
        concurrency: 1,
      });
      const both = yield* listBoth(always);
      expect(both.sql).toEqual(both.memory);
      expect(Option.map(yield* run(store.get(proposalId(1))), (l) => l.row.status)).toEqual(
        Option.some("accepted"),
      );
    }),
  );

  it.live("refuses an applied version the target's chain lacks (the composite foreign key)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          transact(
            store.close(proposalId(5), {
              status: "accepted",
              decidedAt: at(22),
              decidedBy: "u-1",
              decisionNote: Option.none(),
              appliedVersion: Option.some(9n),
            }),
          ),
          yield* runtime.contextEffect,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("lock holds the row FOR UPDATE against a second transaction", () =>
    Effect.gen(function* () {
      // Run once the first transaction holds the lock: `NOWAIT` fails on a locked row.
      /** The same lock on a connection of its own, outside the test's transaction. */
      const lockElsewhere = () =>
        Effect.exit(
          run(
            Effect.gen(function* () {
              const tx = yield* CurrentTransaction;
              yield* tx.execute(
                sql`SELECT 1 FROM ${proposals} WHERE ${proposals.id} = ${proposalId(2)} FOR UPDATE NOWAIT`,
              );
            }),
          ),
        ).pipe(
          // A fresh context: no open transaction, so `run` takes a second connection.
          Effect.updateContext((_: Context.Context<never>) => Context.empty()),
        );
      const outcome = yield* run(
        Effect.gen(function* () {
          const locked = yield* store.lock(proposalId(2));
          const elsewhere = yield* lockElsewhere();
          return { locked, elsewhere };
        }),
      );
      expect(Option.map(outcome.locked, (row) => row.id)).toEqual(Option.some(proposalId(2)));
      expect(outcome.locked).toEqual(yield* memory.lock(proposalId(2)));
      expect(Exit.isFailure(outcome.elsewhere)).toBe(true);
      // Once the first transaction commits, the row is free again.
      expect(Exit.isSuccess(yield* lockElsewhere())).toBe(true);
    }),
  );

  it.live(
    "eraseAuthor deletes the account's open rows, rewrites the rest, in batches of limit",
    () =>
      Effect.gen(function* () {
        const query = { accountId: "u-2", replacement: "erased", limit: 1 };
        const counts = {
          sql: yield* run(
            Effect.forEach(Arr.range(1, 4), () => store.eraseAuthor(query), { concurrency: 1 }),
          ),
          memory: yield* Effect.forEach(Arr.range(1, 4), () => memory.eraseAuthor(query), {
            concurrency: 1,
          }),
        };
        expect(counts.sql).toEqual(counts.memory);
        // u-2 wrote 1 (accepted: rewritten), 3 (rejected: deleted) and 5 (pending: deleted), and decided 3.
        expect(counts.sql).toEqual([1, 1, 1, 0]);
        const both = yield* listBoth(always);
        expect(both.sql).toEqual(both.memory);
        expect(
          Arr.map(both.sql.rows, (l) => [l.row.id, l.row.authorId] as const).find(
            ([id]) => id === proposalId(1),
          ),
        ).toEqual([proposalId(1), "erased"]);
        // A decider's id is rewritten on the row they decided, whoever wrote it.
        expect(
          yield* run(store.eraseAuthor({ accountId: "u-1", replacement: "gone", limit: 10 })),
        ).toBe(yield* memory.eraseAuthor({ accountId: "u-1", replacement: "gone", limit: 10 }));
        const after = yield* listBoth(always);
        expect(after.sql).toEqual(after.memory);
      }),
  );

  it.live("mintId mints a fresh UUID", () =>
    Effect.gen(function* () {
      const [a, b] = yield* run(Effect.all([store.mintId, store.mintId], { concurrency: 1 }));
      expect(a).toMatch(/^[0-9a-f-]{36}$/u);
      expect(a).not.toBe(b);
    }),
  );
});
