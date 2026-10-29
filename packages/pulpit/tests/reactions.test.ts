/**
 * Reactions (pulpit#196), after gardeneria's `apps/api/src/operations/reactions.ts`
 * and its tests: one reaction per account per node (reacting again
 * replaces), the target's read gate on every operation (a hidden node is
 * `NodeNotFound`, never `Forbidden`: `SEC-AUTH-ENUM-001`), and the tally as
 * one grouped read for a page of nodes.
 *
 * @module tests/reactions
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import {
  defineReactions,
  ReactionDeclarationError,
  reactionKinds,
  type ReactionStore,
} from "../src/reactions.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/subtype.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryReactionStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const tagOf = async <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
    : Option.none();
};

const setup = (store = makeInMemoryReactionStore()) => {
  const chain = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, { columns: ["visibility"], now: NOW });
  let viewer: Viewer = Option.none();
  const viewerOf = Effect.sync(() => viewer);
  const posts = defineSubtype({
    type: "posts",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row.id,
  });
  let getManyCalls = 0;
  const reactions = defineReactions({
    type: "posts",
    kinds: reactionKinds(["like", "celebrate", "helpful"]),
    target: {
      get: posts.get,
      getMany: (ids) =>
        Effect.suspend(() => {
          getManyCalls += 1;
          return posts.getMany(ids);
        }),
    },
    reactions: store,
    viewer: viewerOf,
  });
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const post = (visibility: string) =>
    run(as(Option.some(member), posts.create({ id: Option.none(), state: { visibility } }))).then(
      ({ id }) => id,
    );
  return { reactions, store, as, post, getManyCalls: () => getManyCalls };
};

describe("reactionKinds", () => {
  it("throws at import for no kind, an empty one or a repeated one", () => {
    expect(() => reactionKinds([])).toThrow(ReactionDeclarationError);
    expect(() => reactionKinds(["like", ""])).toThrow(ReactionDeclarationError);
    expect(() => reactionKinds(["like", "like"])).toThrow(/named twice/);
  });
});

describe("defineReactions", () => {
  it("keeps one reaction per account per node: reacting again replaces the kind", async () => {
    const { reactions, store, as, post } = setup();
    const id = await post("public");
    const viewer = Option.some(otherMember);
    expect(await run(as(viewer, reactions.react(id, "like")))).toEqual({ replaced: Option.none() });
    expect(await run(as(viewer, reactions.react(id, "celebrate")))).toEqual({
      replaced: Option.some("like"),
    });
    expect(store.rows().map((row) => [row.nodeId, row.accountId, row.kind])).toEqual([
      [id, otherMember.id, "celebrate"],
    ]);
    expect(await run(as(viewer, reactions.unreact(id)))).toEqual({ removed: true });
    expect(await run(as(viewer, reactions.unreact(id)))).toEqual({ removed: false });
    expect(store.rows()).toEqual([]);
  });

  it("answers a hidden or missing node as NodeNotFound, never Forbidden, and writes nothing", async () => {
    const { reactions, store, as, post } = setup();
    const hidden = await post("private");
    const stranger = Option.some(otherMember);
    expect(await tagOf(as(stranger, reactions.react(hidden, "like")))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(as(stranger, reactions.react("missing", "like")))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(as(stranger, reactions.unreact(hidden)))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(store.rows()).toEqual([]);
    // Its owner may react to it.
    await run(as(Option.some(member), reactions.react(hidden, "like")));
    expect(store.rows()).toHaveLength(1);
  });

  it("refuses the anonymous and an undeclared kind", async () => {
    const { reactions, as, post } = setup();
    const id = await post("public");
    expect(await tagOf(as(Option.none(), reactions.react(id, "like")))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(await tagOf(as(Option.none(), reactions.mine({ limit: 10, offset: 0 })))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(await tagOf(as(Option.some(member), reactions.react(id, "angry")))).toEqual(
      Option.some("InvalidReactionKind"),
    );
  });

  it("tallies every readable node of a page in one getMany and one grouped read", async () => {
    let tallies = 0;
    const base = makeInMemoryReactionStore();
    const counting: ReactionStore<never, never> = {
      ...base,
      tally: (ids) => Effect.suspend(() => ((tallies += 1), base.tally(ids))),
    };
    const { reactions, as, post, getManyCalls } = setup({ ...base, ...counting });
    const open = await post("public");
    const quiet = await post("public");
    const hidden = await post("private");
    await run(as(Option.some(member), reactions.react(open, "like")));
    await run(as(Option.some(otherMember), reactions.react(open, "helpful")));
    await run(as(Option.some(member), reactions.react(hidden, "like")));
    const before = getManyCalls();
    const tally = await run(
      as(Option.some(otherMember), reactions.tally([open, quiet, hidden, open, "missing"])),
    );
    expect([tallies, getManyCalls() - before]).toEqual([1, 1]);
    expect(HashMap.get(tally, open)).toEqual(
      Option.some({ counts: { like: 1, celebrate: 0, helpful: 1 }, total: 2 }),
    );
    expect(HashMap.get(tally, quiet)).toEqual(
      Option.some({ counts: { like: 0, celebrate: 0, helpful: 0 }, total: 0 }),
    );
    // A node the viewer can't read has no key: its tally is never confirmed.
    expect(HashMap.has(tally, hidden)).toBe(false);
    expect(HashMap.has(tally, "missing")).toBe(false);
    // The moderate rung reads it.
    const all = await run(as(Option.some(moderator), reactions.tally([hidden])));
    expect(Option.map(HashMap.get(all, hidden), (t) => t.total)).toEqual(Option.some(1));
  });

  it("reads nothing for no ids or more than MAX_SET_VALUES", async () => {
    const { reactions, as } = setup();
    expect(HashMap.size(await run(as(Option.some(member), reactions.tally([]))))).toBe(0);
    const tooMany = Array.from({ length: 1001 }, (_, index) => `n-${index}`);
    expect(HashMap.size(await run(as(Option.some(member), reactions.tally(tooMany))))).toBe(0);
  });

  it("lists the viewer's own reactions, newest first, omitting a node since hidden from them", async () => {
    const store = makeInMemoryReactionStore();
    const { reactions, as, post } = setup(store);
    const open = await post("public");
    const owned = await post("private");
    const other = await post("public");
    await run(as(Option.some(member), reactions.react(open, "like")));
    await run(as(Option.some(member), reactions.react(owned, "like")));
    await run(as(Option.some(otherMember), reactions.react(other, "like")));
    // A reaction otherMember made to `owned` before it was hidden from them.
    await run(
      store.upsert({ nodeId: owned, accountId: otherMember.id, kind: "like", reactedAt: NOW }),
    );
    const mine = await run(as(Option.some(member), reactions.mine({ limit: 10, offset: 0 })));
    expect(
      Arr.sort(
        mine.map((row) => row.nodeId),
        Order.String,
      ),
    ).toEqual(Arr.sort([open, owned], Order.String));
    const theirs = await run(
      as(Option.some(otherMember), reactions.mine({ limit: 10, offset: 0 })),
    );
    expect(theirs.map((row) => row.nodeId)).toEqual([other]);
  });

  it("erases an account's reactions through the store", async () => {
    const store = makeInMemoryReactionStore();
    const { reactions, as, post } = setup(store);
    const id = await post("public");
    await run(as(Option.some(member), reactions.react(id, "like")));
    await run(as(Option.some(otherMember), reactions.react(id, "like")));
    expect(await run(store.eraseAccount(member.id))).toBe(1);
    expect(store.rows().map((row) => row.accountId)).toEqual([otherMember.id]);
  });
});
