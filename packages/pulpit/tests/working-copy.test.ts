/**
 * The working copy: an autosave buffer outside the chain.
 *
 * - Saving writes no version, and merges tri-state over the editor's copy.
 * - One copy per (node, editor).
 * - `commit` appends one `update` expecting the copy's base, and clears it;
 *   an edit landing in between fails `StaleVersion` and keeps the copy.
 * - Every operation runs the leaf's write gate.
 *
 * @module tests/working-copy
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/Subtype.ts";
import { defineWorkingCopy } from "../src/WorkingCopy.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryWorkingCopyStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

const setup = () =>
  Effect.gen(function* () {
    const chain = makeInMemoryVersionChain("posts");
    const leaves = makeInMemoryLeafStore(chain, {
      columns: ["title", "body", "visibility"],
      now: NOW,
    });
    let viewer: Viewer = Option.some(member);
    const leaf = defineSubtype({
      type: "posts",
      access: ownedAccess(),
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
    });
    const store = makeInMemoryWorkingCopyStore();
    const copies = defineWorkingCopy({ leaf, chain, store });
    const { id } = yield* leaf.create({
      id: Option.none(),
      state: { title: "t", body: "b", visibility: "public" },
    });
    const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    return { chain, leaf, store, copies, id, actAs };
  });

describe("defineWorkingCopy", () => {
  it.effect("saving writes no version and merges over the editor's copy", () =>
    Effect.gen(function* () {
      const { chain, copies, id, store } = yield* setup();
      yield* copies.save(id, { title: "draft 1" });
      const copy = yield* copies.save(id, { body: "draft body", title: undefined });
      expect(copy.patch).toEqual({ title: "draft 1", body: "draft body" });
      expect(copy.baseVersion).toBe(0n);
      expect(chain.rows()).toHaveLength(1);
      expect(HashMap.size(store.copies())).toBe(1);
    }),
  );

  it.effect("keeps one copy per editor", () =>
    Effect.gen(function* () {
      const { copies, id, actAs, store } = yield* setup();
      yield* copies.save(id, { title: "mine" });
      yield* actAs(Option.some(moderator), copies.save(id, { title: "theirs" }));
      expect(HashMap.size(store.copies())).toBe(2);
      expect(
        Option.map(yield* actAs(Option.some(member), copies.get(id)), (copy) => copy.patch),
      ).toEqual(Option.some({ title: "mine" }));
    }),
  );

  it.effect("commit appends one update expecting the base, and clears the copy", () =>
    Effect.gen(function* () {
      const { chain, copies, id } = yield* setup();
      yield* copies.save(id, { title: "a" });
      yield* copies.save(id, { title: "b" });
      expect(yield* copies.commit(id)).toEqual({ id, version: 1n });
      expect(chain.rows().map((row) => row.state["title"])).toEqual(["t", "b"]);
      expect(yield* copies.get(id)).toEqual(Option.none());
      expect(yield* tagOf(copies.commit(id))).toEqual(Option.some("WorkingCopyNotFound"));
    }),
  );

  it.effect("an edit landing after the copy's base fails the commit and keeps the copy", () =>
    Effect.gen(function* () {
      const { leaf, copies, id } = yield* setup();
      yield* copies.save(id, { title: "mine" });
      yield* leaf.update({ id, patch: { body: "someone else" } });
      expect(yield* tagOf(copies.commit(id))).toEqual(Option.some("StaleVersion"));
      expect(Option.isSome(yield* copies.get(id))).toBe(true);
    }),
  );

  it.effect("every operation is gated like a write", () =>
    Effect.gen(function* () {
      const { copies, id, actAs, leaf } = yield* setup();
      const operations = [
        copies.save(id, { title: "x" }),
        copies.get(id),
        copies.discard(id),
        copies.commit(id),
      ];
      const refusals = yield* Effect.forEach(
        operations,
        (operation) =>
          Effect.forEach(
            [actAs(Option.some(otherMember), operation), actAs(Option.none(), operation)],
            (refused) => Effect.map(Effect.flip(refused), (error) => error._tag),
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      );
      expect(refusals).toEqual(operations.map(() => ["Forbidden", "Unauthorized"]));
      yield* actAs(Option.some(member), leaf.delete(id));
      expect(yield* tagOf(actAs(Option.some(member), copies.save(id, { title: "x" })))).toEqual(
        Option.some("NodeNotFound"),
      );
    }),
  );

  it.effect("discard throws the copy away", () =>
    Effect.gen(function* () {
      const { copies, id } = yield* setup();
      yield* copies.save(id, { title: "x" });
      yield* copies.discard(id);
      expect(yield* copies.get(id)).toEqual(Option.none());
    }),
  );
});
