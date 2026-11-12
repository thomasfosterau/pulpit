/**
 * Notifications (pulpit#197): the outbox is written inside the triggering
 * write and gone when it rolls back; each kernel kind is derived from its
 * module's write; fan-out tells a recipient only what they may read, and
 * never what they muted or a blocked or muted actor did; the inbox pages,
 * counts and marks read; a re-run sweeps nothing twice.
 *
 * @module tests/notifications
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import {
  accountSubject,
  commentRepliedHook,
  contentFlagged,
  defineNotifications,
  emitting,
  followCreated,
  mentionDrafts,
  moderationDecidedHook,
  nodeSubject,
  notificationHook,
  proposalDecided,
  socialSuppression,
  subjectGateFromGet,
  type KernelNotificationKind,
  type NotificationDraft,
  type NotificationPreferences,
} from "../src/notifications.ts";
import type { ProposalRow } from "../src/proposals.ts";
import {
  defineSubtype,
  ownedAccess,
  WriteRejected,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  makeInMemoryDelivery,
  makeInMemoryFollowers,
  makeInMemoryInbox,
  makeInMemoryLeafStore,
  makeInMemoryOutbox,
  makeInMemoryPreferenceStore,
  makeInMemoryReportStore,
  makeInMemorySocialStore,
  makeInMemoryVersionChain,
  type InMemoryFollowing,
} from "../src/testing.ts";
import type { ChainState, VersionSnapshot } from "../src/version-chain.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failureTag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  run(Effect.match(effect, { onFailure: (error) => error._tag, onSuccess: () => "success" }));

/** A posts leaf whose hooks are `before`, with a mutable viewer. */
const postsLeaf = (before: ReadonlyArray<BeforeWriteHook<never, never>>) => {
  const chain = makeInMemoryVersionChain("posts");
  const leaves = makeInMemoryLeafStore(chain, { columns: ["body", "visibility"], now: NOW });
  let viewer: Viewer = Option.none();
  const posts = defineSubtype<LeafRow, LeafRow, InMemoryFollowing, never, never>({
    type: "posts",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
    hooks: Effect.succeed({ before, after: [] }),
  });
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  return { chain, posts, as };
};

const draftTo = (recipientId: string): NotificationDraft => ({
  kind: "comment.replied",
  recipientId,
  actorId: Option.some(member.id),
  subject: nodeSubject("posts", "p-1"),
});

const refuse: BeforeWriteHook<never, never> = {
  name: "refuse",
  run: (event) =>
    Effect.fail(
      new WriteRejected({ type: event.type, id: event.id, action: event.action, reason: "NO" }),
    ),
  locales: (event) => Effect.succeed(event.locales ?? {}),
};

// ── The outbox and the transaction ────────────────────────────────────

