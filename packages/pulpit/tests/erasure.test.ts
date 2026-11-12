/**
 * Account erasure (pulpit#207) against the in-memory seams.
 *
 * - The owner's dispositions: an owned leaf's nodes are purged, a
 *   reference leaf's contributions reassigned to the tombstone account,
 *   and comments anonymised, so a reply under an erased member's comment
 *   keeps its thread.
 * - The chain stays append-only: every earlier version row is unchanged,
 *   and each node the account wrote gets exactly one redacting version
 *   (the head's state, attributed per the disposition, no `proposedBy`,
 *   declared account columns redacted). Nothing current stays attributed
 *   to the account: no owner record, no head version, no proposal, report,
 *   reaction, relationship or working copy.
 * - Proposals: pending, rejected and withdrawn ones go; an accepted one
 *   stays under the tombstone account.
 * - A re-run changes nothing and appends nothing; a run cut short at a
 *   batch boundary resumes to the same end state. A tombstoned node gets no
 *   redacting version until it is restored and erasure runs again (pulpit#303).
 * - Memberships (pulpit#274): more membership rows and invitations than a
 *   batch go in bounded batches, and an interrupted run resumes to one
 *   uninterrupted run's end state.
 * - Owned groups (pulpit#274, owner decision 2026-11-12): every group the
 *   account owns is reassigned to the tombstone account in bounded
 *   batches, before its memberships go, so the other members still read
 *   the group's rows; `disposeGroups` overrides the reassignment.
 * - The gate: anonymous, a refused actor and the tombstone account itself
 *   are refused before anything is read.
 * - The cache: an anonymised comment is evicted at its redacting version.
 *
 * @module tests/erasure
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
import { defineAccountErasure, ErasurePresets, type ErasureSummary } from "../src/erasure.ts";
import { audienceSeam } from "../src/audience.ts";
import type { ProposalRow } from "../src/proposals.ts";
import type { ReportRow } from "../src/moderation.ts";
import type { Viewer } from "../src/subtype.ts";
import type { VersionRow } from "../src/version-chain.ts";
import { NOW as AT } from "./fixtures.ts";
import {
  makeInMemoryAccountErasureStore,
  makeInMemoryDocumentStore,
  makeInMemoryGroupOwners,
  makeInMemoryLeafStore,
  makeInMemoryMembershipStore,
  makeInMemoryProposalStore,
  makeInMemoryPurgeStore,
  makeInMemoryReactionStore,
  makeInMemoryReportStore,
  makeInMemoryResourceCache,
  makeInMemorySocialStore,
  makeInMemoryVersionChain,
  makeInMemoryWorkingCopyStore,
} from "../src/testing.ts";
import { defineVersionChain } from "../src/version-chain.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const GONE = "u-gone";
const OTHER = "u-other";
const TOMBSTONE = "u-deleted";
const ADMIN: Viewer = Option.some({ id: "u-admin", role: "admin" });

/** One application: posts (owned, purged), comments (owned, anonymised), taxa (reference, reassigned). */
const makeWorld = () => {
  const postChain = makeInMemoryVersionChain("posts");
  const posts = makeInMemoryLeafStore(postChain, { columns: ["body"] });
  const commentChain = makeInMemoryVersionChain("comments");
  const comments = makeInMemoryLeafStore(commentChain, { columns: ["body", "parentId"] });
  const taxonChain = makeInMemoryVersionChain("taxa");
  const taxa = makeInMemoryLeafStore(taxonChain, { columns: ["name", "creditedTo"] });
  const documents = makeInMemoryDocumentStore();
  const proposals = makeInMemoryProposalStore({ chain: postChain, leaves: posts });
  const reports = makeInMemoryReportStore();
  const reactions = makeInMemoryReactionStore();
  const social = makeInMemorySocialStore();
  const workingCopies = makeInMemoryWorkingCopyStore();
  const memberships = makeInMemoryMembershipStore();
  const groups = makeInMemoryGroupOwners();
  const commentCache = makeInMemoryResourceCache<unknown>(() => true);
  const chains = [postChain, commentChain, taxonChain];
  const ops = {
    posts: defineVersionChain("posts", postChain),
    comments: defineVersionChain("comments", commentChain),
    taxa: defineVersionChain("taxa", taxonChain),
  };
  return {
    postChain,
    posts,
    commentChain,
    comments,
    taxonChain,
    taxa,
    documents,
    proposals,
    reports,
    reactions,
    social,
    workingCopies,
    memberships,
    groups,
    commentCache,
    chains,
    ops,
    erasure: (
      /* oxlint-disable effect/prefer-option-over-null -- the workspace's optional-field convention (AGENTS.md → Conventions), as in the definition under test */
      options: {
        readonly viewer?: Viewer | undefined;
        readonly batchSize?: number | undefined;
        readonly disposeGroups?: Option.Option<
          (query: {
            readonly accountId: string;
            readonly replacement: string;
            readonly limit: number;
          }) => Effect.Effect<number>
        >;
      } = {},
      /* oxlint-enable effect/prefer-option-over-null */
    ) =>
      defineAccountErasure({
        viewer: Effect.succeed(options.viewer ?? ADMIN),
        canErase: (actor, accountId) => actor.role === "admin" || actor.id === accountId,
        tombstoneAccountId: TOMBSTONE,
        transact: (effect) => effect,
        store: makeInMemoryAccountErasureStore([
          { type: "posts", chain: postChain, leaves: posts },
          { type: "comments", chain: commentChain, leaves: comments },
          { type: "taxa", chain: taxonChain, leaves: taxa },
        ]),
        purge: makeInMemoryPurgeStore({
          chains,
          documents,
          documentColumns: ["body"],
          dependents: [(id) => posts.dropOwner(id)],
        }),
        families: [
          { type: "posts", disposition: ErasurePresets.ownedLeaf, chain: postChain },
          {
            type: "comments",
            disposition: ErasurePresets.comments,
            chain: commentChain,
            cache: commentCache,
          },
          {
            type: "taxa",
            disposition: ErasurePresets.referenceLeaf,
            chain: taxonChain,
            accountColumns: ["creditedTo"],
          },
        ],
        proposals,
        reports,
        reactions,
        social,
        workingCopies,
        memberships,
        groups: Option.some(groups),
        disposeGroups: options.disposeGroups ?? Option.none(),
        relations: [{ name: "app.notifications", erase: () => Effect.succeed(0) }],
        batchSize: options.batchSize,
      }),
  };
};

