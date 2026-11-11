/**
 * The UGC relation patterns (pulpit#200), over the in-memory seams:
 *
 * - Reshares: the target as its own leaf's `get` serves each viewer, and
 *   the placeholder (no id, no content) for one it hides; the reshare edge
 *   family itself still keeps `EDGE-001`; the sharing node's own gate; the
 *   batched read; the write gate on the sharer and `maxEdges: 1`.
 * - Accepted answers: the question's write gate, the answer-belongs-to-
 *   the-question constraint and one accepted answer per question.
 * - Bylines: an ordered collection of credited accounts that grants no
 *   write right on the node.
 *
 * @module tests/relations
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { defineCollection } from "../src/collections.ts";
import { defineEdgeOps, type EdgeRow, type EdgeValues } from "../src/edges.ts";
import { always } from "../src/filter.ts";
import { acceptedAnswerGate, defineReshares, nodeWriteGate } from "../src/relations.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/subtype.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryCollectionStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const tagOf = async <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
    : Option.none();
};

const anonymous: Viewer = Option.none();
const as = (account: typeof member): Viewer => Option.some(account);

/** A shared viewer and owned leaves over it, as one request's runtime would hold. */
const world = () => {
  let viewer: Viewer = anonymous;
  const viewerOf = Effect.sync(() => viewer);
  const leaf = (type: string, columns: ReadonlyArray<string>) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns, now: NOW });
    const ops = defineSubtype({
      type,
      access: ownedAccess(),
      chain,
      leaves,
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
    });
    return { leaves, ops };
  };
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  return { viewerOf, leaf, actAs };
};

// ── Reshares ──────────────────────────────────────────────────────────

const reshares = () => {
  const { viewerOf, leaf, actAs } = world();
  const posts = leaf("posts", ["visibility"]);
  const ends = {
    sharer: {
      column: "sharer",
      type: "posts",
      access: ownedAccess(),
      nodes: posts.leaves,
      maxEdges: 1,
    },
    target: { column: "target", type: "posts", access: ownedAccess(), nodes: posts.leaves },
  };
  const store = makeInMemoryEdgeStore({ ends, uniqueKey: ["sharer", "target"], now: NOW });
  const edges = defineEdgeOps({
    type: "reshares",
    ends,
    edges: store,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    values: (input: EdgeValues) => input,
    toResource: (row: EdgeRow) => row,
    writeGate: nodeWriteGate("sharer", "posts", posts.ops),
  });
  const reads = defineReshares({
    type: "reshares",
    sharer: posts.ops,
    target: posts.ops,
    edges: store,
    sharerColumn: "sharer",
    targetColumn: "target",
  });
  const post = (who: typeof member, visibility: string) =>
    run(actAs(as(who), posts.ops.create({ id: Option.none(), state: { visibility } }))).then(
      ({ id }) => id,
    );
  const share = (who: typeof member, sharer: string, target: string) =>
    actAs(as(who), edges.create({ sharer, target }));
  return { posts, edges, reads, actAs, post, share };
};

