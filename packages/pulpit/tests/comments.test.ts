/**
 * The comments family (pulpit#50).
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

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import {
  canViewModerated,
  CommentDeclarationError,
  defineComments,
  moderationListFilter,
} from "../src/comments.ts";
import { evaluate } from "../src/filter.ts";
import { moderatedColumns, moderationHook } from "../src/moderation.ts";
import {
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type { ChainState } from "../src/version-chain.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { follower, gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

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
  const postChain = makeInMemoryChainStore();
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
  const termChain = makeInMemoryChainStore();
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
  const commentChain = makeInMemoryChainStore();
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
      before: [moderationHook<never, never>(moderation, gardeneriaPolicy)],
      after: [],
    }),
  });
  const comments = defineComments({
    comments: commentLeaf,
    leaves: commentLeaves,
    targets: { posts, terms },
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    moderation,
    authorColumn: "ownerId",
    maxDepth,
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const post = async (visibility: string) =>
    (await run(actAs(as(member), posts.create({ id: Option.none(), state: { visibility } })))).id;
  const comment = async (
    targetId: string,
    options: {
      readonly targetType?: string;
      readonly approve?: boolean;
      readonly parentId?: string;
      readonly state?: ChainState;
    } = {},
  ) => {
    const { id } = await run(
      actAs(
        as(author),
        comments.create({
          id: Option.none(),
          targetType: options.targetType ?? "posts",
          targetId,
          parentId: Option.fromUndefinedOr(options.parentId),
          state: options.state ?? { body: "hi", visibility: "public" },
        }),
      ),
    );
    if (options.approve !== false) {
      await run(
        actAs(as(moderator), commentLeaf.update({ id, patch: { moderationState: "approved" } })),
      );
    }
    return id;
  };
  const readers = {
    anonymous,
    author: as(author),
    owner: as(member),
    stranger: as(otherMember),
    follower: as(follower),
    moderator: as(moderator),
  };
  /** Who reads comment `id`, through `get` and through `listByTarget` (which must agree). */
  const whoReads = async (id: string, targetId: string, targetType = "posts") => {
    const sightings = await run(
      Effect.forEach(
        Record.toEntries(readers),
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
      ),
    );
    // `get` and `listByTarget` agree for every reader.
    expect(sightings.filter(({ got, listed }) => got !== listed)).toEqual([]);
    return Record.fromEntries(
      sightings.filter(({ got }) => got).map(({ name }) => [name, true] as const),
    );
  };
  return { posts, terms, commentLeaf, comments, actAs, post, comment, whoReads, commentChain };
};

