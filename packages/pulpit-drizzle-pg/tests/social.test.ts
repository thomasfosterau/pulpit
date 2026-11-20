/**
 * The social store with no database (a canned transaction): the answer
 * each statement's rows map to, `isFollowing` failing closed, and the
 * `followingOf` / `silencedBy` subqueries' SQL. The statements run against
 * PostgreSQL in `tests/integration/social.test.ts`.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeSocialStore } from "../src/Social.ts";
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
  return Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
    value,
    calls,
  }));
};

describe("makeSocialStore over canned rows", () => {
  it.effect("addFollow maps the statement's flags, taking the pair lock first", () =>
    Effect.gen(function* () {
      const added = yield* runWith(
        [{ wasBlocked: false, wasInserted: true }],
        store.addFollow(follow),
      );
      expect(added).toEqual({ value: "added", calls: ["execute", "execute"] });
      expect(
        (yield* runWith([{ wasBlocked: true, wasInserted: false }], store.addFollow(follow))).value,
      ).toBe("blocked");
      expect(
        (yield* runWith([{ wasBlocked: false, wasInserted: false }], store.addFollow(follow)))
          .value,
      ).toBe("present");
      expect((yield* runWith([], store.addFollow(follow))).value).toBe("present");
    }),
  );

  it.effect("add, remove and has answer whether a row was written, went or is stored", () =>
    Effect.gen(function* () {
      const mute = { ...follow, kind: "mute" } as const;
      expect((yield* runWith([{ kind: "mute" }], store.add(mute))).value).toBe(true);
      expect((yield* runWith([], store.add(mute))).value).toBe(false);
      expect((yield* runWith([{ kind: "mute" }], store.remove("mute", "ana", "ben"))).value).toBe(
        true,
      );
      expect((yield* runWith([], store.remove("mute", "ana", "ben"))).value).toBe(false);
      expect((yield* runWith([{ kind: "mute" }], store.has("mute", "ana", "ben"))).value).toBe(
        true,
      );
      expect((yield* runWith([], store.has("mute", "ana", "ben"))).value).toBe(false);
    }),
  );

  it.effect("addBlock answers whether the block row went in", () =>
    Effect.gen(function* () {
      const block = { ...follow, kind: "block" } as const;
      expect((yield* runWith([{ n: 1 }], store.addBlock(block))).value).toBe(true);
      expect((yield* runWith([{ n: 0 }], store.addBlock(block))).value).toBe(false);
    }),
  );

  it.effect("list reads the window total, and counts again for a page past the end", () =>
    Effect.gen(function* () {
      const at = follow.at;
      const page = yield* runWith(
        [{ accountId: "ben", at, total: 3 }],
        store.list({ kind: "follow", side: "from", accountId: "ana", limit: 1, offset: 0 }),
      );
      expect(page.value).toEqual({ rows: [{ accountId: "ben", at }], total: 3 });
      const past = yield* runWith(
        [],
        store.list({ kind: "follow", side: "to", accountId: "ana", limit: 1, offset: 9 }),
      );
      expect(past.value).toEqual({ rows: [], total: 0 });
      expect(past.calls.filter((call) => call === "select")).toHaveLength(2);
    }),
  );

  it.effect("isFollowing is an EXISTS, and reads a failing query as false", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ kind: "follow" }], store.isFollowing("ana", "ben"))).value).toBe(
        true,
      );
      expect((yield* runWith([], store.isFollowing("ana", "ben"))).value).toBe(false);
      const failing = failingTransaction("connection lost");
      expect(
        yield* Effect.provideService(
          store.isFollowing("ana", "ben"),
          database.CurrentTransaction,
          failing,
        ),
      ).toBe(false);
    }),
  );

  it("followingOf and silencedBy render a subquery over the kinds", () => {
    const following = dialect.sqlToQuery(store.followingOf("ana"));
    expect(following.sql).toContain('"kind" IN ($1)');
    expect(following.params).toEqual(["follow", "ana"]);
    expect(dialect.sqlToQuery(store.silencedBy("ana")).params).toEqual(["mute", "block", "ana"]);
  });

  it.effect("eraseAccount below one reads nothing; otherwise counts", () =>
    Effect.gen(function* () {
      expect(yield* runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
      expect((yield* runWith([{ erased: 2 }], store.eraseAccount("ana", 5))).value).toBe(2);
    }),
  );
});