describe("the outbox is written inside the write (a rollback notifies nobody)", () => {
  const always = (outbox: ReturnType<typeof makeInMemoryOutbox<KernelNotificationKind>>) =>
    notificationHook({
      name: "always",
      outbox,
      derive: () => Effect.succeed([draftTo(otherMember.id)]),
    });

  it("a committed write leaves its event", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const { posts, as } = postsLeaf([always(outbox)]);
    await run(
      outbox.transact(
        as(
          Option.some(member),
          posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
        ),
      ),
    );
    expect(Arr.map(outbox.events(), (event) => event.recipientId)).toEqual([otherMember.id]);
  });

  it("a later hook's refusal leaves no event", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const { posts, as } = postsLeaf([always(outbox), refuse]);
    const tag = await failureTag(
      outbox.transact(
        as(
          Option.some(member),
          posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
        ),
      ),
    );
    expect(tag).toBe("WriteRejected");
    expect(outbox.events()).toEqual([]);
  });

  it("a lost race at the append leaves no event", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const { chain, posts, as } = postsLeaf([always(outbox)]);
    const { id } = await run(
      as(
        Option.some(member),
        posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
      ),
    );
    const before = outbox.events().length;
    chain.raceNextAppend(id);
    const tag = await failureTag(
      outbox.transact(as(Option.some(member), posts.update({ id, patch: { body: "Yo" } }))),
    );
    expect(["VersionConflict", "StaleVersion"]).toContain(tag);
    expect(outbox.events().length).toBe(before);
  });

  it("emitting enqueues after its write, and a failed derive rolls both back", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    await run(
      outbox.transact(
        emitting(outbox, Effect.succeed(1), () => Effect.succeed([draftTo(otherMember.id)])),
      ),
    );
    expect(outbox.events().length).toBe(1);
    await run(
      Effect.ignore(
        outbox.transact(
          emitting(outbox, outbox.enqueue([draftTo(moderator.id)], NOW), () =>
            Effect.fail("derive failed"),
          ),
        ),
      ),
    );
    expect(outbox.events().length).toBe(1);
  });

  it("a draft addressed to its own actor is dropped", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    await run(emitting(outbox, Effect.void, () => Effect.succeed([draftTo(member.id)])));
    expect(outbox.events()).toEqual([]);
  });
});

// ── The kernel kinds ──────────────────────────────────────────────────

const event = (
  overrides: Partial<BeforeWriteEvent> & { readonly patch: ChainState },
): BeforeWriteEvent => ({
  action: "create",
  id: "c-2",
  type: "comments",
  prior: Option.none(),
  actorId: Option.some(otherMember.id),
  viewer: Option.some(otherMember),
  ...overrides,
});

const head = (state: ChainState): Option.Option<VersionSnapshot> =>
  Option.some({ version: 0n, action: "create", timestamp: NOW, state });

const runHook = async (hook: BeforeWriteHook<never, never>, at: BeforeWriteEvent) => {
  await run(hook.run(at));
};