describe("defineComments — the read gates", () => {
  it("an approved comment on a public target is readable by everyone", async () => {
    const { post, comment, whoReads } = world();
    const target = await post("public");
    const id = await comment(target);
    expect(await whoReads(id, target)).toEqual({
      anonymous: true,
      author: true,
      owner: true,
      stranger: true,
      follower: true,
      moderator: true,
    });
  });

  it("a pending comment reads to its author and the rung only, not the target's owner", async () => {
    const { post, comment, whoReads } = world();
    const target = await post("public");
    const id = await comment(target, { approve: false });
    expect(await whoReads(id, target)).toEqual({ author: true, moderator: true });
  });

  it("a tombstoned comment is hidden from everyone but the view-deleted rung", async () => {
    const { post, comment, whoReads, actAs, commentLeaf } = world();
    const target = await post("public");
    const id = await comment(target);
    await run(actAs(as(author), commentLeaf.delete(id)));
    expect(await whoReads(id, target)).toEqual({ moderator: true });
  });

  it("a comment on a private target reads only to the target's owner and the rung, not its author", async () => {
    const { post, posts, comment, whoReads, actAs } = world();
    // Commented while the author could still read it.
    const target = await post("public");
    const id = await comment(target);
    await run(actAs(as(member), posts.update({ id: target, patch: { visibility: "private" } })));
    expect(await whoReads(id, target)).toEqual({ owner: true, moderator: true });
  });

  it("a comment on a followers-only target reads to the owner, their followers and the rung", async () => {
    const { post, posts, comment, whoReads, actAs } = world();
    const target = await post("public");
    const id = await comment(target);
    await run(actAs(as(member), posts.update({ id: target, patch: { visibility: "followers" } })));
    expect(await whoReads(id, target)).toEqual({ owner: true, follower: true, moderator: true });
  });

  it("flipping the target private hides its comments, its own author included", async () => {
    const { post, posts, comment, whoReads, actAs } = world();
    const target = await post("public");
    const id = await comment(target);
    await run(actAs(as(member), posts.update({ id: target, patch: { visibility: "private" } })));
    expect(await whoReads(id, target)).toEqual({ owner: true, moderator: true });
  });

  it("a comment on a tombstoned target is hidden, even from its author and the owner", async () => {
    const { post, posts, comment, whoReads, actAs } = world();
    const target = await post("public");
    const id = await comment(target);
    await run(actAs(as(member), posts.delete(target)));
    expect(await whoReads(id, target)).toEqual({ moderator: true });
  });

  it("a reference target with no visibility axis is public by construction", async () => {
    const { terms, comment, whoReads, actAs } = world();
    const { id: target } = await run(
      actAs(as(moderator), terms.create({ id: Option.none(), state: { name: "Ferns" } })),
    );
    const id = await comment(target, { targetType: "terms" });
    expect(Record.keys(await whoReads(id, target, "terms"))).toHaveLength(6);
  });

  it("commenting on a target the viewer can't read, or of an unknown type, is NodeNotFound", async () => {
    const { post, comments, actAs } = world();
    const target = await post("private");
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
    expect(await tagOf(create("posts", target))).toEqual(Option.some("NodeNotFound"));
    expect(await tagOf(create("posts", "missing"))).toEqual(Option.some("NodeNotFound"));
    expect(await tagOf(create("galleries", target))).toEqual(Option.some("NodeNotFound"));
    expect(
      await tagOf(
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
  });

  it("a new comment starts pending, whatever it asks for", async () => {
    const { post, comment, commentChain } = world();
    const target = await post("public");
    await comment(target, { approve: false, state: { body: "x", visibility: "public" } });
    expect(commentChain.rows()[0]?.state).toMatchObject({
      moderationState: "pending",
      targetType: "posts",
      targetId: target,
      parentId: null,
      depth: 0,
    });
  });
});

describe("defineComments — reply depth", () => {
  it("maxDepth 1 (the default) takes one level of replies", async () => {
    const { post, comment, comments, actAs } = world();
    const target = await post("public");
    const top = await comment(target);
    const reply = await comment(target, { parentId: top });
    expect(
      await tagOf(
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
    const replies = await run(
      actAs(
        anonymous,
        comments.listByTarget({
          targetType: "posts",
          targetId: target,
          parentId: Option.some(Option.some(top)),
          limit: 10,
          offset: 0,
          includeDeleted: false,
        }),
      ),
    );
    const tops = await run(
      actAs(
        anonymous,
        comments.listByTarget({
          targetType: "posts",
          targetId: target,
          parentId: Option.some(Option.none()),
          limit: 10,
          offset: 0,
          includeDeleted: false,
        }),
      ),
    );
    expect(replies.rows.map((row) => row.id)).toEqual([reply]);
    expect(tops.rows.map((row) => row.id)).toEqual([top]);
  });

  it("maxDepth 0 is flat, and maxDepth 2 nests twice", async () => {
    const flat = world(0);
    const flatTarget = await flat.post("public");
    const flatTop = await flat.comment(flatTarget);
    await expect(flat.comment(flatTarget, { parentId: flatTop })).rejects.toBeDefined();
    const deep = world(2);
    const deepTarget = await deep.post("public");
    const one = await deep.comment(deepTarget);
    const two = await deep.comment(deepTarget, { parentId: one });
    const three = await deep.comment(deepTarget, { parentId: two });
    expect(three).toBeTypeOf("string");
    await expect(deep.comment(deepTarget, { parentId: three })).rejects.toBeDefined();
  });

  it("a reply to a comment on another target is NodeNotFound", async () => {
    const { post, comment, comments, actAs } = world();
    const first = await post("public");
    const second = await post("public");
    const top = await comment(first);
    expect(
      await tagOf(
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
  });

  it("maxDepth must be a non-negative safe integer", () => {
    expect(() => world(-1)).toThrow(CommentDeclarationError);
    expect(() => world(1.5)).toThrow(CommentDeclarationError);
  });
});
