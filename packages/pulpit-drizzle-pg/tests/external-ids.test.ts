/**
 * The external-identifier store with no database (a canned transaction):
 * the decode of a stored link, what `link` reads after an insert that wrote
 * nothing, and an empty or oversized lookup reading nothing. The SQL runs
 * against PostgreSQL in `tests/integration/external-ids.test.ts`.
 */

import { MAX_SET_VALUES } from "@thomasfosterau/pulpit/Filter";
import { getTableName } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeExternalIdStore } from "../src/ExternalIds.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, externalIds } from "./fixtures/tree.ts";

const store = makeExternalIdStore({
  table: externalIds,
  CurrentTransaction: database.CurrentTransaction,
});
const NODE = "00000000-0000-4000-8000-000000000001";

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

describe("makeExternalIdStore over canned rows", () => {
  it("the table is named external_id by default", () => {
    expect(getTableName(externalIds)).toBe("external_id");
  });

  it.effect("lookup decodes each link, its NULL baseline as none", () =>
    Effect.gen(function* () {
      const stored = { authority: "wikidata", externalId: "Q1", nodeId: NODE, baseline: null };
      const { value } = yield* runWith([stored], store.lookup("wikidata", ["Q1", "Q1"]));
      expect(HashMap.toEntries(value)).toEqual([["Q1", { ...stored, baseline: Option.none() }]]);
      const withBaseline = yield* runWith(
        [{ ...stored, baseline: { title: "x" } }],
        store.lookup("wikidata", ["Q1"]),
      );
      expect(Option.flatMap(HashMap.get(withBaseline.value, "Q1"), (l) => l.baseline)).toEqual(
        Option.some({ title: "x" }),
      );
    }),
  );

  it.effect("an empty or oversized lookup reads nothing", () =>
    Effect.gen(function* () {
      expect((yield* runWith([], store.lookup("wikidata", []))).calls).toEqual([]);
      const many = Arr.map(Arr.range(0, MAX_SET_VALUES), (n) => `Q${String(n)}`);
      expect((yield* runWith([], store.lookup("wikidata", many))).calls).toEqual([]);
    }),
  );

  it.effect(
    "link answers linked off the insert, and taken when nothing was written or stored",
    () =>
      Effect.gen(function* () {
        expect(
          (yield* runWith([{ authority: "wikidata" }], store.link("wikidata", "Q1", NODE))).value,
        ).toBe("linked");
        // The canned rows answer the insert and the read alike, so an empty set is the
        // insert writing nothing and no stored link naming the node: "taken". The
        // "present" branch needs both answers at once, so it is checked in integration.
        const nothing = cannedTransaction([]);
        expect(
          yield* Effect.provideService(
            store.link("wikidata", "Q1", NODE),
            database.CurrentTransaction,
            nothing.tx,
          ),
        ).toBe("taken");
      }),
  );

  it.effect("recordBaseline updates the link; a baseline holding no JSON is a defect", () =>
    Effect.gen(function* () {
      expect(
        (yield* runWith([], store.recordBaseline("wikidata", "Q1", { title: "x" }))).calls,
      ).toEqual(["update", "set", "where"]);
      const exit = yield* Effect.exit(
        Effect.provideService(
          store.recordBaseline("wikidata", "Q1", { at: 1n }),
          database.CurrentTransaction,
          cannedTransaction([]).tx,
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
