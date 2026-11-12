/**
 * **Notifications** (pulpit#197) — an outbox of content events written in
 * the triggering write's own transaction, a fan-out that tells each
 * recipient only what they may read, per-account preferences, an inbox,
 * and a delivery seam the application's transports fill.
 *
 * The behavioural spec is gardeneria's `packages/jobs/src/notifications/`
 * queue and its `social.notification_preferences` table. The kernel owns
 * **who is told what**; the application owns **how it is delivered**
 * (web-push, APNs, FCM, email) and the copy.
 *
 * ## The model
 *
 * - **An event is an outbox row**, `(kind, recipient, actor, subject)`,
 *   written by the write that caused it, inside that write's transaction:
 *   a write that rolls back notifies nobody. A chain write emits through a
 *   before hook ({@link notificationHook}, the place `./subtype` names for
 *   an outbox); a write that appends no version (a report, a proposal's
 *   decision, a follow) emits through {@link emitting}, inside the same
 *   transaction as the write it wraps. A draft addressed to its own actor
 *   is dropped.
 * - **Kinds** are the kernel's ({@link KernelNotificationKind}:
 *   `comment.replied`, `comment.moderated`, `content.flagged`,
 *   `proposal.decided`, `follow.created`, `mention.created`) or the
 *   application's: every type here is generic in `Kind extends string`.
 * - **Mentions** (pulpit#198): {@link mentionCreatedHook} emits
 *   `mention.created` for the accounts a write's documents newly mention,
 *   through the application's {@link MentionExtractor}; the kernel never
 *   reads a document's grammar.
 * - **Fan-out** ({@link NotificationOps.sweep}) reads the outbox oldest
 *   first in bounded batches (`PERF-DB-001`) and, per event, writes the
 *   recipient's inbox entry and hands it to each channel the recipient
 *   enabled, unless:
 *   - the recipient muted the kind;
 *   - the actor and the recipient are muted or blocked
 *     ({@link SocialSuppression}, `./social`);
 *   - the recipient can't read the subject: each node subject is checked
 *     through its leaf's own read, as the recipient ({@link SubjectGate}),
 *     so nobody is told about a node they can't read
 *     (`SEC-AUTH-ENUM-001`). The gate is read at fan-out: an event whose
 *     subject the recipient can't read then is dropped for good. A node
 *     subject of a type with no declared gate is dropped (fail closed).
 * - **Delivery is at-least-once.** A batch's events are marked processed
 *   after their delivery, so a sweep that stops part-way re-delivers the
 *   unprocessed ones; each delivery carries the event's id as its
 *   idempotency key, and the inbox entry is keyed by it, so a re-run adds
 *   no second entry.
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#notifications.
 *
 * @copyright Thomas Foster
 * @module pulpit/notifications
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { DocumentHash, DocumentStore } from "./documents.ts";
import { nowDate, signedIn } from "./internal/plain-rows.ts";
import type { ProposalStore } from "./proposals.ts";
import type { ReportStore } from "./moderation.ts";
import type { SocialStore } from "./social.ts";
import {
  MAX_PAGE_LIMIT,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type Page,
  type Unauthorized,
  type Viewer,
} from "./subtype.ts";
import {
  localesOf,
  type ChainPatch,
  type ChainState,
  type ColumnValue,
  type NodeNotFound,
} from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * The notification kinds the kernel derives from its own modules. An
 * application adds its own by widening the `Kind` parameter every type
 * here takes (`KernelNotificationKind | "task.due"`).
 *
 * @since 0.2.0
 */
export const KernelNotificationKind = Schema.Literals([
  "comment.replied",
  "comment.moderated",
  "content.flagged",
  "proposal.decided",
  "follow.created",
  "mention.created",
]);
/**
 * The {@link KernelNotificationKind} literal union.
 *
 * @since 0.2.0
 */
export type KernelNotificationKind = typeof KernelNotificationKind.Type;

/**
 * What a notification is about: a node (read through its leaf's gate at
 * fan-out) or an account (a new follower).
 *
 * @since 0.2.0
 */
export type NotificationSubject =
  | { readonly _tag: "Node"; readonly type: string; readonly id: string }
  | { readonly _tag: "Account"; readonly id: string };

/**
 * A node subject.
 *
 * @since 0.2.0
 */
