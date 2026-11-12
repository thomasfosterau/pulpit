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
import { describe, expect, it } from "vite-plus/test";
import { makeReactionStore } from "../src/reactions.ts";
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
  return Effect.runPromise(
    Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
      value,
      calls,
    })),
  );
};

describe("makeReactionStore over canned rows", () => {
  it("upsert answers the replaced kind, or none", async () => {
    const row = { nodeId: NODE, accountId: "ana", kind: "love", reactedAt: at };
    expect((await runWith([{ kind: "like" }], store.upsert(row))).value).toEqual(
      Option.some("like"),
    );
    expect((await runWith([], store.upsert(row))).value).toEqual(Option.none());
  });

  it("delete answers whether a row went", async () => {
    expect((await runWith([{ kind: "like" }], store.delete(NODE, "ana"))).value).toBe(true);
    expect((await runWith([], store.delete(NODE, "ana"))).value).toBe(false);
  });

  it("tally folds the grouped counts by node", async () => {
    const tally = await runWith(
      [
        { nodeId: NODE, kind: "like", count: 2 },
        { nodeId: NODE, kind: "love", count: 1 },
      ],
      store.tally([NODE, NODE]),
    );
    expect(HashMap.get(tally.value, NODE)).toEqual(Option.some({ like: 2, love: 1 }));
  });

  it("byAccount decodes the rows; a row that is no reaction is a defect", async () => {
    const row = { nodeId: NODE, accountId: "ana", kind: "like", reactedAt: at };
    const read = await runWith([row], store.byAccount({ accountId: "ana", limit: 5, offset: 0 }));
    expect(read.value).toEqual([row]);
    const { tx } = cannedTransaction([{ nodeId: NODE }]);
    const exit = await Effect.runPromiseExit(
      Effect.provideService(
        store.byAccount({ accountId: "ana", limit: 5, offset: 0 }),
        database.CurrentTransaction,
        tx,
      ),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });

  it("eraseAccount answers the count, zero for no row", async () => {
    expect((await runWith([{ erased: 3 }], store.eraseAccount("ana", 5))).value).toBe(3);
    expect((await runWith([], store.eraseAccount("ana", 5))).value).toBe(0);
  });

  it("a malformed node id or a limit below one issues no statement", async () => {
    const row = { nodeId: "nope", accountId: "ana", kind: "like", reactedAt: at };
    expect(await runWith([], store.upsert(row))).toEqual({ value: Option.none(), calls: [] });
    expect(await runWith([], store.delete("nope", "ana"))).toEqual({ value: false, calls: [] });
    expect((await runWith([], store.tally(["nope"]))).calls).toEqual([]);
    expect(
      (await runWith([], store.byAccount({ accountId: "ana", limit: 0, offset: 0 }))).calls,
    ).toEqual([]);
    expect(await runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
  });
});