type World = ReturnType<typeof makeWorld>;

const proposal = (
  id: string,
  authorId: string,
  status: ProposalRow["status"],
  targetId: string,
): ProposalRow => ({
  id,
  targetId,
  targetType: "posts",
  authorId,
  patch: {},
  locales: Option.none(),
  rationale: Option.none(),
  baseVersion: 0n,
  status,
  submittedAt: AT,
  decidedAt: status === "pending" ? Option.none() : Option.some(AT),
  decidedBy: status === "pending" ? Option.none() : Option.some(OTHER),
  decisionNote: Option.none(),
  appliedVersion: Option.none(),
});

const report = (id: string, reporterId: string, resolvedBy: Option.Option<string>): ReportRow => ({
  id,
  targetId: "n-1",
  targetType: "posts",
  reporterId,
  reason: "spam",
  details: Option.none(),
  status: Option.isSome(resolvedBy) ? "resolved" : "open",
  filedAt: AT,
  resolvedAt: Option.map(resolvedBy, () => AT),
  resolvedBy,
  resolutionNote: Option.none(),
});

/** Seed the world: the account owns, wrote, proposed, reported, reacted and followed. */
const seed = (world: World) =>
  Effect.gen(function* () {
    const { hash } = yield* world.documents.put({ text: "personal" });
    const mine = yield* world.ops.posts.create({
      id: Option.some("n-post-mine"),
      state: { body: hash },
      actorId: Option.some(GONE),
    });
    yield* world.posts.stampOwner(mine.id, GONE);
    const theirs = yield* world.ops.posts.create({
      id: Option.some("n-post-theirs"),
      state: { body: "theirs" },
      actorId: Option.some(OTHER),
    });
    yield* world.posts.stampOwner(theirs.id, OTHER);
    // The account, a moderator once, edited someone else's post.
    yield* world.ops.posts.update({
      id: theirs.id,
      patch: { body: "edited" },
      actorId: Option.some(GONE),
    });
    const comment = yield* world.ops.comments.create({
      id: Option.some("n-comment"),
      state: { body: "first", parentId: null },
      actorId: Option.some(GONE),
    });
    yield* world.comments.stampOwner(comment.id, GONE);
    const reply = yield* world.ops.comments.create({
      id: Option.some("n-reply"),
      state: { body: "reply", parentId: comment.id },
      actorId: Option.some(OTHER),
    });
    yield* world.comments.stampOwner(reply.id, OTHER);
    yield* world.commentCache.set(comment.id, { id: comment.id }, 0n);
    const taxon = yield* world.ops.taxa.create({
      id: Option.some("n-taxon"),
      state: { name: "Rosa", creditedTo: GONE },
      actorId: Option.some(GONE),
    });
    // An accepted proposal of theirs, applied by a curator.
    yield* world.ops.taxa.update({
      id: taxon.id,
      patch: { name: "Rosa canina" },
      actorId: Option.some(OTHER),
      proposedBy: Option.some(GONE),
    });
    yield* world.proposals.insert(proposal("p-pending", GONE, "pending", theirs.id));
    yield* world.proposals.insert(proposal("p-rejected", GONE, "rejected", theirs.id));
    yield* world.proposals.insert(proposal("p-accepted", GONE, "accepted", theirs.id));
    yield* world.proposals.insert(proposal("p-other", OTHER, "pending", theirs.id));
    // A proposal the account decided as a moderator: its row stays, the decider goes.
    yield* world.proposals.insert({
      ...proposal("p-decided", OTHER, "rejected", theirs.id),
      decidedBy: Option.some(GONE),
    });
    yield* world.reports.insert(report("r-filed", GONE, Option.none()));
    yield* world.reports.insert(report("r-resolved", OTHER, Option.some(GONE)));
    yield* world.reactions.upsert({
      nodeId: theirs.id,
      accountId: GONE,
      kind: "like",
      reactedAt: AT,
    });
    yield* world.reactions.upsert({
      nodeId: mine.id,
      accountId: OTHER,
      kind: "like",
      reactedAt: AT,
    });
    yield* world.social.add({ kind: "follow", from: GONE, to: OTHER, at: AT });
    yield* world.social.add({ kind: "follow", from: OTHER, to: GONE, at: AT });
    yield* world.social.add({ kind: "mute", from: OTHER, to: TOMBSTONE, at: AT });
    yield* world.memberships.add({ groupId: "g-1", accountId: GONE, role: "admin", at: AT });
    yield* world.memberships.add({ groupId: "g-1", accountId: OTHER, role: "member", at: AT });
    // A group the account owns, with its owner's own membership (audience's model).
    yield* world.groups.put("g-own", GONE);
    yield* world.memberships.add({ groupId: "g-own", accountId: GONE, role: "admin", at: AT });
    yield* world.memberships.add({ groupId: "g-own", accountId: OTHER, role: "member", at: AT });
    yield* world.workingCopies.put(
      { id: theirs.id, userId: GONE },
      { patch: {}, baseVersion: 0n, savedAt: AT },
    );
    return {
      mine: mine.id,
      theirs: theirs.id,
      comment: comment.id,
      reply: reply.id,
      taxon: taxon.id,
    };
  });

