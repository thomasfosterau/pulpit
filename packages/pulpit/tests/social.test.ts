/**
 * The social graph, after gardeneria's `social.follows` and
 * `apps/api/src/operations/follows.ts`: follow / mute / block as the
 * actor's own facts, a block ending both follows and refusing new ones
 * (interaction only: it hides no content), the follower seam filled from
 * the graph so a `followers` row reads end to end, and the opt-in read
 * filter over the authors a viewer silenced.
 *
 * @module tests/social
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import { always, evaluate, type FilterRow } from "../src/Filter.ts";
import { defineSocial, socialFollowers, type SocialStore } from "../src/Social.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryLeafStore,
  makeInMemorySocialStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import type { ColumnValue } from "../src/VersionChain.ts";
import { gardeneriaPolicy, member, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
      : Option.none();
  });
const page = { limit: 10, offset: 0 };
const ids = (rows: ReadonlyArray<{ readonly accountId: string }>) =>
  rows.map((row) => row.accountId);

const setup = (visible?: (ids: ReadonlyArray<string>) => ReadonlyArray<string>) => {
  const store = makeInMemorySocialStore();
  let viewer: Viewer = Option.none();
  const base = { store, viewer: Effect.sync(() => viewer) };
  const social = defineSocial(
    visible === undefined
      ? base
      : {
          ...base,
          accounts: {
            visible: (_: Viewer, accountIds: ReadonlyArray<string>) =>
              Effect.succeed(HashSet.fromIterable(visible(accountIds))),
          },
        },
  );
  const as = <A, E>(who: string, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = Option.some({ id: who, role: "user" });
      return effect;
    });
  return { store, social, as };
};

describe("defineSocial — follows, mutes and blocks", () => {
  it.effect("follows immediately and idempotently, and lists both sides newest first", () =>
    Effect.gen(function* () {
      const { social, as } = setup();
      expect(yield* as("u-a", social.follow("u-b"))).toEqual({ changed: true });
      expect(yield* as("u-a", social.follow("u-b"))).toEqual({ changed: false });
      yield* as("u-c", social.follow("u-b"));
      const followers = yield* social.followers("u-b", page);
      expect([followers.total, Arr.sort(ids(followers.rows), Order.String)]).toEqual([
        Option.some(2),
        ["u-a", "u-c"],
      ]);
      expect(ids((yield* social.following("u-a", page)).rows)).toEqual(["u-b"]);
      expect(yield* as("u-a", social.unfollow("u-b"))).toEqual({ changed: true });
      expect(yield* as("u-a", social.unfollow("u-b"))).toEqual({ changed: false });
    }),
  );

  it.effect("refuses the anonymous and a relationship with oneself", () =>
    Effect.gen(function* () {
      const { social, as } = setup();
      expect(yield* tagOf(social.follow("u-b"))).toEqual(Option.some("Unauthorized"));
      expect(yield* tagOf(social.muted(page))).toEqual(Option.some("Unauthorized"));
      expect(yield* tagOf(as("", social.follow("u-b")))).toEqual(Option.some("Unauthorized"));
      expect(yield* tagOf(as("", social.muted(page)))).toEqual(Option.some("Unauthorized"));
      expect(yield* tagOf(as("u-a", social.follow("u-a")))).toEqual(
        Option.some("SelfRelationship"),
      );
      expect(yield* tagOf(as("u-a", social.block("u-a")))).toEqual(Option.some("SelfRelationship"));
      expect(yield* tagOf(as("u-a", social.mute("u-a")))).toEqual(Option.some("SelfRelationship"));
    }),
  );

  it.effect("a block ends both follows and refuses a new one either way, until unblocked", () =>
    Effect.gen(function* () {
      const { store, social, as } = setup();
      yield* as("u-a", social.follow("u-b"));
      yield* as("u-b", social.follow("u-a"));
      yield* as("u-a", social.block("u-b"));
      expect(store.rows().filter((row) => row.kind === "follow")).toEqual([]);
      expect(yield* tagOf(as("u-b", social.follow("u-a")))).toEqual(
        Option.some("InteractionBlocked"),
      );
      expect(yield* tagOf(as("u-a", social.follow("u-b")))).toEqual(
        Option.some("InteractionBlocked"),
      );
      expect(yield* social.interactionAllowed("u-b", "u-a")).toBe(false);
      expect(yield* social.interactionAllowed("u-a", "u-a")).toBe(true);
      expect(ids((yield* as("u-a", social.blocked(page))).rows)).toEqual(["u-b"]);
      yield* as("u-a", social.unblock("u-b"));
      expect(yield* social.interactionAllowed("u-b", "u-a")).toBe(true);
      expect(yield* as("u-b", social.follow("u-a"))).toEqual({ changed: true });
    }),
  );

  it.effect("a mute is one-way and private: it changes no follow and no interaction", () =>
    Effect.gen(function* () {
      const { social, as } = setup();
      yield* as("u-a", social.follow("u-b"));
      yield* as("u-a", social.mute("u-b"));
      expect(ids((yield* social.following("u-a", page)).rows)).toEqual(["u-b"]);
      expect(yield* social.interactionAllowed("u-a", "u-b")).toBe(true);
      expect(ids((yield* as("u-a", social.muted(page))).rows)).toEqual(["u-b"]);
      expect((yield* as("u-b", social.muted(page))).rows).toEqual([]);
      expect(yield* as("u-a", social.unmute("u-b"))).toEqual({ changed: true });
    }),
  );

  it.effect("shows the follower lists through the application's account visibility", () =>
    Effect.gen(function* () {
      const { social, as } = setup((accountIds) => accountIds.filter((id) => id !== "u-hidden"));
      yield* as("u-a", social.follow("u-b"));
      yield* as("u-hidden", social.follow("u-b"));
      const followers = yield* social.followers("u-b", page);
      expect(ids(followers.rows)).toEqual(["u-a"]);
      // The store's total would count the hidden follower too, so none is given.
      expect(followers.total).toEqual(Option.none());
    }),
  );

  it.effect("answers a subject the viewer can't see as one with no relationships", () =>
    Effect.gen(function* () {
      const { social, as } = setup((accountIds) => accountIds.filter((id) => id !== "u-hidden"));
      yield* as("u-a", social.follow("u-hidden"));
      yield* as("u-hidden", social.follow("u-a"));
      const missing = yield* social.followers("u-nobody", page);
      expect(yield* social.followers("u-hidden", page)).toEqual(missing);
      expect(yield* social.following("u-hidden", page)).toEqual(missing);
      expect(missing).toEqual({ rows: [], total: Option.none() });
    }),
  );

  it.effect("a block racing a follow never leaves the follow standing (either order)", () =>
    Effect.gen(function* () {
      // The block commits after the follow began but before its write: the
      // write itself refuses (there is no separate check for the block to slip past).
      const inner = makeInMemorySocialStore();
      const racing: SocialStore<InMemoryFollowing, never, never> = {
        ...inner,
        addFollow: (relationship) =>
          Effect.andThen(
            inner.addBlock({
              kind: "block",
              from: relationship.to,
              to: relationship.from,
              at: NOW,
            }),
            inner.addFollow(relationship),
          ),
      };
      const social = defineSocial({
        store: racing,
        viewer: Effect.succeedSome({ id: "u-a", role: "user" }),
      });
      expect(yield* tagOf(social.follow("u-b"))).toEqual(Option.some("InteractionBlocked"));
      expect(inner.rows().filter((row) => row.kind === "follow")).toEqual([]);
      // The block lands just after the follow: it ends the follow it finds.
      const { store, social: after, as } = setup();
      yield* as("u-a", after.follow("u-b"));
      yield* as("u-b", after.block("u-a"));
      expect(store.rows().filter((row) => row.kind === "follow")).toEqual([]);
    }),
  );

  it.effect("erases an account's relationships either way through the store", () =>
    Effect.gen(function* () {
      const { store, social, as } = setup();
      yield* as("u-a", social.follow("u-b"));
      yield* as("u-b", social.follow("u-a"));
      yield* as("u-c", social.mute("u-a"));
      expect(yield* store.eraseAccount("u-a", 10)).toBe(3);
      expect(store.rows()).toEqual([]);
    }),
  );
});

describe("the silenced-authors read filter (opt-in)", () => {
  const context = {
    now: NOW,
    contains: (set: InMemoryFollowing, value: ColumnValue) =>
      P.isString(value) && HashSet.has(set, value),
  };
  const rows: ReadonlyArray<FilterRow> = [
    { id: "1", authorId: "u-b" },
    { id: "2", authorId: "u-c" },
    { id: "3", authorId: "u-d" },
    { id: "4", authorId: null },
  ];

  it.effect("drops the authors the viewer muted or blocked, and keeps an unset author", () =>
    Effect.gen(function* () {
      const { social, as } = setup();
      yield* as("u-a", social.mute("u-b"));
      yield* as("u-a", social.block("u-c"));
      const filter = yield* as("u-a", social.silencedFilter("authorId"));
      expect(rows.filter((row) => evaluate(filter, row, context)).map((row) => row["id"])).toEqual([
        "3",
        "4",
      ]);
      // Someone the viewer is blocked BY still shows: a block hides nothing by itself.
      const blocked = yield* as("u-c", social.silencedFilter("authorId"));
      expect(rows.filter((row) => evaluate(blocked, row, context))).toHaveLength(4);
    }),
  );

  it.effect("is always for the anonymous", () =>
    Effect.gen(function* () {
      const { social } = setup();
      expect(yield* social.silencedFilter("authorId")).toEqual({ kind: "always" });
    }),
  );
});

describe("socialFollowers fills the follower seam end to end", () => {
  it.effect("lets a follower read a followers row, and only while following", () =>
    Effect.gen(function* () {
      const store = makeInMemorySocialStore();
      const chain = makeInMemoryVersionChain("posts");
      const leaves = makeInMemoryLeafStore(chain, { columns: ["visibility"], now: NOW });
      let viewer: Viewer = Option.some(member);
      const viewerOf = Effect.sync(() => viewer);
      const social = defineSocial({ store, viewer: viewerOf });
      const posts = defineSubtype({
        type: "posts",
        access: ownedAccess(),
        chain,
        leaves,
        viewer: viewerOf,
        policy: gardeneriaPolicy,
        followers: socialFollowers(store),
        toResource: (row: LeafRow) => row.id,
      });
      const { id } = yield* posts.create({ id: Option.none(), state: { visibility: "followers" } });
      viewer = Option.some(otherMember);
      const listed = () =>
        Effect.map(
          posts.list({ limit: 10, offset: 0, includeDeleted: false, where: always }),
          (p) => p.rows,
        );
      expect(yield* tagOf(posts.get(id))).toEqual(Option.some("NodeNotFound"));
      expect(yield* listed()).toEqual([]);
      yield* social.follow(member.id);
      expect(yield* posts.get(id)).toBe(id);
      expect(yield* listed()).toEqual([id]);
      // A block by the owner ends the follow, and the row hides again.
      viewer = Option.some(member);
      yield* social.block(otherMember.id);
      viewer = Option.some(otherMember);
      expect(yield* tagOf(posts.get(id))).toEqual(Option.some("NodeNotFound"));
    }),
  );
});
