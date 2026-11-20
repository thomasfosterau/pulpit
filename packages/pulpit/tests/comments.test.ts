/**
 * The comments family.
 *
 * - The moderation gate: `canViewModerated` and `moderationListFilter` never
 *   disagree, for every state × author × viewer.
 * - The three read gates end to end, ported from gardeneria's
 *   `comment-visibility.test.ts` and `comment-target-visibility-flip.test.ts`:
 *   moderation state, the comment's tombstone, and the target's own read
 *   (private, followers-only, tombstoned, reference), composed; `get` and
 *   `listByTarget` agree.
 * - Reply depth: `maxDepth` 0, 1 and 2, a parent on another target, and the
 *   declaration check.
 *
 * @module tests/comments
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import {
  canViewModerated,
  CommentDeclarationError,
  defineComments,
  moderationListFilter,
  type CommentsDefinition,
} from "../src/Comments.ts";
import { evaluate } from "../src/Filter.ts";
import { moderatedColumns, moderationHook } from "../src/Moderation.ts";
import {
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/Subtype.ts";
import type { ChainState } from "../src/VersionChain.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { follower, gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

const columns = { authorColumn: "ownerId", stateColumn: "moderationState" };
const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();
const author: ViewerAccount = { id: "u-author", role: "user" };

describe("the moderation gate: canViewModerated ≡ moderationListFilter", () => {
  const states = ["pending", "approved", "rejected", null, "bogus"] as const;
  const viewers = [anonymous, as(author), as(otherMember), as(moderator)];
  it("agrees for every state × author × viewer", () => {
    const context = { now: NOW, contains: () => false };
    const rows = Arr.flatMap(states, (state) =>
      Arr.map([author.id, null], (owner): LeafRow => ({
        id: "c",
        version: 0n,
        action: "create",
        moderationState: state,
        ownerId: owner,
      })),
    );
    const disagreements = Arr.flatMap(rows, (row) =>
      Arr.filter(
        viewers,
        (viewer) =>
          canViewModerated(viewer, gardeneriaPolicy, columns, row) !==
          evaluate(moderationListFilter(viewer, gardeneriaPolicy, columns), row, context),
      ),
    );
    expect(disagreements).toEqual([]);
  });

  it("an unapproved comment reads to its author and the rung, never to anyone else", () => {
    const pending: LeafRow = {
      id: "c",
      version: 0n,
      action: "create",
      moderationState: "pending",
      ownerId: author.id,
    };
    expect(
      viewers.map((viewer) => canViewModerated(viewer, gardeneriaPolicy, columns, pending)),
    ).toEqual([false, true, false, true]);
  });
});

/** A world: an owned `posts` target, a reference `terms` target, and a comment leaf on them. */
const world = (maxDepth?: number) => {
  let viewer: Viewer = anonymous;
  const viewerOf = Effect.sync(() => viewer);
  const followers = makeInMemoryFollowers([[follower.id, [member.id]]]);
  const postChain = makeInMemoryVersionChain("posts");
  const postLeaves = makeInMemoryLeafStore(postChain, { columns: ["visibility"], now: NOW });
  const posts = defineSubtype({
    type: "posts",
    access: ownedAccess(),
    chain: postChain,
    leaves: postLeaves,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers,
    toResource: (row: LeafRow) => row,
  });
  const termChain = makeInMemoryVersionChain("terms");
  const terms = defineSubtype({
    type: "terms",
    access: { kind: "reference" },
    chain: termChain,
    leaves: makeInMemoryLeafStore(termChain, { columns: ["name"], now: NOW }),
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers,
    toResource: (row: LeafRow) => row,
  });
  const commentChain = makeInMemoryVersionChain("comments");
  const commentLeaves = makeInMemoryLeafStore(commentChain, {
    columns: [
      "body",
      "visibility",
      "moderationState",
      "moderatedAt",
      "moderatedBy",
      "targetType",
      "targetId",
      "parentId",
      "depth",
    ],
    now: NOW,
  });
  const moderation = moderatedColumns(["body"]);
  const commentLeaf = defineSubtype<LeafRow, LeafRow, InMemoryFollowing, never, never>({
    type: "comments",
    access: ownedAccess(),
    chain: commentChain,
    leaves: commentLeaves,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers,
    toResource: (row) => row,
    hooks: Effect.succeed({
      before: [moderationHook(moderation, gardeneriaPolicy)],
      after: [],
    }),
  });
  const definition: CommentsDefinition<LeafRow, InMemoryFollowing, never, never> = {
    comments: commentLeaf,
    leaves: commentLeaves,
    targets: { posts, terms },
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    moderation,
    authorColumn: "ownerId",
  };
  const comments = defineComments(
    maxDepth === undefined ? definition : { ...definition, maxDepth },
  );
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const post = (visibility: string) =>
    Effect.map(
      actAs(as(member), posts.create({ id: Option.none(), state: { visibility } })),
      (value) => value.id,
    );
  const comment = (
    targetId: string,
    options: {
      readonly targetType?: string;
      readonly approve?: boolean;
      readonly parentId?: string;
      readonly state?: ChainState;
    } = {},
  ) =>
    Effect.gen(function* () {
      const { id } = yield* actAs(
        as(author),
        comments.create({
          id: Option.none(),
          targetType: options.targetType ?? "posts",
          targetId,
          parentId: Option.fromUndefinedOr(options.parentId),
          state: options.state ?? { body: "hi", visibility: "public" },
        }),
      );
      if (options.approve !== false) {
        yield* actAs(
          as(moderator),
          commentLeaf.update({ id, patch: { moderationState: "approved" } }),
        );
      }
      return id;
    });
  const readers = {
    anonymous,
    author: as(author),
    owner: as(member),
    stranger: as(otherMember),
    follower: as(follower),
    moderator: as(moderator),
  };
  /** Who reads comment `id`, through `get` and through `listByTarget` (which must agree). */
  const whoReads = (id: string, targetId: string, targetType = "posts") =>
    Effect.gen(function* () {
      const sightings = yield* Effect.forEach(
        R.toEntries(readers),
        ([name, who]) =>
          Effect.all(
            [
              Effect.option(actAs(who, comments.get(id))),
              Effect.option(
                actAs(
                  who,
                  comments.listByTarget({
                    targetType,
                    targetId,
                    parentId: Option.none(),
                    limit: 50,
                    offset: 0,
                    includeDeleted: true,
                  }),
                ),
              ),
            ],
            { concurrency: 1 },
          ).pipe(
            Effect.map(([got, page]) => ({
              name,
              got: Option.isSome(got),
              listed: Option.exists(page, (listed) => listed.rows.some((row) => row.id === id)),
            })),
          ),
        { concurrency: 1 },
      );
      // `get` and `listByTarget` agree for every reader.
      expect(sightings.filter(({ got, listed }) => got !== listed)).toEqual([]);
      return R.fromEntries(
        sightings.filter(({ got }) => got).map(({ name }) => [name, true] as const),
      );
    });
  return { posts, terms, commentLeaf, comments, actAs, post, comment, whoReads, commentChain };
};

