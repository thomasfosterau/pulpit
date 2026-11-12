/**
 * The document store's handling of a query's rows, with no database (a
 * canned transaction): the first-insert flag, the hash a no-op put reads
 * back, the decode, and malformed hashes reading nothing. Its hashes are
 * checked against the kernel's canonical text on PostgreSQL in
 * `tests/integration/documents.test.ts`.
 */

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { makeDocumentStore } from "../src/documents.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, documents } from "./fixtures/tree.ts";

const Doc = Schema.Struct({ type: Schema.String });
const store = makeDocumentStore({
  table: documents,
  document: Doc,
  CurrentTransaction: database.CurrentTransaction,
});
const HASH = "a".repeat(64);

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

describe("makeDocumentStore over canned rows", () => {
  it("put reports a first insert, and the stored hash for a seen document", async () => {
    expect((await runWith([{ hash: HASH }], store.put({ type: "doc" }))).value).toEqual({
      hash: HASH,
      inserted: true,
    });
  });

  it("get and getMany decode the documents; malformed hashes read nothing", async () => {
    expect((await runWith([{ document: { type: "doc" } }], store.get(HASH))).value).toEqual(
      Option.some({ type: "doc" }),
    );
    expect((await runWith([], store.get(HASH))).value).toEqual(Option.none());
    expect((await runWith([], store.get("nope"))).calls).toEqual([]);
    const many = await runWith(
      [{ hash: HASH, document: { type: "doc" } }],
      store.getMany([HASH, HASH, "nope"]),
    );
    expect(HashMap.get(many.value, HASH)).toEqual(Option.some({ type: "doc" }));
    expect((await runWith([], store.getMany(["nope"]))).calls).toEqual([]);
  });

  it("a stored document outside the family's schema is a defect", async () => {
    const { tx } = cannedTransaction([{ document: { kind: "other" } }]);
    const exit = await Effect.runPromiseExit(
      Effect.provideService(store.get(HASH), database.CurrentTransaction, tx),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });
});
