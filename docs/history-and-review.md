# History and review

The append-only version chain and its compare (`./VersionChain`), an editor's autosave buffer (`./WorkingCopy`), suggested edits (`./Proposals`) and the moderation workflow (`./Moderation`).

## `./VersionChain`

The append-only chain, written and read through a `VersionChain` port the application supplies, one per leaf: in production pulpit-drizzle-pg over effect-drizzle-ext's `-pg/chain`, in tests `./testing`'s `makeInMemoryVersionChain`. `defineVersionChain` binds a leaf's operations over it, running the leaf's before-append hooks and adding `compare`.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineVersionChain, type VersionChain } from "@thomasfosterau/pulpit/VersionChain";

const program = <E, R>(port: VersionChain<E, R>) =>
  Effect.gen(function* () {
    const chain = defineVersionChain("posts", port);
    const actorId = Option.none<string>();
    const { id } = yield* chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
    yield* chain.update({ id, patch: { title: "Hi", summary: null }, actorId }); // null clears; an absent key carries forward
    yield* chain.update({ id, patch: { title: "Hey" }, actorId, expectedVersion: 1n }); // StaleVersion unless the head is 1
    yield* chain.delete(id, actorId); // tombstone; idempotent
    yield* chain.restoreVersion(id, 0n, actorId); // appends version N+1 with version 0's state
    const { changes } = yield* chain.compare(id, 0n, 1n); // { title: changed "Hello" → "Hi", summary: added null }
  });
```

These are the port's invariants, which every implementation holds and `./testing`'s `versionChainConformance` checks. Every write lands at `N_max + 1`; nothing is rewritten. A plain `update` never resurrects a tombstone (`restore` and `restoreVersion` do). A create is never an upsert (`NodeAlreadyExists`). `restoreVersion` refuses a version that cannot be fully reconstructed before writing anything. `history` is bounded (`MAX_HISTORY_LIMIT`).

**Optional members**. The chain's optional input, snapshot and hook members (`expectedVersion`, `locales`, `beforeAppend`, `beforeAppendLocales`) are bare `?: T`: a caller that has no value omits the key, and an explicit `undefined` does not type-check under `exactOptionalPropertyTypes`. `proposedBy` is `?: Option.Option<string>`, since none is a value a caller passes on. The tri-state patches (`ChainPatch`, `LocalePatch`) are the exception, a wire contract: there an `undefined` key is the carry-forward, as a decoded update input says it.

**Optimistic concurrency.** `update`, `restore`, `delete` and `restoreVersion` take an optional `expectedVersion` (a `Precondition`): the head version the caller last read. If the head has moved, the write fails `StaleVersion`, which carries the head it found (`current`), and nothing is written. Without one, a write extends whatever the head is, so a column that two patches both set is last-writer-wins. The check runs against the same head read the append extends, and the append lands at that head + 1. A writer that slips in between therefore takes the `(id, version)` key first, and the later append fails `VersionConflict`. The `(id, version)` key is what makes the check atomic. **With hooks** (`defineVersionChain(type, port, hooks)`, which `./Subtype`'s lifecycle hooks use) the kernel reads the head and its state, runs the hooks, and appends their patch with `expectedVersion` pinned to that head (the caller's own, when given), so the hooks always see the head the append extends; a writer that lands in between makes the write `StaleVersion` (both it and `VersionConflict` are the wire's 409), where an unhooked write without a precondition would report `VersionConflict`. A delete over a tombstone stays idempotent whatever the precondition (the delete it asked for has happened). A missing node is still `NodeNotFound`, and a plain `update` over a tombstone is still `NodeNotFound`, whatever version it expects.

**Comparing versions.** `diffStates(from, to)` is the field-level change set between two states: one entry per column that is `added`, `removed` or `changed`, each with its `before` and `after` values. Unchanged columns are omitted, so equal states diff to `{}`. A `null` is a value, so a column cleared to `null` is `changed`, and only a column with no key is absent (`added` / `removed`). Values compare structurally with Effect's `Equal.equals`: JSON objects and arrays by content (ignoring key order), a `Date` by its instant, and a `bigint` by value. A content-addressed document is held as its hash (`documentRef`), so it compares by hash, and a textual diff of the document is the UI's job. `compare(id, from, to)` makes two `getVersion` reads and returns both snapshots with `changes: diffStates(from.state, to.state)`. It fails `VersionNotFound` for either version, checking `from` first. A tombstone is the version's `action`, never an attribute: a version compared with the tombstone after it has no changes, and `to.action === "delete"` says the node was deleted there. The chain's `compare`, like its `getVersion`, applies no gate; `./Subtype`'s `compare` is the gated one (see [`./Subtype`](read-model.md#subtype)).

**Entry points:** `defineVersionChain`. Each export's contract, error channel and invariant IDs are in its TSDoc (`vp run -r docgen`).

## `./WorkingCopy`

An editor's autosave buffer. Nothing in it is a version, so a hundred autosaves leave no trace in history (`VERSION-CHAIN-001`); an explicit save appends one.

```ts
import { defineWorkingCopy } from "@thomasfosterau/pulpit/WorkingCopy";

