/**
 * The leaf store's construction, with no database: one store per leaf view,
 * its column set, and the view-merge check that refuses a tree whose leaf
 * view would take one key from two sources (gardeneria's `slug` /
 * `createdAt` trap). The reads and writes run against PostgreSQL in
 * `tests/integration/leaf-store.test.ts`.
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { getTableName } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { always, eq } from "@thomasfosterau/pulpit/filter";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { describe, expect, it } from "vite-plus/test";
import { makeLeafStores, makeNodeOwnerTable, OWNER_COLUMN } from "../src/leaf-store.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, owners, tables, tree, views } from "./fixtures/tree.ts";

const nullableText = (column: string) =>
  dbColumn(Schema.NullOr(Schema.String), { column, pg: "text", notNull: false });

describe("makeLeafStores", () => {
  const stores = makeLeafStores({
    tree,
    tables,
    views,
    owners,
    CurrentTransaction: database.CurrentTransaction,
  });

  it("binds one store per leaf view", () => {
    expect(Arr.sort(R.keys(stores), Str.Order)).toEqual(["links", "notes", "posts"]);
  });

  it("reads the view's columns, the identity extras and the joined owner", () => {
    expect(Arr.sort([...stores.posts.columns], Str.Order)).toEqual(
      Arr.sort(
        [
          "id",
          "version",
          "action",
          "slug",
          "title",
          "visibility",
          "draft",
          "groupId",
          "rank",
          "score",
          "publishedAt",
          "timestamp",
          "createdAt",
          OWNER_COLUMN,
        ],
        Str.Order,
      ),
    );
  });

  it("names the owner table node_owner unless told otherwise", () => {
    expect(getTableName(owners)).toBe("node_owner");
    expect(
      getTableName(
        makeNodeOwnerTable({
          schema: pgSchema("x"),
          identity: tables.root.identity,
          name: "owners",
        }),
      ),
    ).toBe("owners");
  });
});

describe("makeLeafStores — the view-merge trap is refused at module load", () => {
  const schema = pgSchema("trap");
  const builders = {
    text: (column: string) => text(column),
    timestamptz: (column: string) => timestamp(column, { withTimezone: true }),
  };
  /** A store set over `trapTables`' views: what an application's database module builds at load. */
  const storesOver =
    <
      S,
      T extends Parameters<typeof makeLeafStores>[0]["tables"] &
        Parameters<typeof makeTreeViews>[1],
    >(
      trapTree: Parameters<typeof makeTreeViews<S, unknown, T>>[0],
      trapTables: T,
    ) =>
    () =>
      makeLeafStores({
        tree: trapTree,
        tables: trapTables,
        views: makeTreeViews(trapTree, trapTables, { schema }),
        owners: makeNodeOwnerTable({ schema, identity: trapTables.root.identity }),
        CurrentTransaction: database.CurrentTransaction,
      });

  it("an identity extra shadowed by a level column of the same key (slug)", () => {
    const trapTree = defineTree({ page: { leaf: { slug: nullableText("page_slug") } } });
    const trapTables = makeTreeTables(trapTree, {
      schema,
      builders,
      root: { identityColumns: { slug: text("slug") } },
    });
    const make = storesOver(trapTree, trapTables);
    expect(make).toThrow(DerivationError);
    expect(make).toThrow(/"slug" from both the identity table and level "page"/u);
  });

  it("a level column shadowed by the view's birth timestamp (createdAt)", () => {
    const createdAt = dbColumn(Schema.NullOr(Schema.Date), {
      column: "created_on",
      pg: "timestamptz",
      notNull: false,
    });
    const trapTree = defineTree({ page: { leaf: { createdAt } } });
    const make = storesOver(trapTree, makeTreeTables(trapTree, { schema, builders }));
    expect(make).toThrow(/"createdAt" from both the view's own projection and level "page"/u);
  });

  it("a level column shadowed by the joined owner (ownerId)", () => {
    const trapTree = defineTree({ page: { leaf: { ownerId: nullableText("owner") } } });
    const make = storesOver(trapTree, makeTreeTables(trapTree, { schema, builders }));
    expect(make).toThrow(/"ownerId"/u);
  });

  it("builds a tree with no collision", () => {
    const trapTree = defineTree({ page: { leaf: { body: nullableText("body") } } });
    const trapTables = makeTreeTables(trapTree, {
      schema,
      builders,
      root: { identityColumns: { slug: text("slug") } },
    });
    expect(storesOver(trapTree, trapTables)).not.toThrow();
  });
});

