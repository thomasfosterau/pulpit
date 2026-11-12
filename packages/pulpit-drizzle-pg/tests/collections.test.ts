/**
 * The collection store with no database (a canned transaction): the decode
 * of `entries`, `replace` as one statement, and a malformed id or a limit
 * below one issuing none. The statements run against PostgreSQL in
 * `tests/integration/collections.test.ts`.
 */

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";
import { makeCollectionStore } from "../src/collections.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { collection, database } from "./fixtures/tree.ts";

const store = makeCollectionStore({
  table: collection,
  CurrentTransaction: database.CurrentTransaction,
});
const PARENT = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";

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

describe("makeCollectionStore over canned rows", () => {
  it("entries decodes the rows, ordered and limited by the query", async () => {
    const read = await runWith([{ memberId: MEMBER, position: 0 }], store.entries(PARENT, 10));
    expect(read.value).toEqual([{ memberId: MEMBER, position: 0 }]);
    expect(read.calls).toEqual(["select", "from", "where", "orderBy", "limit"]);
  });

  it("a row whose position is no integer is a defect", async () => {
    const { tx } = cannedTransaction([{ memberId: MEMBER, position: 0.5 }]);
    const exit = await Effect.runPromiseExit(
      Effect.provideService(store.entries(PARENT, 1), database.CurrentTransaction, tx),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });

  it("a malformed parent or a limit below one reads nothing", async () => {
    expect(await runWith([{ memberId: MEMBER, position: 0 }], store.entries("nope", 5))).toEqual({
      value: [],
      calls: [],
    });
    expect((await runWith([], store.entries(PARENT, 0))).calls).toEqual([]);
  });

  it("replace is one statement, the delete alone for no entries", async () => {
    expect(
      (await runWith([], store.replace(PARENT, [{ memberId: MEMBER, position: 0 }]))).calls,
    ).toEqual(["execute"]);
    expect((await runWith([], store.replace(PARENT, []))).calls).toEqual(["execute"]);
    expect(
      (await runWith([], store.replace(PARENT, [{ memberId: "nope", position: 0 }]))).calls,
    ).toEqual(["execute"]);
  });

  it("a malformed parent takes no write", async () => {
    expect(
      (await runWith([], store.replace("nope", [{ memberId: MEMBER, position: 0 }]))).calls,
    ).toEqual([]);
  });
});