describe("defineComments — the read gates", () => {
  it.effect("an approved comment on a public target is readable by everyone", () =>
    Effect.gen(function* () {
      const { post, comment, whoReads } = world();
      const target = yield* post("public");
      const id = yield* comment(target);
      expect(yield* whoReads(id, target)).toEqual({
        anonymous: true,
        author: true,
        owner: true,
        stranger: true,
        follower: true,
        moderator: true,
      });
    }),
  );

  it.effect("a pending comment reads to its author and the rung only, not the target's owner", () =>
    Effect.gen(function* () {
      const { post, comment, whoReads } = world();
      const target = yield* post("public");
      const id = yield* comment(target, { approve: false });
      expect(yield* whoReads(id, target)).toEqual({ author: true, moderator: true });
    }),
  );

  it.effect(
    "an empty-id viewer is anonymous: it can't comment, and an empty-id moderator can't read a pending one",
    () =>
      Effect.gen(function* () {
        const { post, comment, comments, actAs } = world();
        const target = yield* post("public");
        const pending = yield* comment(target, { approve: false });
        const create = comments.create({
          id: Option.none(),
          targetType: "posts",
          targetId: target,
          parentId: Option.none(),
          state: { body: "hi", visibility: "public" },
        });
        expect(yield* tagOf(actAs(as({ ...author, id: "" }), create))).toEqual(
          Option.some("Unauthorized"),
        );
        expect(yield* tagOf(actAs(as({ ...moderator, id: "" }), comments.get(pending)))).toEqual(
          Option.some("NodeNotFound"),
        );
      }),
  );

  it.effect("a tombstoned comment is hidden from everyone but the view-deleted rung", () =>
    Effect.gen(function* () {
      const { post, comment, whoReads, actAs, commentLeaf } = world();
      const target = yield* post("public");
      const id = yield* comment(target);
      yield* actAs(as(author), commentLeaf.delete(id));
      expect(yield* whoReads(id, target)).toEqual({ moderator: true });
    }),
  );

  it.effect(
    "a comment on a private target reads only to the target's owner and the rung, not its author",
    () =>
      Effect.gen(function* () {
        const { post, posts, comment, whoReads, actAs } = world();
        // Commented while the author could still read it.
        const target = yield* post("public");
        const id = yield* comment(target);
        yield* actAs(as(member), posts.update({ id: target, patch: { visibility: "private" } }));
        expect(yield* whoReads(id, target)).toEqual({ owner: true, moderator: true });
      }),
  );

  it.effect(
    "a comment on a followers-only target reads to the owner, their followers and the rung",
    () =>
      Effect.gen(function* () {
        const { post, posts, comment, whoReads, actAs } = world();
        const target = yield* post("public");
        const id = yield* comment(target);
        yield* actAs(as(member), posts.update({ id: target, patch: { visibility: "followers" } }));
        expect(yield* whoReads(id, target)).toEqual({
          owner: true,
          follower: true,
          moderator: true,
        });
      }),
  );

  it.effect("flipping the target private hides its comments, its own author included", () =>
    Effect.gen(function* () {
      const { post, posts, comment, whoReads, actAs } = world();
      const target = yield* post("public");
      const id = yield* comment(target);
      yield* actAs(as(member), posts.update({ id: target, patch: { visibility: "private" } }));
      expect(yield* whoReads(id, target)).toEqual({ owner: true, moderator: true });
    }),
  );

  it.effect("a comment on a tombstoned target is hidden, even from its author and the owner", () =>
    Effect.gen(function* () {
      const { post, posts, comment, whoReads, actAs } = world();
      const target = yield* post("public");
      const id = yield* comment(target);
      yield* actAs(as(member), posts.delete(target));
      expect(yield* whoReads(id, target)).toEqual({ moderator: true });
    }),
  );

  it.effect("a reference target with no visibility axis is public by construction", () =>
    Effect.gen(function* () {
      const { terms, comment, whoReads, actAs } = world();
      const { id: target } = yield* actAs(
        as(moderator),
        terms.create({ id: Option.none(), state: { name: "Ferns" } }),
      );
      const id = yield* comment(target, { targetType: "terms" });
      expect(R.keys(yield* whoReads(id, target, "terms"))).toHaveLength(6);
    }),
  );

  it.effect(
    "commenting on a target the viewer can't read, or of an unknown type, is NodeNotFound",
    () =>
      Effect.gen(function* () {
        const { post, comments, actAs } = world();
        const target = yield* post("private");
        const create = (targetType: string, targetId: string) =>
          actAs(
            as(otherMember),
            comments.create({
              id: Option.none(),
              targetType,
              targetId,
              parentId: Option.none(),
              state: {},
            }),
          );
        expect(yield* tagOf(create("posts", target))).toEqual(Option.some("NodeNotFound"));
        expect(yield* tagOf(create("posts", "missing"))).toEqual(Option.some("NodeNotFound"));
        expect(yield* tagOf(create("galleries", target))).toEqual(Option.some("NodeNotFound"));
        expect(
          yield* tagOf(
            actAs(
              as(otherMember),
              comments.listByTarget({
                targetType: "posts",
                targetId: target,
                parentId: Option.none(),
                limit: 10,
                offset: 0,
                includeDeleted: false,
              }),
            ),
          ),
        ).toEqual(Option.some("NodeNotFound"));
      }),
  );

  it.effect("a new comment starts pending, whatever it asks for", () =>
    Effect.gen(function* () {
      const { post, comment, commentChain } = world();
      const target = yield* post("public");
      yield* comment(target, { approve: false, state: { body: "x", visibility: "public" } });
      expect(commentChain.rows()[0]?.state).toMatchObject({
        moderationState: "pending",
        targetType: "posts",
        targetId: target,
        parentId: null,
        depth: 0,
      });
    }),
  );
});