export const nodeSubject = (type: string, id: string): NotificationSubject => ({
  _tag: "Node",
  type,
  id,
});

/**
 * An account subject.
 *
 * @since 0.2.0
 */
export const accountSubject = (id: string): NotificationSubject => ({ _tag: "Account", id });

/**
 * One notification a write derives, before it is stored.
 *
 * @since 0.2.0
 */
export interface NotificationDraft<Kind extends string = KernelNotificationKind> {
  readonly kind: Kind;
  readonly recipientId: string;
  /** Who caused it; none for a system write. */
  readonly actorId: Option.Option<string>;
  readonly subject: NotificationSubject;
}

/**
 * A stored outbox event: a draft with its id and the instant it was written.
 *
 * @since 0.2.0
 */
export interface NotificationEvent<
  Kind extends string = KernelNotificationKind,
> extends NotificationDraft<Kind> {
  readonly id: string;
  readonly at: Date;
}

/**
 * One inbox entry: the event and when its recipient read it.
 *
 * @since 0.2.0
 */
export interface InboxEntry<Kind extends string = KernelNotificationKind> {
  readonly event: NotificationEvent<Kind>;
  readonly readAt: Option.Option<Date>;
}

/**
 * An account's notification preferences: the delivery channels it enabled
 * (the application's names: `push`, `email`, …; the inbox is always
 * written) and the kinds it muted (no inbox entry, no delivery).
 *
 * @since 0.2.0
 */
export interface NotificationPreferences {
  readonly channels: ReadonlyArray<string>;
  readonly mutedKinds: ReadonlyArray<string>;
}

// ── The seams ─────────────────────────────────────────────────────────

/**
 * The outbox table an application supplies. A store seam: no policy, never
 * opens a transaction (`enqueue` runs inside the caller's, which is what
 * makes a rolled-back write notify nobody), fails only with its `E`. See
 * docs/seams.md.
 *
 * @since 0.2.0
 */
export interface OutboxStore<Kind extends string, E, R> {
  /** Insert the drafts, one row each, minting their ids, stamped `at`. */
  readonly enqueue: (
    drafts: ReadonlyArray<NotificationDraft<Kind>>,
    at: Date,
  ) => Effect.Effect<void, E, R>;
  /** At most `limit` unprocessed events, oldest first (`at ASC, id ASC`). */
  readonly pending: (limit: number) => Effect.Effect<ReadonlyArray<NotificationEvent<Kind>>, E, R>;
  /** Mark the events processed, so `pending` no longer returns them. Idempotent. */
  readonly markProcessed: (ids: ReadonlyArray<string>) => Effect.Effect<void, E, R>;
}

/**
 * The inbox table an application supplies, keyed by the event's id (one
 * recipient per event). A store seam, as {@link OutboxStore} is.
 *
 * @since 0.2.0
 */
