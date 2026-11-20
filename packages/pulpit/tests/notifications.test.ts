/**
 * Notifications: the outbox is written inside the triggering
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
import type * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  accountSubject,
  commentRepliedHook,
  contentFlagged,
  defineNotifications,
  emitting,
  followCreated,
  mentionCreatedHook,
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
} from "../src/Notifications.ts";
import type { ProposalRow } from "../src/Proposals.ts";
import {
  defineSubtype,
  ownedAccess,
  WriteRejected,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/Subtype.ts";
import {
  jsonMentionExtractor,
  makeInMemoryDelivery,
  makeInMemoryDocumentStore,
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
import type { ChainState, VersionSnapshot } from "../src/VersionChain.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const failureTag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, { onFailure: (error) => error._tag, onSuccess: () => "success" });

/** A posts leaf whose hooks are `before`, with a mutable viewer. */
const postsLeaf = (
  before: ReadonlyArray<BeforeWriteHook<never, never>>,
  columns: ReadonlyArray<string> = ["body", "visibility"],
) => {
  const chain = makeInMemoryVersionChain("posts");
  const leaves = makeInMemoryLeafStore(chain, { columns, now: NOW });
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

  it.effect("a committed write leaves its event", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      const { posts, as } = postsLeaf([always(outbox)]);
      yield* outbox.transact(
        as(
          Option.some(member),
          posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
        ),
      );
      expect(Arr.map(outbox.events(), (event) => event.recipientId)).toEqual([otherMember.id]);
    }),
  );

  it.effect("a later hook's refusal leaves no event", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      const { posts, as } = postsLeaf([always(outbox), refuse]);
      const tag = yield* failureTag(
        outbox.transact(
          as(
            Option.some(member),
            posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
          ),
        ),
      );
      expect(tag).toBe("WriteRejected");
      expect(outbox.events()).toEqual([]);
    }),
  );

  it.effect("a lost race at the append leaves no event", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      const { chain, posts, as } = postsLeaf([always(outbox)]);
      const { id } = yield* as(
        Option.some(member),
        posts.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
      );
      const before = outbox.events().length;
      chain.raceNextAppend(id);
      const tag = yield* failureTag(
        outbox.transact(as(Option.some(member), posts.update({ id, patch: { body: "Yo" } }))),
      );
      expect(["VersionConflict", "StaleVersion"]).toContain(tag);
      expect(outbox.events().length).toBe(before);
    }),
  );

  it.effect("emitting enqueues after its write, and a failed derive rolls both back", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      yield* outbox.transact(
        emitting(outbox, Effect.succeed(1), () => Effect.succeed([draftTo(otherMember.id)])),
      );
      expect(outbox.events().length).toBe(1);
      yield* Effect.ignore(
        outbox.transact(
          emitting(outbox, outbox.enqueue([draftTo(moderator.id)], NOW), () =>
            Effect.fail("derive failed"),
          ),
        ),
      );
      expect(outbox.events().length).toBe(1);
    }),
  );

  it.effect("a draft addressed to its own actor is dropped", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      yield* emitting(outbox, Effect.void, () => Effect.succeed([draftTo(member.id)]));
      expect(outbox.events()).toEqual([]);
    }),
  );
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

const runHook = (hook: BeforeWriteHook<never, never>, at: BeforeWriteEvent) =>
  Effect.asVoid(hook.run(at));

