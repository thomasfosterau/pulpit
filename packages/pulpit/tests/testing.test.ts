/**
 * The `./testing` fakes' own behaviour, where the operation suites don't
 * reach it: the follower table, the owner-stamp hooks, and the Effect `Clock`
 * a store reads when it is given no fixed `now`. The seams' contracts are
 * exercised through the operations in the other suites.
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as TestClock from "effect/testing/TestClock";
import { isNull, notPublished, or, published } from "../src/Filter.ts";
import { defineVersionChain } from "../src/VersionChain.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryNodes,
} from "../src/testing.ts";
import { NOW } from "./fixtures.ts";

const at = (millis: number) => DateTime.toDate(DateTime.makeUnsafe(millis));

/** Run `effect` with the `TestClock` set to `millis`. */
const runAt = <A, E>(millis: number, effect: Effect.Effect<A, E>) =>
  Effect.andThen(TestClock.setTime(millis), effect);

describe("makeInMemoryFollowers", () => {
  const seam = makeInMemoryFollowers([["u-fan", ["u-a", "u-b"]]]);

  it.effect("answers isFollower from the table", () =>
    Effect.gen(function* () {
      expect(yield* seam.isFollower("u-fan", "u-a")).toBe(true);
      expect(yield* seam.isFollower("u-fan", "u-c")).toBe(false);
      expect(yield* seam.isFollower("u-a", "u-fan")).toBe(false);
    }),
  );

  it("returns the follower's row as the in set, empty for an account the table doesn't name", () => {
    expect(Arr.sort(seam.following("u-fan"), Order.String)).toEqual(["u-a", "u-b"]);
    expect(HashSet.size(seam.following("u-nobody"))).toBe(0);
  });
});

describe("makeInMemoryLeafStore", () => {
  it.effect("merges the owner stamp into the view, and dropOwner removes it", () =>
    Effect.gen(function* () {
      const chain = makeInMemoryVersionChain("notes");
      const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
      const { id } = yield* defineVersionChain("notes", chain).create({
        id: Option.none(),
        state: { title: "A" },
        actorId: Option.none(),
      });
      yield* leaves.stampOwner(id, "u-owner");
      expect(HashMap.get(leaves.owners(), id)).toEqual(Option.some("u-owner"));
      expect(Option.map(yield* leaves.get(id), (row) => row["ownerId"])).toEqual(
        Option.some("u-owner"),
      );
      leaves.dropOwner(id);
      expect(yield* leaves.ownerOf(id)).toEqual(Option.none());
      expect(Option.map(yield* leaves.get(id), (row) => "ownerId" in row)).toEqual(
        Option.some(false),
      );
    }),
  );

  it.effect("without a fixed now, reads published against the Effect Clock at each list", () =>
    Effect.gen(function* () {
      const chain = makeInMemoryVersionChain("notes");
      const leaves = makeInMemoryLeafStore(chain, { columns: ["publishedAt"] });
      const stamp = NOW.getTime();
      yield* defineVersionChain("notes", chain).create({
        id: Option.none(),
        state: { publishedAt: at(stamp) },
        actorId: Option.none(),
      });
      const listed = (millis: number) =>
        runAt(
          millis,
          Effect.map(
            leaves.list({ where: published("publishedAt"), orderBy: [], limit: 10, offset: 0 }),
            (page) => page.total,
          ),
        );
      expect(yield* listed(stamp - 1)).toBe(0);
      expect(yield* listed(stamp)).toBe(1);
    }),
  );

  it.effect(
    "reads a node over a column the view lacks as never, as the SQL renderer does, even where a NULL would satisfy it",
    () =>
      Effect.gen(function* () {
        const chain = makeInMemoryVersionChain("notes");
        const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
        // `extra` is in the state but not the view; `missing` is in neither.
        yield* defineVersionChain("notes", chain).create({
          id: Option.none(),
          state: { title: null, extra: null },
          actorId: Option.none(),
        });
        const total = (where: Parameters<typeof leaves.list>[0]["where"]) =>
          Effect.map(
            leaves.list({ where, orderBy: [], limit: 10, offset: 0 }),
            (page) => page.total,
          );
        expect(yield* total(isNull("title"))).toBe(1);
        expect(yield* total(isNull("missing"))).toBe(0);
        expect(yield* total(isNull("extra"))).toBe(0);
        expect(yield* total(notPublished("missing"))).toBe(0);
        expect(yield* total(or(isNull("missing"), isNull("title")))).toBe(1);
        expect(
          (yield* leaves.distinct({
            column: "title",
            where: isNull("missing"),
            limit: 10,
            offset: 0,
          })).total,
        ).toBe(0);
      }),
  );
});

describe("makeInMemoryEdgeStore", () => {
  it.effect("without a fixed now, stamps createdAt from the Effect Clock", () =>
    Effect.gen(function* () {
      const nodes = makeInMemoryNodes([]);
      const edges = makeInMemoryEdgeStore({
        ends: {
          from: { column: "fromId", type: "nodes", access: { kind: "reference" }, nodes },
        },
        uniqueKey: [],
      });
      const stamp = NOW.getTime();
      yield* runAt(stamp, edges.insert({ fromId: "n-1" }));
      expect(edges.rows().map((row) => row.createdAt.getTime())).toEqual([stamp + 1]);
    }),
  );

  it.effect(
    "stamps every third insert at its predecessor's instant, so the list's id tie-break decides",
    () =>
      Effect.gen(function* () {
        const nodes = makeInMemoryNodes([]);
        const edges = makeInMemoryEdgeStore({
          ends: {
            from: { column: "fromId", type: "nodes", access: { kind: "reference" }, nodes },
          },
          uniqueKey: [],
          now: NOW,
        });
        nodes.put({ id: "n-1", version: 0n, action: "create" });
        // Sequential: each insert mints the next id and instant.
        yield* Effect.forEach(Arr.range(1, 6), () => edges.insert({ fromId: "n-1" }), {
          concurrency: 1,
        });
        const stamp = NOW.getTime();
        expect(edges.rows().map((row) => row.createdAt.getTime() - stamp)).toEqual([
          1, 2, 2, 4, 5, 5,
        ]);
        const { rows } = yield* edges.list({ where: { kind: "always" }, limit: 10, offset: 0 });
        expect(rows.map((row) => row.id)).toEqual([
          "edge-0001",
          "edge-0002",
          "edge-0003",
          "edge-0004",
          "edge-0005",
          "edge-0006",
        ]);
      }),
  );
});
