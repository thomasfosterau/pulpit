/**
 * Reactions, after gardeneria's `apps/api/src/operations/reactions.ts`
 * and its tests: one reaction per account per node (reacting again
 * replaces), the target's read gate on every operation (a hidden node is
 * `NodeNotFound`, never `Forbidden`: `SEC-AUTH-ENUM-001`), and the tally as
 * one grouped read for a page of nodes.
 *
 * @module tests/reactions
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
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
} from "../src/Reactions.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryReactionStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
      : Option.none();
  });

const setup = (store = makeInMemoryReactionStore()) => {
  const chain = makeInMemoryVersionChain("posts");
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
    Effect.map(
      as(Option.some(member), posts.create({ id: Option.none(), state: { visibility } })),
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
  it.effect("keeps one reaction per account per node: reacting again replaces the kind", () =>
    Effect.gen(function* () {
      const { reactions, store, as, post } = setup();
      const id = yield* post("public");
      const viewer = Option.some(otherMember);
      expect(yield* as(viewer, reactions.react(id, "like"))).toEqual({ replaced: Option.none() });
      expect(yield* as(viewer, reactions.react(id, "celebrate"))).toEqual({
        replaced: Option.some("like"),
      });
      expect(store.rows().map((row) => [row.nodeId, row.accountId, row.kind])).toEqual([
        [id, otherMember.id, "celebrate"],
      ]);
      expect(yield* as(viewer, reactions.unreact(id))).toEqual({ removed: true });
      expect(yield* as(viewer, reactions.unreact(id))).toEqual({ removed: false });
      expect(store.rows()).toEqual([]);
    }),
  );

  it.effect(
    "answers a hidden or missing node as NodeNotFound, never Forbidden, and writes nothing",
    () =>
      Effect.gen(function* () {
        const { reactions, store, as, post } = setup();
        const hidden = yield* post("private");
        const stranger = Option.some(otherMember);
        expect(yield* tagOf(as(stranger, reactions.react(hidden, "like")))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* tagOf(as(stranger, reactions.react("missing", "like")))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* tagOf(as(stranger, reactions.unreact(hidden)))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(store.rows()).toEqual([]);
        // Its owner may react to it.
        yield* as(Option.some(member), reactions.react(hidden, "like"));
        expect(store.rows()).toHaveLength(1);
      }),
  );

  it.effect("refuses the anonymous and an undeclared kind", () =>
    Effect.gen(function* () {
      const { reactions, as, post } = setup();
      const id = yield* post("public");
      expect(yield* tagOf(as(Option.none(), reactions.react(id, "like")))).toEqual(
        Option.some("Unauthorized"),
      );
      expect(yield* tagOf(as(Option.none(), reactions.mine({ limit: 10, offset: 0 })))).toEqual(
        Option.some("Unauthorized"),
      );
      expect(
        yield* tagOf(as(Option.some({ ...member, id: "" }), reactions.react(id, "like"))),
      ).toEqual(Option.some("Unauthorized"));
      expect(yield* tagOf(as(Option.some(member), reactions.react(id, "angry")))).toEqual(
        Option.some("InvalidReactionKind"),
      );
    }),
  );

  it.effect("tallies every readable node of a page in one getMany and one grouped read", () =>
    Effect.gen(function* () {
      let tallies = 0;
      const base = makeInMemoryReactionStore();
      const counting: ReactionStore<never, never> = {
        ...base,
        tally: (ids) => Effect.suspend(() => ((tallies += 1), base.tally(ids))),
      };
      const { reactions, as, post, getManyCalls } = setup({ ...base, ...counting });
      const open = yield* post("public");
      const quiet = yield* post("public");
      const hidden = yield* post("private");
      yield* as(Option.some(member), reactions.react(open, "like"));
      yield* as(Option.some(otherMember), reactions.react(open, "helpful"));
      yield* as(Option.some(member), reactions.react(hidden, "like"));
      const before = getManyCalls();
      const tally = yield* as(
        Option.some(otherMember),
        reactions.tally([open, quiet, hidden, open, "missing"]),
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
      const all = yield* as(Option.some(moderator), reactions.tally([hidden]));
      expect(Option.map(HashMap.get(all, hidden), (t) => t.total)).toEqual(Option.some(1));
    }),
  );

  it.effect("reads nothing for no ids or more than MAX_SET_VALUES", () =>
    Effect.gen(function* () {
      const { reactions, as } = setup();
      expect(HashMap.size(yield* as(Option.some(member), reactions.tally([])))).toBe(0);
      const tooMany = Array.from({ length: 1001 }, (_, index) => `n-${index}`);
      expect(HashMap.size(yield* as(Option.some(member), reactions.tally(tooMany)))).toBe(0);
    }),
  );

  it.effect(
    "lists the viewer's own reactions, newest first, omitting a node since hidden from them",
    () =>
      Effect.gen(function* () {
        const store = makeInMemoryReactionStore();
        const { reactions, as, post } = setup(store);
        const open = yield* post("public");
        const owned = yield* post("private");
        const other = yield* post("public");
        yield* as(Option.some(member), reactions.react(open, "like"));
        yield* as(Option.some(member), reactions.react(owned, "like"));
        yield* as(Option.some(otherMember), reactions.react(other, "like"));
        // A reaction otherMember made to `owned` before it was hidden from them.
        yield* store.upsert({
          nodeId: owned,
          accountId: otherMember.id,
          kind: "like",
          reactedAt: NOW,
        });
        const mine = yield* as(Option.some(member), reactions.mine({ limit: 10, offset: 0 }));
        expect(
          Arr.sort(
            mine.map((row) => row.nodeId),
            Order.String,
          ),
        ).toEqual(Arr.sort([open, owned], Order.String));
        const theirs = yield* as(
          Option.some(otherMember),
          reactions.mine({ limit: 10, offset: 0 }),
        );
        expect(theirs.map((row) => row.nodeId)).toEqual([other]);
      }),
  );

  it.effect("erases an account's reactions through the store", () =>
    Effect.gen(function* () {
      const store = makeInMemoryReactionStore();
      const { reactions, as, post } = setup(store);
      const id = yield* post("public");
      yield* as(Option.some(member), reactions.react(id, "like"));
      yield* as(Option.some(otherMember), reactions.react(id, "like"));
      expect(yield* store.eraseAccount(member.id, 10)).toBe(1);
      expect(store.rows().map((row) => row.accountId)).toEqual([otherMember.id]);
    }),
  );
});
