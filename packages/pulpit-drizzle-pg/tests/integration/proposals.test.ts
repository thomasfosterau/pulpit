/**
 * The proposal store against PostgreSQL (pulpit#355), checked against the
 * kernel's `makeInMemoryProposalStore` over the same writes: `get` with the
 * target's head version, `list` under every filter column (the target's
 * type and owner joined in) newest first with the unpaged total, `close`
 * only on a pending row, `eraseAuthor` in `limit`-sized batches, and `lock`
 * holding the row `FOR UPDATE` against a second transaction.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { always, and, eq, isNull, type ListFilter } from "@thomasfosterau/pulpit/filter";
import type { ProposalRow } from "@thomasfosterau/pulpit/proposals";
import {
  makeInMemoryLeafStore,
  makeInMemoryProposalStore,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeLeafStores } from "../../src/leaf-store.ts";
import { makeProposalStore } from "../../src/proposals.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
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

/** The second transaction's probe could not even run (its promise rejected). */
class LockProbeFailed extends Schema.TaggedError<
  LockProbeFailed,
  { readonly brand: unique symbol }
>()("LockProbeFailed", {}) {}

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromise(transact(effect));

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
  await run(
    Effect.forEach(rows, (row) => Effect.andThen(store.insert(row), memory.insert(row)), {
      concurrency: 1,
    }),
  );
});

const listBoth = async (where: ListFilter<never>, limit = 100, offset = 0) => {
  const query = { where, limit, offset };
  return {
    sql: await run(store.list(query)),
    memory: await Effect.runPromise(memory.list(query)),
  };
};

describe("ProposalStore over PostgreSQL agrees with the in-memory store", () => {
  it("get reads the row with its target's head version; an unknown or malformed id none", async () => {
    const ids = Arr.map([1, 2, 3, 4, 5], proposalId);
    expect(await run(Effect.forEach(ids, store.get, { concurrency: 1 }))).toEqual(
      await Effect.runPromise(Effect.forEach(ids, memory.get, { concurrency: 1 })),
    );
    expect(Option.map(await run(store.get(proposalId(1))), (l) => l.targetVersion)).toEqual(
      Option.some(Option.some(2n)),
    );
    expect(await run(store.get(proposalId(99)))).toEqual(Option.none());
    expect(await run(store.get("not-a-uuid"))).toEqual(Option.none());
  });

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
  it.each(filters)("list, newest first with the total: %s", async (_name, where) => {
    const both = await listBoth(where);
    expect(both.sql).toEqual(both.memory);
  });

  it("list pages, the total unpaged (so agreement is not vacuous)", async () => {
    const both = await listBoth(always, 2, 1);
    expect(both.sql).toEqual(both.memory);
    expect(both.sql.total).toBe(6);
    // Newest first, `id DESC` on the 00:07 tie.
    const all = await run(store.list({ where: always, limit: 100, offset: 0 }));
    expect(Arr.map(all.rows, (l) => l.row.id)).toEqual(Arr.map([5, 3, 2, 1, 6, 4], proposalId));
  });

  it("close writes a pending row's decision once; a closed row stays as it was", async () => {
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
    await run(
      Effect.forEach(decisions, ([id, decision]) => store.close(id, decision), { concurrency: 1 }),
    );
    await Effect.runPromise(
      Effect.forEach(decisions, ([id, decision]) => memory.close(id, decision), { concurrency: 1 }),
    );
    const both = await listBoth(always);
    expect(both.sql).toEqual(both.memory);
    expect(Option.map(await run(store.get(proposalId(1))), (l) => l.row.status)).toEqual(
      Option.some("accepted"),
    );
  });

  it("refuses an applied version the target's chain lacks (the composite foreign key)", async () => {
    const exit = await runtime.runPromiseExit(
      transact(
        store.close(proposalId(5), {
          status: "accepted",
          decidedAt: at(22),
          decidedBy: "u-1",
          decisionNote: Option.none(),
          appliedVersion: Option.some(9n),
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("lock holds the row FOR UPDATE against a second transaction", async () => {
    // Run once the first transaction holds the lock: `NOWAIT` fails on a locked row.
    const lockElsewhere = () =>
      runtime.runPromiseExit(
        transact(
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.execute(
              sql`SELECT 1 FROM ${proposals} WHERE ${proposals.id} = ${proposalId(2)} FOR UPDATE NOWAIT`,
            );
          }),
        ),
      );
    const outcome = await run(
      Effect.gen(function* () {
        const locked = yield* store.lock(proposalId(2));
        const elsewhere = yield* Effect.tryPromise({
          try: lockElsewhere,
          catch: () => new LockProbeFailed(),
        });
        return { locked, elsewhere };
      }),
    );
    expect(Option.map(outcome.locked, (row) => row.id)).toEqual(Option.some(proposalId(2)));
    expect(outcome.locked).toEqual(await Effect.runPromise(memory.lock(proposalId(2))));
    expect(Exit.isFailure(outcome.elsewhere)).toBe(true);
    // Once the first transaction commits, the row is free again.
    expect(Exit.isSuccess(await lockElsewhere())).toBe(true);
  });

  it("eraseAuthor deletes the account's open rows, rewrites the rest, in batches of limit", async () => {
    const query = { accountId: "u-2", replacement: "erased", limit: 1 };
    const counts = {
      sql: await run(
        Effect.forEach(Arr.range(1, 4), () => store.eraseAuthor(query), { concurrency: 1 }),
      ),
      memory: await Effect.runPromise(
        Effect.forEach(Arr.range(1, 4), () => memory.eraseAuthor(query), { concurrency: 1 }),
      ),
    };
    expect(counts.sql).toEqual(counts.memory);
    // u-2 wrote 1 (accepted: rewritten), 3 (rejected: deleted) and 5 (pending: deleted), and decided 3.
    expect(counts.sql).toEqual([1, 1, 1, 0]);
    const both = await listBoth(always);
    expect(both.sql).toEqual(both.memory);
    expect(
      Arr.map(both.sql.rows, (l) => [l.row.id, l.row.authorId] as const).find(
        ([id]) => id === proposalId(1),
      ),
    ).toEqual([proposalId(1), "erased"]);
    // A decider's id is rewritten on the row they decided, whoever wrote it.
    expect(await run(store.eraseAuthor({ accountId: "u-1", replacement: "gone", limit: 10 }))).toBe(
      await Effect.runPromise(
        memory.eraseAuthor({ accountId: "u-1", replacement: "gone", limit: 10 }),
      ),
    );
    const after = await listBoth(always);
    expect(after.sql).toEqual(after.memory);
  });

  it("mintId mints a fresh UUID", async () => {
    const [a, b] = await run(Effect.all([store.mintId, store.mintId], { concurrency: 1 }));
    expect(a).toMatch(/^[0-9a-f-]{36}$/u);
    expect(a).not.toBe(b);
  });
});
