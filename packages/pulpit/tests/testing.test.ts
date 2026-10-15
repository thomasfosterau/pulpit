/**
 * The `./testing` fakes' own behaviour, where the operation suites don't
 * reach it: the follower table, the owner-stamp hooks, and the Effect `Clock`
 * a store reads when it is given no fixed `now`. The seams' contracts are
 * exercised through the operations in the other suites.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as TestClock from "effect/testing/TestClock";
import { published } from "../src/filter.ts";
import { defineVersionChain } from "../src/version-chain.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryNodes,
} from "../src/testing.ts";
import { NOW } from "./fixtures.ts";

const at = (millis: number) => DateTime.toDate(DateTime.makeUnsafe(millis));

// oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary the rule asks for
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Run `effect` with the `TestClock` set to `millis`. */
const runAt = <A, E>(millis: number, effect: Effect.Effect<A, E>) =>
  run(Effect.andThen(TestClock.setTime(millis), effect).pipe(Effect.provide(TestClock.layer())));

describe("makeInMemoryFollowers", () => {
  const seam = makeInMemoryFollowers([["u-fan", ["u-a", "u-b"]]]);

  it("answers isFollower from the table", async () => {
    expect(await run(seam.isFollower("u-fan", "u-a"))).toBe(true);
    expect(await run(seam.isFollower("u-fan", "u-c"))).toBe(false);
    expect(await run(seam.isFollower("u-a", "u-fan"))).toBe(false);
  });

  it("returns the follower's row as the in set, empty for an account the table doesn't name", () => {
    expect(Arr.sort(seam.following("u-fan"), Order.String)).toEqual(["u-a", "u-b"]);
    expect(HashSet.size(seam.following("u-nobody"))).toBe(0);
  });
});

describe("makeInMemoryLeafStore", () => {
  it("merges the owner stamp into the view, and dropOwner removes it", async () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
    const { id } = await run(
      defineVersionChain("notes", chain).create({
        id: Option.none(),
        state: { title: "A" },
        actorId: Option.none(),
      }),
    );
    await run(leaves.stampOwner(id, "u-owner"));
    expect(HashMap.get(leaves.owners(), id)).toEqual(Option.some("u-owner"));
    expect(Option.map(await run(leaves.get(id)), (row) => row["ownerId"])).toEqual(
      Option.some("u-owner"),
    );
    leaves.dropOwner(id);
    expect(await run(leaves.ownerOf(id))).toEqual(Option.none());
    expect(Option.map(await run(leaves.get(id)), (row) => "ownerId" in row)).toEqual(
      Option.some(false),
    );
  });

  it("without a fixed now, reads published against the Effect Clock at each list", async () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["publishedAt"] });
    const stamp = NOW.getTime();
    await run(
      defineVersionChain("notes", chain).create({
        id: Option.none(),
        state: { publishedAt: at(stamp) },
        actorId: Option.none(),
      }),
    );
    const listed = (millis: number) =>
      runAt(
        millis,
        Effect.map(
          leaves.list({ where: published("publishedAt"), limit: 10, offset: 0 }),
          (page) => page.total,
        ),
      );
    expect(await listed(stamp - 1)).toBe(0);
    expect(await listed(stamp)).toBe(1);
  });
});

describe("makeInMemoryEdgeStore", () => {
  it("without a fixed now, stamps createdAt from the Effect Clock", async () => {
    const nodes = makeInMemoryNodes([]);
    const edges = makeInMemoryEdgeStore({
      ends: {
        from: { column: "fromId", type: "nodes", access: { kind: "reference" }, nodes },
      },
      uniqueKey: [],
    });
    const stamp = NOW.getTime();
    await runAt(stamp, edges.insert({ fromId: "n-1" }));
    expect(edges.rows().map((row) => row.createdAt.getTime())).toEqual([stamp + 1]);
  });

  it("stamps every third insert at its predecessor's instant, so the list's id tie-break decides", async () => {
    const nodes = makeInMemoryNodes([]);
    const edges = makeInMemoryEdgeStore({
      ends: {
        from: { column: "fromId", type: "nodes", access: { kind: "reference" }, nodes },
      },
      uniqueKey: [],
      now: NOW,
    });
    nodes.put({ id: "n-1", action: "create" });
    // Sequential: each insert mints the next id and instant.
    await run(
      Effect.forEach(Arr.range(1, 6), () => edges.insert({ fromId: "n-1" }), { concurrency: 1 }),
    );
    const stamp = NOW.getTime();
    expect(edges.rows().map((row) => row.createdAt.getTime() - stamp)).toEqual([1, 2, 2, 4, 5, 5]);
    const { rows } = await run(edges.list({ where: { kind: "always" }, limit: 10, offset: 0 }));
    expect(rows.map((row) => row.id)).toEqual([
      "edge-0001",
      "edge-0002",
      "edge-0003",
      "edge-0004",
      "edge-0005",
      "edge-0006",
    ]);
  });
});
