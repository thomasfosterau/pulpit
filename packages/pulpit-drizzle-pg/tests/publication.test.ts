/**
 * The live pointer's construction and what each seam makes of a query's
 * rows, with no database (a canned transaction). The SQL each builds runs
 * against PostgreSQL in `tests/integration/publication.test.ts`.
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { always, eq } from "@thomasfosterau/pulpit/filter";
import type { PgView } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { describe, expect, it } from "vite-plus/test";
import { makePublications } from "../src/publication.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, owners, tables, views } from "./fixtures/tree.ts";

const publications = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});
const gated = publications.posts;

const ID = "00000000-0000-4000-8000-000000000001";
const AT = DateTime.toDate(DateTime.makeUnsafe("2020-01-01T00:00:00.000Z"));
const row = { id: ID, version: 1n, action: "update", title: "Hi", draft: false, ownerId: "u-1" };
const logRow = { id: ID, version: 1n, at: AT, actor: "u-1", recordedAt: AT };
const fact = {
  id: ID,
  version: Option.some(1n),
  at: AT,
  actorId: Option.some("u-1"),
  recordedAt: AT,
};

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

describe("makePublications", () => {
  it("binds one gated leaf per pointer leaf, with the gated store's columns", () => {
    expect(R.keys(publications)).toEqual(["posts", "notes"]);
    expect(Arr.sort([...gated.leaves.columns], Str.Order)).toContain("draft");
    expect([...gated.leaves.columns]).toContain("publishedAt");
  });

  it("refuses a pointer name its views do not carry, and a leaf with no view", () => {
    const build = (pointer: string, leaves: Readonly<Record<string, PgView>>) => () =>
      makePublications({
        views: { leaves },
        pointer,
        log: tables.pointers.live,
        live: views.pointers.live.leaves,
        owners,
        CurrentTransaction: database.CurrentTransaction,
      });
    expect(build("draft", views.leaves)).toThrow(/no draftAt column/u);
    expect(build("live", R.empty())).toThrow(DerivationError);
  });
});

describe("a localised gated leaf (pulpit#343)", () => {
  const localised = makePublications({
    views,
    pointer: "live",
    log: tables.pointers.live,
    live: views.pointers.live.leaves,
    keyed: { views: views.keyed, live: views.pointers.live.keyed },
    owners,
    CurrentTransaction: database.CurrentTransaction,
  });

  it("reads the keyed rows: the gated store's columns carry the locale level", () => {
    const columns = [...localised.notes.leaves.columns];
    expect(columns).toContain("locale");
    expect(columns).toContain("heading");
    expect(columns).toContain("draft");
    // An unkeyed leaf of the same pointer is unchanged.
    expect([...localised.posts.leaves.columns]).not.toContain("locale");
  });

  it("refuses a leaf keyed on one side only", () => {
    const build =
      (keyed: {
        readonly views: Readonly<Record<string, PgView>>;
        readonly live: Readonly<Record<string, PgView>>;
      }) =>
      () =>
        makePublications({
          views,
          pointer: "live",
          log: tables.pointers.live,
          live: views.pointers.live.leaves,
          keyed,
          owners,
          CurrentTransaction: database.CurrentTransaction,
        });
    expect(build({ views: views.keyed, live: R.empty() })).toThrow(/keyed view on one side only/u);
    expect(build({ views: R.empty(), live: views.pointers.live.keyed })).toThrow(DerivationError);
  });

  it("listLocalised pages the chosen locale rows, and reads none for no locales", async () => {
    const query = {
      headFor: eq("ownerId", "u-1"),
      where: always,
      orderBy: [],
      limit: 5,
      offset: 0,
    };
    const chosen = await runWith(
      [{ ...row, locale: "en", heading: "Hi", pageTotal: 1 }],
      localised.notes.live.listLocalised({ ...query, locales: ["en", "fr"] }),
    );
    expect(chosen.value.total).toBe(1);
    expect(chosen.calls).toContain("select");
    const none = await runWith(
      [row],
      localised.notes.live.listLocalised({ ...query, locales: [] }),
    );
    expect(none).toEqual({ value: { rows: [], total: 0 }, calls: [] });
    const list = await runWith(
      [{ ...row, locale: "fr", heading: "Salut", pageTotal: 1 }],
      localised.notes.live.list(query),
    );
    expect(list.value.rows).toHaveLength(1);
  });
});

describe("the publication log over canned rows", () => {
  it("reads facts as the kernel's PublicationFact", async () => {
    expect((await runWith([logRow], gated.facts.effective(ID))).value).toEqual(Option.some(fact));
    expect((await runWith([], gated.facts.effective(ID))).value).toEqual(Option.none());
    expect((await runWith([logRow], gated.facts.facts(ID, 10))).value).toEqual([fact]);
    expect(
      (await runWith([{ ...logRow, version: null, actor: null }], gated.facts.facts(ID, 10))).value,
    ).toEqual([{ ...fact, version: Option.none(), actorId: Option.none() }]);
    expect((await runWith([logRow], gated.facts.scheduled([ID, ID, "x"]))).value).toEqual([fact]);
  });

  it("an id that is no UUID reads nothing; record inserts", async () => {
    expect((await runWith([logRow], gated.facts.effective("x"))).calls).toEqual([]);
    expect((await runWith([logRow], gated.facts.facts("x", 10))).calls).toEqual([]);
    expect((await runWith([logRow], gated.facts.scheduled(["x"]))).calls).toEqual([]);
    expect((await runWith([], gated.facts.record(fact))).calls).toEqual(["insert", "values"]);
  });
});

describe("the live view over canned rows", () => {
  it("get / getMany read live rows; a malformed id reads nothing", async () => {
    expect((await runWith([row], gated.live.get(ID))).value).toEqual(Option.some(row));
    expect((await runWith([row], gated.live.get("x"))).calls).toEqual([]);
    expect((await runWith([row], gated.live.getMany([ID, "x"]))).value).toEqual([row]);
    expect((await runWith([row], gated.live.getMany(["x"]))).value).toEqual([]);
  });

  it("list and distinct read the chosen rows; listLocalised reads none", async () => {
    const query = {
      headFor: eq("ownerId", "u-1"),
      where: always,
      orderBy: [],
      limit: 5,
      offset: 0,
    };
    expect((await runWith([{ ...row, pageTotal: 3 }], gated.live.list(query))).value).toEqual({
      rows: [row],
      total: 3,
    });
    expect(
      (
        await runWith(
          [{ value: "Hi", total: 1 }],
          gated.live.distinct({ ...query, column: "title" }),
        )
      ).value,
    ).toEqual({ rows: ["Hi"], total: 1 });
    expect(
      (await runWith([], gated.live.listLocalised({ ...query, locales: ["en"] }))).value,
    ).toEqual({ rows: [], total: 0 });
  });
});