describe("each kernel kind is derived from its module's write", () => {
  it("comment.replied: a reply notifies the parent's author; a top-level comment nobody", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const hook = commentRepliedHook({
      outbox,
      authorOf: (parentId) =>
        Effect.succeed(parentId === "c-1" ? Option.some(member.id) : Option.none()),
    });
    await runHook(hook, event({ patch: { body: "top", parentId: null } }));
    await runHook(hook, event({ patch: { body: "re", parentId: "c-1" } }));
    await runHook(hook, event({ action: "update", patch: { parentId: "c-1" } }));
    expect(outbox.events()).toMatchObject([
      {
        kind: "comment.replied",
        recipientId: member.id,
        actorId: Option.some(otherMember.id),
        subject: nodeSubject("comments", "c-2"),
      },
    ]);
  });

  it("comment.moderated: a move to approved or rejected notifies the owner, once", async () => {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const hook = moderationDecidedHook({
      outbox,
      kind: "comment.moderated",
      column: "moderationState",
      ownerColumn: "ownerId",
    });
    const pending = head({ moderationState: "pending", ownerId: member.id });
    const at = (state: string, prior = pending) =>
      event({
        action: "update",
        prior,
        viewer: Option.some(moderator),
        patch: { moderationState: state },
      });
    await runHook(hook, at("approved"));
    await runHook(hook, at("rejected"));
    await runHook(hook, at("pending"));
    await runHook(hook, at("approved", head({ moderationState: "approved", ownerId: member.id })));
    expect(Arr.map(outbox.events(), (stored) => stored.recipientId)).toEqual([
      member.id,
      member.id,
    ]);
  });

  it("content.flagged: a filed report notifies each moderator", async () => {
    const reports = makeInMemoryReportStore();
    await run(
      reports.insert({
        id: "r-1",
        targetId: "p-1",
        targetType: "posts",
        reporterId: otherMember.id,
        reason: "spam",
        details: Option.none(),
        status: "open",
        filedAt: NOW,
        resolvedAt: Option.none(),
        resolvedBy: Option.none(),
        resolutionNote: Option.none(),
      }),
    );
    const derive = contentFlagged({
      reports,
      moderators: Effect.succeed([moderator.id, "u-mod-2"]),
    });
    expect(await run(derive({ id: "r-1" }))).toEqual([
      {
        kind: "content.flagged",
        recipientId: moderator.id,
        actorId: Option.some(otherMember.id),
        subject: nodeSubject("posts", "p-1"),
      },
      {
        kind: "content.flagged",
        recipientId: "u-mod-2",
        actorId: Option.some(otherMember.id),
        subject: nodeSubject("posts", "p-1"),
      },
    ]);
    expect(await run(derive({ id: "missing" }))).toEqual([]);
  });

  const proposal = (status: ProposalRow["status"]): ProposalRow => ({
    id: "pr-1",
    targetId: "p-1",
    targetType: "posts",
    authorId: otherMember.id,
    patch: {},
    locales: Option.none(),
    rationale: Option.none(),
    baseVersion: 0n,
    status,
    submittedAt: NOW,
    decidedAt: Option.some(NOW),
    decidedBy: Option.some(member.id),
    decisionNote: Option.none(),
    appliedVersion: Option.none(),
  });

  it.each(["accepted", "rejected"] as const)(
    "proposal.decided: %s notifies the author",
    async (status) => {
      const store = {
        get: () => Effect.succeedSome({ row: proposal(status), targetVersion: Option.none() }),
      };
      expect(await run(proposalDecided(store, "pr-1")())).toEqual([
        {
          kind: "proposal.decided",
          recipientId: otherMember.id,
          actorId: Option.some(member.id),
          subject: nodeSubject("posts", "p-1"),
        },
      ]);
    },
  );

  it.each(["pending", "withdrawn"] as const)(
    "proposal.decided: %s notifies nobody",
    async (status) => {
      const store = {
        get: () => Effect.succeedSome({ row: proposal(status), targetVersion: Option.none() }),
      };
      expect(await run(proposalDecided(store, "pr-1")())).toEqual([]);
    },
  );

  it("follow.created: a changed follow notifies the followed account", async () => {
    const derive = followCreated(Effect.succeedSome(otherMember), member.id);
    expect(await run(derive({ changed: true }))).toEqual([
      {
        kind: "follow.created",
        recipientId: member.id,
        actorId: Option.some(otherMember.id),
        subject: accountSubject(otherMember.id),
      },
    ]);
    expect(await run(derive({ changed: false }))).toEqual([]);
  });

  it("mention.created: one draft per mentioned account", () => {
    expect(
      Arr.map(
        mentionDrafts({
          mentioned: [member.id, moderator.id, member.id],
          actorId: Option.some(otherMember.id),
          subject: nodeSubject("posts", "p-1"),
        }),
        (draft) => `${draft.kind} ${draft.recipientId}`,
      ),
    ).toEqual([`mention.created ${member.id}`, `mention.created ${moderator.id}`]);
  });
});

// ── Fan-out ───────────────────────────────────────────────────────────

const accounts: ReadonlyArray<ViewerAccount> = [member, otherMember, moderator];

