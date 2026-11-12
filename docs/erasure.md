# Erasure

The one destructive path, purging a node's whole history (`./purge`), and account erasure over it (`./erasure`).

## `./purge`

Erasure (pulpit#58). A tombstone hides a node and keeps every version of its content. Where that content is personal data that must be erased rather than hidden, `purge` hard-deletes it. It is the one sanctioned exception to the append-only chain (`VERSION-CHAIN-001/002`) and to `DOC-001`.

```ts
import { definePurge } from "@thomasfosterau/pulpit/purge";

const posts = definePurge({
  type: "posts",
  chain,
  store: purgeStore, // the application's erasure (see Seams)
  viewer,
  canPurge: (account) => account.role === "admin",
  transact,
  blobs: r2, // optional: where unreferenced bytes are deleted from
  cache, // optional: evicted past the purged head
});
// posts.purge(id) → { id, documents, blobs, bytesLeft }
```

- **The whole chain goes.** Every version row on every level, a live node's or a tombstone's, with the node's identity and owner rows. So do the rows the other seams keep for it: working copies, proposals, publication facts, path claims and aliases, reports, and every edge with the node at an end. A purged id is `NodeNotFound`, and so is its history.
- **Shared content survives.** Documents and bytes are shared by hash. A purge drops the node's references, and deletes a document or bytes only when no version of any other node still references the hash.
- **Bytes go after the commit.** The erasure and the document deletes run inside `transact`. The bytes are deleted once it has returned, as `./blobs` writes them. A failed delete is logged and listed in the report's `bytesLeft` rather than failing a purge that has committed. Without a `blobs` store every unreferenced content hash is listed there. A file written with the same bytes between the commit and the delete loses them, so a deployment that can race that way confirms its `bytesLeft` and pending files after a purge.
- **A dedicated rung.** `canPurge` is checked before anything is read, so a caller below it gets `Unauthorized` or `Forbidden` for every id alike. Erasure is one step: a live node purges as a tombstoned one does.
- **The writes bypass `subtypeHandlers`** and the leaf's lifecycle hooks. Pass the leaf's `cache` so no cached copy outlives the erasure (`CACHE-AUTH-005`).

| Export | What it is |
| --- | --- |
| `definePurge(definition)`, `PurgeDefinition`, `PurgeOps` | The operation (`purge`) and what it binds. |
| `PurgeStore`, `ErasedReferences` | The erasure seam (see [Seams](seams.md#seams)) and the hashes an erased node referenced. |
| `PurgeReport` | What a purge did: the documents and bytes deleted, and the bytes left behind. |

## `./erasure`

Account erasure (pulpit#207). `./purge` erases one node; this erases one account: when a member deletes their account, everything they own or wrote is purged, reassigned or anonymised, and every row that names them goes.

```ts
import { defineAccountErasure, ErasurePresets } from "@thomasfosterau/pulpit/erasure";

const erasure = defineAccountErasure({
  viewer,
  canErase: (actor, accountId) => actor.role === "admin" || actor.id === accountId,
  tombstoneAccountId: DELETED_ACCOUNT, // the account reassigned rows name
  transact,
  store: accountErasureStore, // owner records, and the nodes still to redact (see Seams)
  purge: purgeStore, // the `./purge` seam, for the `purge` families
  blobs: r2, // optional, as for `./purge`
  families: [
    { type: "posts", disposition: ErasurePresets.ownedLeaf, chain: postChain, cache: postCache },
    { type: "comments", disposition: ErasurePresets.comments, chain: commentChain },
    {
      type: "taxa",
      disposition: ErasurePresets.referenceLeaf,
      chain: taxonChain,
      accountColumns: ["creditedTo"], // state columns holding an account id, if any
    },
  ],
  proposals, // each kernel store the application keeps, all optional
  reports,
  reactions,
  social,
  workingCopies,
  memberships, // `./audience`
  groups: groupOwnerStore, // `./audience`: the groups the account owns go to the tombstone account
  relations: [{ name: "notifications", erase: eraseNotifications }], // the application's own
});
// erasure.erase(accountId, { maxBatches }) → { complete, batches, changed, purged }
```

- **A disposition per family** (owner decisions on pulpit#207, named as `ErasurePresets`):
  - `purge`, the default for owned leaves: each node the account owns goes through `./purge`, whole chain, documents and bytes.
  - `reassign`, the default for reference contributions: owner records name the tombstone account instead, and each node the account wrote gets a redacting version attributed to the tombstone account.
  - `anonymise`, the default for comments: the content stays and the owner record is removed, so the row is no one's (an ownerless owned row reads only when public, pulpit#85), and each node the account wrote gets a redacting version with no actor. A reply keeps the thread it answers.
- **A redacting version, never a rewrite** (owner decision on pulpit#207, 2026-11-11). The chain stays strictly append-only (SECURITY.md → `VERSION-CHAIN-001/002`): no version row is rewritten. Each node with a version the account wrote, its own or someone else's, or that an accepted proposal of theirs produced (`proposedBy`), gets one new version appended through the family's `VersionChain` port: a plain `update` pinned to the head it read (`expectedVersion`), carrying the head's state, attributed as the disposition says (the tombstone account for `reassign`, no one for `anonymise` and for a `purge` family's other members' nodes) and with no `proposedBy`. A state column the family declares in `accountColumns` is set to the tombstone account (`reassign`) or `null` in that version where it names the account; erasure knows no other field. **Earlier versions keep their original attribution by design**: the current version no longer names the account, and the history of who wrote what is not rewritten. `./purge` is the way to remove history, so a family whose history must go is a `purge` family.
  - The append bypasses `defineVersionChain`'s hooks and the leaf's lifecycle hooks: it is not an edit.
  - A node whose head is a tombstone gets no redacting version, since no port operation appends over a tombstone without resurrecting it (`VERSION-CHAIN-006`); the tombstone stays hidden below the view-deleted rung. **It is redacted on restore** (owner decision on pulpit#303): a restored node's head is live again and still matches the marker, so **an application that restores a node an erased account wrote re-runs erasure for that account afterwards**, and that run appends the redacting version. A family whose history must go is a `purge` family.
  - **The marker** that keeps it to one: a node needs a redacting version when a version names the account (actor or `proposedBy`) and no later version is attributed the way the redacting one would be (the disposition's actor, no `proposedBy`); `AccountErasureStore.unredactedNodes` reads that off the version rows. A later write by another account keeps the node redacted; only a later version by the account itself makes it match again.
  - The node is evicted from its family's `cache` at the redacting version (`CACHE-AUTH-005`), and a node whose owner record changes, past its head. A redacting append that loses a race fails `StaleVersion` or `VersionConflict`; its batch rolls back and a re-run resumes.
- **The kernel's stores:** pending, rejected and withdrawn proposals are deleted, and accepted ones keep their row under the tombstone account; reports filed are deleted, and a resolution names the tombstone; reactions, follows, mutes, blocks, group memberships (`./audience`) and working copies are deleted. Add the application's own (memberships, notifications, …) as `relations`.
- **Groups the account owns** (owner decision on pulpit#274, 2026-11-12): every one is reassigned to the tombstone account through `groups` (a `GroupOwnerStore`, see [Seams](seams.md#seams)), so its members keep their access: their membership rows stay, and `isMember` still answers them. The step runs just before the memberships step, so the account owns none of the groups whose membership rows then go; those rows are deleted through the store, so `GroupOwnerMembership` (an operation's refusal, not the store's) never blocks erasure. The tombstone account owns the group with no membership row, so it reads none of its rows. **The override** is `disposeGroups: erase`, a bounded erase shaped like a relation's (`{ accountId, replacement, limit } → Effect<number>`) that runs in the reassignment's place: delete the groups (each with `MembershipStore.removeGroup`, so their `group` rows read as `private`), or hand them to an admin. Like every step it changes at most `limit` groups per call, each of which then no longer names the account as its owner. Without `groups` or `disposeGroups`, erasure touches no group. If a group is a node of an erasure family, its owner record is handled there instead.
- **Bounded, resumable, idempotent.** Each step reads or writes at most `batchSize` rows or nodes (default 100, capped at `MAX_PAGE_LIMIT`, `PERF-DB-001`) in its own `transact`, and repeats until a batch changes fewer. Written rows stop matching, so a run cut short by `maxBatches` (it counts the batches that change rows) or a crash resumes on the next run, and a run over an erased account changes nothing and appends no version (`changed: {}`).
- **The gate:** `canErase(actor, accountId)` is checked before anything is read (`Unauthorized` / `Forbidden`), and erasing the tombstone account itself fails `TombstoneErasure`.
- **The application deletes the account row itself** once a run answers `complete: true`; nothing the kernel stores names it then, save the earlier versions' attribution, kept by design (so a version table's actor column must not hold a foreign key that blocks the delete, or must point at an account row kept for it).

| Export | What it is |
| --- | --- |
| `defineAccountErasure(definition)`, `AccountErasureDefinition`, `AccountErasureOps` | The operation (`erase`) and what it binds. |
| `Disposition`, `ErasurePresets`, `ErasureFamily` | A family's declaration (its chain, cache and `accountColumns`), and the owner's defaults. |
| `AccountErasureStore`, `AccountRelation` | The owner-record seam, with the redaction marker's read (see [Seams](seams.md#seams)), and an application relation. |
| `ErasureSummary`, `TombstoneErasure`, `DEFAULT_ERASURE_BATCH` | What a run did, the tombstone refusal, the default batch. |