const copies = defineWorkingCopy({ leaf: postOps, chain, store: workingCopies });
// copies.save(id, { title: "Draft" })   — overwrites this editor's copy, no version
// copies.commit(id)                     — one update, expecting the head the copy was based on
```

- **One copy per (node, editor)**, so two editors never overwrite each other's unsaved work.
- **`save` merges tri-state** over the editor's copy. A new copy is based on the head.
- **`commit` appends the copy** through the leaf's `update`, expecting that base, and clears it. If an edit landed in between, it fails `StaleVersion` and keeps the copy, so a commit never overwrites work its editor didn't see. With no copy it fails `WorkingCopyNotFound`.
- **Every operation runs the leaf's write gate** (`authorize`), since a copy shows unpublished state.

**Entry points:** `defineWorkingCopy`, `WorkingCopyOps`. Each export's contract, error channel and invariant IDs are in its TSDoc (`vp run -r docgen`).

## `./Proposals`

Suggested edits. A contributor proposes a patch to a node they can read; the node's writer accepts it (appending it as a new version) or rejects it, and the proposer may withdraw it while it is pending. A proposal is a plain row, not a node: the target, the patch as submitted, the `baseVersion` it was written against (stamped from the target's head, never client-supplied), its status (`pending | accepted | rejected | withdrawn`), the decider and the timestamps.

The optional members (`ProposalsDefinition`'s `forbidden`, `localeAttributes` and `budget`, `submit`'s `locales`, and `validateProposalPatch`'s `locales` and `localeAttributes`) are bare `?: T`: a caller that has no value omits the key rather than passing `undefined`.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineProposals } from "@thomasfosterau/pulpit/Proposals";

const pages = defineProposals({
  type: "pages",
  target: pageOps, // the leaf's defineSubtype operations
  chain, // the target leaf's VersionChain: the head a proposal is stamped with
  ownerOf: pageLeaves.ownerOf,
  proposals: proposalStore,
  viewer,
  policy,
  canPropose: () => true, // any signed-in account (gardeneria); website: contributor+
  attributes: ["title", "body"], // the leaf's update fields, in declaration order
  decode: decodePageUpdate, // the leaf's update decoder over a patch's values
});

const program = Effect.gen(function* () {
  const { id } = yield* pages.submit({
    targetId,
    patch: { title: "Better" },
    rationale: Option.none(),
  });
  const review = yield* pages.review(id); // { baseState: "clean" | "moved", conflict: { state, conflictingAttributes } }
  return yield* pages.accept(id, { note: Option.some("thanks") }); // the { id, version } it appended
});
```