const fanOut = async (
  preferences: ReadonlyArray<readonly [string, NotificationPreferences]> = [],
) => {
  const outbox = makeInMemoryOutbox<KernelNotificationKind>();
  const inbox = makeInMemoryInbox<KernelNotificationKind>();
  const delivery = makeInMemoryDelivery<KernelNotificationKind>();
  const prefs = makeInMemoryPreferenceStore();
  const social = makeInMemorySocialStore();
  await run(Effect.forEach(preferences, ([id, value]) => prefs.set(id, value), { concurrency: 1 }));
  const { posts, as } = postsLeaf([]);
  const asRecipient =
    (recipientId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() =>
        as(
          Arr.findFirst(accounts, (account) => account.id === recipientId),
          Effect.void,
        ).pipe(Effect.andThen(effect)),
      );
  let viewer: Viewer = Option.none();
  const notifications = defineNotifications({
    outbox,
    inbox,
    preferences: prefs,
    delivery,
    subjects: { posts: subjectGateFromGet(posts.get, asRecipient) },
    suppression: Option.some(socialSuppression(social)),
    defaults,
    viewer: Effect.sync(() => viewer),
  });
  const post = (visibility: string) =>
    run(
      Effect.map(
        as(
          Option.some(member),
          posts.create({ id: Option.none(), state: { body: "x", visibility } }),
        ),
        (write) => write.id,
      ),
    );
  const notify = (drafts: ReadonlyArray<NotificationDraft>) => run(outbox.enqueue(drafts, NOW));
  const viewAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    run(
      Effect.suspend(() => {
        viewer = who;
        return effect;
      }),
    );
  return { outbox, inbox, delivery, social, notifications, post, notify, viewAs };
};

const defaults: NotificationPreferences = { channels: ["push"], mutedKinds: [] };

const toOther = (subjectId: string, kind: KernelNotificationKind = "comment.replied") => ({
  kind,
  recipientId: otherMember.id,
  actorId: Option.some(member.id),
  subject: nodeSubject("posts", subjectId),
});

describe("fan-out tells a recipient only what they may read", () => {
  it("a readable subject reaches the inbox and each enabled channel", async () => {
    const { inbox, delivery, notifications, post, notify } = await fanOut([
      [otherMember.id, { channels: ["push", "email"], mutedKinds: [] }],
    ]);
    await notify([toOther(await post("public"))]);
    expect(await run(notifications.sweep(10))).toEqual({
      processed: 1,
      delivered: 2,
      suppressed: 0,
    });
    expect(inbox.entries().length).toBe(1);
    expect(Arr.map(delivery.deliveries(), (delivered) => delivered.channel)).toEqual([
      "push",
      "email",
    ]);
  });

  it("a subject the recipient can't read is dropped; the rung reads it", async () => {
    const { inbox, notifications, post, notify } = await fanOut();
    const hidden = await post("private");
    await notify([toOther(hidden), { ...toOther(hidden), recipientId: moderator.id }]);
    expect(await run(notifications.sweep(10))).toMatchObject({ processed: 2, suppressed: 1 });
    expect(Arr.map(inbox.entries(), (entry) => entry.event.recipientId)).toEqual([moderator.id]);
  });

  it("a node subject of an undeclared type is dropped; an account subject is not gated", async () => {
    const { inbox, notifications, notify } = await fanOut();
    await notify([
      { ...toOther("x"), subject: nodeSubject("albums", "a-1") },
      { ...toOther("x"), kind: "follow.created", subject: accountSubject(member.id) },
    ]);
    await run(notifications.sweep(10));
    expect(Arr.map(inbox.entries(), (entry) => entry.event.kind)).toEqual(["follow.created"]);
  });

  it("a muted kind writes nothing; a recipient with no channels gets the inbox alone", async () => {
    const { inbox, delivery, notifications, post, notify } = await fanOut([
      [otherMember.id, { channels: [], mutedKinds: ["proposal.decided"] }],
    ]);
    const id = await post("public");
    await notify([toOther(id, "proposal.decided"), toOther(id)]);
    expect(await run(notifications.sweep(10))).toEqual({
      processed: 2,
      delivered: 0,
      suppressed: 1,
    });
    expect(Arr.map(inbox.entries(), (entry) => entry.event.kind)).toEqual(["comment.replied"]);
    expect(delivery.deliveries()).toEqual([]);
  });

  it.each([
    ["the recipient muted the actor", "mute", otherMember.id, member.id],
    ["the recipient blocked the actor", "block", otherMember.id, member.id],
    ["the actor blocked the recipient", "block", member.id, otherMember.id],
  ] as const)("suppressed when %s", async (_label, kind, from, to) => {
    const { inbox, social, notifications, post, notify } = await fanOut();
    await run(social.add({ kind, from, to, at: NOW }));
    await notify([toOther(await post("public"))]);
    expect(await run(notifications.sweep(10))).toMatchObject({ suppressed: 1 });
    expect(inbox.entries()).toEqual([]);
  });

  it("a re-run sweeps nothing twice, and a batch is bounded", async () => {
    const { inbox, delivery, notifications, post, notify } = await fanOut();
    const id = await post("public");
    await notify([toOther(id), toOther(id), toOther(id)]);
    expect(await run(notifications.sweep(2))).toMatchObject({ processed: 2 });
    expect(await run(notifications.sweep(10))).toMatchObject({ processed: 1 });
    expect(await run(notifications.sweep(10))).toEqual({
      processed: 0,
      delivered: 0,
      suppressed: 0,
    });
    expect(inbox.entries().length).toBe(3);
    expect(delivery.deliveries().length).toBe(3);
  });

  it("a re-added event writes no second inbox entry", async () => {
    const { inbox, notifications, post, notify, outbox } = await fanOut();
    await notify([toOther(await post("public"))]);
    await run(notifications.sweep(10));
    const [stored] = outbox.events();
    expect(stored === undefined ? true : await run(inbox.add(stored))).toBe(false);
  });
});

