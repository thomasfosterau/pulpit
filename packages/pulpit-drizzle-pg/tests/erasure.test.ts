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
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { makeAccountErasureStore, makePurgeStore, type HashColumn } from "../src/Erasure.ts";
import { makeNodeOwnerTable } from "../src/LeafStore.ts";
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
  return Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
    value,
    calls,
  }));
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

  it.effect("eraseNode keeps the carried values that are hashes, then deletes the dependents", () =>
    Effect.gen(function* () {
      const erased = yield* runWith(
        [{ hash: HASH }, { hash: "not a hash" }],
        store.eraseNode(NODE),
      );
      expect(erased.value).toEqual({ documents: [HASH], blobs: [HASH] });
      expect(erased.calls).toEqual(["execute", "execute", "execute"]);
    }),
  );

  it.effect("deleteUnreferencedDocuments and unreferencedBlobs answer the rows' hashes", () =>
    Effect.gen(function* () {
      expect(
        (yield* runWith([{ hash: HASH }], store.deleteUnreferencedDocuments([HASH]))).value,
      ).toEqual([HASH]);
      expect(
        (yield* runWith([{ hash: HASH }], store.unreferencedBlobs([HASH, HASH]))).value,
      ).toEqual([HASH]);
    }),
  );

  it.effect("a malformed id or hash, or no candidate, issues no statement", () =>
    Effect.gen(function* () {
      expect(yield* runWith([], store.eraseNode("nope"))).toEqual({
        value: { documents: [], blobs: [] },
        calls: [],
      });
      expect((yield* runWith([], store.deleteUnreferencedDocuments(["nope"]))).calls).toEqual([]);
      expect((yield* runWith([], store.unreferencedBlobs([]))).calls).toEqual([]);
    }),
  );

  it.effect("fails closed: without documents or blobs it deletes nothing and reports nothing", () =>
    Effect.gen(function* () {
      const bare = makePurgeStore({ CurrentTransaction: database.CurrentTransaction });
      expect(yield* runWith([{ hash: HASH }], bare.eraseNode(NODE))).toEqual({
        value: { documents: [], blobs: [] },
        calls: [],
      });
      expect(yield* runWith([{ hash: HASH }], bare.deleteUnreferencedDocuments([HASH]))).toEqual({
        value: [],
        calls: [],
      });
      expect(yield* runWith([{ hash: HASH }], bare.unreferencedBlobs([HASH]))).toEqual({
        value: [],
        calls: [],
      });
    }),
  );

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

  it.effect("ownedNodes and unredactedNodes decode the ids; a limit below one reads nothing", () =>
    Effect.gen(function* () {
      const owned = yield* runWith(
        [{ id: NODE }],
        store.ownedNodes({ accountId: "a", type: "posts", limit: 5 }),
      );
      expect(owned.value).toEqual([NODE]);
      const query = { accountId: "a", type: "posts", redactedAs: Option.some("r"), limit: 5 };
      expect((yield* runWith([{ id: NODE }], store.unredactedNodes(query))).value).toEqual([NODE]);
      expect(
        yield* runWith([], store.ownedNodes({ accountId: "a", type: "posts", limit: 0 })),
      ).toEqual({ value: [], calls: [] });
      expect(yield* runWith([], store.unredactedNodes({ ...query, limit: 0 }))).toEqual({
        value: [],
        calls: [],
      });
    }),
  );

  it.effect("setOwner upserts for some, deletes for none, and ignores a malformed id", () =>
    Effect.gen(function* () {
      const reassign = yield* runWith(
        [],
        store.setOwner({ type: "posts", id: NODE, ownerId: Option.some("b") }),
      );
      expect(reassign.calls).toEqual(["insert", "values", "onConflictDoUpdate"]);
      const retract = yield* runWith(
        [],
        store.setOwner({ type: "posts", id: NODE, ownerId: Option.none() }),
      );
      expect(retract.calls).toEqual(["delete", "where"]);
      expect(
        (yield* runWith([], store.setOwner({ type: "posts", id: "nope", ownerId: Option.none() })))
          .calls,
      ).toEqual([]);
    }),
  );

  it.effect(
    "over a tree with no proposedBy column, unredactedNodes still reads (the actor arms alone)",
    () =>
      Effect.gen(function* () {
        const plain = makeAccountErasureStore({
          root: plainTables.root,
          owners: makeNodeOwnerTable({ schema, identity: plainTables.root.identity }),
          CurrentTransaction: database.CurrentTransaction,
        });
        const query = { accountId: "a", type: "posts", redactedAs: Option.none(), limit: 5 };
        expect(yield* runWith([{ id: NODE }], plain.unredactedNodes(query))).toEqual({
          value: [NODE],
          calls: ["execute"],
        });
      }),
  );
});
