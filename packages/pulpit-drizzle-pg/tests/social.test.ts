/**
 * The social store with no database (a canned transaction): the answer
 * each statement's rows map to, `isFollowing` failing closed, and the
 * `followingOf` / `silencedBy` subqueries' SQL. The statements run against
 * PostgreSQL in `tests/integration/social.test.ts`.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { makeSocialStore } from "../src/social.ts";
import { cannedTransaction, failingTransaction } from "./fixtures/canned.ts";
import { database, relationships } from "./fixtures/tree.ts";

const dialect = new PgDialect();
const store = makeSocialStore({
  table: relationships,
  CurrentTransaction: database.CurrentTransaction,
});
const follow = {
  kind: "follow",
  from: "ana",
  to: "ben",
  at: DateTime.toDate(DateTime.makeUnsafe("2026-11-01T12:00:00.000Z")),
} as const;

const runWith = <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => {
  const { tx, calls } = cannedTransaction(rows);
  return Effect.runPromise(
    Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
      value,
      calls,
    })),
  );
};

describe("makeSocialStore over canned rows", () => {
  it("addFollow maps the statement's flags, taking the pair lock first", async () => {
    const added = await runWith(
      [{ wasBlocked: false, wasInserted: true }],
      store.addFollow(follow),
    );
    expect(added).toEqual({ value: "added", calls: ["execute", "execute"] });
    expect(
      (await runWith([{ wasBlocked: true, wasInserted: false }], store.addFollow(follow))).value,
    ).toBe("blocked");
    expect(
      (await runWith([{ wasBlocked: false, wasInserted: false }], store.addFollow(follow))).value,
    ).toBe("present");
    expect((await runWith([], store.addFollow(follow))).value).toBe("present");
  });

  it("add, remove and has answer whether a row was written, went or is stored", async () => {
    const mute = { ...follow, kind: "mute" } as const;
    expect((await runWith([{ kind: "mute" }], store.add(mute))).value).toBe(true);
    expect((await runWith([], store.add(mute))).value).toBe(false);
    expect((await runWith([{ kind: "mute" }], store.remove("mute", "ana", "ben"))).value).toBe(
      true,
    );
    expect((await runWith([], store.remove("mute", "ana", "ben"))).value).toBe(false);
    expect((await runWith([{ kind: "mute" }], store.has("mute", "ana", "ben"))).value).toBe(true);
    expect((await runWith([], store.has("mute", "ana", "ben"))).value).toBe(false);
  });

  it("addBlock answers whether the block row went in", async () => {
    const block = { ...follow, kind: "block" } as const;
    expect((await runWith([{ n: 1 }], store.addBlock(block))).value).toBe(true);
    expect((await runWith([{ n: 0 }], store.addBlock(block))).value).toBe(false);
  });

  it("list reads the window total, and counts again for a page past the end", async () => {
    const at = follow.at;
    const page = await runWith(
      [{ accountId: "ben", at, total: 3 }],
      store.list({ kind: "follow", side: "from", accountId: "ana", limit: 1, offset: 0 }),
    );
    expect(page.value).toEqual({ rows: [{ accountId: "ben", at }], total: 3 });
    const past = await runWith(
      [],
      store.list({ kind: "follow", side: "to", accountId: "ana", limit: 1, offset: 9 }),
    );
    expect(past.value).toEqual({ rows: [], total: 0 });
    expect(past.calls.filter((call) => call === "select")).toHaveLength(2);
  });

  it("isFollowing is an EXISTS, and reads a failing query as false", async () => {
    expect((await runWith([{ kind: "follow" }], store.isFollowing("ana", "ben"))).value).toBe(true);
    expect((await runWith([], store.isFollowing("ana", "ben"))).value).toBe(false);
    const failing = failingTransaction("connection lost");
    expect(
      await Effect.runPromise(
        Effect.provideService(
          store.isFollowing("ana", "ben"),
          database.CurrentTransaction,
          failing,
        ),
      ),
    ).toBe(false);
  });

  it("followingOf and silencedBy render a subquery over the kinds", () => {
    const following = dialect.sqlToQuery(store.followingOf("ana"));
    expect(following.sql).toContain('"kind" IN ($1)');
    expect(following.params).toEqual(["follow", "ana"]);
    expect(dialect.sqlToQuery(store.silencedBy("ana")).params).toEqual(["mute", "block", "ana"]);
  });

  it("eraseAccount below one reads nothing; otherwise counts", async () => {
    expect(await runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
    expect((await runWith([{ n: 2 }], store.eraseAccount("ana", 5))).value).toBe(2);
  });
});
