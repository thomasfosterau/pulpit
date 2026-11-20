/**
 * The edge store with no database (a canned transaction): construction
 * refusing a table or end it can't read, what each method asks of the
 * transaction, the decode of a stored edge, and a malformed id or an empty
 * id set reading nothing. The SQL runs against PostgreSQL in
 * `tests/integration/edges.test.ts`.
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { always } from "@thomasfosterau/pulpit/Filter";
import { getTableName } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeEdgeStore } from "../src/Edges.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, owners, relations, tables, views } from "./fixtures/tree.ts";

const config = {
  table: relations,
  ends: {
    subject: { column: "subjectId", view: views.leaves.posts },
    object: { column: "objectId", view: views.leaves.posts },
  },
  uniqueKey: ["subjectId", "objectId", "role"],
  identity: tables.root.identity,
  owners,
  CurrentTransaction: database.CurrentTransaction,
};
const store = makeEdgeStore(config);
const unkeyed = makeEdgeStore({ ...config, uniqueKey: [] });

const ID = "00000000-0000-4000-a000-000000000001";
const NODE = "00000000-0000-4000-8000-000000000001";
const AT = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
const row = {
  id: ID,
  createdAt: AT,
  subjectId: NODE,
  objectId: NODE,
  role: null,
  validFrom: null,
  validTo: null,
};
const values = { subjectId: NODE, objectId: NODE, role: "cites", unknown: 1 };

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

describe("makeEdgeStore", () => {
  it("names the table and refuses an end or key column the table lacks", () => {
    expect(getTableName(relations)).toBe("relation");
    expect(() =>
      makeEdgeStore({ ...config, ends: { subject: { column: "nope", view: views.leaves.posts } } }),
    ).toThrow(DerivationError);
    expect(() => makeEdgeStore({ ...config, uniqueKey: ["nope"] })).toThrow(/no column "nope"/u);
  });

  it.effect("get decodes the edge; a malformed id reads nothing", () =>
    Effect.gen(function* () {
      expect((yield* runWith([row], store.get(ID))).value).toEqual(Option.some(row));
      expect(yield* runWith([row], store.get("x"))).toEqual({ value: Option.none(), calls: [] });
    }),
  );

  it.effect("a row outside the kernel's EdgeRow is a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provideService(
          store.get(ID),
          database.CurrentTransaction,
          cannedTransaction([{ ...row, createdAt: "not a date" }]).tx,
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("list pages the decoded edges with the window total", () =>
    Effect.gen(function* () {
      const query = { where: always, limit: 5, offset: 0 };
      expect((yield* runWith([{ ...row, pageTotal: 3 }], store.list(query))).value).toEqual({
        rows: [row],
        total: 3,
      });
      expect((yield* runWith([], store.list(query))).value).toEqual({ rows: [], total: 0 });
    }),
  );

  it.effect("countAt locks the node, then counts; an unknown column or id counts 0 unread", () =>
    Effect.gen(function* () {
      const counted = yield* runWith(
        [{ counted: 2 }],
        store.countAt({ column: "subjectId", nodeId: NODE, where: always }),
      );
      expect(counted.value).toBe(2);
      expect(counted.calls[0]).toBe("execute");
      expect(
        yield* runWith([], store.countAt({ column: "nope", nodeId: NODE, where: always })),
      ).toEqual({ value: 0, calls: [] });
      expect(
        yield* runWith([], store.countAt({ column: "subjectId", nodeId: "x", where: always })),
      ).toEqual({ value: 0, calls: [] });
    }),
  );

  it.effect(
    "existing reads the unique key, none without one; insert writes the table's columns",
    () =>
      Effect.gen(function* () {
        expect((yield* runWith([{ id: ID }], store.existing(values))).value).toEqual(
          Option.some(ID),
        );
        expect(yield* runWith([{ id: ID }], unkeyed.existing(values))).toEqual({
          value: Option.none(),
          calls: [],
        });
        const inserted = yield* runWith([{ id: ID }], store.insert(values));
        expect(inserted.value).toEqual(Option.some(ID));
        expect(inserted.calls).toEqual(["insert", "values", "onConflictDoNothing", "returning"]);
        expect((yield* runWith([], store.insert(values))).value).toEqual(Option.none());
      }),
  );

  it.effect(
    "delete and closeValidity answer whether a row changed, refusing a bad id or column",
    () =>
      Effect.gen(function* () {
        expect((yield* runWith([{ id: ID }], store.delete(ID))).value).toBe(true);
        expect((yield* runWith([], store.delete(ID))).value).toBe(false);
        expect((yield* runWith([{ id: ID }], store.delete("x"))).calls).toEqual([]);
        expect((yield* runWith([{ id: ID }], store.closeValidity(ID, "validTo", AT))).value).toBe(
          true,
        );
        expect((yield* runWith([], store.closeValidity(ID, "validTo", AT))).value).toBe(false);
        expect((yield* runWith([{ id: ID }], store.closeValidity(ID, "id", AT))).calls).toEqual([]);
        expect((yield* runWith([{ id: ID }], store.closeValidity(ID, "nope", AT))).calls).toEqual(
          [],
        );
      }),
  );

  it.effect("members builds a subquery and reads nothing", () =>
    Effect.gen(function* () {
      const query = { column: "objectId", otherColumn: "subjectId", ids: [NODE], where: always };
      expect((yield* runWith([], store.members(query))).calls).toEqual([]);
      expect((yield* runWith([], store.members({ ...query, ids: [] }))).calls).toEqual([]);
      expect((yield* runWith([], store.members({ ...query, column: "nope" }))).calls).toEqual([]);
    }),
  );

  it.effect("countBy is one grouped read; no id reads nothing", () =>
    Effect.gen(function* () {
      const query = { column: "subjectId", ids: [NODE, NODE], where: always };
      const grouped = yield* runWith([{ node: NODE, counted: 4 }], store.countBy(query));
      expect(HashMap.toEntries(grouped.value)).toEqual([[NODE, 4]]);
      expect(grouped.calls).toContain("groupBy");
      expect((yield* runWith([], store.countBy({ ...query, ids: [] }))).calls).toEqual([]);
    }),
  );
});
