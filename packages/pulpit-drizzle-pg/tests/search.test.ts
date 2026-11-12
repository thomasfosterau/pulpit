/**
 * The search branches with no database (a canned transaction): what a
 * branch asks of the transaction for a query, a blank query and a zero
 * limit, and the hits it makes of the rows. The ranked SQL runs against
 * PostgreSQL in `tests/integration/search.test.ts`.
 */

import { always } from "@thomasfosterau/pulpit/filter";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { makePublications } from "../src/publication.ts";
import { fullTextRank, makeSearchBranch } from "../src/search.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, owners, tables, views } from "./fixtures/tree.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const rank = fullTextRank({
  vector: (columns) => sql`to_tsvector('simple', coalesce(${columns["title"]}, ''))`,
});
const branch = makeSearchBranch({
  view: views.leaves.posts,
  owners,
  name: "text",
  weight: 2,
  rank,
  CurrentTransaction: database.CurrentTransaction,
});

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

describe("makeSearchBranch", () => {
  it("carries its name and weight", () => {
    expect({ name: branch.name, weight: branch.weight }).toEqual({ name: "text", weight: 2 });
  });

  it("ranks in one statement and makes hits of the ids, in order", async () => {
    const { value, calls } = await runWith(
      [{ id: ID }, { id: "b" }],
      branch.search({ query: "apple", scope: always, limit: 10 }),
    );
    expect(value).toEqual([{ id: ID }, { id: "b" }]);
    expect(calls).toEqual(["select", "from", "where", "orderBy", "limit"]);
  });

  it.each([
    ["a blank query", "  ", 10],
    ["a zero limit", "apple", 0],
    ["a negative limit", "apple", -3],
  ])("reads nothing for %s", async (_name, query, limit) => {
    const { value, calls } = await runWith(
      [{ id: ID }],
      branch.search({ query, scope: always, limit }),
    );
    expect({ value, calls }).toEqual({ value: [], calls: [] });
  });
});

describe("a gated leaf's searchBranch", () => {
  const gated = makePublications({
    views,
    pointer: "live",
    log: tables.pointers.live,
    live: views.pointers.live.leaves,
    owners,
    CurrentTransaction: database.CurrentTransaction,
  }).posts;

  it("ranks over the chosen rows for its headFor, in one statement", async () => {
    const search = gated.searchBranch({ name: "live text", rank })(always);
    const { value, calls } = await runWith(
      [{ id: ID }],
      search.search({ query: "apple", scope: always, limit: 5 }),
    );
    expect({ name: search.name, value }).toEqual({ name: "live text", value: [{ id: ID }] });
    expect(calls).toEqual(["select", "from", "where", "orderBy", "limit"]);
  });
});