describe("each kernel kind is derived from its module's write", () => {
  it.effect(
    "comment.replied: a reply notifies the parent's author; a top-level comment nobody",
    () =>
      Effect.gen(function* () {
        const outbox = makeInMemoryOutbox<KernelNotificationKind>();
        const hook = commentRepliedHook({
          outbox,
          authorOf: (parentId) =>
            Effect.succeed(parentId === "c-1" ? Option.some(member.id) : Option.none()),
        });
        yield* runHook(hook, event({ patch: { body: "top", parentId: null } }));
        yield* runHook(hook, event({ patch: { body: "re", parentId: "c-1" } }));
        yield* runHook(hook, event({ action: "update", patch: { parentId: "c-1" } }));
        expect(outbox.events()).toMatchObject([
          {
            kind: "comment.replied",
            recipientId: member.id,
            actorId: Option.some(otherMember.id),
            subject: nodeSubject("comments", "c-2"),
          },
        ]);
      }),
  );

  it.effect("comment.moderated: a move to approved or rejected notifies the owner, once", () =>
    Effect.gen(function* () {
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
      yield* runHook(hook, at("approved"));
      yield* runHook(hook, at("rejected"));
      yield* runHook(hook, at("pending"));
      yield* runHook(
        hook,
        at("approved", head({ moderationState: "approved", ownerId: member.id })),
      );
      expect(Arr.map(outbox.events(), (stored) => stored.recipientId)).toEqual([
        member.id,
        member.id,
      ]);
    }),
  );

  it.effect("content.flagged: a filed report notifies each moderator", () =>
    Effect.gen(function* () {
      const reports = makeInMemoryReportStore();
      yield* reports.insert({
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
      });
      const derive = contentFlagged({
        reports,
        moderators: Effect.succeed([moderator.id, "u-mod-2"]),
      });
      expect(yield* derive({ id: "r-1" })).toEqual([
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
      expect(yield* derive({ id: "missing" })).toEqual([]);
    }),
  );

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

  it.effect.each(["accepted", "rejected"] as const)(
    "proposal.decided: %s notifies the author",
    (status) =>
      Effect.gen(function* () {
        const store = {
          get: () => Effect.succeedSome({ row: proposal(status), targetVersion: Option.none() }),
        };
        expect(yield* proposalDecided(store, "pr-1")()).toEqual([
          {
            kind: "proposal.decided",
            recipientId: otherMember.id,
            actorId: Option.some(member.id),
            subject: nodeSubject("posts", "p-1"),
          },
        ]);
      }),
  );

  it.effect.each(["pending", "withdrawn"] as const)(
    "proposal.decided: %s notifies nobody",
    (status) =>
      Effect.gen(function* () {
        const store = {
          get: () => Effect.succeedSome({ row: proposal(status), targetVersion: Option.none() }),
        };
        expect(yield* proposalDecided(store, "pr-1")()).toEqual([]);
      }),
  );

  it.effect("follow.created: a changed follow notifies the followed account", () =>
    Effect.gen(function* () {
      const derive = followCreated(Effect.succeedSome(otherMember), member.id);
      expect(yield* derive({ changed: true })).toEqual([
        {
          kind: "follow.created",
          recipientId: member.id,
          actorId: Option.some(otherMember.id),
          subject: accountSubject(otherMember.id),
        },
      ]);
      expect(yield* derive({ changed: false })).toEqual([]);
    }),
  );

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

const fanOut = (preferences: ReadonlyArray<readonly [string, NotificationPreferences]> = []) =>
  Effect.gen(function* () {
    const outbox = makeInMemoryOutbox<KernelNotificationKind>();
    const inbox = makeInMemoryInbox<KernelNotificationKind>();
    const delivery = makeInMemoryDelivery<KernelNotificationKind>();
    const prefs = makeInMemoryPreferenceStore();
    const social = makeInMemorySocialStore();
    yield* Effect.forEach(preferences, ([id, value]) => prefs.set(id, value), { concurrency: 1 });
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
      Effect.map(
        as(
          Option.some(member),
          posts.create({ id: Option.none(), state: { body: "x", visibility } }),
        ),
        (write) => write.id,
      );
    const notify = (drafts: ReadonlyArray<NotificationDraft>) => outbox.enqueue(drafts, NOW);
    const viewAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    return { outbox, inbox, delivery, social, notifications, post, notify, viewAs };
  });

const defaults: NotificationPreferences = { channels: ["push"], mutedKinds: [] };

const toOther = (subjectId: string, kind: KernelNotificationKind = "comment.replied") => ({
  kind,
  recipientId: otherMember.id,
  actorId: Option.some(member.id),
  subject: nodeSubject("posts", subjectId),
});

describe("fan-out tells a recipient only what they may read", () => {
  it.effect("a readable subject reaches the inbox and each enabled channel", () =>
    Effect.gen(function* () {
      const { inbox, delivery, notifications, post, notify } = yield* fanOut([
        [otherMember.id, { channels: ["push", "email"], mutedKinds: [] }],
      ]);
      yield* notify([toOther(yield* post("public"))]);
      expect(yield* notifications.sweep(10)).toEqual({
        processed: 1,
        delivered: 2,
        suppressed: 0,
      });
      expect(inbox.entries().length).toBe(1);
      expect(Arr.map(delivery.deliveries(), (delivered) => delivered.channel)).toEqual([
        "push",
        "email",
      ]);
    }),
  );

  it.effect("a subject the recipient can't read is dropped; the rung reads it", () =>
    Effect.gen(function* () {
      const { inbox, notifications, post, notify } = yield* fanOut();
      const hidden = yield* post("private");
      yield* notify([toOther(hidden), { ...toOther(hidden), recipientId: moderator.id }]);
      expect(yield* notifications.sweep(10)).toMatchObject({ processed: 2, suppressed: 1 });
      expect(Arr.map(inbox.entries(), (entry) => entry.event.recipientId)).toEqual([moderator.id]);
    }),
  );

  it.effect(
    "a node subject of an undeclared type is dropped; an account subject is not gated",
    () =>
      Effect.gen(function* () {
        const { inbox, notifications, notify } = yield* fanOut();
        yield* notify([
          { ...toOther("x"), subject: nodeSubject("albums", "a-1") },
          { ...toOther("x"), kind: "follow.created", subject: accountSubject(member.id) },
        ]);
        yield* notifications.sweep(10);
        expect(Arr.map(inbox.entries(), (entry) => entry.event.kind)).toEqual(["follow.created"]);
      }),
  );

  it.effect("a muted kind writes nothing; a recipient with no channels gets the inbox alone", () =>
    Effect.gen(function* () {
      const { inbox, delivery, notifications, post, notify } = yield* fanOut([
        [otherMember.id, { channels: [], mutedKinds: ["proposal.decided"] }],
      ]);
      const id = yield* post("public");
      yield* notify([toOther(id, "proposal.decided"), toOther(id)]);
      expect(yield* notifications.sweep(10)).toEqual({
        processed: 2,
        delivered: 0,
        suppressed: 1,
      });
      expect(Arr.map(inbox.entries(), (entry) => entry.event.kind)).toEqual(["comment.replied"]);
      expect(delivery.deliveries()).toEqual([]);
    }),
  );

  it.effect.each([
    ["the recipient muted the actor", "mute", otherMember.id, member.id],
    ["the recipient blocked the actor", "block", otherMember.id, member.id],
    ["the actor blocked the recipient", "block", member.id, otherMember.id],
  ] as const)("suppressed when %s", ([_label, kind, from, to]) =>
    Effect.gen(function* () {
      const { inbox, social, notifications, post, notify } = yield* fanOut();
      yield* social.add({ kind, from, to, at: NOW });
      yield* notify([toOther(yield* post("public"))]);
      expect(yield* notifications.sweep(10)).toMatchObject({ suppressed: 1 });
      expect(inbox.entries()).toEqual([]);
    }),
  );

  it.effect("a re-run sweeps nothing twice, and a batch is bounded", () =>
    Effect.gen(function* () {
      const { inbox, delivery, notifications, post, notify } = yield* fanOut();
      const id = yield* post("public");
      yield* notify([toOther(id), toOther(id), toOther(id)]);
      expect(yield* notifications.sweep(2)).toMatchObject({ processed: 2 });
      expect(yield* notifications.sweep(10)).toMatchObject({ processed: 1 });
      expect(yield* notifications.sweep(10)).toEqual({
        processed: 0,
        delivered: 0,
        suppressed: 0,
      });
      expect(inbox.entries().length).toBe(3);
      expect(delivery.deliveries().length).toBe(3);
    }),
  );

  it.effect("a re-added event writes no second inbox entry", () =>
    Effect.gen(function* () {
      const { inbox, notifications, post, notify, outbox } = yield* fanOut();
      yield* notify([toOther(yield* post("public"))]);
      yield* notifications.sweep(10);
      const [stored] = outbox.events();
      expect(stored === undefined ? true : yield* inbox.add(stored)).toBe(false);
    }),
  );
});

// ── The inbox ─────────────────────────────────────────────────────────

describe("the inbox is the viewer's own", () => {
  const seeded = () =>
    Effect.gen(function* () {
      const harness = yield* fanOut();
      const id = yield* harness.post("public");
      yield* harness.notify([toOther(id), toOther(id), toOther(id)]);
      yield* harness.notifications.sweep(10);
      return harness;
    });

  it.effect("pages newest first, counts unread and marks read only its own entries", () =>
    Effect.gen(function* () {
      const { notifications, viewAs, outbox } = yield* seeded();
      const other = Option.some(otherMember);
      const page = yield* viewAs(
        other,
        notifications.inbox({ unreadOnly: false, limit: 2, offset: 0 }),
      );
      expect(page.total).toBe(3);
      expect(Arr.map(page.rows, (entry) => entry.event.id)).toEqual(["n-000003", "n-000002"]);
      expect(yield* viewAs(other, notifications.unreadCount)).toBe(3);
      const ids = Arr.map(outbox.events(), (stored) => stored.id);
      expect(yield* viewAs(Option.some(member), notifications.markRead(ids))).toBe(0);
      expect(yield* viewAs(other, notifications.markRead(Arr.take(ids, 2)))).toBe(2);
      expect(yield* viewAs(other, notifications.markRead(Arr.take(ids, 2)))).toBe(0);
      expect(yield* viewAs(other, notifications.unreadCount)).toBe(1);
      const unread = yield* viewAs(
        other,
        notifications.inbox({ unreadOnly: true, limit: 50, offset: 0 }),
      );
      expect(Arr.map(unread.rows, (entry) => entry.event.id)).toEqual(["n-000003"]);
    }),
  );

  it.effect("preferences default until set, and are the viewer's own", () =>
    Effect.gen(function* () {
      const { notifications, viewAs } = yield* seeded();
      const other = Option.some(otherMember);
      expect(yield* viewAs(other, notifications.preferences)).toEqual(defaults);
      const muted: NotificationPreferences = {
        channels: ["email"],
        mutedKinds: ["follow.created"],
      };
      yield* viewAs(other, notifications.setPreferences(muted));
      expect(yield* viewAs(other, notifications.preferences)).toEqual(muted);
      expect(yield* viewAs(Option.some(member), notifications.preferences)).toEqual(defaults);
    }),
  );

  it.effect("an anonymous viewer is Unauthorized", () =>
    Effect.gen(function* () {
      const { notifications, viewAs } = yield* seeded();
      expect(
        yield* viewAs(
          Option.none(),
          Effect.match(notifications.unreadCount, {
            onFailure: (error) => error._tag,
            onSuccess: () => "success",
          }),
        ),
      ).toBe("Unauthorized");
    }),
  );
});

// ── Mentions ─────────────────────────────────────────────

const mentionNode = (id: string): Schema.Json => ({ type: "mention", attrs: { id, label: id } });

/** A posts leaf with `title` and `body` documents and the mention hook, plus a sweep gated on its `get`. */
const mentioning = () => {
  const outbox = makeInMemoryOutbox<KernelNotificationKind>();
  const inbox = makeInMemoryInbox<KernelNotificationKind>();
  const social = makeInMemorySocialStore();
  const documents = makeInMemoryDocumentStore<Schema.Json>();
  let reads = 0;
  const hook = mentionCreatedHook({
    outbox,
    fields: ["title", "body"],
    documents: {
      getMany: (hashes) =>
        Effect.suspend(() => {
          reads += 1;
          return documents.getMany(hashes);
        }),
    },
    extract: jsonMentionExtractor,
  });
  const { posts, as } = postsLeaf([hook], ["title", "body", "visibility"]);
  const asRecipient =
    (recipientId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.andThen(
        as(
          Arr.findFirst(accounts, (account) => account.id === recipientId),
          Effect.void,
        ),
        effect,
      );
  const notifications = defineNotifications({
    outbox,
    inbox,
    preferences: makeInMemoryPreferenceStore(),
    delivery: makeInMemoryDelivery<KernelNotificationKind>(),
    subjects: { posts: subjectGateFromGet(posts.get, asRecipient) },
    suppression: Option.some(socialSuppression(social)),
    defaults,
    viewer: Effect.succeedNone,
  });
  /** Store a document mentioning `ids`, and return its hash. */
  const doc = (...ids: ReadonlyArray<string>) =>
    Effect.map(
      documents.put({
        type: "doc",
        content: [{ type: "paragraph", content: Arr.map(ids, mentionNode) }],
      }),
      (put) => put.hash,
    );
  const write = <A, E>(effect: Effect.Effect<A, E>) => as(Option.some(member), effect);
  const create = (state: ChainState) =>
    Effect.map(
      write(posts.create({ id: Option.none(), state: { visibility: "public", ...state } })),
      (value) => value.id,
    );
  const recipients = () => Arr.map(outbox.events(), (queued) => queued.recipientId);
  return {
    outbox,
    inbox,
    social,
    notifications,
    posts,
    doc,
    write,
    create,
    recipients,
    reads: () => reads,
  };
};

describe("mention.created: only the mentions a write adds", () => {
  it.effect(
    "a create notifies each account its documents mention, once, and never the author",
    () =>
      Effect.gen(function* () {
        const { create, doc, outbox, recipients } = mentioning();
        const id = yield* create({
          title: yield* doc(otherMember.id),
          body: yield* doc(otherMember.id, moderator.id, member.id),
        });
        expect(recipients()).toEqual([otherMember.id, moderator.id]);
        expect(outbox.events()[0]).toMatchObject({
          kind: "mention.created",
          actorId: Option.some(member.id),
          subject: nodeSubject("posts", id),
        });
      }),
  );

  it.effect(
    "an edit that keeps a mention doesn't re-emit; one that adds a mention emits it alone",
    () =>
      Effect.gen(function* () {
        const { create, doc, posts, write, recipients } = mentioning();
        const id = yield* create({ body: yield* doc(otherMember.id) });
        yield* write(
          posts.update({ id, patch: { body: yield* doc(otherMember.id, otherMember.id) } }),
        );
        expect(recipients()).toEqual([otherMember.id]);
        yield* write(
          posts.update({ id, patch: { body: yield* doc(otherMember.id, moderator.id) } }),
        );
        expect(recipients()).toEqual([otherMember.id, moderator.id]);
      }),
  );

  it.effect("a mention moved to another field is not new", () =>
    Effect.gen(function* () {
      const { create, doc, posts, write, recipients } = mentioning();
      const id = yield* create({ title: yield* doc(otherMember.id), body: yield* doc() });
      yield* write(
        posts.update({ id, patch: { title: yield* doc(), body: yield* doc(otherMember.id) } }),
      );
      expect(recipients()).toEqual([otherMember.id]);
    }),
  );

  it.effect("a write that sets no new document reads nothing and emits nothing", () =>
    Effect.gen(function* () {
      const { create, doc, posts, write, recipients, reads } = mentioning();
      const body = yield* doc(otherMember.id);
      const id = yield* create({ body });
      const before = reads();
      yield* write(posts.update({ id, patch: { visibility: "private" } }));
      yield* write(posts.update({ id, patch: { body } }));
      yield* write(posts.delete(id));
      expect(reads()).toBe(before);
      expect(recipients()).toEqual([otherMember.id]);
    }),
  );

  it.effect("a mention removed and then restored notifies again (the diff is over the head)", () =>
    Effect.gen(function* () {
      const { create, doc, posts, write, recipients } = mentioning();
      const id = yield* create({ body: yield* doc(otherMember.id) });
      yield* write(posts.update({ id, patch: { body: yield* doc() } }));
      yield* write(posts.restoreVersion(id, 0n));
      expect(recipients()).toEqual([otherMember.id, otherMember.id]);
    }),
  );

  it.effect("a reference with no stored document mentions nobody", () =>
    Effect.gen(function* () {
      const { create, recipients } = mentioning();
      yield* create({ body: "0".repeat(64) });
      expect(recipients()).toEqual([]);
    }),
  );

  it.effect("a localised write diffs across every locale: a moved mention is not new", () =>
    Effect.gen(function* () {
      const outbox = makeInMemoryOutbox<KernelNotificationKind>();
      const documents = makeInMemoryDocumentStore<Schema.Json>();
      const hook = mentionCreatedHook({
        outbox,
        fields: ["body"],
        documents,
        extract: jsonMentionExtractor,
      });
      const put = (...ids: ReadonlyArray<string>) =>
        Effect.map(documents.put({ content: Arr.map(ids, mentionNode) }), (stored) => stored.hash);
      const prior: VersionSnapshot = {
        version: 0n,
        action: "create",
        timestamp: NOW,
        state: { visibility: "public" },
        locales: { en: { body: yield* put(otherMember.id) } },
      };
      const write: BeforeWriteEvent = {
        action: "update",
        type: "posts",
        id: "p-1",
        prior: Option.some(prior),
        patch: {},
        locales: {
          en: null,
          fr: { body: yield* put(otherMember.id, moderator.id) },
          de: undefined,
        },
        actorId: Option.some(member.id),
        viewer: Option.some(member),
      };
      expect(yield* hook.run(write)).toEqual({});
      expect(yield* hook.locales?.(write) ?? Effect.succeed({})).toEqual(write.locales);
      expect(Arr.map(outbox.events(), (stored) => stored.recipientId)).toEqual([moderator.id]);
    }),
  );

  it.effect("the sweep tells a mentioned account only about a node it can read", () =>
    Effect.gen(function* () {
      const { create, doc, inbox, notifications } = mentioning();
      yield* create({ visibility: "private", body: yield* doc(otherMember.id, moderator.id) });
      expect(yield* notifications.sweep(10)).toMatchObject({ processed: 2, suppressed: 1 });
      expect(Arr.map(inbox.entries(), (entry) => entry.event.recipientId)).toEqual([moderator.id]);
    }),
  );

  it.effect("the sweep drops a mention of an account that blocks the author", () =>
    Effect.gen(function* () {
      const { create, doc, inbox, notifications, social } = mentioning();
      yield* social.add({ kind: "block", from: otherMember.id, to: member.id, at: NOW });
      yield* create({ body: yield* doc(otherMember.id) });
      expect(yield* notifications.sweep(10)).toMatchObject({ processed: 1, suppressed: 1 });
      expect(inbox.entries()).toEqual([]);
    }),
  );
});

describe("jsonMentionExtractor (the fake extractor)", () => {
  it("reads every mention's string id at any depth, in document order", () => {
    expect(
      jsonMentionExtractor([
        { type: "mention", attrs: { id: "a" } },
        { nested: { content: [{ type: "mention", attrs: { id: "b" } }] } },
        { type: "mention", attrs: { id: 1 } },
        { type: "mention", attrs: ["c"] },
        { type: "mention" },
        "mention",
        null,
        7,
        true,
      ]),
    ).toEqual(["a", "b"]);
  });
});