describe("makeLeafStores — what a store makes of a query's rows", () => {
  const stores = makeLeafStores({
    tree,
    tables,
    views,
    owners,
    CurrentTransaction: database.CurrentTransaction,
  });
  const ID = "00000000-0000-4000-8000-000000000001";
  const row = { id: ID, version: 2n, action: "update", title: "Hi", ownerId: "u-1" };
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

  it("get and getMany decode the rows; a malformed id reads nothing", async () => {
    expect((await runWith([row], stores.posts.get(ID))).value).toEqual(Option.some(row));
    expect((await runWith([row], stores.posts.get("nope"))).calls).toEqual([]);
    expect((await runWith([row], stores.posts.getMany([ID, ID, "x"]))).value).toEqual([row]);
    expect((await runWith([], stores.posts.getMany(["x"]))).calls).toEqual([]);
  });

  it("list strips the window total off each row and reads it off the first", async () => {
    const { value, calls } = await runWith(
      [{ ...row, pageTotal: 7 }],
      stores.posts.list({
        where: always,
        orderBy: [{ column: "title", direction: "asc" }],
        limit: 1,
        offset: 0,
      }),
    );
    expect(value).toEqual({ rows: [row], total: 7 });
    expect(calls).toEqual(["select", "from", "leftJoin", "where", "orderBy", "limit", "offset"]);
    expect(
      (await runWith([], stores.posts.list({ where: always, orderBy: [], limit: 1, offset: 9 })))
        .value,
    ).toEqual({
      rows: [],
      total: 0,
    });
  });

  it("a row outside the kernel's LeafRow is a defect", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provideService(
        stores.posts.get(ID),
        database.CurrentTransaction,
        cannedTransaction([{ id: ID }]).tx,
      ),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });

  it("distinct reads the values and the distinct count; a non-string column has none", async () => {
    const query = { column: "title", where: eq("action", "update"), limit: 10, offset: 0 } as const;
    expect(
      (
        await runWith(
          [
            { value: "a", total: 2 },
            { value: "b", total: 2 },
          ],
          stores.posts.distinct(query),
        )
      ).value,
    ).toEqual({
      rows: ["a", "b"],
      total: 2,
    });
    expect((await runWith([], stores.posts.distinct(query))).value).toEqual({ rows: [], total: 0 });
    expect((await runWith([], stores.posts.distinct({ ...query, column: "rank" }))).calls).toEqual(
      [],
    );
  });

  it("ownerOf reads the stamp; stampOwner inserts it; listLocalised reads none", async () => {
    expect((await runWith([{ ownerId: "u-1" }], stores.posts.ownerOf(ID))).value).toEqual(
      Option.some("u-1"),
    );
    expect((await runWith([], stores.posts.ownerOf(ID))).value).toEqual(Option.none());
    expect((await runWith([], stores.posts.ownerOf("x"))).calls).toEqual([]);
    expect((await runWith([], stores.posts.stampOwner(ID, "u-1"))).calls).toEqual([
      "insert",
      "values",
    ]);
    expect(
      (
        await runWith(
          [],
          stores.posts.listLocalised({
            where: always,
            orderBy: [],
            limit: 1,
            offset: 0,
            locales: ["en"],
          }),
        )
      ).value,
    ).toEqual({ rows: [], total: 0 });
  });
});
