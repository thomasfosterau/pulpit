# Participation

Participation and user-generated content: comments, reactions, write budgets, the social graph, audiences, notifications, translation lineage and external reference import.

## `./comments`

The comments family (pulpit#50). A comment is an ordinary owned leaf, built with `defineSubtype` with `./moderation`'s `moderationHook` among its hooks. Edits append versions, a delete tombstones, and its history is gated like any leaf's. `defineComments` wraps it with the comment's own rules.

`CommentsDefinition.maxDepth` and `CommentListRequest.orderBy` are bare `?: T` (pulpit#238): a caller that has no value omits the key rather than passing `undefined`.

```ts
import { defineComments } from "@thomasfosterau/pulpit/comments";
import { moderatedColumns, moderationHook } from "@thomasfosterau/pulpit/moderation";

const moderation = moderatedColumns(["body"]);
// commentOps = defineSubtype({ …, access: ownedAccess({ moderation: true }), hooks: Effect.succeed({ before: [moderationHook(moderation, policy)], after: [] }) })
const comments = defineComments({
  comments: commentOps,
  leaves: commentLeaves, // the comment leaf's current-version view
  targets: { posts: postOps, images: imageOps }, // each target leaf's own operations
  viewer,
  policy,
  moderation,
  authorColumn: "ownerId",
  maxDepth: 1, // the default: one level of replies; 0 is flat
});
```

- **Three read gates, all of them** (`SEC-AUTH-ENUM-001`). A comment reads to a viewer only when all three admit it; anything else is `NodeNotFound`, never `Forbidden`.
  1. **The comment leaf's own `get`**: its owned visibility, and a tombstone only to the view-deleted rung.
  2. **The moderation gate.** An unapproved comment reads only to its author and the moderate rung, so the target's owner does not see a pending comment on their own row. `canViewModerated` and `moderationListFilter` are this one rule in two readings and never disagree.
  3. **The target gate**, run through the target leaf's own `get`. A comment on a target the viewer can't read is missing to them: a private or followers-only target they aren't admitted to, or a tombstoned one. The comment's own author is no exception.
- **`listByTarget`** checks the target first (`NodeNotFound` for one the viewer can't read), then lists through the comment leaf's own list and the moderation gate. It lists either every comment on the target, the top-level ones only (`parentId: some(none)`), or one comment's replies.
- **Reply depth is `maxDepth`**, default `1`: `0` is flat, `N` nests `N` deep.
  - A reply past it fails `CommentDepthExceeded`.
  - A reply's parent must be a comment the viewer can read, on the same target.
  - Each comment stores `targetType`, `targetId`, `parentId` and `depth`, all written by `create`.
  - A `maxDepth` that isn't a non-negative safe integer throws `CommentDeclarationError` when the family is declared.
- **Stays outside the kernel:** the document grammar (prosekit-utilities), captcha and spam handling, and the UI. Reactions are [`./reactions`](#reactions).

| Export | What it is |
| --- | --- |
| `defineComments(definition)`, `CommentsDefinition`, `CommentOps`, `CommentCreate`, `CommentListRequest`, `CommentTarget` | The family, its declaration, the operations (`create`, `get`, `listByTarget`), their inputs, and a target leaf's read. |
| `canViewModerated`, `moderationListFilter`, `ModeratedColumns` | The moderation gate as a row predicate and as a list filter, and the columns it reads. |
| `CommentDepthExceeded`, `CommentDeclarationError` | A reply past `maxDepth` (422); a malformed `maxDepth`, thrown at declaration. |

## `./reactions`

Reactions (pulpit#196), after gardeneria's `social.reactions`: likes and their kin on any node.

```ts
import { defineReactions, reactionKinds } from "@thomasfosterau/pulpit/reactions";

const reactions = defineReactions({
  type: "posts",
  kinds: reactionKinds(["like", "celebrate", "helpful", "curious", "sympathise"]),
  target: postOps, // the target leaf's `defineSubtype` operations: `get` and `getMany`
  reactions: reactionStore,
  viewer,
});

reactions.react(postId, "like"); // { replaced: Option<kind> }
reactions.tally(pageOfPostIds); // HashMap<postId, { counts, total }>
```

- **A fact beside the node** (owner decision on pulpit#196). No version chain and no history: the store keys a reaction `(node, account)`, so an account has at most one per node. `react` with another kind replaces it (and returns the kind it replaced); `unreact` hard-deletes it.
- **The kinds are the family's.** `reactionKinds(kinds)` throws `ReactionDeclarationError` at import for no kind, an empty one or a repeated one; `react` with an undeclared kind fails `InvalidReactionKind` (422). The kernel holds no list of kinds.
- **The target's read gate on every operation** (`SEC-AUTH-ENUM-001`). `react` and `unreact` on a node the viewer can't read fail `NodeNotFound`, never `Forbidden`. `tally(nodeIds)` answers only for the nodes the viewer can read (a hidden or missing one has no key; a readable one with no reaction has a zero tally), in one `getMany` and one grouped store read (`PERF-DB-001`); more than `MAX_SET_VALUES` ids reads nothing (`SEC-INPUT-003`). `mine({ limit, offset })` is the viewer's own reactions, newest first, omitting one whose node is now hidden from them.
- **Account erasure** (pulpit#207) deletes a member's reactions through the store's `eraseAccount`; no reaction operation exposes it.
- **Block and mute** (pulpit#195) suppress interaction only: a family gates `react` on the social graph once it lands; a tally counts every account's reaction.

| Export | What it is |
| --- | --- |
| `defineReactions(definition)`, `ReactionsDefinition`, `ReactionOps`, `Tally` | The factory, its declaration, the operations (`react`, `unreact`, `tally`, `mine`) and a node's tally. |
| `reactionKinds(kinds)`, `ReactionKinds`, `ReactionDeclarationError` | The family's vocabulary and its import-time check. |
| `ReactionStore`, `ReactionRow` | The table seam (see [Seams](seams.md#seams)) and one stored reaction. |
| `InvalidReactionKind` | An undeclared kind: 422. |

## `./budgets`

Write budgets (pulpit#199): every family that takes user content needs a write throttle, and gardeneria re-adds one per family (a count-then-insert in the write's transaction). A budget is declared once per family and action: at most `limit` writes per account in any window of `windowSeconds`.

`WriteBudget.exempt` is a bare `?: (policy) => (account) => boolean` (pulpit#238): omit the key for the default (the moderate rung) rather than passing `undefined`.

```ts
import * as Effect from "effect/Effect";
import { bindBudget, budgetHook, countingCounter } from "@thomasfosterau/pulpit/budgets";

const budget = bindBudget({
  type: "comments",
  budget: { limit: 10, windowSeconds: 3600 }, // ten comments an hour
  counter: countingCounter(commentCounts), // count(*) over the family's own rows
  policy,
});
const comments = defineSubtype({
  // …the leaf's declaration…
  hooks: Effect.succeed({ before: [budgetHook(budget)], after: [] }),
});
const proposals = defineProposals({ /* … */ budget }); // throttles submit
const reports = defineReports({ /* … */ budget }); // throttles file
```

- **Spent inside the write.** `budgetHook(bound, actions?)` is a before hook on [`./subtype`'s lifecycle seam](read-model.md#subtype): it spends one write on each create (or each of the `actions` it lists), so a write over budget appends nothing, and a localised write spends once. `./proposals`' `submit` and `./moderation`'s report `file` take the bound budget as an opt-in `budget` and spend it as the `submit` or `file` action once the request is valid, before the row is stored. A comment family throttles through its leaf's hooks.
- **A distinct refusal.** Over budget, the write fails `WriteRejected` with the reason `RATE_LIMITED`; `isRateLimited(error)` tells it apart from every other refusal, so the wire answers 429 rather than 422.
- **Who spends.** Each account has its own budget per family and action. An account the budget's `exempt` rung admits (`(policy) => policy.canModerate` by default) spends nothing, and neither does an anonymous viewer, whom the write's own gate refuses.
- **The window** is rolling: a write counts from the instant it was made until `windowSeconds` later. The clock is Effect's `Clock`, so a test fixes it with `TestClock`.
- **One counter seam, two shapes** (owner decision on [#199](https://github.com/thomasfosterau/pulpit/issues/199)). `countingCounter(store)` is gardeneria's count within the write's transaction: one indexed `count(*)` of the account's writes since the window opened, with the write's own row as the spend. It is exact but not atomic: two concurrent transactions can both count `limit - 1` and both write. A family that must hold its limit under concurrency fills `BudgetCounter.take` with an atomic counter instead (a Durable Object, a row taken `FOR UPDATE`); see [Seams](seams.md#seams).
- **A malformed budget** (a `limit` or `windowSeconds` that isn't a positive safe integer) throws `BudgetDeclarationError` when it is bound, never as an Effect failure.

| Export | What it is |
| --- | --- |
| `WriteBudget`, `bindBudget(definition)`, `BoundBudget` | The declaration (limit, window, exempt rung), its binding to a family's type, counter and policy, and the bound budget's `spend`. |
| `budgetHook(bound, actions?)` | The bound budget as a chain write's before hook. |
| `BudgetCounter`, `BudgetRequest`, `countingCounter(store)`, `WriteCountStore` | The counter seam and what it is asked; the count-within-the-transaction counter and the count it reads (see [Seams](seams.md#seams)). |
| `RATE_LIMITED`, `isRateLimited(error)` | The refusal's reason, and the test for it. |
| `BudgetDeclarationError` | A malformed budget, thrown by `bindBudget`. |

## `./social`

The social graph (pulpit#195), after gardeneria's `social.follows`: who follows, mutes and blocks whom.

`SocialDefinition.accounts` is a bare `?: AccountVisibility<R>` (pulpit#238): omit the key to show every account rather than passing `undefined`.

```ts
import { defineSocial, socialFollowers } from "@thomasfosterau/pulpit/social";

const social = defineSocial({ store: socialStore, viewer, accounts }); // `accounts`: the app's account visibility
const posts = defineSubtype({ …, followers: socialFollowers(socialStore) }); // `followers` rows, end to end

social.follow(accountId); // { changed }
social.silencedFilter("ownerId"); // the opt-in read filter: drop the authors the viewer muted or blocked
```

- **A relationship is a fact** keyed `(kind, from, to)` for `follow`, `mute` and `block`: no history, asserting one twice changes nothing (`changed: false`), removing one hard-deletes it. Only the viewer writes their own (`Unauthorized` when anonymous); one with oneself is `SelfRelationship` (422).
- **Following is immediate** (owner decision on pulpit#195); follow requests are a later slice.
- **A block suppresses interaction only** (owner decision on pulpit#195). While either account blocks the other, neither may follow the other (`InteractionBlocked`, 403), and blocking ends both follows between them. The block check is part of the follow's write (the store's `addFollow`), and `addBlock` inserts the block and ends both follows in one step, both under one lock on the account pair, so a follow racing a block never stands across it. Other modules gate an interaction (a reaction, a reply, a mention) on `interactionAllowed(a, b)`. A block hides no content by itself: `silencedFilter(column)` is the opt-in read filter a feed or thread applies, `column NOT IN` the accounts the viewer muted or blocked (through `./filter`'s `notIn`; an unset author is kept, and the anonymous get `always`).
- **A mute is one-way and private**: it only feeds that filter.
- **Lists.** `followers` and `following` are public, newest first, `LIMIT`ed (`MAX_PAGE_LIMIT`), and shown through the application's `AccountVisibility` (a private profile, a suspended account), when it supplies one. With one, a subject the viewer can't see answers exactly as an account with no relationships, and `total` is none (the store's count would include accounts the seam hides), so a page may hold fewer than `limit` rows; without one, `total` is the store's. `muted` and `blocked` are the viewer's own.
- **The follower seam.** `socialFollowers(store)` is `./subtype`'s `FollowerSeam` over the graph, so a `followers` row is readable by its owner's followers, and stops being the moment the follow ends.
- **Account erasure** (pulpit#207) deletes every relationship from or to a member through the store's `eraseAccount`.

| Export | What it is |
| --- | --- |
| `defineSocial(definition)`, `SocialDefinition`, `SocialOps`, `SocialPageRequest`, `Related`, `RelatedPage` | The factory, its declaration, the operations, a page request, a listed account and a public list's page. |
| `socialFollowers(store)` | The follower seam over the graph. |
| `SocialStore`, `Relationship`, `RelationshipKind`, `AccountVisibility` | The relationship table seam (see [Seams](seams.md#seams)), one relationship, its kinds, and the application's account visibility. |
| `InteractionBlocked`, `SelfRelationship` | The failures: 403 and 422. |

## `./audience`

Audiences (pulpit#194), after in-the-dark's groups and gardeneria's `social.group_memberships`: named groups of accounts a row can be shared with, as the `group` visibility state.

```ts
import { audienceSeam, defineAudience } from "@thomasfosterau/pulpit/audience";

const audience = defineAudience({ store: membershipStore, groups: { ownerOf }, viewer });
const posts = defineSubtype({
  …,
  access: ownedAccess({ draft: true, group: true }), // the `groupId` column names the row's group
  followers: { ...socialFollowers(socialStore), ...audienceSeam(membershipStore) },
});

audience.addMember(groupId, accountId); // { changed }; the owner or a group admin
audience.leave(groupId); // any member but the owner
audience.invite(groupId, accountId, "admin"); // { changed }; pending until the invitee accepts
audience.accept(groupId); // the invitee: the pending invitation becomes a membership
```

- **A group is the application's.** The kernel reads its owner through `GroupOwnership.ownerOf` (none: `GroupNotFound`, 404) and keeps only its memberships, keyed `(groupId, accountId)` with the role `member | admin`.
- **The owner and the admins manage members** (`addMember`, `removeMember`, `setRole`; anyone else signed in is `Forbidden`). A member may only `leave`. The owner can't leave, be removed or be re-roled (`GroupOwnerMembership`, 409). Members are added directly, by account id (owner decision on pulpit#194), or invited.
- **Invitations** (pulpit#227) are pending memberships. The owner or an admin `invite`s an account with a role (`SelfInvitation`, 422, for themselves; `AlreadyMember`, 409, for an active member; inviting again changes nothing) and may `revoke` it. The invitee alone `accept`s (the invitation becomes a membership with the invited role) or `decline`s it; anyone else has no invitation to answer (`InvitationNotFound`, 404), as does a revoked or declined one. **A pending invitee is not a member**: they read no `group` row, appear in no member list, and a pending `admin` invitation manages nothing until accepted. `invitations(groupId, page)` lists a group's pending invitations to its managers (a member gets `Forbidden`, anyone else `GroupNotFound`); `myInvitations(page)` lists the viewer's own. A direct `addMember` of an invited account supersedes the invitation.
- **The member list** is the owner's and the members'; anyone else gets `GroupNotFound`, never `Forbidden`, so it confirms no group (`SEC-AUTH-ENUM-001`). Oldest first, `LIMIT`ed (`MAX_PAGE_LIMIT`).
- **The audience is the membership rows.** `audienceSeam(store)` is the `isMember` / `groups` pair of `./subtype`'s `FollowerSeam`; spread it into the seam a leaf or an edge family takes. The owner reads their own rows anyway; to read rows others share with the group, they need a membership too, so record one when the group is created.
- **Deleting a group** (owner decision on pulpit#194): `removeGroup` (the owner only) deletes every membership, so its `group` rows open to nobody but their owners and the view-private rung, and read as `private`. Clear the rows' group column in the same transaction (in-the-dark's `ON DELETE SET NULL`); a column naming no group reads the same.
- **Never cache-serveable.** A `group` row isn't `public`, so `isPubliclyServeable` refuses it (`CACHE-AUTH-005`).
- **Account erasure** (pulpit#207) deletes an account's memberships through the store's `eraseAccount`, with its pending invitations and the pending invitations it sent, in bounded batches (pulpit#274). **A group the erased account owns is reassigned to the tombstone account first** (owner decision on pulpit#274, 2026-11-12), through the application's `GroupOwnerStore`, so its members keep reading its `group` rows; `GroupOwnership.ownerOf` then answers the tombstone account, which holds no membership. The erasure definition's `disposeGroups` overrides that (see [`./erasure`](erasure.md#erasure)).

| Export | What it is |
| --- | --- |
| `defineAudience(definition)`, `AudienceDefinition`, `AudienceOps`, `MembersPageRequest` | The factory, its declaration, the operations and a page request. |
| `audienceSeam(store)`, `AudienceSeam` | The audience half of the follower seam, over the membership store. |
| `MembershipStore`, `GroupOwnership`, `GroupOwnerStore`, `Membership`, `MembershipRole`, `Invitation` | The membership table seam (see [Seams](seams.md#seams)), the application's group owners, their bounded reassignment for account erasure (see [Seams](seams.md#seams)), one membership, its roles, and one pending invitation. |
| `GroupNotFound`, `MemberNotFound`, `GroupOwnerMembership`, `InvitationNotFound`, `AlreadyMember`, `SelfInvitation` | The failures: 404, 404, 409, 404, 409 and 422. |

## `./notifications`

Notifications (pulpit#197), after gardeneria's `packages/jobs/src/notifications/` queue and its `social.notification_preferences`: the kernel owns _who is told what_; the application owns _how it is delivered_ (web-push, APNs, FCM, email) and the copy.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  commentRepliedHook,
  contentFlagged,
  defineNotifications,
  emitting,
  socialSuppression,
  subjectGateFromGet,
} from "@thomasfosterau/pulpit/notifications";

// In the write: a comment leaf's before hooks gain the reply event…
const hooks = {
  before: [moderationHook(declaration, policy), commentRepliedHook({ outbox, authorOf })],
  after: [],
};
// …and a write that appends no version emits inside the same transaction.
const file = (input) =>
  transact(
    emitting(outbox, reports.file(input), contentFlagged({ reports: reportStore, moderators })),
  );

// Out of band: the sweep fans the outbox out.
const notifications = defineNotifications({
  outbox,
  inbox,
  preferences,
  delivery, // the application's transports
  subjects: {
    posts: subjectGateFromGet(posts.get, asRecipient),
    comments: subjectGateFromGet(comments.get, asRecipient),
  },
  suppression: Option.some(socialSuppression(socialStore)),
  defaults: { channels: ["push"], mutedKinds: [] },
  viewer,
});
const sweep = Effect.gen(function* () {
  return yield* notifications.sweep(500); // { processed, delivered, suppressed }
});
```

- **The outbox is written by the write that causes it, in its transaction.** A chain write emits through a before hook (`notificationHook`, the place `./subtype` reserves for an outbox): a refusing hook after it, a lost race at the append or any later failure rolls the event back with the write. A write that appends no version (a report, a proposal's decision, a follow) emits through `emitting(outbox, write, derive)`, run inside the transaction that runs `write`. A draft addressed to its own actor is dropped.
- **The kernel kinds** (`KernelNotificationKind`), each a ready derivation: `comment.replied` (`commentRepliedHook`, the parent's author), `comment.moderated` (`moderationDecidedHook`, a move to `approved` or `rejected` notifies the owner), `content.flagged` (`contentFlagged`, each moderator), `proposal.decided` (`proposalDecided`, the author of an accepted or rejected proposal), `follow.created` (`followCreated`), and `mention.created` (`mentionCreatedHook`, below). An application adds its own kinds by widening `Kind`.
- **Mentions are the new ones in a write's documents** (pulpit#198). The kernel never reads a document's grammar: the application fills the [`MentionExtractor`](seams.md#mentionextractordocument-the-mention-extractor) seam (`(document) => accountIds`), and `mentionCreatedHook({ outbox, fields, documents, extract })` on the leaf's before hooks extracts the mentions from every document the write sets in a declared field (every locale's too, on a localised leaf), subtracts those the head's documents already mention (every declared field and locale), and emits one `mention.created` per account left, the node as its subject. So an edit that keeps a mention, or moves it to another field or locale, notifies nobody again; a `restoreVersion` that brings back a mention a later edit removed notifies again, since the diff is over the head. A write whose documents are all the head's (or that sets none) reads nothing; any other reads the new and the head's documents in one `getMany`, and a hash with no stored document mentions nobody. The recipient is gated at fan-out, as every node subject is: a mention of an account that can't read the node (a private post, a draft) or that blocks or is blocked by the author is dropped there (`SEC-AUTH-ENUM-001`), and a self-mention never reaches the outbox.
- **Fan-out reads the outbox oldest first, in bounded batches** (`sweep(limit)`, clamped to `MAX_PAGE_LIMIT`, `PERF-DB-001`). Per event, the recipient gets an inbox entry and a delivery on each channel they enabled, unless they muted the kind, they and the actor are muted or blocked (`socialSuppression`, `./social`), or **they can't read the subject**: each node subject is checked through its leaf's own `get`, run as the recipient (`subjectGateFromGet`), so nobody is told about a node they can't read (`SEC-AUTH-ENUM-001`). The gate is read at fan-out, once: a subject unreadable then (a reply still `pending` review, say) is dropped for good. A node subject whose type has no declared gate is dropped (fail closed); an account subject (a new follower) is not gated.
- **At-least-once.** The batch is marked processed after its deliveries, so a sweep that stops part-way re-delivers the unprocessed events; `deliver` gets the event, whose `id` is the transport's idempotency key, and the inbox is keyed by it, so a re-run adds no second entry.
- **The inbox is the viewer's own**: `inbox({ unreadOnly, limit, offset })` newest first, `markRead(ids)` (another account's ids change nothing), `unreadCount`, and `preferences` / `setPreferences` (the declared defaults until set). Each fails `Unauthorized` when anonymous.

| Export | What it is |
| --- | --- |
| `defineNotifications(definition)`, `NotificationsDefinition`, `NotificationOps`, `SweepSummary` | The factory, its declaration, the sweep and the inbox operations. |
| `notificationHook(options)`, `emitting(outbox, write, derive)` | The two ways a write emits, both inside its transaction. |
| `commentRepliedHook`, `moderationDecidedHook`, `contentFlagged`, `proposalDecided`, `followCreated`, `mentionCreatedHook` (`MentionDeclaration`), `mentionDrafts` | The kernel kinds' derivations. |
| `KernelNotificationKind`, `NotificationDraft`, `NotificationEvent`, `NotificationSubject` (`nodeSubject`, `accountSubject`), `InboxEntry`, `NotificationPreferences` | The vocabulary. |
| `OutboxStore`, `InboxStore`, `PreferenceStore`, `DeliverySeam`, `SubjectGate` (`subjectGateFromGet`), `SocialSuppression` (`socialSuppression`), `MentionExtractor` | The seams (see [Seams](seams.md#seams)). |

## `./translation`

Translation lineage and staleness (pulpit#208), after website's machine translation (`packages/jobs/src/translation/`, the `derivedFromId` lineage and the daily sweep). For a localised leaf (see [Localisation](read-model.md#subtype)).

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineTranslation, humanLineageHook } from "@thomasfosterau/pulpit/translation";

const declaration = {
  type: "pages",
  columns: ["title", "body"],
  sourceLocale: "en",
  targets: ["fr", "de"],
};
const translation = defineTranslation({
  ...declaration,
  chain: pagesChain, // the leaf's VersionChain port: the sweep reads `head` / `getVersion`
  candidates, // the nodes the sweep may send to the model, by id
  translator, // the application's model
  landing: { kind: "direct", update: pagesOps.update, actorId: Option.some(botId) },
  // or: { kind: "proposal", submit: botProposals.submit, hasPending }
});
const hooks = { before: [humanLineageHook(declaration)], after: [] }; // the leaf's LifecycleHooks

const nightly = Effect.gen(function* () {
  const page = yield* translation.sweep({ after: Option.none(), limit: 100 }); // { landed, skipped, conflicts, next }
  return page.next; // the cursor for the next page
});
```

- **Lineage is three locale columns.** Each locale records the locale it was derived from, the node version whose source text it translates (a decimal string, so it stays JSON inside a proposal's locale patch), and the method, `human` or `machine` (`LineageColumns`, default `derivedFrom` / `derivedFromVersion` / `derivation`). Declare them in the leaf's `LocaleLevel` beside the translated columns, and list only the translatable ones in the declaration's `columns`. As ordinary locale columns they travel through every write path (the `VersionChain` port's `locales`, `SubtypeOps.update`, a proposal, `restoreVersion`), and new lineage is always a new version (`VERSION-CHAIN-001/002`). `lineageOf` reads them and fails closed: a missing or malformed column reads as an **original** locale, never stale.
- **Stale and missing.** A derived locale is `stale` when its source's translatable columns at the head differ from those at the version it records, or that version can't be read. A target the node lacks, while the source locale is present, is `missing`. `pending` lists both for one keyset page of candidate nodes (`limit` clamped to `[1, MAX_PAGE_LIMIT]`): a chain read for the head, one for its snapshot, and one per distinct source version. A tombstoned node, a source the node dropped and a shared-column edit list nothing.
- **A privileged sweep read.** The sweep reads the chain directly, without a read gate: it is a server job that never serves what it reads. **Which nodes may reach a model is the application's**: `TranslationCandidates.nodes` is where it leaves out owned or private content it must not send to a third party.
- **Landing (owner decision on pulpit#208): per family.** `direct` writes one version per node through the leaf's hooked `update`, attributed to the bot, marked `machine`, and pinned to the head the sweep read (`expectedVersion`), so a concurrent edit is a `CONFLICT` entry, never overwritten. `proposal` submits one proposal per node through a `./proposals` instance whose viewer is the bot, so a person reviews it. `hasPending`, when given, skips a locale whose bot proposal is still pending, so a re-run doesn't propose it twice. A refused landing is a conflict entry named by its error's tag; a translator returning a column outside the family's is `TRANSLATOR_COLUMNS`. The translator's own failure stops the page, and a re-run from the same cursor resumes.
- **Human edits.** `humanLineageHook(declaration)` is a before hook: a write that sets a derived locale's translatable column, but no lineage column, is stamped `human`, keeping its source and source version, so a person's revision still goes stale when the source moves on. `stampHumanLineage` is the same transform for a chain-level `ChainHooks.beforeAppendLocales`.
- **Documents.** The `Translator` seam takes the source locale's translatable column values as they are. A ProseKit document column is the application's to translate segment by segment, without the model ever seeing its structure (prosekit-utilities; owner decision on pulpit#202).

| Export | What it is |
| --- | --- |
| `defineTranslation(definition)`, `TranslationDeclaration`, `TranslationOps` | The factory, its declaration and the two operations (`pending`, `sweep`). |
| `TranslationPair`, `TranslationPageRequest`, `PendingPage`, `SweepSummary`, `SweepConflict` | One pending locale, a page request, a page of pairs, a sweep page's summary and its conflict entries. |
| `Translator`, `TranslationCandidates`, `TranslationLanding` | The model seam, the candidate-node seam and the landing mode. |
| `LineageColumns`, `defaultLineageColumns`, `LocaleLineage`, `TranslationMethod`, `lineageOf`, `lineagePatch` | The lineage columns, their default names, a read lineage, its method, and its read and write. |
| `humanLineageHook(declaration)`, `stampHumanLineage` | The before hook that marks a person's edit, and its pure transform. |

## `./reference-import`

External reference import (pulpit#209), after preferenceflow's ingestion writer (`packages/jobs/src/apply/write.ts`: the upsert on an external id, the per-column `UpdateMode`, an admin's pre-attached id), gardeneria's reconcile jobs and website's Wikidata reconciliation: reference content that comes from outside, merged with curated edits.

```ts
import * as Effect from "effect/Effect";
import { defineReferenceImport } from "@thomasfosterau/pulpit/reference-import";

const parties = defineReferenceImport({
  leaf: partiesDefinition, // the reference leaf's own `SubtypeDefinition`
  ids: externalIds, // its `ExternalIdStore`
  authorities: ["aec", "wikidata"],
  actor: { id: ingestBotId, role: "contributor" }, // at the leaf's corpus-write rung
  fields: { name: "overwrite", abbreviation: "coalesce", colour: "curated-wins" },
});

const nightly = Effect.gen(function* () {
  // An admin links a curated node first, so the feed updates it instead of duplicating it.
  yield* parties.attach({ authority: "aec", externalId: "36", id: curatedGreensId });
  const summary = yield* parties.run({ authority: "aec", records: feedPage }); // ≤ MAX_IMPORT_BATCH
  return summary; // { created, updated, unchanged, written, conflicts }
});
```

- **Ordinary chain writes, made as the actor.** `run` rebinds the leaf's own `defineSubtype` operations to the declared actor (a bot account), so the leaf's gates and before hooks apply and every version records the actor: a `create` for an id that names no node (the id is minted and linked before the create), an `update` with the head it read as its expected version otherwise. No version is rewritten (`VERSION-CHAIN-001/002`), and a tombstoned node is never written over (`VERSION-CHAIN-006`). The declaration throws `ReferenceImportDeclarationError` for a leaf that isn't reference data, an actor below its corpus-write rung, no authority or a repeated one, and a field the view lacks.
- **Merge modes**, per declared field; a key the record omits always carries the node's value forward:
  - `overwrite`: the feed's value, `null` included;
  - `coalesce`: the feed's value, except that `null` keeps the node's;
  - `curated-wins`: the feed's value unless the field is **curated**, meaning its value on the node differs from what the last import of this id sent (the link's baseline, kept by the `ExternalIdStore`), so someone else changed it since. With no baseline for the field (a pre-attached id), any present, non-`null` value is curated. The baseline is the feed's own record: the chain's read seam reports no actor per version, and replaying the history per field would be unbounded.
- **No-op detection.** A record whose merged state equals the head appends nothing (`unchanged`); a re-import of identical data writes no version.
- **One external id, one node.** Within a family an `(authority, externalId)` pair names one node and a node has at most one id per authority. `attach` (the leaf's write gate for that node, as the request's viewer) links an existing node, and fails `ExternalIdTaken` when either side is already linked otherwise.
- **A batch, and its conflicts.** At most `MAX_IMPORT_BATCH` records (`PERF-DB-001`; `ImportBatchTooLarge` otherwise, and `UnknownAuthority` for an undeclared authority, both before anything is read), their links read in one `lookup`, the records written in order. A record that loses a race (`StaleVersion`, `VersionConflict`), meets a tombstone, is refused by a before hook (`WriteRejected`), loses a link race or repeats an earlier id is a conflict entry with its reason (`stale`, `deleted`, `rejected`, `taken`, `duplicate`), never a failed batch. Run each batch in one transaction.
- **No cache write-through.** The import writes through the operations, not `subtypeHandlers`: evict each `written` entry's `(id, version)` from the resource cache once the batch commits.

| Export | What it is |
| --- | --- |
| `defineReferenceImport(definition)`, `ReferenceImportDefinition`, `ReferenceImportOps` | The factory, its declaration, and `run` / `attach`. |
| `MergeMode`, `MAX_IMPORT_BATCH` | The three merge modes and the batch cap. |
| `ImportBatch`, `ImportRecord`, `ImportSummary`, `ImportWrite`, `ImportConflict`, `ImportConflictReason` | A batch, a record, the summary, a write and a conflict. |
| `ExternalIdStore`, `ExternalIdLink` | The external-identifier table seam (see [Seams](seams.md#seams)) and one link. |
| `UnknownAuthority`, `ImportBatchTooLarge`, `ExternalIdTaken`, `ReferenceImportDeclarationError` | The failures: 422, 413 and 409, and the declaration error (thrown). |
