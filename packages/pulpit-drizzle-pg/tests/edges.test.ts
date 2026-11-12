/**
 * The edge store with no database (a canned transaction): construction
 * refusing a table or end it can't read, what each method asks of the
 * transaction, the decode of a stored edge, and a malformed id or an empty
 * id set reading nothing. The SQL runs against PostgreSQL in
 * `tests/integration/edges.test.ts`.
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { always } from "@thomasfosterau/pulpit/filter";
import { getTableName } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { makeEdgeStore } from "../src/edges.ts";
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
  return Effect.runPromise(
    Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
      value,
      calls,
    })),
  );
};

describe("makeEdgeStore", () => {
  it("names the table and refuses an end or key column the table lacks", () => {
    expect(getTableName(relations)).toBe("relation");
    expect(() =>
      makeEdgeStore({ ...config, ends: { subject: { column: "nope", view: views.leaves.posts } } }),
    ).toThrow(DerivationError);
    expect(() => makeEdgeStore({ ...config, uniqueKey: ["nope"] })).toThrow(/no column "nope"/u);
  });

  it("get decodes the edge; a malformed id reads nothing", async () => {
    expect((await runWith([row], store.get(ID))).value).toEqual(Option.some(row));
    expect(await runWith([row], store.get("x"))).toEqual({ value: Option.none(), calls: [] });
  });

  it("a row outside the kernel's EdgeRow is a defect", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provideService(
        store.get(ID),
        database.CurrentTransaction,
        cannedTransaction([{ ...row, createdAt: "not a date" }]).tx,
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("list pages the decoded edges with the window total", async () => {
    const query = { where: always, limit: 5, offset: 0 };
    expect((await runWith([{ ...row, pageTotal: 3 }], store.list(query))).value).toEqual({
      rows: [row],
      total: 3,
    });
    expect((await runWith([], store.list(query))).value).toEqual({ rows: [], total: 0 });
  });

  it("countAt locks the node, then counts; an unknown column or id counts 0 unread", async () => {
    const counted = await runWith(
      [{ counted: 2 }],
      store.countAt({ column: "subjectId", nodeId: NODE, where: always }),
    );
    expect(counted.value).toBe(2);
    expect(counted.calls[0]).toBe("execute");
    expect(
      await runWith([], store.countAt({ column: "nope", nodeId: NODE, where: always })),
    ).toEqual({ value: 0, calls: [] });
    expect(
      await runWith([], store.countAt({ column: "subjectId", nodeId: "x", where: always })),
    ).toEqual({ value: 0, calls: [] });
  });

  it("existing reads the unique key, none without one; insert writes the table's columns", async () => {
    expect((await runWith([{ id: ID }], store.existing(values))).value).toEqual(Option.some(ID));
    expect(await runWith([{ id: ID }], unkeyed.existing(values))).toEqual({
      value: Option.none(),
      calls: [],
    });
    const inserted = await runWith([{ id: ID }], store.insert(values));
    expect(inserted.value).toEqual(Option.some(ID));
    expect(inserted.calls).toEqual(["insert", "values", "onConflictDoNothing", "returning"]);
    expect((await runWith([], store.insert(values))).value).toEqual(Option.none());
  });

  it("delete and closeValidity answer whether a row changed, refusing a bad id or column", async () => {
    expect((await runWith([{ id: ID }], store.delete(ID))).value).toBe(true);
    expect((await runWith([], store.delete(ID))).value).toBe(false);
    expect((await runWith([{ id: ID }], store.delete("x"))).calls).toEqual([]);
    expect((await runWith([{ id: ID }], store.closeValidity(ID, "validTo", AT))).value).toBe(true);
    expect((await runWith([], store.closeValidity(ID, "validTo", AT))).value).toBe(false);
    expect((await runWith([{ id: ID }], store.closeValidity(ID, "id", AT))).calls).toEqual([]);
    expect((await runWith([{ id: ID }], store.closeValidity(ID, "nope", AT))).calls).toEqual([]);
  });

  it("members builds a subquery and reads nothing", async () => {
    const query = { column: "objectId", otherColumn: "subjectId", ids: [NODE], where: always };
    expect((await runWith([], store.members(query))).calls).toEqual([]);
    expect((await runWith([], store.members({ ...query, ids: [] }))).calls).toEqual([]);
    expect((await runWith([], store.members({ ...query, column: "nope" }))).calls).toEqual([]);
  });

  it("countBy is one grouped read; no id reads nothing", async () => {
    const query = { column: "subjectId", ids: [NODE, NODE], where: always };
    const grouped = await runWith([{ node: NODE, counted: 4 }], store.countBy(query));
    expect(HashMap.toEntries(grouped.value)).toEqual([[NODE, 4]]);
    expect(grouped.calls).toContain("groupBy");
    expect((await runWith([], store.countBy({ ...query, ids: [] }))).calls).toEqual([]);
  });
});