describe("reshares: the target through its own gate, or a placeholder", () => {
  it("shows a readable target, and nothing for a node that reshares nothing", async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const sharer = await r.post(otherMember, "public");
    const plain = await r.post(otherMember, "public");
    await run(r.share(otherMember, sharer, target));
    const shown = await run(r.actAs(anonymous, r.reads.targetOf(sharer)));
    expect(shown).toEqual(
      Option.some({ _tag: "Visible", target: expect.objectContaining({ id: target }) }),
    );
    expect(await run(r.actAs(anonymous, r.reads.targetOf(plain)))).toEqual(Option.none());
  });

  /** A reshare whose target has since gone private. */
  const hiddenTarget = async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const sharer = await r.post(otherMember, "public");
    await run(r.share(otherMember, sharer, target));
    await run(
      r.actAs(as(member), r.posts.ops.update({ id: target, patch: { visibility: "private" } })),
    );
    return { r, target, sharer };
  };

  it.each([
    { label: "anonymous", viewer: anonymous },
    { label: "a stranger", viewer: as({ id: "u-stranger", role: "user" }) },
    { label: "the sharer's owner", viewer: as(otherMember) },
  ])("a private target is the placeholder to $label", async ({ viewer }) => {
    const { r, sharer } = await hiddenTarget();
    // Exactly `{ _tag: "Unavailable" }`: neither the target's id nor its content.
    expect(await run(r.actAs(viewer, r.reads.targetOf(sharer)))).toEqual(
      Option.some({ _tag: "Unavailable" }),
    );
  });

  it.each([
    { label: "the target's owner", viewer: as(member) },
    { label: "a moderator", viewer: as(moderator) },
  ])("a private target is visible to $label", async ({ viewer }) => {
    const { r, target, sharer } = await hiddenTarget();
    expect(await run(r.actAs(viewer, r.reads.targetOf(sharer)))).toEqual(
      Option.some({ _tag: "Visible", target: expect.objectContaining({ id: target }) }),
    );
  });

  it("a tombstoned target is the placeholder below the rung that reads tombstones", async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const sharer = await r.post(otherMember, "public");
    await run(r.share(otherMember, sharer, target));
    await run(r.actAs(as(member), r.posts.ops.delete(target)));
    expect(await run(r.actAs(anonymous, r.reads.targetOf(sharer)))).toEqual(
      Option.some({ _tag: "Unavailable" }),
    );
  });

  it("the reshare edge itself keeps EDGE-001: a hidden target hides the edge", async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const sharer = await r.post(otherMember, "public");
    await run(r.share(otherMember, sharer, target));
    await run(
      r.actAs(as(member), r.posts.ops.update({ id: target, patch: { visibility: "private" } })),
    );
    const page = await run(
      r.actAs(anonymous, r.edges.list({ limit: 10, offset: 0, where: always })),
    );
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("a hidden sharing node is NodeNotFound, as its own get answers", async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const sharer = await r.post(otherMember, "private");
    await run(r.share(otherMember, sharer, target));
    expect(await tagOf(r.actAs(anonymous, r.reads.targetOf(sharer)))).toEqual(
      Option.some("NodeNotFound"),
    );
  });

  it("targetsOf answers a page in one pass, omitting hidden sharers and non-reshares", async () => {
    const r = reshares();
    const open = await r.post(member, "public");
    const closed = await r.post(member, "public");
    const sharesOpen = await r.post(otherMember, "public");
    const sharesClosed = await r.post(otherMember, "public");
    const hiddenSharer = await r.post(otherMember, "private");
    const plain = await r.post(otherMember, "public");
    await run(r.share(otherMember, sharesOpen, open));
    await run(r.share(otherMember, sharesClosed, closed));
    await run(r.share(otherMember, hiddenSharer, open));
    await run(
      r.actAs(as(member), r.posts.ops.update({ id: closed, patch: { visibility: "private" } })),
    );
    const page = await run(
      r.actAs(
        anonymous,
        r.reads.targetsOf([sharesOpen, sharesClosed, hiddenSharer, plain, sharesOpen]),
      ),
    );
    expect(HashMap.size(page)).toBe(2);
    expect(Option.map(HashMap.get(page, sharesOpen), (t) => t._tag)).toEqual(
      Option.some("Visible"),
    );
    expect(HashMap.get(page, sharesClosed)).toEqual(Option.some({ _tag: "Unavailable" }));
    expect(await run(r.actAs(anonymous, r.reads.targetsOf([])))).toEqual(HashMap.empty());
  });

  it("targetsOf reads nothing past MAX_SET_VALUES ids", async () => {
    const r = reshares();
    const ids = Arr.makeBy(1001, (i) => `p-${String(i)}`);
    expect(HashMap.size(await run(r.actAs(anonymous, r.reads.targetsOf(ids))))).toBe(0);
  });

  it("only a writer of the sharing node reshares from it, once", async () => {
    const r = reshares();
    const target = await r.post(member, "public");
    const other = await r.post(member, "public");
    const sharer = await r.post(otherMember, "public");
    expect(await tagOf(r.share(member, sharer, target))).toEqual(Option.some("Forbidden"));
    expect(await tagOf(r.actAs(anonymous, r.edges.create({ sharer, target })))).toEqual(
      Option.some("Unauthorized"),
    );
    await run(r.share(otherMember, sharer, target));
    expect(await tagOf(r.share(otherMember, sharer, other))).toEqual(
      Option.some("EdgeCardinalityExceeded"),
    );
    expect(Option.isSome(await run(r.actAs(as(moderator), r.reads.targetOf(sharer))))).toBe(true);
  });
});

// ── Accepted answers ──────────────────────────────────────────────────