export interface InboxStore<Kind extends string, E, R> {
  /** Insert the entry (`ON CONFLICT DO NOTHING`); whether a row was written. */
  readonly add: (event: NotificationEvent<Kind>) => Effect.Effect<boolean, E, R>;
  /** One page of a recipient's entries, newest first (`at DESC, id DESC`), with the unpaged total. */
  readonly list: (query: {
    readonly recipientId: string;
    readonly unreadOnly: boolean;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<InboxEntry<Kind>>, E, R>;
  /** Stamp the recipient's own unread entries among `ids` read; how many changed. */
  readonly markRead: (
    recipientId: string,
    ids: ReadonlyArray<string>,
    at: Date,
  ) => Effect.Effect<number, E, R>;
  readonly unreadCount: (recipientId: string) => Effect.Effect<number, E, R>;
}

/**
 * The per-account preferences table an application supplies.
 *
 * @since 0.2.0
 */
export interface PreferenceStore<E, R> {
  /** The account's stored preferences; none when it never set any. */
  readonly get: (accountId: string) => Effect.Effect<Option.Option<NotificationPreferences>, E, R>;
  readonly set: (
    accountId: string,
    preferences: NotificationPreferences,
  ) => Effect.Effect<void, E, R>;
}

/**
 * The delivery seam the application's transports fill. `event.id` is the
 * idempotency key: delivery is at-least-once (see the module doc).
 *
 * @since 0.2.0
 */
export interface DeliverySeam<Kind extends string, E, R> {
  readonly deliver: (channel: string, event: NotificationEvent<Kind>) => Effect.Effect<void, E, R>;
}

/**
 * Whether a recipient may read a node: the subject leaf's own read, run as
 * the recipient. Build it with {@link subjectGateFromGet}; never re-spell a
 * read rule here.
 *
 * @since 0.2.0
 */
export interface SubjectGate<E, R> {
  readonly canRead: (recipientId: string, id: string) => Effect.Effect<boolean, E, R>;
}

/**
 * A {@link SubjectGate} over a leaf's own `get`: `asRecipient` runs an
 * effect as the recipient (the application provides its viewer for that
 * account), and `NodeNotFound` reads as "can't read". Any other failure is
 * the sweep's.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { subjectGateFromGet } from "@thomasfosterau/pulpit/notifications";
 * import { NodeNotFound } from "@thomasfosterau/pulpit/version-chain";
 *
 * // A leaf whose `get` serves its row to "u-1" alone.
 * let current = "";
 * const get = (id: string) =>
 *   Effect.suspend(() =>
 *     current === "u-1"
 *       ? Effect.succeed({ id })
 *       : Effect.fail(new NodeNotFound({ type: "posts", id })),
 *   );
 * const gate = subjectGateFromGet(get, (recipientId) => (effect) =>
 *   Effect.suspend(() => {
 *     current = recipientId;
 *     return effect;
 *   }),
 * );
 * strictEqual(Effect.runSync(gate.canRead("u-1", "p-1")), true);
 * strictEqual(Effect.runSync(gate.canRead("u-2", "p-1")), false);
 * ```
 *
 * @since 0.2.0
 */
export const subjectGateFromGet = <E, R>(
  get: (id: string) => Effect.Effect<unknown, NodeNotFound | E, R>,
  asRecipient: (
    recipientId: string,
  ) => <A, E1, R1>(effect: Effect.Effect<A, E1, R1>) => Effect.Effect<A, E1, R1>,
): SubjectGate<E, R> => {
  const notFound = (error: NodeNotFound | E): error is NodeNotFound =>
    P.isTagged(error, "NodeNotFound");
  return {
    canRead: (recipientId, id) =>
      Effect.flatMap(Effect.result(asRecipient(recipientId)(get(id))), (result) => {
        if (Result.isSuccess(result)) return Effect.succeed(true);
        const error = result.failure;
        return notFound(error) ? Effect.succeed(false) : Effect.fail(error);
      }),
  };
};

/**
 * Whether a notification between two accounts is suppressed: either blocks
 * the other, or the recipient muted the actor.
 *
 * @since 0.2.0
 */
export interface SocialSuppression<E, R> {
  readonly suppressed: (recipientId: string, actorId: string) => Effect.Effect<boolean, E, R>;
}

/**
 * The {@link SocialSuppression} a social store fills (`./social`): a block
 * either way, or the recipient's mute of the actor.
 *
 * @since 0.2.0
 */
export const socialSuppression = <E, R>(
  store: Pick<SocialStore<unknown, E, R>, "has">,
): SocialSuppression<E, R> => ({
  suppressed: (recipientId, actorId) =>
    Effect.map(
      Effect.all(
        [
          store.has("block", recipientId, actorId),
          store.has("block", actorId, recipientId),
          store.has("mute", recipientId, actorId),
        ],
        { concurrency: 1 },
      ),
      Arr.some((found) => found),
    ),
});

// ── Emitting ──────────────────────────────────────────────────────────

/** Drop drafts addressed to their own actor; enqueue the rest, if any, stamped now. */
const enqueueDrafts = <Kind extends string, E, R>(
  outbox: OutboxStore<Kind, E, R>,
  drafts: ReadonlyArray<NotificationDraft<Kind>>,
): Effect.Effect<void, E, R> => {
  const addressed = Arr.filter(
    drafts,
    (draft) => !Option.contains(draft.actorId, draft.recipientId),
  );
  return Arr.isReadonlyArrayNonEmpty(addressed)
    ? Effect.flatMap(nowDate, (at) => outbox.enqueue(addressed, at))
    : Effect.void;
};

/**
 * A before hook that writes the drafts `derive` returns to the outbox,
 * inside the write's transaction, and passes the write's patch through
 * unchanged (its locale patch too). Every kernel derivation below is one;
 * so is {@link mentionCreatedHook}, and an application's own.
 *
 * @since 0.2.0
 */
export const notificationHook = <Kind extends string, E, R>(options: {
  readonly name: string;
  readonly outbox: OutboxStore<Kind, E, R>;
  readonly derive: (
    event: BeforeWriteEvent,
  ) => Effect.Effect<ReadonlyArray<NotificationDraft<Kind>>, E, R>;
}): BeforeWriteHook<E, R> => ({
  name: options.name,
  run: (event) =>
    Effect.as(
      Effect.flatMap(options.derive(event), (drafts) => enqueueDrafts(options.outbox, drafts)),
      event.patch,
    ),
  locales: (event) => Effect.succeed(event.locales ?? {}),
});

/**
 * Run `write`, then write the drafts `derive` returns from its result to
 * the outbox, as one effect: run inside the transaction that runs `write`,
 * so a write that rolls back notifies nobody, and a failed derive fails the
 * write. For writes that append no version (a report, a proposal's
 * decision, a follow).
 *
 * @since 0.2.0
 */
export const emitting = <A, Kind extends string, E1, R1, E2, R2>(
  outbox: OutboxStore<Kind, E2, R2>,
  write: Effect.Effect<A, E1, R1>,
  derive: (result: A) => Effect.Effect<ReadonlyArray<NotificationDraft<Kind>>, E2, R2>,
): Effect.Effect<A, E1 | E2, R1 | R2> =>
  Effect.tap(write, (result) =>
    Effect.flatMap(derive(result), (drafts) => enqueueDrafts(outbox, drafts)),
  );

const actorOf = (event: BeforeWriteEvent): Option.Option<string> =>
  Option.map(event.viewer, (account) => account.id);

// oxlint-disable-next-line effect/prefer-option-over-null -- reads a `ChainPatch` / `ChainState` cell, whose absent key is `undefined` (the tri-state patch convention)
const stringColumn = (value: ColumnValue | undefined): Option.Option<string> =>
  Option.liftPredicate(value, P.isString);

/**
 * `comment.replied`: a comment created as a reply notifies the author of
 * the comment it replies to. For the comment leaf's hooks (`./comments`).
 * `authorOf` reads the parent's author (the comment leaf's view row's
 * author column); the subject is the reply.
 *
 * @since 0.2.0
 */
export const commentRepliedHook = <E, R>(options: {
  readonly outbox: OutboxStore<KernelNotificationKind, E, R>;
  readonly authorOf: (parentId: string) => Effect.Effect<Option.Option<string>, E, R>;
  /** The reply's parent column; `parentId` when omitted. */
  readonly parentColumn?: string;
}): BeforeWriteHook<E, R> =>
  notificationHook({
    name: "notifications.commentReplied",
    outbox: options.outbox,
    derive: (event) =>
      event.action !== "create"
        ? Effect.succeed([])
        : Option.match(stringColumn(event.patch[options.parentColumn ?? "parentId"]), {
            onNone: () => Effect.succeed([]),
            onSome: (parentId) =>
              Effect.map(options.authorOf(parentId), (author) =>
                Option.toArray(
                  Option.map(author, (recipientId): NotificationDraft => ({
                    kind: "comment.replied",
                    recipientId,
                    actorId: actorOf(event),
                    subject: nodeSubject(event.type, event.id),
                  })),
                ),
              ),
          }),
  });

/**
 * `comment.moderated` (or `kind`): a moderation decision, a write that
 * moves the row's moderation column to `approved` or `rejected` from
 * anything else, notifies the row's owner. For a moderated leaf's hooks
 * (`./moderation`); the subject is the row.
 *
 * @since 0.2.0
 */
export const moderationDecidedHook = <Kind extends string, E, R>(options: {
  readonly outbox: OutboxStore<Kind, E, R>;
  readonly kind: Kind;
  /** The moderation state column (`./moderation`'s `moderationState`). */
  readonly column: string;
  /** The owner column (`ownerId`). */
  readonly ownerColumn: string;
}): BeforeWriteHook<E, R> =>
  notificationHook({
    name: "notifications.moderationDecided",
    outbox: options.outbox,
    derive: (event) => {
      const next = event.patch[options.column];
      const decided = next === "approved" || next === "rejected";
      const prior = Option.map(event.prior, (head) => head.state);
      const changed = Option.exists(prior, (state) => state[options.column] !== next);
      const owner = Option.flatMap(prior, (state) => stringColumn(state[options.ownerColumn]));
      return Effect.succeed(
        decided && changed
          ? Option.toArray(
              Option.map(owner, (recipientId): NotificationDraft<Kind> => ({
                kind: options.kind,
                recipientId,
                actorId: actorOf(event),
                subject: nodeSubject(event.type, event.id),
              })),
            )
          : [],
      );
    },
  });

/**
 * `content.flagged`: a filed report notifies each moderator. For
 * {@link emitting} around `./moderation`'s `ReportOps.file`; the subject is
 * the reported node, and the actor its reporter.
 *
 * @since 0.2.0
 */
export const contentFlagged =
  <E, R>(options: {
    readonly reports: Pick<ReportStore<E, R>, "get">;
    readonly moderators: Effect.Effect<ReadonlyArray<string>, E, R>;
  }) =>
  (filed: { readonly id: string }): Effect.Effect<ReadonlyArray<NotificationDraft>, E, R> =>
    Effect.flatMap(options.reports.get(filed.id), (row) =>
      Option.match(row, {
        onNone: () => Effect.succeed([]),
        onSome: (report) =>
          Effect.map(options.moderators, (moderators) =>
            Arr.map(moderators, (recipientId): NotificationDraft => ({
              kind: "content.flagged",
              recipientId,
              actorId: Option.some(report.reporterId),
              subject: nodeSubject(report.targetType, report.targetId),
            })),
          ),
      }),
    );

/**
 * `proposal.decided`: an accepted or rejected proposal notifies its author.
 * For {@link emitting} around `./proposals`' `accept` / `reject` (a
 * withdrawal notifies nobody); the subject is the proposal's target node,
 * and the actor whoever decided it.
 *
 * @since 0.2.0
 */
export const proposalDecided =
  <E, R>(proposals: Pick<ProposalStore<E, R>, "get">, id: string) =>
  (): Effect.Effect<ReadonlyArray<NotificationDraft>, E, R> =>
    Effect.map(proposals.get(id), (listing) =>
      Option.toArray(
        Option.flatMap(listing, ({ row }) =>
          row.status === "accepted" || row.status === "rejected"
            ? Option.some<NotificationDraft>({
                kind: "proposal.decided",
                recipientId: row.authorId,
                actorId: row.decidedBy,
                subject: nodeSubject(row.targetType, row.targetId),
              })
            : Option.none(),
        ),
      ),
    );

/**
 * `follow.created`: a new follow notifies the account followed. For
 * {@link emitting} around `./social`'s `follow`; a follow that changed
 * nothing notifies nobody. The subject is the follower's account.
 *
 * @since 0.2.0
 */
export const followCreated =
  <R>(viewer: Effect.Effect<Viewer, never, R>, accountId: string) =>
  (result: {
    readonly changed: boolean;
  }): Effect.Effect<ReadonlyArray<NotificationDraft>, never, R> =>
    Effect.map(viewer, (current) =>
      result.changed
        ? Option.toArray(
            Option.map(current, (follower): NotificationDraft => ({
              kind: "follow.created",
              recipientId: accountId,
              actorId: Option.some(follower.id),
              subject: accountSubject(follower.id),
            })),
          )
        : [],
    );

/**
 * `mention.created` drafts for the accounts a write newly mentions, one per
 * account (duplicates dropped). {@link mentionCreatedHook} derives the new
 * mentions from a write's documents and emits these.
 *
 * @since 0.2.0
 */
export const mentionDrafts = (options: {
  readonly mentioned: ReadonlyArray<string>;
  readonly actorId: Option.Option<string>;
  readonly subject: NotificationSubject;
}): ReadonlyArray<NotificationDraft> =>
  Arr.map(Arr.dedupe(options.mentioned), (recipientId): NotificationDraft => ({
    kind: "mention.created",
    recipientId,
    actorId: options.actorId,
    subject: options.subject,
  }));

/**
 * The mention seam (pulpit#198): the account ids a document mentions, in
 * any order, duplicates allowed. The kernel never reads a document's
 * grammar, so the application fills it (for ProseKit, prosekit-utilities'
 * `extractMentions` over the editor's `mention` atom); it is pure and total,
 * and a document that mentions nobody returns `[]`. `./testing`'s
 * `jsonMentionExtractor` is its reference fake.
 *
 * @since 0.2.0
 */
export type MentionExtractor<Document> = (document: Document) => ReadonlyArray<string>;

/**
 * What {@link mentionCreatedHook} reads: the leaf's document reference
 * columns, the store their documents are read back from, and the mention
 * seam.
 *
 * @since 0.2.0
 */
export interface MentionDeclaration<Document, E, R> {
  readonly outbox: OutboxStore<KernelNotificationKind, E, R>;
  /** The columns that hold a document hash (`./documents`' `documentRef`); any other column is never read. */
  readonly fields: ReadonlyArray<string>;
  /** Where the hook reads the documents back (one `getMany` per write that sets a new one). */
  readonly documents: Pick<DocumentStore<Document, E, R>, "getMany">;
  readonly extract: MentionExtractor<Document>;
}

/** The document hashes the declared fields hold in a state or a patch: a string each (`null` clears, absent carries forward). */
const hashesIn = (fields: ReadonlyArray<string>, cells: ChainPatch): ReadonlyArray<DocumentHash> =>
  Arr.getSomes(Arr.map(fields, (field) => stringColumn(cells[field])));

/** The patches a write sets: its shared columns' and, on a localised leaf, each locale's it writes. */
const writtenPatches = (event: BeforeWriteEvent): ReadonlyArray<ChainPatch> => [
  event.patch,
  ...Arr.filter(R.values(event.locales ?? {}), P.isNotNullish),
];

/** The states the head holds: its shared columns' and each locale's. None for a create. */
const priorStates = (event: BeforeWriteEvent): ReadonlyArray<ChainState> =>
  Option.match(event.prior, {
    onNone: () => [],
    onSome: (head) => [head.state, ...R.values(localesOf(head))],
  });

/**
 * `mention.created`: a write that sets a document mentioning an account
 * the head's documents didn't mention notifies that account, once. For the
 * hooks of a leaf whose documents carry mentions; the subject is the node,
 * and the actor the writer.
 *
 * - **Only new mentions.** The accounts the written documents mention
 *   (every declared field the patch sets, and on a localised leaf every
 *   locale's) less those the head's documents already mention (every
 *   declared field, every locale), so an edit that keeps a mention, or moves
 *   it to another field or locale, emits nothing. A field the patch leaves
 *   absent carries its documents forward and adds no mention. The diff is
 *   over the head the write extends, whatever the action: a `restoreVersion`
 *   that brings back a mention a later edit removed notifies again.
 * - **Reads only when a new document is set.** A write whose documents are
 *   all the head's (or that sets none: a `delete`, a publication write) reads
 *   nothing; any other reads the new and the head's documents with one
 *   `getMany`. A hash with no stored document mentions nobody.
 * - **Gated at fan-out, as every node subject is.** The hook writes the
 *   drafts inside the write's transaction ({@link notificationHook}); the
 *   sweep drops a mention whose recipient can't read the node then (its
 *   {@link SubjectGate}, `SEC-AUTH-ENUM-001`: a notification never reveals
 *   a node), or who blocks or is blocked by the author
 *   ({@link SocialSuppression}). A self-mention is dropped at the outbox.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Arr from "effect/Array";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { mentionCreatedHook } from "@thomasfosterau/pulpit/notifications";
 * import type { BeforeWriteEvent } from "@thomasfosterau/pulpit/subtype";
 * import {
 *   jsonMentionExtractor,
 *   makeInMemoryDocumentStore,
 *   makeInMemoryOutbox,
 * } from "@thomasfosterau/pulpit/testing";
 * import type { KernelNotificationKind } from "@thomasfosterau/pulpit/notifications";
 *
 * const mention = (id: string) => ({ type: "mention", attrs: { id } });
 * const documents = makeInMemoryDocumentStore();
 * const outbox = makeInMemoryOutbox<KernelNotificationKind>();
 * const hook = mentionCreatedHook({
 *   outbox,
 *   fields: ["body"],
 *   documents,
 *   extract: jsonMentionExtractor,
 * });
 *
 * const program = Effect.gen(function* () {
 *   const first = yield* documents.put({ content: [mention("u-1")] });
 *   const second = yield* documents.put({ content: [mention("u-1"), mention("u-2")] });
 *   const edit: BeforeWriteEvent = {
 *     action: "update",
 *     type: "posts",
 *     id: "p-1",
 *     prior: Option.some({
 *       version: 0n,
 *       action: "create",
 *       timestamp: new Date(0),
 *       state: { body: first.hash },
 *     }),
 *     patch: { body: second.hash },
 *     actorId: Option.some("u-author"),
 *     viewer: Option.some({ id: "u-author", role: "user" }),
 *   };
 *   yield* hook.run(edit);
 * });
 * await Effect.runPromise(program);
 * // "u-1" was already mentioned; only "u-2" is told.
 * deepStrictEqual(
 *   Arr.map(outbox.events(), (event) => event.recipientId),
 *   ["u-2"],
 * );
 * ```
 *
 * @since 0.2.0
 */
export const mentionCreatedHook = <Document, E, R>(
  declaration: MentionDeclaration<Document, E, R>,
): BeforeWriteHook<E, R> => {
  const { outbox, fields, documents, extract } = declaration;
  return notificationHook({
    name: "notifications.mentionCreated",
    outbox,
    derive: (event) => {
      const before = Arr.dedupe(
        Arr.flatMap(priorStates(event), (state) => hashesIn(fields, state)),
      );
      const written = Arr.filter(
        Arr.dedupe(Arr.flatMap(writtenPatches(event), (patch) => hashesIn(fields, patch))),
        (hash) => !Arr.contains(before, hash),
      );
      return Arr.match(written, {
        onEmpty: () => Effect.succeed([]),
        onNonEmpty: (added) =>
          Effect.map(documents.getMany(Arr.appendAll(added, before)), (found) => {
            const mentionedIn = (hashes: ReadonlyArray<DocumentHash>) =>
              Arr.flatMap(hashes, (hash) =>
                Option.match(HashMap.get(found, hash), { onNone: () => [], onSome: extract }),
              );
            const known = HashSet.fromIterable(mentionedIn(before));
            return mentionDrafts({
              mentioned: Arr.filter(mentionedIn(added), (id) => !HashSet.has(known, id)),
              actorId: actorOf(event),
              subject: nodeSubject(event.type, event.id),
            });
          }),
      });
    },
  });
};

// ── Fan-out and the inbox ─────────────────────────────────────────────

/**
 * A notifications family's declaration.
 *
 * @since 0.2.0
 */
export interface NotificationsDefinition<Kind extends string, E, R> {
  readonly outbox: OutboxStore<Kind, E, R>;
  readonly inbox: InboxStore<Kind, E, R>;
  readonly preferences: PreferenceStore<E, R>;
  readonly delivery: DeliverySeam<Kind, E, R>;
  /** Each node subject's gate, by leaf type; a type absent here is never delivered. */
  readonly subjects: { readonly [type: string]: SubjectGate<E, R> };
  /** Mute and block; none suppresses nothing. */
  readonly suppression: Option.Option<SocialSuppression<E, R>>;
  /** The preferences of an account that never set any. */
  readonly defaults: NotificationPreferences;
  /** The request's viewer (the inbox reads are the viewer's own). */
  readonly viewer: Effect.Effect<Viewer, never, R>;
}

/**
 * What one {@link NotificationOps.sweep} did: how many events it read, how
 * many it wrote to an inbox, and how many deliveries it made.
 *
 * @since 0.2.0
 */
export interface SweepSummary {
  readonly processed: number;
  readonly delivered: number;
  readonly suppressed: number;
}

/**
 * The operations {@link defineNotifications} produces.
 *
 * @since 0.2.0
 */
export interface NotificationOps<Kind extends string, E, R> {
  /**
   * Fan out at most `limit` (clamped to `[1, MAX_PAGE_LIMIT]`) pending
   * events, oldest first, then mark them processed. Idempotent: a re-run
   * finds nothing left.
   */
  readonly sweep: (limit: number) => Effect.Effect<SweepSummary, E, R>;
  /** The viewer's inbox, newest first (`limit` clamped). `Unauthorized` when anonymous. */
  readonly inbox: (request: {
    readonly unreadOnly: boolean;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<InboxEntry<Kind>>, Unauthorized | E, R>;
  /** Mark the viewer's own entries read; how many changed. Another account's ids change nothing. */
  readonly markRead: (ids: ReadonlyArray<string>) => Effect.Effect<number, Unauthorized | E, R>;
  readonly unreadCount: Effect.Effect<number, Unauthorized | E, R>;
  /** The viewer's preferences (the declared defaults until set). */
  readonly preferences: Effect.Effect<NotificationPreferences, Unauthorized | E, R>;
  readonly setPreferences: (
    preferences: NotificationPreferences,
  ) => Effect.Effect<void, Unauthorized | E, R>;
}

const clampLimit = (limit: number): number =>
  Math.max(1, Math.min(Math.trunc(limit), MAX_PAGE_LIMIT));

/**
 * Bind a notifications family. See the module doc for the fan-out rules.
 *
 * @since 0.2.0
 */
export const defineNotifications = <Kind extends string, E, R>(
  definition: NotificationsDefinition<Kind, E, R>,
): NotificationOps<Kind, E, R> => {
  const { outbox, inbox, preferences, delivery, subjects, suppression, defaults } = definition;

  const preferencesOf = (accountId: string) =>
    Effect.map(
      preferences.get(accountId),
      Option.getOrElse(() => defaults),
    );

  const subjectReadable = (event: NotificationEvent<Kind>): Effect.Effect<boolean, E, R> =>
    event.subject._tag === "Account"
      ? Effect.succeed(true)
      : Option.match(Option.fromUndefinedOr(subjects[event.subject.type]), {
          onNone: () => Effect.succeed(false),
          onSome: (gate) => gate.canRead(event.recipientId, event.subject.id),
        });

  const actorSuppressed = (event: NotificationEvent<Kind>): Effect.Effect<boolean, E, R> =>
    Option.match(Option.all([suppression, event.actorId]), {
      onNone: () => Effect.succeed(false),
      onSome: ([social, actorId]) => social.suppressed(event.recipientId, actorId),
    });

  /** Whether the event reaches its recipient; cheapest checks first. */
  const allowed = (event: NotificationEvent<Kind>, prefs: NotificationPreferences) =>
    Arr.contains(prefs.mutedKinds, event.kind)
      ? Effect.succeed(false)
      : Effect.flatMap(actorSuppressed(event), (muted) =>
          muted ? Effect.succeed(false) : subjectReadable(event),
        );

  /** One event's fan-out: how many deliveries it made, or none when it was suppressed. */
  const fanOut = (event: NotificationEvent<Kind>) =>
    Effect.flatMap(preferencesOf(event.recipientId), (prefs) =>
      Effect.flatMap(allowed(event, prefs), (reaches) =>
        reaches
          ? Effect.as(
              Effect.andThen(
                inbox.add(event),
                Effect.forEach(prefs.channels, (channel) => delivery.deliver(channel, event), {
                  concurrency: 1,
                  discard: true,
                }),
              ),
              Option.some(prefs.channels.length),
            )
          : Effect.succeed(Option.none<number>()),
      ),
    );

  const sweep = Effect.fn("notifications.sweep")(function* (limit: number) {
    const events = yield* outbox.pending(clampLimit(limit));
    const outcomes = yield* Effect.forEach(events, fanOut, { concurrency: 1 });
    yield* outbox.markProcessed(Arr.map(events, (event) => event.id));
    const reached = Arr.getSomes(outcomes);
    return {
      processed: events.length,
      delivered: Arr.reduce(reached, 0, (total, count) => total + count),
      suppressed: outcomes.length - reached.length,
    };
  });

  const me = signedIn(definition.viewer);

  return {
    sweep,
    inbox: (request) =>
      Effect.flatMap(me, (account) =>
        inbox.list({
          recipientId: account.id,
          unreadOnly: request.unreadOnly,
          limit: clampLimit(request.limit),
          offset: Math.max(0, Math.trunc(request.offset)),
        }),
      ),
    markRead: (ids) =>
      Effect.flatMap(me, (account) =>
        Effect.flatMap(nowDate, (at) => inbox.markRead(account.id, ids, at)),
      ),
    unreadCount: Effect.flatMap(me, (account) => inbox.unreadCount(account.id)),
    preferences: Effect.flatMap(me, (account) => preferencesOf(account.id)),
    setPreferences: (prefs) => Effect.flatMap(me, (account) => preferences.set(account.id, prefs)),
  };
};
