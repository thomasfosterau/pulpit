/**
 * The UGC relation patterns, over the in-memory seams:
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

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { defineCollection } from "../src/Collections.ts";
import { defineEdgeOps, type EdgeRow, type EdgeValues } from "../src/Edges.ts";
import { always } from "../src/Filter.ts";
import { acceptedAnswerGate, defineReshares, nodeWriteGate } from "../src/Relations.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryCollectionStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
      : Option.none();
  });

const anonymous: Viewer = Option.none();
const as = (account: typeof member): Viewer => Option.some(account);

/** A shared viewer and owned leaves over it, as one request's runtime would hold. */
const world = () => {
  let viewer: Viewer = anonymous;
  const viewerOf = Effect.sync(() => viewer);
  const leaf = (type: string, columns: ReadonlyArray<string>) => {
    const chain = makeInMemoryVersionChain(type);
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
    Effect.map(
      actAs(as(who), posts.ops.create({ id: Option.none(), state: { visibility } })),
      ({ id }) => id,
    );
  const share = (who: typeof member, sharer: string, target: string) =>
    actAs(as(who), edges.create({ sharer, target }));
  return { posts, edges, reads, actAs, post, share };
};

describe("reshares: the target through its own gate, or a placeholder", () => {
  it.effect("shows a readable target, and nothing for a node that reshares nothing", () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "public");
      const plain = yield* r.post(otherMember, "public");
      yield* r.share(otherMember, sharer, target);
      const shown = yield* r.actAs(anonymous, r.reads.targetOf(sharer));
      expect(shown).toEqual(
        Option.some({ _tag: "Visible", target: expect.objectContaining({ id: target }) }),
      );
      expect(yield* r.actAs(anonymous, r.reads.targetOf(plain))).toEqual(Option.none());
    }),
  );

  /** A reshare whose target has since gone private. */
  const hiddenTarget = () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "public");
      yield* r.share(otherMember, sharer, target);
      yield* r.actAs(
        as(member),
        r.posts.ops.update({ id: target, patch: { visibility: "private" } }),
      );
      return { r, target, sharer };
    });

  it.effect.each([
    { label: "anonymous", viewer: anonymous },
    { label: "a stranger", viewer: as({ id: "u-stranger", role: "user" }) },
    { label: "the sharer's owner", viewer: as(otherMember) },
  ])("a private target is the placeholder to $label", ({ viewer }) =>
    Effect.gen(function* () {
      const { r, sharer } = yield* hiddenTarget();
      // Exactly `{ _tag: "Unavailable" }`: neither the target's id nor its content.
      expect(yield* r.actAs(viewer, r.reads.targetOf(sharer))).toEqual(
        Option.some({ _tag: "Unavailable" }),
      );
    }),
  );

  it.effect.each([
    { label: "the target's owner", viewer: as(member) },
    { label: "a moderator", viewer: as(moderator) },
  ])("a private target is visible to $label", ({ viewer }) =>
    Effect.gen(function* () {
      const { r, target, sharer } = yield* hiddenTarget();
      expect(yield* r.actAs(viewer, r.reads.targetOf(sharer))).toEqual(
        Option.some({ _tag: "Visible", target: expect.objectContaining({ id: target }) }),
      );
    }),
  );

  it.effect("a tombstoned target is the placeholder below the rung that reads tombstones", () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "public");
      yield* r.share(otherMember, sharer, target);
      yield* r.actAs(as(member), r.posts.ops.delete(target));
      expect(yield* r.actAs(anonymous, r.reads.targetOf(sharer))).toEqual(
        Option.some({ _tag: "Unavailable" }),
      );
    }),
  );

  it.effect("the reshare edge itself keeps EDGE-001: a hidden target hides the edge", () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "public");
      yield* r.share(otherMember, sharer, target);
      yield* r.actAs(
        as(member),
        r.posts.ops.update({ id: target, patch: { visibility: "private" } }),
      );
      const page = yield* r.actAs(anonymous, r.edges.list({ limit: 10, offset: 0, where: always }));
      expect(page.rows).toEqual([]);
      expect(page.total).toBe(0);
    }),
  );

  it.effect("a hidden sharing node is NodeNotFound, as its own get answers", () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "private");
      yield* r.share(otherMember, sharer, target);
      expect(yield* tagOf(r.actAs(anonymous, r.reads.targetOf(sharer)))).toEqual(
        Option.some("NodeNotFound"),
      );
    }),
  );

  it.effect("targetsOf answers a page in one pass, omitting hidden sharers and non-reshares", () =>
    Effect.gen(function* () {
      const r = reshares();
      const open = yield* r.post(member, "public");
      const closed = yield* r.post(member, "public");
      const sharesOpen = yield* r.post(otherMember, "public");
      const sharesClosed = yield* r.post(otherMember, "public");
      const hiddenSharer = yield* r.post(otherMember, "private");
      const plain = yield* r.post(otherMember, "public");
      yield* r.share(otherMember, sharesOpen, open);
      yield* r.share(otherMember, sharesClosed, closed);
      yield* r.share(otherMember, hiddenSharer, open);
      yield* r.actAs(
        as(member),
        r.posts.ops.update({ id: closed, patch: { visibility: "private" } }),
      );
      const page = yield* r.actAs(
        anonymous,
        r.reads.targetsOf([sharesOpen, sharesClosed, hiddenSharer, plain, sharesOpen]),
      );
      expect(HashMap.size(page)).toBe(2);
      expect(Option.map(HashMap.get(page, sharesOpen), (t) => t._tag)).toEqual(
        Option.some("Visible"),
      );
      expect(HashMap.get(page, sharesClosed)).toEqual(Option.some({ _tag: "Unavailable" }));
      expect(yield* r.actAs(anonymous, r.reads.targetsOf([]))).toEqual(HashMap.empty());
    }),
  );

  it.effect("targetsOf reads nothing past MAX_SET_VALUES ids", () =>
    Effect.gen(function* () {
      const r = reshares();
      const ids = Arr.makeBy(1001, (i) => `p-${String(i)}`);
      expect(HashMap.size(yield* r.actAs(anonymous, r.reads.targetsOf(ids)))).toBe(0);
    }),
  );

  it.effect("only a writer of the sharing node reshares from it, once", () =>
    Effect.gen(function* () {
      const r = reshares();
      const target = yield* r.post(member, "public");
      const other = yield* r.post(member, "public");
      const sharer = yield* r.post(otherMember, "public");
      expect(yield* tagOf(r.share(member, sharer, target))).toEqual(Option.some("Forbidden"));
      expect(yield* tagOf(r.actAs(anonymous, r.edges.create({ sharer, target })))).toEqual(
        Option.some("Unauthorized"),
      );
      yield* r.share(otherMember, sharer, target);
      expect(yield* tagOf(r.share(otherMember, sharer, other))).toEqual(
        Option.some("EdgeCardinalityExceeded"),
      );
      expect(Option.isSome(yield* r.actAs(as(moderator), r.reads.targetOf(sharer)))).toBe(true);
    }),
  );
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
    Effect.map(
      actAs(as(who), questions.ops.create({ id: Option.none(), state: { visibility: "public" } })),
      ({ id }) => id,
    );
  const reply = (who: typeof member, questionId: string) =>
    Effect.map(
      actAs(
        as(who),
        answers.ops.create({ id: Option.none(), state: { visibility: "public", questionId } }),
      ),
      ({ id }) => id,
    );
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

  it.effect.each(writers)("$label accepting an answer", ({ viewer, outcome }) =>
    Effect.gen(function* () {
      const q = qanda();
      const question = yield* q.ask(member);
      const answer = yield* q.reply(otherMember, question);
      expect(yield* tagOf(q.accept(viewer, question, answer))).toEqual(outcome);
    }),
  );

  it.effect("refuses an answer to another question, after the gate", () =>
    Effect.gen(function* () {
      const q = qanda();
      const question = yield* q.ask(member);
      const elsewhere = yield* q.ask(otherMember);
      const answer = yield* q.reply(otherMember, elsewhere);
      expect(yield* tagOf(q.accept(as(member), question, answer))).toEqual(
        Option.some("AnswerNotOfQuestion"),
      );
      // A stranger is refused by the gate first, so it learns nothing about the answer.
      expect(yield* tagOf(q.accept(as(otherMember), question, answer))).toEqual(
        Option.some("Forbidden"),
      );
    }),
  );

  it.effect("holds one accepted answer per question; only a writer un-accepts it", () =>
    Effect.gen(function* () {
      const q = qanda();
      const question = yield* q.ask(member);
      const first = yield* q.reply(otherMember, question);
      const second = yield* q.reply(otherMember, question);
      const { id } = yield* q.accept(as(member), question, first);
      expect(yield* tagOf(q.accept(as(member), question, second))).toEqual(
        Option.some("EdgeCardinalityExceeded"),
      );
      expect(yield* tagOf(q.actAs(as(otherMember), q.accepted.delete(id)))).toEqual(
        Option.some("Forbidden"),
      );
      yield* q.actAs(as(member), q.accepted.delete(id));
      expect(yield* tagOf(q.accept(as(member), question, second))).toEqual(Option.none());
    }),
  );
});