/** Each node's head row, in the order the chain first saw it. */
const heads = (world: World): ReadonlyArray<VersionRow> =>
  Arr.flatMap(world.chains, (chain) =>
    Arr.flatMap(Arr.dedupe(Arr.map(chain.rows(), (row) => row.id)), (id) =>
      Option.toArray(Arr.last(Arr.filter(chain.rows(), (row) => row.id === id))),
    ),
  );

/**
 * Every account id the world currently records: owner records, each head
 * version's attribution and declared account column, and every other
 * store. Earlier versions keep their attribution by design, so they are
 * not read here.
 */
const recordedAccounts = (world: World): ReadonlyArray<string> => [
  ...Arr.flatMap([world.posts, world.comments, world.taxa], (leaves) =>
    HashMap.toValues(leaves.owners()),
  ),
  ...Arr.flatMap(heads(world), (row) => [
    ...Option.toArray(row.actorId),
    ...Option.toArray(row.proposedBy),
    ...Arr.filter([row.state["creditedTo"]], P.isString),
  ]),
  ...Arr.flatMap(world.proposals.rows(), (row) => [row.authorId, ...Option.toArray(row.decidedBy)]),
  ...Arr.flatMap(world.reports.rows(), (row) => [
    row.reporterId,
    ...Option.toArray(row.resolvedBy),
  ]),
  ...Arr.map(world.reactions.rows(), (row) => row.accountId),
  ...Arr.flatMap(world.social.rows(), (row) => [row.from, row.to]),
  ...Arr.map(world.memberships.rows(), (row) => row.accountId),
  ...Arr.flatMap(world.memberships.pending(), (row) => [row.accountId, row.invitedBy]),
  ...HashMap.toValues(world.groups.owners()),
  ...Arr.map(Arr.fromIterable(HashMap.keys(world.workingCopies.copies())), (key) =>
    key.slice(key.indexOf(":") + 1),
  ),
];

