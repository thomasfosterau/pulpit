/**
 * Edge validity intervals: a family declares `validity`
 * columns, a create checks `from ≤ to`, `maxEdges` counts only the edges
 * valid at the same time, `validAt` lists the edges valid
 * at an instant, and `closeValidity` is the one update an edge takes: it
 * sets only the interval's end, and only narrows it (`EDGE-002`).
 *
 * @module tests/edge-validity
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";
import {
  defineEdgeOps,
  EdgeDeclarationError,
  validAt,
  type EdgeRow,
  type EdgeStore,
  type EdgeValues,
} from "../src/Edges.ts";
import type { Viewer } from "../src/Subtype.ts";
import {
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryNodes,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
      : Option.none();
  });
const day = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(`${iso}T00:00:00Z`));
const validity = { from: "validFrom", to: "validTo" };

/** An office (one holder at a time) and its people, as reference leaves: preferenceflow's office holdings. */
const offices = () => {
  const officeNodes = makeInMemoryNodes(["visibility"]);
  const people = makeInMemoryNodes(["visibility"]);
  officeNodes.put({ id: "o-pm", version: 0n, action: "create", visibility: "public" });
  people.put({ id: "p-1", version: 0n, action: "create", visibility: "public" });
  people.put({ id: "p-2", version: 0n, action: "create", visibility: "public" });
  const ends = {
    office: {
      column: "officeId",
      type: "offices",
      access: { kind: "reference" } as const,
      nodes: officeNodes,
      maxEdges: 1,
    },
    holder: {
      column: "personId",
      type: "people",
      access: { kind: "reference" } as const,
      nodes: people,
    },
  };
  const store = makeInMemoryEdgeStore({ ends, uniqueKey: [], now: NOW });
  let viewer: Viewer = Option.some(moderator);
  const ops = defineEdgeOps({
    type: "holdings",
    ends,
    edges: store,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    values: (input: EdgeValues) => input,
    toResource: (row: EdgeRow) => row,
    validity,
  });
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const hold = (personId: string, from: Option.Option<Date>, to: Option.Option<Date>) =>
    ops.create({
      officeId: "o-pm",
      personId,
      validFrom: Option.getOrNull(from),
      validTo: Option.getOrNull(to),
    });
  return { ops, store, ends, as, hold };
};

