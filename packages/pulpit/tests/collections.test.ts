/**
 * Ordered collections: both models over one store seam (the
 * order beside the chain, the default, and the order versioned with the
 * parent), the parent's read gate on a read and its write gate on a write,
 * and a member the viewer can't read omitted from the page and its total.
 *
 * @module tests/collections
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import {
  defineCollection,
  hideRecordedOrder,
  MAX_COLLECTION_SIZE,
  type CollectionMode,
} from "../src/Collections.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryCollectionStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
      : Option.none();
  });

const setup = (versioned = false) => {
  let viewer: Viewer = Option.some(member);
  const viewerOf = Effect.sync(() => viewer);
  const leaf = (type: string, columns: ReadonlyArray<string>) => {
    const chain = makeInMemoryVersionChain("list-items");
    const ops = defineSubtype({
      type,
      access: ownedAccess(),
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns, now: NOW }),
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: hideRecordedOrder("memberOrder", (row: LeafRow) => row),
    });
    return { chain, ops };
  };
  const lists = leaf("lists", ["visibility", "memberOrder"]);
  const items = leaf("items", ["visibility"]);
  const store = makeInMemoryCollectionStore();
  const mode: CollectionMode<never, never> = versioned
    ? { kind: "versioned", column: "memberOrder", chain: lists.chain }
    : { kind: "mutable" };
  const collection = defineCollection({
    type: "list-items",
    parent: lists.ops,
    members: items.ops,
    store,
    mode,
  });
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const create = (ops: typeof lists.ops, visibility: string) =>
    Effect.map(
      as(Option.some(member), ops.create({ id: Option.none(), state: { visibility } })),
      ({ id }) => id,
    );
  const order = (parentId: string, who: Viewer = Option.some(member)) =>
    Effect.gen(function* () {
      return (yield* as(who, collection.list(parentId, { limit: 100, offset: 0 }))).rows.map(
        (row) => row.memberId,
      );
    });
  return { lists, items, store, collection, as, create, order };
};

describe("defineCollection — mutable order (the default)", () => {
  it.effect("appends, moves and removes members in order, beside the chain", () =>
    Effect.gen(function* () {
      const { lists, items, collection, as, create, order } = setup();
      const list = yield* create(lists.ops, "public");
      const [a, b, c] = yield* Effect.all(
        [create(items.ops, "public"), create(items.ops, "public"), create(items.ops, "public")],
        { concurrency: "unbounded" },
      );
      const me = Option.some(member);
      yield* as(me, collection.append(list, a ?? ""));
      yield* as(me, collection.append(list, b ?? ""));
      yield* as(me, collection.append(list, c ?? ""));
      expect(yield* order(list)).toEqual([a, b, c]);
      yield* as(me, collection.move(list, c ?? "", 0));
      expect(yield* order(list)).toEqual([c, a, b]);
      yield* as(me, collection.move(list, c ?? "", 99));
      expect(yield* order(list)).toEqual([a, b, c]);
      yield* as(me, collection.remove(list, b ?? ""));
      expect(yield* order(list)).toEqual([a, c]);
      // The parent's chain never moved: the order lives beside it.
      expect(lists.chain.rows().filter((row) => row.id === list)).toHaveLength(1);
    }),
  );

  it.effect("refuses a duplicate, a missing member, and a member the writer can't read", () =>
    Effect.gen(function* () {
      const { lists, items, collection, as, create } = setup();
      const list = yield* create(lists.ops, "public");
      const a = yield* create(items.ops, "public");
      const me = Option.some(member);
      yield* as(me, collection.append(list, a));
      expect(yield* tagOf(as(me, collection.append(list, a)))).toEqual(
        Option.some("AlreadyMember"),
      );
      expect(yield* tagOf(as(me, collection.move(list, "nope", 0)))).toEqual(
        Option.some("NotMember"),
      );
      expect(yield* tagOf(as(me, collection.remove(list, "nope")))).toEqual(
        Option.some("NotMember"),
      );
      expect(yield* tagOf(as(me, collection.append(list, "missing")))).toEqual(
        Option.some("NodeNotFound"),
      );
    }),
  );

  it.effect("gates a write on the parent's write gate", () =>
    Effect.gen(function* () {
      const { lists, items, collection, as, create } = setup();
      const list = yield* create(lists.ops, "public");
      const a = yield* create(items.ops, "public");
      expect(yield* tagOf(as(Option.some(otherMember), collection.append(list, a)))).toEqual(
        Option.some("Forbidden"),
      );
      expect(yield* tagOf(as(Option.none(), collection.append(list, a)))).toEqual(
        Option.some("Unauthorized"),
      );
    }),
  );

  it.effect(
    "reads through the parent's gate, and omits a hidden member from the page and its total",
    () =>
      Effect.gen(function* () {
        const { lists, items, collection, as, create, order } = setup();
        const open = yield* create(lists.ops, "public");
        const hiddenList = yield* create(lists.ops, "private");
        const shown = yield* create(items.ops, "public");
        const hiddenItem = yield* create(items.ops, "private");
        const me = Option.some(member);
        yield* as(me, collection.append(open, shown));
        yield* as(me, collection.append(open, hiddenItem));
        const stranger = Option.some(otherMember);
        expect(yield* order(open, stranger)).toEqual([shown]);
        const page = yield* as(stranger, collection.list(open, { limit: 10, offset: 0 }));
        expect(page.total).toBe(1);
        expect(
          yield* tagOf(as(stranger, collection.list(hiddenList, { limit: 10, offset: 0 }))),
        ).toEqual(Option.some("NodeNotFound"));
        // The owner reads both, with indexes in order.
        const owned = yield* as(me, collection.list(open, { limit: 1, offset: 1 }));
        expect([owned.total, owned.rows.map((row) => [row.memberId, row.index])]).toEqual([
          2,
          [[hiddenItem, 1]],
        ]);
      }),
  );

  it.effect("refuses a member past MAX_COLLECTION_SIZE", () =>
    Effect.gen(function* () {
      const { lists, items, store, collection, as, create } = setup();
      const list = yield* create(lists.ops, "public");
      const a = yield* create(items.ops, "public");
      yield* store.replace(
        list,
        Array.from({ length: MAX_COLLECTION_SIZE }, (_, position) => ({
          memberId: `m-${position}`,
          position,
        })),
      );
      expect(yield* tagOf(as(Option.some(member), collection.append(list, a)))).toEqual(
        Option.some("CollectionFull"),
      );
    }),
  );
});

describe("defineCollection — order versioned with the parent", () => {
  it.effect("records each change as a parent version, and resyncs the store after a restore", () =>
    Effect.gen(function* () {
      const { lists, items, collection, as, create, order } = setup(true);
      const list = yield* create(lists.ops, "public");
      const a = yield* create(items.ops, "public");
      const b = yield* create(items.ops, "public");
      const me = Option.some(member);
      yield* as(me, collection.append(list, a));
      yield* as(me, collection.append(list, b));
      yield* as(me, collection.move(list, b, 0));
      const versions = lists.chain.rows().filter((row) => row.id === list);
      expect(versions.map((row) => row.version)).toEqual([0n, 1n, 2n, 3n]);
      expect(yield* order(list)).toEqual([b, a]);
      // Restore the version recording [a, b], then resync the store from it.
      yield* as(me, lists.ops.restoreVersion(list, 2n));
      expect(yield* order(list)).toEqual([b, a]);
      yield* as(me, collection.resync(list));
      expect(yield* order(list)).toEqual([a, b]);
    }),
  );

  it.effect("resync adopts only members the writer can read (gate parity with append)", () =>
    Effect.gen(function* () {
      const { lists, items, store, collection, as, create } = setup(true);
      const me = Option.some(member);
      const list = yield* create(lists.ops, "public");
      const a = yield* create(items.ops, "public");
      // Another account's private item, which the list's owner can't read.
      const secret = yield* Effect.map(
        as(
          Option.some(otherMember),
          items.ops.create({ id: Option.none(), state: { visibility: "private" } }),
        ),
        ({ id }) => id,
      );
      // Planted through the parent's own generic update of the order column.
      yield* as(me, lists.ops.update({ id: list, patch: { memberOrder: [a, secret] } }));
      yield* as(me, collection.resync(list));
      expect(
        Option.map(HashMap.get(store.rows(), list), (entries) =>
          entries.map((entry) => entry.memberId),
        ),
      ).toEqual(Option.some([a]));
    }),
  );

  it.effect("keeps the recorded order out of the parent's resource (EDGE-001)", () =>
    Effect.gen(function* () {
      const { lists, items, collection, as, create } = setup(true);
      const me = Option.some(member);
      const list = yield* create(lists.ops, "public");
      const mine = yield* create(items.ops, "private");
      yield* as(me, collection.append(list, mine));
      // The chain records the order, so resync can read it back...
      const head = lists.chain.rows().findLast((row) => row.id === list);
      expect(head?.state["memberOrder"]).toEqual([mine]);
      // ...but another reader of the public list never sees the private member's id.
      const seen = yield* as(Option.some(otherMember), lists.ops.get(list));
      expect(seen["memberOrder"]).toBeUndefined();
      expect(
        yield* as(Option.some(otherMember), collection.list(list, { limit: 10, offset: 0 })),
      ).toMatchObject({ rows: [], total: 0 });
    }),
  );

  it.effect(
    "gates resync on the parent's write gate, and leaves a mutable family's store alone",
    () =>
      Effect.gen(function* () {
        const versioned = setup(true);
        const list = yield* versioned.create(versioned.lists.ops, "public");
        expect(
          yield* tagOf(versioned.as(Option.some(otherMember), versioned.collection.resync(list))),
        ).toEqual(Option.some("Forbidden"));
        const mutable = setup();
        const other = yield* mutable.create(mutable.lists.ops, "public");
        const a = yield* mutable.create(mutable.items.ops, "public");
        yield* mutable.as(Option.some(member), mutable.collection.append(other, a));
        yield* mutable.as(Option.some(member), mutable.collection.resync(other));
        expect(yield* mutable.order(other)).toEqual([a]);
      }),
  );
});