- **Classification comes in two tiers.** `classifyProposalBase(base, head)` is `clean` or `moved` from two version numbers, with no read, so `get` and `list` give it for every pending row. `classifyProposalConflict(baseSnapshot, headSnapshot, touchedKeys)` is `clean`, `stale` (the target moved, but no touched attribute changed) or `conflicting`, over `diffStates`; it needs two version reads, so only `review` and `accept` run it. A touched attribute either state lacks (kept outside the chain) counts as conflicting on a moved target: fail closed.
- **A localised leaf**. Declare `localeAttributes` (the translated columns a proposal may touch: the leaf's locale level's `columns`, or fewer), and `submit` takes `locales`, a per-locale patch beside `patch`, stored as submitted in the row's `locales` and accepted through the same `update` as one version. `classifyProposalConflict(base, head, touchedKeys, touchedLocales)` reads each touched locale from the two versions' locale levels: a touched translated column conflicts when it changed or either version lacks it, every touched column of a locale added or dropped in between conflicts, and a locale neither version carries (a new translation) does not. The verdict's `conflictingLocales` and `ProposalConflict`'s `locales` name them by locale. A proposal may add a translation but never drop one: a `null` locale is refused, since removing a locale is the owner's.
- **The patch rules** (`validateProposalPatch`, at submit and again at accept): an object with at least one key; no `PROPOSAL_FORBIDDEN_KEYS` (`id`, `type`, `visibility`, `draft`, `publishedAt`, plus the leaf's own `forbidden`), checked before unknown keys; no key outside `attributes` (refused, never dropped); then the leaf's `decode`. A per-locale patch follows the same rules per locale, against `localeAttributes`, with a non-empty locale tag and no `null` (and the shared patch may then be `{}`). A failure is `InvalidProposalPatch` (422).
- **Accept appends through the target's own `update`** (`PUB-003`), as the account that accepted, with the head it classified against as `expectedVersion` and the proposer as the version's `proposedBy`; a conflicting proposal fails `ProposalConflict` (409) and writes nothing, and an edit landing between the classification and the append fails `StaleVersion`. The append and the proposal's close run in the caller's transaction, so they commit together. It runs the target's before hooks but not `subtypeHandlers`' cache write-through: an application that caches the target writes the accepted version through itself.
- **Gates.** `submit`: signed in (`Unauthorized`), at `canPropose` (`Forbidden`), and able to `get` the target (`NodeNotFound` otherwise, never `Forbidden`). `review`, `accept`, `reject`: the target's write gate (`requireWriter`) before the proposal's status is disclosed; `review` and `accept` then read the versions through the target's gated `compare`. A proposal whose target was deleted can still be rejected. `withdraw`: its author (`Forbidden` for anyone else). A decided proposal fails `ProposalClosed` (409). `get` / `list`: the moderate rung reads every proposal; any other signed-in account reads its own and those on targets it owns; the anonymous read none, and a proposal the viewer can't read is `ProposalNotFound`.

A [write budget](participation.md#budgets) throttles `submit` when the definition passes one as `budget`. Notifications and the wire shape (a JSON:API `proposals` resource) are the application's.

**Entry points:** `defineProposals`, `ProposalsDefinition`, `ProposalOps`. Each export's contract, error channel and invariant IDs are in its TSDoc (`vp run -r docgen`).

## `./Moderation`

The moderation workflow. The kernel owns the rules; the transport (a queue, running the classifier, an API-call ledger, moderator notifications) stays the application's. A leaf's moderation state is a column of its version row (`ModerationState`: `pending | approved | rejected`), so every decision is an appended version.

`defineReports`' `budget` is a bare `?: BoundBudget<E, R>`: omit the key for unthrottled reports rather than passing `undefined`.

```ts
import * as Effect from "effect/Effect";
import {
  defineModeration,
  moderatedColumns,
  moderationHook,
} from "@thomasfosterau/pulpit/Moderation";

const declaration = moderatedColumns(["body"]); // moderationState / moderatedAt / moderatedBy; an edit to body re-reviews
const comments = defineSubtype({
  // …the leaf's declaration…
  hooks: Effect.succeed({ before: [moderationHook(declaration, policy)], after: [] }),
});
const moderation = defineModeration({ target: comments, declaration, viewer, policy });
// moderation.moderate(id, "approved")
```

- **The rules** (`moderatePatch`, run as `moderationHook`, a before hook on [`./Subtype`'s lifecycle seam](read-model.md#subtype), so every write path honours them):
  - A create stores `pending`, and a create asking for another state fails `WriteRejected`.
  - Only the moderate rung changes the state, along `isModerationTransition`: `pending → approved | rejected`, re-moderation between `approved` and `rejected`, and re-review back to `pending`. Anyone else's change fails `WriteRejected`, appending nothing. A patch echoing the current state changes nothing.
  - A decision is stamped into the declared `moderatedAtColumn` and `moderatedByColumn`.
  - An edit that changes one of the leaf's `reReviewOn` attributes sends an `approved` row back to `pending`.
  - A `restoreVersion` below the moderate rung carries the current moderation columns over the restored version's, so an old approval never returns with old content.
  - An owner withdraws their own content by deleting it, which the owned write gate admits in every state.
- **The decision**, `defineModeration(...).moderate(id, decision, precondition?)`, is the moderate rung's: it fails `Unauthorized` / `Forbidden` before anything is read, then appends through the target's own `update`.
- **The read gate** is opt-in, on owned leaves only: declare the state column as the leaf's `moderationColumn` (`ownedAccess({ moderation: true })`), and `get` / `getMany` / `list` show a `pending` or `rejected` row only to its author and the view-private rung, as they do a draft. Without it, readers see every state the visibility axes admit, and the rule is the application's.
- **The review queue** is the leaf's pending rows, `reviewQueueFilter(viewer, policy, column?)` (pass it as a list request's `where`; `never` below the moderate rung), plus the open member reports.
- **Threshold grading**, `gradeScores(scores, thresholds, defaultThreshold?)`, is pure. It takes a classifier's report shaped like effect-ai-ext's `ModerationModel` output (`{ flagged, categoryScores }`; pulpit doesn't import it) and the leaf's per-category bars.
  - A category with no bar is graded against `DEFAULT_MODERATION_THRESHOLD` (0.5).
  - A score breaches only strictly above its bar, and an unassessed category (absent, never `0`) can't breach.
  - The classifier's own flag is never overridden downward.
  - The grade has a priority band (`low | medium | high | urgent`) from the worst breach.
  - Classification runs from an application's after hook; acting on a grade is a `moderate` call.
- **Member reports**, `defineReports({ target, reports, viewer, policy, budget?, moderation? })`, are plain rows over a `ReportStore`. An optional [write budget](participation.md#budgets) throttles `file`.
  - `file` needs a signed-in account that can `get` the target. One that can't gets `NodeNotFound`, never `Forbidden`, and the answer never says whether others reported the node.
  - `get` / `list` are for the reporter and the moderate rung.
  - `resolve(id, "resolved" | "dismissed", note)` is the moderate rung's alone. A closed report fails `ReportClosed`.
- **The report state machine** is `open → resolved | dismissed` (`isReportTransition`): a report is filed `open` and closes once, `resolved` when upheld (the content was acted on) and `dismissed` when not.
- **Reports and content moderation are linked** when `defineReports` is given the leaf's `moderation` (its `defineModeration` ops), and a decision goes through `withReports({ moderation, reports, viewer })`:
  - **Upholding a report is a content decision.** `resolve(id, "resolved", note)` moderates the target `rejected` (through its own `moderate`, so the hook stamps it), then closes every open report against it `resolved` with the same note. A target its owner already deleted still closes its reports. Dismissing closes that report alone and leaves the content as it is.
  - **A content decision settles the reports.** `withReports(...).moderate(id, decision)` is `moderate`, then closes the target's open reports as `reportOutcomeOf(decision)` says: `rejected` upholds them (`resolved`), `approved` dismisses them, and `pending` (a re-review) leaves them open. Its gate and errors are `moderate`'s, and a refused decision closes nothing.
  - Both writes run in the caller's transaction, so wrap the call in one for the decision and the closes to land together.
  - Without `moderation`, the two are independent, and acting on the node is a separate call.
- **Reports never change content on their own.** `file` writes only the report: a reporter can't write the target, so the kernel has no path that hides content because members reported it. An application that wants approved content re-reviewed after N open reports adds that write itself, after `file`, under an account it names. The re-review goes through the leaf's own `moderate` with the viewer seam answering that account for the one call, because `moderate` and the target's `update` both read the viewer, so the moderation hook admits and stamps it and the version chain records who made it:

  ```ts
  import { and, eq } from "@thomasfosterau/pulpit/filter";
  import * as Effect from "effect/Effect";

  // `moderation` is the leaf's `defineModeration`. `asSystem` is the application's: it runs an
  // effect with its viewer seam answering the system account (at the moderate rung) instead of
  // the reporter, e.g. `Effect.provideService(CurrentViewer, systemViewer)`.
  const fileReport = (input: Parameters<typeof reports.file>[0]) =>
    reports.file(input).pipe(
      Effect.tap(() =>
        reportStore
          .list({
            where: and(eq("targetId", input.targetId), eq("status", "open")),
            limit: 0,
            offset: 0,
          })
          .pipe(
            Effect.flatMap(({ total }) =>
              total >= RE_REVIEW_AT
                ? asSystem(moderation.moderate(input.targetId, "pending"))
                : Effect.void,
            ),
          ),
      ),
    );
  ```

  Run it in one transaction with the report. Moving to `pending` hides the node under a declared moderation column and puts it in the review queue, and the open reports stay open for the moderator who picks it up. A target that is already `pending` is left as it is, because the patch echoes its state. Read the state first if a `rejected` node shouldn't go back into the queue. The system account can then hide any member's content, so give it its own id and audit it like any other moderator.

Which rows a viewer below the moderate rung may _read_ in each state (gardeneria shows an unapproved comment to its author and the rung only) is still the application's read rule, as `PUB-005` records; `isPubliclyServeable` already refuses every state but `approved` from the cache.

**Entry points:** `moderationHook` and `defineModeration` for the decision, `defineReports` and `withReports` for member reports, and `gradeScores` for a classifier's report. Each export's contract, error channel and invariant IDs are in its TSDoc (`vp run -r docgen`).
