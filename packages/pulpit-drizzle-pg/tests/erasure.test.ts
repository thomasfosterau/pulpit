/**
 * The erasure stores with no database (a canned transaction): what each
 * statement's rows map to, the guards that issue no statement (no
 * references, no document table, malformed ids and hashes, a limit below
 * one), and `unredactedNodes` over a tree whose root version table has no
 * `proposedBy` column. The statements run against PostgreSQL in
 * `tests/integration/erasure.test.ts`.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makeAccountErasureStore, makePurgeStore, type HashColumn } from "../src/erasure.ts";
import { makeNodeOwnerTable } from "../src/leaf-store.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, documents, owners, plainTables, schema, tables } from "./fixtures/tree.ts";

const NODE = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const notes = tables.levels.notes.version;

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

describe("makePurgeStore over canned rows", () => {
  const store = makePurgeStore({
    documents: {
      tables: [documents],
      references: [{ table: notes, id: notes.id, column: notes.body }],
    },
    blobs: [{ table: notes, id: notes.id, column: notes.summary }],
    dependents: [{ table: owners, id: owners.nodeId }],
    CurrentTransaction: database.CurrentTransaction,
  });

  it("eraseNode keeps the carried values that are hashes, then deletes the dependents", async () => {
    const erased = await runWith([{ hash: HASH }, { hash: "not a hash" }], store.eraseNode(NODE));
    expect(erased.value).toEqual({ documents: [HASH], blobs: [HASH] });
    expect(erased.calls).toEqual(["execute", "execute", "execute"]);
  });

  it("deleteUnreferencedDocuments and unreferencedBlobs answer the rows' hashes", async () => {
    expect(
      (await runWith([{ hash: HASH }], store.deleteUnreferencedDocuments([HASH]))).value,
    ).toEqual([HASH]);
    expect((await runWith([{ hash: HASH }], store.unreferencedBlobs([HASH, HASH]))).value).toEqual([
      HASH,
    ]);
  });

  it("a malformed id or hash, or no candidate, issues no statement", async () => {
    expect(await runWith([], store.eraseNode("nope"))).toEqual({
      value: { documents: [], blobs: [] },
      calls: [],
    });
    expect((await runWith([], store.deleteUnreferencedDocuments(["nope"]))).calls).toEqual([]);
    expect((await runWith([], store.unreferencedBlobs([]))).calls).toEqual([]);
  });

  it("fails closed: without documents or blobs it deletes nothing and reports nothing", async () => {
    const bare = makePurgeStore({ CurrentTransaction: database.CurrentTransaction });
    expect(await runWith([{ hash: HASH }], bare.eraseNode(NODE))).toEqual({
      value: { documents: [], blobs: [] },
      calls: [],
    });
    expect(await runWith([{ hash: HASH }], bare.deleteUnreferencedDocuments([HASH]))).toEqual({
      value: [],
      calls: [],
    });
    expect(await runWith([{ hash: HASH }], bare.unreferencedBlobs([HASH]))).toEqual({
      value: [],
      calls: [],
    });
  });

  it("refuses at construction a document table with no reference column, or empty blobs", () => {
    // The types require both lists non-empty; an untyped caller (or a list
    // emptied after it was typed) reaches the runtime check instead.
    const noReferences: [HashColumn, ...Array<HashColumn>] = [
      { table: notes, id: notes.id, column: notes.body },
    ];
    noReferences.pop();
    const noBlobs: [HashColumn, ...Array<HashColumn>] = [
      { table: notes, id: notes.id, column: notes.summary },
    ];
    noBlobs.pop();
    expect(() =>
      makePurgeStore({
        documents: { tables: [documents], references: noReferences },
        CurrentTransaction: database.CurrentTransaction,
      }),
    ).toThrow(DerivationError);
    expect(() =>
      makePurgeStore({ blobs: noBlobs, CurrentTransaction: database.CurrentTransaction }),
    ).toThrow(/blobs is empty/);
  });
});

describe("makeAccountErasureStore over canned rows", () => {
  const store = makeAccountErasureStore({
    root: tables.root,
    owners,
    CurrentTransaction: database.CurrentTransaction,
  });

  it("ownedNodes and unredactedNodes decode the ids; a limit below one reads nothing", async () => {
    const owned = await runWith(
      [{ id: NODE }],
      store.ownedNodes({ accountId: "a", type: "posts", limit: 5 }),
    );
    expect(owned.value).toEqual([NODE]);
    const query = { accountId: "a", type: "posts", redactedAs: Option.some("r"), limit: 5 };
    expect((await runWith([{ id: NODE }], store.unredactedNodes(query))).value).toEqual([NODE]);
    expect(
      await runWith([], store.ownedNodes({ accountId: "a", type: "posts", limit: 0 })),
    ).toEqual({ value: [], calls: [] });
    expect(await runWith([], store.unredactedNodes({ ...query, limit: 0 }))).toEqual({
      value: [],
      calls: [],
    });
  });

  it("setOwner upserts for some, deletes for none, and ignores a malformed id", async () => {
    const reassign = await runWith(
      [],
      store.setOwner({ type: "posts", id: NODE, ownerId: Option.some("b") }),
    );
    expect(reassign.calls).toEqual(["insert", "values", "onConflictDoUpdate"]);
    const retract = await runWith(
      [],
      store.setOwner({ type: "posts", id: NODE, ownerId: Option.none() }),
    );
    expect(retract.calls).toEqual(["delete", "where"]);
    expect(
      (await runWith([], store.setOwner({ type: "posts", id: "nope", ownerId: Option.none() })))
        .calls,
    ).toEqual([]);
  });

  it("over a tree with no proposedBy column, unredactedNodes still reads (the actor arms alone)", async () => {
    const plain = makeAccountErasureStore({
      root: plainTables.root,
      owners: makeNodeOwnerTable({ schema, identity: plainTables.root.identity }),
      CurrentTransaction: database.CurrentTransaction,
    });
    const query = { accountId: "a", type: "posts", redactedAs: Option.none(), limit: 5 };
    expect(await runWith([{ id: NODE }], plain.unredactedNodes(query))).toEqual({
      value: [NODE],
      calls: ["execute"],
    });
  });
});