describe("edge validity intervals", () => {
  it.effect("counts maxEdges only over the edges valid at the same time", () =>
    Effect.gen(function* () {
      const { hold } = offices();
      yield* hold("p-1", Option.some(day("2010-01-01")), Option.some(day("2013-06-24")));
      // A successor after the first term ends: no overlap, so the office's one slot is free.
      expect((yield* hold("p-2", Option.some(day("2013-06-24")), Option.none())).created).toBe(
        true,
      );
      // An overlapping holding is refused.
      expect(yield* tagOf(hold("p-1", Option.some(day("2015-01-01")), Option.none()))).toEqual(
        Option.some("EdgeCardinalityExceeded"),
      );
      expect(yield* tagOf(hold("p-1", Option.none(), Option.some(day("2010-06-01"))))).toEqual(
        Option.some("EdgeCardinalityExceeded"),
      );
      // Before every holding: free.
      expect(
        (yield* hold("p-1", Option.some(day("2000-01-01")), Option.some(day("2005-01-01"))))
          .created,
      ).toBe(true);
    }),
  );

  it.effect("refuses an interval that starts after it ends, or a bound that is not a date", () =>
    Effect.gen(function* () {
      const { ops, hold } = offices();
      expect(
        yield* tagOf(hold("p-1", Option.some(day("2020-01-01")), Option.some(day("2019-01-01")))),
      ).toEqual(Option.some("InvalidValidity"));
      expect(
        yield* tagOf(
          ops.create({ officeId: "o-pm", personId: "p-1", validFrom: "yesterday", validTo: null }),
        ),
      ).toEqual(Option.some("InvalidValidity"));
    }),
  );

  it.effect("lists the edges valid at an instant through validAt", () =>
    Effect.gen(function* () {
      const { ops, hold } = offices();
      yield* hold("p-1", Option.some(day("2010-01-01")), Option.some(day("2013-06-24")));
      yield* hold("p-2", Option.some(day("2013-06-24")), Option.none());
      const holderAt = (at: Date) =>
        Effect.gen(function* () {
          return (yield* ops.list({ limit: 10, offset: 0, where: validAt(validity, at) })).rows.map(
            (row) => row["personId"],
          );
        });
      expect(yield* holderAt(day("2012-01-01"))).toEqual(["p-1"]);
      expect(yield* holderAt(day("2013-06-24"))).toEqual(["p-2"]);
      expect(yield* holderAt(day("2009-01-01"))).toEqual([]);
    }),
  );

  it.effect("closes an open interval, updating only its end, and frees the slot after it", () =>
    Effect.gen(function* () {
      const { ops, store, hold } = offices();
      const { id } = yield* hold("p-1", Option.some(day("2010-01-01")), Option.none());
      const before = store.rows().find((row) => row.id === id);
      yield* ops.closeValidity(id, day("2013-06-24"));
      const after = store.rows().find((row) => row.id === id);
      expect(after).toEqual({ ...before, validTo: day("2013-06-24") });
      expect((yield* hold("p-2", Option.some(day("2013-06-24")), Option.none())).created).toBe(
        true,
      );
    }),
  );

  it.effect("only narrows: never past a closed end, nor before the start (EDGE-002)", () =>
    Effect.gen(function* () {
      const { ops, hold } = offices();
      const { id } = yield* hold(
        "p-1",
        Option.some(day("2010-01-01")),
        Option.some(day("2013-01-01")),
      );
      expect(yield* tagOf(ops.closeValidity(id, day("2014-01-01")))).toEqual(
        Option.some("InvalidValidity"),
      );
      expect(yield* tagOf(ops.closeValidity(id, day("2009-01-01")))).toEqual(
        Option.some("InvalidValidity"),
      );
      yield* ops.closeValidity(id, day("2012-01-01"));
    }),
  );

  it.effect("gates a close: missing is EdgeNotFound, a refused writer is Forbidden", () =>
    Effect.gen(function* () {
      const { ops, as, hold } = offices();
      const { id } = yield* hold("p-1", Option.some(day("2010-01-01")), Option.none());
      expect(yield* tagOf(ops.closeValidity("nope", day("2011-01-01")))).toEqual(
        Option.some("EdgeNotFound"),
      );
      expect(
        yield* tagOf(as(Option.some(member), ops.closeValidity(id, day("2011-01-01")))),
      ).toEqual(Option.some("Forbidden"));
    }),
  );

  it.effect("refuses a close on a family without an interval", () =>
    Effect.gen(function* () {
      const { ends, store } = offices();
      const plain = defineEdgeOps({
        type: "links",
        ends,
        edges: store,
        viewer: Effect.succeedSome(moderator),
        policy: gardeneriaPolicy,
        followers: makeInMemoryFollowers([]),
        values: (input: EdgeValues) => input,
        toResource: (row: EdgeRow) => row,
      });
      const { id } = yield* plain.create({ officeId: "o-pm", personId: "p-1" });
      expect(yield* tagOf(plain.closeValidity(id, day("2011-01-01")))).toEqual(
        Option.some("InvalidValidity"),
      );
    }),
  );

  it("throws at declaration for one column named twice, or a store without closeValidity", () => {
    const { ends, store } = offices();
    const declare =
      (edges: EdgeStore<EdgeRow, InMemoryFollowing, never, never>, columns = validity) =>
      () =>
        defineEdgeOps({
          type: "links",
          ends,
          edges,
          viewer: Effect.succeedSome(moderator),
          policy: gardeneriaPolicy,
          followers: makeInMemoryFollowers([]),
          values: (input: EdgeValues) => input,
          toResource: (row: EdgeRow) => row,
          validity: columns,
        });
    expect(declare(store, { from: "x", to: "x" })).toThrow(EdgeDeclarationError);
    expect(declare(Struct.omit(store, ["closeValidity"]))).toThrow(/closeValidity/);
  });
});
