/**
 * The reaction store with no database (a canned transaction): the decode
 * of each read, and a malformed node id or a limit below one issuing no
 * statement. The statements run against PostgreSQL in
 * `tests/integration/reactions.test.ts`.
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeReactionStore } from "../src/Reactions.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, reactions } from "./fixtures/tree.ts";

const store = makeReactionStore({
  table: reactions,
  CurrentTransaction: database.CurrentTransaction,
});
const NODE = "00000000-0000-4000-8000-000000000001";
const at = DateTime.toDate(DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"));

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

describe("makeReactionStore over canned rows", () => {
  it.effect("upsert answers the replaced kind, or none", () =>
    Effect.gen(function* () {
      const row = { nodeId: NODE, accountId: "ana", kind: "love", reactedAt: at };
      expect((yield* runWith([{ kind: "like" }], store.upsert(row))).value).toEqual(
        Option.some("like"),
      );
      expect((yield* runWith([], store.upsert(row))).value).toEqual(Option.none());
    }),
  );

  it.effect("delete answers whether a row went", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ kind: "like" }], store.delete(NODE, "ana"))).value).toBe(true);
      expect((yield* runWith([], store.delete(NODE, "ana"))).value).toBe(false);
    }),
  );

  it.effect("tally folds the grouped counts by node", () =>
    Effect.gen(function* () {
      const tally = yield* runWith(
        [
          { nodeId: NODE, kind: "like", count: 2 },
          { nodeId: NODE, kind: "love", count: 1 },
        ],
        store.tally([NODE, NODE]),
      );
      expect(HashMap.get(tally.value, NODE)).toEqual(Option.some({ like: 2, love: 1 }));
    }),
  );

  it.effect("byAccount decodes the rows; a row that is no reaction is a defect", () =>
    Effect.gen(function* () {
      const row = { nodeId: NODE, accountId: "ana", kind: "like", reactedAt: at };
      const read = yield* runWith(
        [row],
        store.byAccount({ accountId: "ana", limit: 5, offset: 0 }),
      );
      expect(read.value).toEqual([row]);
      const { tx } = cannedTransaction([{ nodeId: NODE }]);
      const exit = yield* Effect.exit(
        Effect.provideService(
          store.byAccount({ accountId: "ana", limit: 5, offset: 0 }),
          database.CurrentTransaction,
          tx,
        ),
      );
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
    }),
  );

  it.effect("eraseAccount answers the count, zero for no row", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ erased: 3 }], store.eraseAccount("ana", 5))).value).toBe(3);
      expect((yield* runWith([], store.eraseAccount("ana", 5))).value).toBe(0);
    }),
  );

  it.effect("a malformed node id or a limit below one issues no statement", () =>
    Effect.gen(function* () {
      const row = { nodeId: "nope", accountId: "ana", kind: "like", reactedAt: at };
      expect(yield* runWith([], store.upsert(row))).toEqual({ value: Option.none(), calls: [] });
      expect(yield* runWith([], store.delete("nope", "ana"))).toEqual({ value: false, calls: [] });
      expect((yield* runWith([], store.tally(["nope"]))).calls).toEqual([]);
      expect(
        (yield* runWith([], store.byAccount({ accountId: "ana", limit: 0, offset: 0 }))).calls,
      ).toEqual([]);
      expect(yield* runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
    }),
  );
});