const byGroupId = Order.mapInput(Order.String, ([groupId]: readonly [string, string]) => groupId);

/** The world's state, comparable across runs. */
const snapshot = (world: World) => ({
  // The seed runs on the wall clock, so two worlds differ only in their timestamps.
  rows: Arr.map(world.chains, (chain) =>
    Arr.map(chain.rows(), (row) => ({ ...row, timestamp: AT })),
  ),
  owners: Arr.map([world.posts, world.comments, world.taxa], (leaves) =>
    HashMap.toEntries(leaves.owners()),
  ),
  proposals: world.proposals.rows(),
  reports: world.reports.rows(),
  reactions: world.reactions.rows(),
  social: world.social.rows(),
  memberships: world.memberships.rows(),
  invitations: world.memberships.pending(),
  groups: Arr.sort(HashMap.toEntries(world.groups.owners()), byGroupId),
  copies: HashMap.toEntries(world.workingCopies.copies()),
  documents: HashMap.size(world.documents.stored()),
});

describe("defineAccountErasure", () => {
  it("leaves nothing recorded against the account", async () => {
    const world = makeWorld();
    await run(seed(world));
    expect(recordedAccounts(world)).toContain(GONE);
    const summary = await run(world.erasure().erase(GONE));
    expect(summary.complete).toBe(true);
    expect(recordedAccounts(world)).not.toContain(GONE);
  });

  it("purges the account's owned posts, document included, and anonymises its edit of another's", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    const summary = await run(world.erasure().erase(GONE));
    expect(Arr.map(summary.purged, (purged) => purged.id)).toEqual([ids.mine]);
    expect(summary.purged[0]?.documents.length).toBe(1);
    expect(Arr.filter(world.postChain.rows(), (row) => row.id === ids.mine)).toEqual([]);
    const edits = Arr.filter(world.postChain.rows(), (row) => row.id === ids.theirs);
    expect(Arr.map(edits, (row) => [row.action, row.state["body"], row.actorId])).toEqual([
      ["create", "theirs", Option.some(OTHER)],
      ["update", "edited", Option.some(GONE)],
      // The redacting version: the head's state, no actor.
      ["update", "edited", Option.none()],
    ]);
    expect(HashMap.get(world.posts.owners(), ids.theirs)).toEqual(Option.some(OTHER));
  });

  it("anonymises a comment: content and its reply survive, the owner record and the actor go", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    await run(world.erasure().erase(GONE));
    const comment = await run(world.comments.get(ids.comment));
    const reply = await run(world.comments.get(ids.reply));
    expect(Option.map(comment, (row) => [row["body"], row["ownerId"]])).toEqual(
      Option.some(["first", undefined]),
    );
    expect(Option.map(reply, (row) => [row["parentId"], row["ownerId"]])).toEqual(
      Option.some([ids.comment, OTHER]),
    );
    const versions = Arr.filter(world.commentChain.rows(), (row) => row.id === ids.comment);
    expect(Arr.map(versions, (row) => [row.version, row.actorId, row.state["body"]])).toEqual([
      [0n, Option.some(GONE), "first"],
      [1n, Option.none(), "first"],
    ]);
    expect(world.commentCache.get(ids.comment)).toEqual(Option.none());
    expect(world.commentCache.versionOf(ids.comment)).toEqual(Option.some(1n));
  });

  it("reassigns a reference contribution with a redacting version under the tombstone, its declared column redacted", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    await run(world.erasure().erase(GONE));
    const versions = Arr.filter(world.taxonChain.rows(), (row) => row.id === ids.taxon);
    expect(Arr.map(versions, (row) => [row.actorId, row.proposedBy, row.state])).toEqual([
      [Option.some(GONE), Option.none(), { name: "Rosa", creditedTo: GONE }],
      [Option.some(OTHER), Option.some(GONE), { name: "Rosa canina", creditedTo: GONE }],
      [Option.some(TOMBSTONE), Option.none(), { name: "Rosa canina", creditedTo: TOMBSTONE }],
    ]);
  });

  it("leaves every earlier version row unchanged and appends exactly one redacting version per node", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    // Every row of a node that survives (the account's own post is purged).
    const before = Arr.map(world.chains, (chain) =>
      Arr.filter(chain.rows(), (row) => row.id !== ids.mine),
    );
    await run(world.erasure().erase(GONE));
    const after = Arr.map(world.chains, (chain) => chain.rows());
    Arr.forEach(before, (rows, index) => {
      const kept = (after[index] ?? []).slice(0, rows.length);
      expect(kept).toEqual(rows);
      // The very same row objects: nothing was rewritten, not even to an equal value.
      Arr.forEach(rows, (row, at) => expect(kept[at]).toBe(row));
    });
    const appended = Arr.flatMap(after, (rows, index) => rows.slice((before[index] ?? []).length));
    expect(Arr.map(appended, (row) => [row.id, row.action, row.actorId, row.proposedBy])).toEqual([
      [ids.theirs, "update", Option.none(), Option.none()],
      [ids.comment, "update", Option.none(), Option.none()],
      [ids.taxon, "update", Option.some(TOMBSTONE), Option.none()],
    ]);
  });

  it("appends no redacting version to a tombstoned node", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    await run(world.ops.comments.delete(ids.comment, Option.some(GONE)));
    const before = world.commentChain.rows();
    const summary = await run(world.erasure().erase(GONE));
    expect(summary.complete).toBe(true);
    expect(world.commentChain.rows()).toEqual(before);
    expect(summary.changed["comments.redact"]).toBeUndefined();
  });

  it("redacts a tombstoned node on restore, when erasure is run again (pulpit#303)", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    await run(world.ops.comments.delete(ids.comment, Option.some(GONE)));
    await run(world.erasure().erase(GONE));
    await run(
      world.commentChain.restore({ id: ids.comment, patch: {}, actorId: Option.some(OTHER) }),
    );
    const before = world.commentChain.rows().length;
    const again = await run(world.erasure().erase(GONE));
    expect(again.complete).toBe(true);
    const appended = Arr.filter(
      world.commentChain.rows().slice(before),
      (row) => row.id === ids.comment,
    );
    expect(Arr.map(appended, (row) => [row.action, row.actorId, row.proposedBy])).toEqual([
      ["update", Option.none(), Option.none()],
    ]);
  });

  it("deletes pending, rejected and filed rows, and keeps an accepted proposal and a resolution under the tombstone", async () => {
    const world = makeWorld();
    await run(seed(world));
    await run(world.erasure().erase(GONE));
    expect(Arr.map(world.proposals.rows(), (row) => [row.id, row.authorId])).toEqual([
      ["p-accepted", TOMBSTONE],
      ["p-other", OTHER],
      ["p-decided", OTHER],
    ]);
    expect(
      Arr.map(
        Arr.filter(world.proposals.rows(), (row) => row.id === "p-decided"),
        (row) => row.decidedBy,
      ),
    ).toEqual([Option.some(TOMBSTONE)]);
    expect(Arr.map(world.reports.rows(), (row) => [row.id, row.resolvedBy])).toEqual([
      ["r-resolved", Option.some(TOMBSTONE)],
    ]);
    expect(Arr.map(world.reactions.rows(), (row) => row.accountId)).toEqual([OTHER]);
    expect(Arr.map(world.social.rows(), (row) => row.kind)).toEqual(["mute"]);
    expect(HashMap.size(world.workingCopies.copies())).toBe(0);
    expect(Arr.map(world.memberships.rows(), (row) => [row.groupId, row.accountId])).toEqual([
      ["g-1", OTHER],
      ["g-own", OTHER],
    ]);
    expect(HashMap.toEntries(world.groups.owners())).toEqual([["g-own", TOMBSTONE]]);
  });

  it("changes nothing when run again", async () => {
    const world = makeWorld();
    await run(seed(world));
    await run(world.erasure().erase(GONE));
    const before = snapshot(world);
    const rows = Arr.map(world.chains, (chain) => chain.rows().length);
    const again = await run(world.erasure().erase(GONE));
    expect(again).toMatchObject({ complete: true, changed: {}, purged: [] });
    expect(snapshot(world)).toEqual(before);
    expect(Arr.map(world.chains, (chain) => chain.rows().length)).toEqual(rows);
  });

  it("keeps a node redacted when another account writes after the redacting version", async () => {
    const world = makeWorld();
    const ids = await run(seed(world));
    await run(world.erasure().erase(GONE));
    await run(
      world.ops.comments.update({
        id: ids.comment,
        patch: { body: "moderated" },
        actorId: Option.some(OTHER),
      }),
    );
    const rows = world.commentChain.rows().length;
    const again = await run(world.erasure().erase(GONE));
    expect(again.changed).toEqual({});
    expect(world.commentChain.rows().length).toBe(rows);
  });

  it.each([1, 2, 3])(
    "resumes a run cut short every %i batches to the same end state",
    async (maxBatches) => {
      const whole = makeWorld();
      await run(seed(whole));
      await run(whole.erasure({ batchSize: 1 }).erase(GONE));

      const cut = makeWorld();
      await run(seed(cut));
      const erasure = cut.erasure({ batchSize: 1 });
      const runs = (count: number): Effect.Effect<number, unknown> =>
        Effect.flatMap(
          erasure.erase(GONE, { maxBatches }),
          (summary: ErasureSummary): Effect.Effect<number, unknown> =>
            summary.complete ? Effect.succeed(count) : runs(count + 1),
        );
      const passes = await run(runs(1));
      expect(passes).toBeGreaterThan(1);
      expect(snapshot(cut)).toEqual(snapshot(whole));
      expect(recordedAccounts(cut)).not.toContain(GONE);
    },
  );

  describe("memberships at a batch boundary (pulpit#274)", () => {
    const BATCH = 3;
    /** More of `GONE`'s membership rows than a batch: 4 memberships, 2 invitations to it, 2 from it. */
    const seedMemberships = (world: World) => {
      const { memberships } = world;
      const invite = (groupId: string, accountId: string, invitedBy: string) =>
        memberships.invite({ groupId, accountId, role: "member", invitedBy, at: AT });
      return Effect.all(
        [
          Effect.forEach(
            ["g-1", "g-2", "g-3", "g-4"],
            (groupId) =>
              Effect.andThen(
                memberships.add({ groupId, accountId: GONE, role: "admin", at: AT }),
                memberships.add({ groupId, accountId: OTHER, role: "member", at: AT }),
              ),
            { concurrency: 1 },
          ),
          Effect.forEach(["g-5", "g-6"], (groupId) => invite(groupId, GONE, OTHER), {
            concurrency: 1,
          }),
          Effect.forEach(
            ["u-invited-1", "u-invited-2"],
            (accountId) => invite("g-1", accountId, GONE),
            { concurrency: 1 },
          ),
          // An invitation neither to nor from the account stays.
          invite("g-2", "u-invited-3", OTHER),
        ],
        { concurrency: 1, discard: true },
      );
    };

    it("erases them in bounded batches, invitations counted against the same limit", async () => {
      const world = makeWorld();
      await run(seedMemberships(world));
      const summary = await run(world.erasure({ batchSize: BATCH }).erase(GONE));
      expect(summary.complete).toBe(true);
      expect(summary.changed).toEqual({ memberships: 8 });
      expect(Arr.map(world.memberships.rows(), (row) => row.accountId)).toEqual([
        OTHER,
        OTHER,
        OTHER,
        OTHER,
      ]);
      expect(Arr.map(world.memberships.pending(), (row) => row.accountId)).toEqual(["u-invited-3"]);
      expect(recordedAccounts(world)).not.toContain(GONE);
    });

    it.each([1, 2])(
      "resumes a run cut short every %i batches to one uninterrupted run's end state",
      async (maxBatches) => {
        const whole = makeWorld();
        await run(seedMemberships(whole));
        await run(whole.erasure({ batchSize: BATCH }).erase(GONE));

        const cut = makeWorld();
        await run(seedMemberships(cut));
        const erasure = cut.erasure({ batchSize: BATCH });
        const first = await run(erasure.erase(GONE, { maxBatches }));
        expect(first.complete).toBe(false);
        expect(first.changed).toEqual({ memberships: BATCH * maxBatches });
        const runs = (count: number): Effect.Effect<number, unknown> =>
          Effect.flatMap(
            erasure.erase(GONE, { maxBatches }),
            (summary: ErasureSummary): Effect.Effect<number, unknown> =>
              summary.complete ? Effect.succeed(count) : runs(count + 1),
          );
        expect(await run(runs(2))).toBeGreaterThan(1);
        expect(snapshot(cut)).toEqual(snapshot(whole));
        expect(recordedAccounts(cut)).not.toContain(GONE);
      },
    );
  });

  describe("owned groups at a batch boundary (pulpit#274)", () => {
    const BATCH = 2;
    const OWNED = ["g-a", "g-b", "g-c", "g-d", "g-e"];
    /** More groups owned by `GONE` than a batch, each with `GONE`'s own membership and `OTHER`'s; and one group `OTHER` owns. */
    const seedGroups = (world: World) =>
      Effect.andThen(
        Effect.forEach(
          OWNED,
          (groupId) =>
            Effect.all(
              [
                world.groups.put(groupId, GONE),
                world.memberships.add({ groupId, accountId: GONE, role: "admin", at: AT }),
                world.memberships.add({ groupId, accountId: OTHER, role: "member", at: AT }),
              ],
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        ),
        world.groups.put("g-theirs", OTHER),
      );
    const audience = (world: World) => audienceSeam(world.memberships);

    it("reassigns every group to the tombstone account before the memberships go, and its members keep their access", async () => {
      const world = makeWorld();
      await run(seedGroups(world));
      const summary = await run(world.erasure({ batchSize: BATCH }).erase(GONE));
      expect(summary.complete).toBe(true);
      expect(summary.changed).toEqual({ groups: OWNED.length, memberships: OWNED.length });
      expect(Arr.sort(HashMap.toEntries(world.groups.owners()), byGroupId)).toEqual([
        ...Arr.map(OWNED, (groupId) => [groupId, TOMBSTONE]),
        ["g-theirs", OTHER],
      ]);
      const seam = audience(world);
      // The tombstone account owns each group but holds no membership, so it reads nothing.
      const access = await run(
        Effect.forEach(
          OWNED,
          (groupId) =>
            Effect.all(
              [
                seam.isMember(OTHER, groupId),
                seam.isMember(GONE, groupId),
                seam.isMember(TOMBSTONE, groupId),
                world.groups.ownerOf(groupId),
              ],
              { concurrency: 1 },
            ),
          { concurrency: 1 },
        ),
      );
      expect(access).toEqual(Arr.map(OWNED, () => [true, false, false, Option.some(TOMBSTONE)]));
      expect(recordedAccounts(world)).not.toContain(GONE);
    });

    it("changes nothing when run again", async () => {
      const world = makeWorld();
      await run(seedGroups(world));
      await run(world.erasure({ batchSize: BATCH }).erase(GONE));
      const before = snapshot(world);
      const again = await run(world.erasure({ batchSize: BATCH }).erase(GONE));
      expect(again).toMatchObject({ complete: true, changed: {} });
      expect(snapshot(world)).toEqual(before);
    });

    it.each([1, 2])(
      "resumes a run cut short every %i batches to one uninterrupted run's end state",
      async (maxBatches) => {
        const whole = makeWorld();
        await run(seedGroups(whole));
        await run(whole.erasure({ batchSize: BATCH }).erase(GONE));

        const cut = makeWorld();
        await run(seedGroups(cut));
        const erasure = cut.erasure({ batchSize: BATCH });
        const first = await run(erasure.erase(GONE, { maxBatches }));
        expect(first.complete).toBe(false);
        expect(first.changed).toEqual({ groups: BATCH * maxBatches });
        // Cut short mid-reassignment: the account still holds its memberships, and no member lost access.
        expect(await run(audience(cut).isMember(OTHER, "g-a"))).toBe(true);
        const runs = (count: number): Effect.Effect<number, unknown> =>
          Effect.flatMap(
            erasure.erase(GONE, { maxBatches }),
            (summary: ErasureSummary): Effect.Effect<number, unknown> =>
              summary.complete ? Effect.succeed(count) : runs(count + 1),
          );
        expect(await run(runs(2))).toBeGreaterThan(1);
        expect(snapshot(cut)).toEqual(snapshot(whole));
        expect(recordedAccounts(cut)).not.toContain(GONE);
      },
    );

    it("runs the application's disposeGroups in the reassignment's place", async () => {
      const world = makeWorld();
      await run(seedGroups(world));
      // An application that deletes the groups instead: each with its memberships, a batch at a time.
      const deleteOwned = (query: {
        readonly accountId: string;
        readonly replacement: string;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const owned = Arr.take(
            Arr.sort(
              Arr.map(
                Arr.filter(
                  HashMap.toEntries(world.groups.owners()),
                  ([, ownerId]) => ownerId === query.accountId,
                ),
                ([groupId]) => groupId,
              ),
              Order.String,
            ),
            query.limit,
          );
          yield* Effect.forEach(
            owned,
            (groupId) =>
              Effect.andThen(world.memberships.removeGroup(groupId), world.groups.remove(groupId)),
            { concurrency: 1, discard: true },
          );
          return owned.length;
        });
      const summary = await run(
        world.erasure({ batchSize: BATCH, disposeGroups: Option.some(deleteOwned) }).erase(GONE),
      );
      expect(summary.complete).toBe(true);
      expect(summary.changed).toEqual({ groups: OWNED.length });
      expect(HashMap.toEntries(world.groups.owners())).toEqual([["g-theirs", OTHER]]);
      expect(world.memberships.rows()).toEqual([]);
      expect(await run(audience(world).isMember(OTHER, "g-a"))).toBe(false);
    });
  });

  it("refuses before reading anything", async () => {
    const world = makeWorld();
    await run(seed(world));
    const before = snapshot(world);
    const refusal = (viewer: Viewer, accountId: string) =>
      run(Effect.flip(world.erasure({ viewer }).erase(accountId))).then((error) => error._tag);
    expect(await refusal(Option.none(), GONE)).toBe("Unauthorized");
    expect(await refusal(Option.some({ id: OTHER, role: "user" }), GONE)).toBe("Forbidden");
    expect(await refusal(ADMIN, TOMBSTONE)).toBe("TombstoneErasure");
    expect(snapshot(world)).toEqual(before);
  });

  it("lets an actor the definition allows erase their own account", async () => {
    const world = makeWorld();
    await run(seed(world));
    const summary = await run(
      world.erasure({ viewer: Option.some({ id: GONE, role: "user" }) }).erase(GONE),
    );
    expect(summary.complete).toBe(true);
    expect(recordedAccounts(world)).not.toContain(GONE);
  });

  it("removes a dangling owner record whose chain is gone instead of looping on it", async () => {
    const world = makeWorld();
    await run(world.posts.stampOwner("n-orphan", GONE));
    const summary = await run(world.erasure({ batchSize: 1 }).erase(GONE));
    expect(summary).toMatchObject({ complete: true, purged: [], changed: { "posts.purge": 1 } });
    expect(HashMap.size(world.posts.owners())).toBe(0);
  });
});