// ── The inbox ─────────────────────────────────────────────────────────

describe("the inbox is the viewer's own", () => {
  const seeded = async () => {
    const harness = await fanOut();
    const id = await harness.post("public");
    await harness.notify([toOther(id), toOther(id), toOther(id)]);
    await run(harness.notifications.sweep(10));
    return harness;
  };

  it("pages newest first, counts unread and marks read only its own entries", async () => {
    const { notifications, viewAs, outbox } = await seeded();
    const other = Option.some(otherMember);
    const page = await viewAs(
      other,
      notifications.inbox({ unreadOnly: false, limit: 2, offset: 0 }),
    );
    expect(page.total).toBe(3);
    expect(Arr.map(page.rows, (entry) => entry.event.id)).toEqual(["n-000003", "n-000002"]);
    expect(await viewAs(other, notifications.unreadCount)).toBe(3);
    const ids = Arr.map(outbox.events(), (stored) => stored.id);
    expect(await viewAs(Option.some(member), notifications.markRead(ids))).toBe(0);
    expect(await viewAs(other, notifications.markRead(Arr.take(ids, 2)))).toBe(2);
    expect(await viewAs(other, notifications.markRead(Arr.take(ids, 2)))).toBe(0);
    expect(await viewAs(other, notifications.unreadCount)).toBe(1);
    const unread = await viewAs(
      other,
      notifications.inbox({ unreadOnly: true, limit: 50, offset: 0 }),
    );
    expect(Arr.map(unread.rows, (entry) => entry.event.id)).toEqual(["n-000003"]);
  });

  it("preferences default until set, and are the viewer's own", async () => {
    const { notifications, viewAs } = await seeded();
    const other = Option.some(otherMember);
    expect(await viewAs(other, notifications.preferences)).toEqual(defaults);
    const muted: NotificationPreferences = { channels: ["email"], mutedKinds: ["follow.created"] };
    await viewAs(other, notifications.setPreferences(muted));
    expect(await viewAs(other, notifications.preferences)).toEqual(muted);
    expect(await viewAs(Option.some(member), notifications.preferences)).toEqual(defaults);
  });

  it("an anonymous viewer is Unauthorized", async () => {
    const { notifications, viewAs } = await seeded();
    expect(
      await viewAs(
        Option.none(),
        Effect.match(notifications.unreadCount, {
          onFailure: (error) => error._tag,
          onSuccess: () => "success",
        }),
      ),
    ).toBe("Unauthorized");
  });
});