const qanda = () => {
  const { viewerOf, leaf, actAs } = world();
  const questions = leaf("questions", ["visibility"]);
  const answers = leaf("answers", ["visibility", "questionId"]);
  const ends = {
    question: {
      column: "question",
      type: "questions",
      access: ownedAccess(),
      nodes: questions.leaves,
      maxEdges: 1,
    },
    answer: { column: "answer", type: "answers", access: ownedAccess(), nodes: answers.leaves },
  };
  const accepted = defineEdgeOps({
    type: "accepted-answers",
    ends,
    edges: makeInMemoryEdgeStore({ ends, uniqueKey: ["question", "answer"], now: NOW }),
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    values: (input: EdgeValues) => input,
    toResource: (row: EdgeRow) => row,
    writeGate: acceptedAnswerGate({
      questionType: "questions",
      questions: questions.ops,
      questionColumn: "question",
      answerColumn: "answer",
      answers: answers.leaves,
      parentColumn: "questionId",
    }),
  });
  const ask = (who: typeof member) =>
    run(
      actAs(as(who), questions.ops.create({ id: Option.none(), state: { visibility: "public" } })),
    ).then(({ id }) => id);
  const reply = (who: typeof member, questionId: string) =>
    run(
      actAs(
        as(who),
        answers.ops.create({ id: Option.none(), state: { visibility: "public", questionId } }),
      ),
    ).then(({ id }) => id);
  const accept = (who: Viewer, question: string, answer: string) =>
    actAs(who, accepted.create({ question, answer }));
  return { accepted, actAs, ask, reply, accept };
};

describe("accepted answers: the question's write gate and the answer's parent", () => {
  const writers = [
    { label: "the question's owner", viewer: as(member), outcome: Option.none() },
    { label: "a moderator", viewer: as(moderator), outcome: Option.none() },
    { label: "the answer's author", viewer: as(otherMember), outcome: Option.some("Forbidden") },
    { label: "anonymous", viewer: anonymous, outcome: Option.some("Unauthorized") },
  ] as const;

  it.each(writers)("$label accepting an answer", async ({ viewer, outcome }) => {
    const q = qanda();
    const question = await q.ask(member);
    const answer = await q.reply(otherMember, question);
    expect(await tagOf(q.accept(viewer, question, answer))).toEqual(outcome);
  });

  it("refuses an answer to another question, after the gate", async () => {
    const q = qanda();
    const question = await q.ask(member);
    const elsewhere = await q.ask(otherMember);
    const answer = await q.reply(otherMember, elsewhere);
    expect(await tagOf(q.accept(as(member), question, answer))).toEqual(
      Option.some("AnswerNotOfQuestion"),
    );
    // A stranger is refused by the gate first, so it learns nothing about the answer.
    expect(await tagOf(q.accept(as(otherMember), question, answer))).toEqual(
      Option.some("Forbidden"),
    );
  });

  it("holds one accepted answer per question; only a writer un-accepts it", async () => {
    const q = qanda();
    const question = await q.ask(member);
    const first = await q.reply(otherMember, question);
    const second = await q.reply(otherMember, question);
    const { id } = await run(q.accept(as(member), question, first));
    expect(await tagOf(q.accept(as(member), question, second))).toEqual(
      Option.some("EdgeCardinalityExceeded"),
    );
    expect(await tagOf(q.actAs(as(otherMember), q.accepted.delete(id)))).toEqual(
      Option.some("Forbidden"),
    );
    await run(q.actAs(as(member), q.accepted.delete(id)));
    expect(await tagOf(q.accept(as(member), question, second))).toEqual(Option.none());
  });
});

// ── Bylines ───────────────────────────────────────────────────────────

describe("bylines: credit only", () => {
  const bylines = async () => {
    const { leaf, actAs } = world();
    const posts = leaf("posts", ["visibility"]);
    const profiles = leaf("profiles", ["visibility"]);
    const byline = defineCollection({
      type: "post-authors",
      parent: posts.ops,
      members: profiles.ops,
      store: makeInMemoryCollectionStore(),
    });
    const post = await run(
      actAs(as(member), posts.ops.create({ id: Option.none(), state: { visibility: "public" } })),
    );
    const profile = await run(
      actAs(
        as(otherMember),
        profiles.ops.create({ id: Option.none(), state: { visibility: "public" } }),
      ),
    );
    return { posts, byline, actAs, post: post.id, profile: profile.id };
  };

  it("lists the credited authors to every reader of the node", async () => {
    const b = await bylines();
    await run(b.actAs(as(member), b.byline.append(b.post, b.profile)));
    const page = await run(b.actAs(anonymous, b.byline.list(b.post, { limit: 10, offset: 0 })));
    expect(page.rows.map((row) => row.memberId)).toEqual([b.profile]);
  });

  it("grants a credited co-author no write on the node or its byline", async () => {
    const b = await bylines();
    await run(b.actAs(as(member), b.byline.append(b.post, b.profile)));
    expect(
      await tagOf(
        b.actAs(
          as(otherMember),
          b.posts.ops.update({ id: b.post, patch: { visibility: "private" } }),
        ),
      ),
    ).toEqual(Option.some("Forbidden"));
    expect(await tagOf(b.actAs(as(otherMember), b.byline.remove(b.post, b.profile)))).toEqual(
      Option.some("Forbidden"),
    );
  });
});