describe("defineComments — reply depth", () => {
  it.effect("maxDepth 1 (the default) takes one level of replies", () =>
    Effect.gen(function* () {
      const { post, comment, comments, actAs } = world();
      const target = yield* post("public");
      const top = yield* comment(target);
      const reply = yield* comment(target, { parentId: top });
      expect(
        yield* tagOf(
          actAs(
            as(author),
            comments.create({
              id: Option.none(),
              targetType: "posts",
              targetId: target,
              parentId: Option.some(reply),
              state: {},
            }),
          ),
        ),
      ).toEqual(Option.some("CommentDepthExceeded"));
      const replies = yield* actAs(
        anonymous,
        comments.listByTarget({
          targetType: "posts",
          targetId: target,
          parentId: Option.some(Option.some(top)),
          limit: 10,
          offset: 0,
          includeDeleted: false,
        }),
      );
      const tops = yield* actAs(
        anonymous,
        comments.listByTarget({
          targetType: "posts",
          targetId: target,
          parentId: Option.some(Option.none()),
          limit: 10,
          offset: 0,
          includeDeleted: false,
        }),
      );
      expect(replies.rows.map((row) => row.id)).toEqual([reply]);
      expect(tops.rows.map((row) => row.id)).toEqual([top]);
    }),
  );

  it.effect("maxDepth 0 is flat, and maxDepth 2 nests twice", () =>
    Effect.gen(function* () {
      const flat = world(0);
      const flatTarget = yield* flat.post("public");
      const flatTop = yield* flat.comment(flatTarget);
      expect(
        Exit.isFailure(yield* Effect.exit(flat.comment(flatTarget, { parentId: flatTop }))),
      ).toBe(true);
      const deep = world(2);
      const deepTarget = yield* deep.post("public");
      const one = yield* deep.comment(deepTarget);
      const two = yield* deep.comment(deepTarget, { parentId: one });
      const three = yield* deep.comment(deepTarget, { parentId: two });
      expect(three).toBeTypeOf("string");
      expect(
        Exit.isFailure(yield* Effect.exit(deep.comment(deepTarget, { parentId: three }))),
      ).toBe(true);
    }),
  );

  it.effect("a reply to a comment on another target is NodeNotFound", () =>
    Effect.gen(function* () {
      const { post, comment, comments, actAs } = world();
      const first = yield* post("public");
      const second = yield* post("public");
      const top = yield* comment(first);
      expect(
        yield* tagOf(
          actAs(
            as(author),
            comments.create({
              id: Option.none(),
              targetType: "posts",
              targetId: second,
              parentId: Option.some(top),
              state: {},
            }),
          ),
        ),
      ).toEqual(Option.some("NodeNotFound"));
    }),
  );

  it("maxDepth must be a non-negative safe integer", () => {
    expect(() => world(-1)).toThrow(CommentDeclarationError);
    expect(() => world(1.5)).toThrow(CommentDeclarationError);
  });
});