// ── Bylines ───────────────────────────────────────────────────────────

describe("bylines: credit only", () => {
  const bylines = () =>
    Effect.gen(function* () {
      const { leaf, actAs } = world();
      const posts = leaf("posts", ["visibility"]);
      const profiles = leaf("profiles", ["visibility"]);
      const byline = defineCollection({
        type: "post-authors",
        parent: posts.ops,
        members: profiles.ops,
        store: makeInMemoryCollectionStore(),
      });
      const post = yield* actAs(
        as(member),
        posts.ops.create({ id: Option.none(), state: { visibility: "public" } }),
      );
      const profile = yield* actAs(
        as(otherMember),
        profiles.ops.create({ id: Option.none(), state: { visibility: "public" } }),
      );
      return { posts, byline, actAs, post: post.id, profile: profile.id };
    });

  it.effect("lists the credited authors to every reader of the node", () =>
    Effect.gen(function* () {
      const b = yield* bylines();
      yield* b.actAs(as(member), b.byline.append(b.post, b.profile));
      const page = yield* b.actAs(anonymous, b.byline.list(b.post, { limit: 10, offset: 0 }));
      expect(page.rows.map((row) => row.memberId)).toEqual([b.profile]);
    }),
  );

  it.effect("grants a credited co-author no write on the node or its byline", () =>
    Effect.gen(function* () {
      const b = yield* bylines();
      yield* b.actAs(as(member), b.byline.append(b.post, b.profile));
      expect(
        yield* tagOf(
          b.actAs(
            as(otherMember),
            b.posts.ops.update({ id: b.post, patch: { visibility: "private" } }),
          ),
        ),
      ).toEqual(Option.some("Forbidden"));
      expect(yield* tagOf(b.actAs(as(otherMember), b.byline.remove(b.post, b.profile)))).toEqual(
        Option.some("Forbidden"),
      );
    }),
  );
});
