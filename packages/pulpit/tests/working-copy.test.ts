/**
 * The working copy (pulpit#46): an autosave buffer outside the chain.
 *
 * - Saving writes no version, and merges tri-state over the editor's copy.
 * - One copy per (node, editor).
 * - `commit` appends one `update` expecting the copy's base, and clears it;
 *   an edit landing in between fails `StaleVersion` and keeps the copy.
 * - Every operation runs the leaf's write gate.
 *
 * @module tests/working-copy
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/subtype.ts";
import { defineWorkingCopy } from "../src/working-copy.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryWorkingCopyStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

const setup = async () => {
  const chain = makeInMemoryChainStore();
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
  const { id } = await run(
    leaf.create({ id: Option.none(), state: { title: "t", body: "b", visibility: "public" } }),
  );
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  return { chain, leaf, store, copies, id, actAs };
};

describe("defineWorkingCopy", () => {
  it("saving writes no version and merges over the editor's copy", async () => {
    const { chain, copies, id, store } = await setup();
    await run(copies.save(id, { title: "draft 1" }));
    const copy = await run(copies.save(id, { body: "draft body", title: undefined }));
    expect(copy.patch).toEqual({ title: "draft 1", body: "draft body" });
    expect(copy.baseVersion).toBe(0n);
    expect(chain.rows()).toHaveLength(1);
    expect(HashMap.size(store.copies())).toBe(1);
  });

  it("keeps one copy per editor", async () => {
    const { copies, id, actAs, store } = await setup();
    await run(copies.save(id, { title: "mine" }));
    await run(actAs(Option.some(moderator), copies.save(id, { title: "theirs" })));
    expect(HashMap.size(store.copies())).toBe(2);
    expect(
      Option.map(await run(actAs(Option.some(member), copies.get(id))), (copy) => copy.patch),
    ).toEqual(Option.some({ title: "mine" }));
  });

  it("commit appends one update expecting the base, and clears the copy", async () => {
    const { chain, copies, id } = await setup();
    await run(copies.save(id, { title: "a" }));
    await run(copies.save(id, { title: "b" }));
    expect(await run(copies.commit(id))).toEqual({ id, version: 1n });
    expect(chain.rows().map((row) => row.state["title"])).toEqual(["t", "b"]);
    expect(await run(copies.get(id))).toEqual(Option.none());
    expect(await tagOf(copies.commit(id))).toEqual(Option.some("WorkingCopyNotFound"));
  });

  it("an edit landing after the copy's base fails the commit and keeps the copy", async () => {
    const { leaf, copies, id } = await setup();
    await run(copies.save(id, { title: "mine" }));
    await run(leaf.update({ id, patch: { body: "someone else" } }));
    expect(await tagOf(copies.commit(id))).toEqual(Option.some("StaleVersion"));
    expect(Option.isSome(await run(copies.get(id)))).toBe(true);
  });

  it("every operation is gated like a write", async () => {
    const { copies, id, actAs, leaf } = await setup();
    const operations = [
      copies.save(id, { title: "x" }),
      copies.get(id),
      copies.discard(id),
      copies.commit(id),
    ];
    const refusals = await run(
      Effect.forEach(
        operations,
        (operation) =>
          Effect.all(
            [actAs(Option.some(otherMember), operation), actAs(Option.none(), operation)].map(
              (refused) => Effect.map(Effect.flip(refused), (error) => error._tag),
            ),
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      ),
    );
    expect(refusals).toEqual(operations.map(() => ["Forbidden", "Unauthorized"]));
    await run(actAs(Option.some(member), leaf.delete(id)));
    expect(await tagOf(actAs(Option.some(member), copies.save(id, { title: "x" })))).toEqual(
      Option.some("NodeNotFound"),
    );
  });

  it("discard throws the copy away", async () => {
    const { copies, id } = await setup();
    await run(copies.save(id, { title: "x" }));
    await run(copies.discard(id));
    expect(await run(copies.get(id))).toEqual(Option.none());
  });
});
