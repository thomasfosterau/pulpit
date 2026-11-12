---
"@thomasfosterau/pulpit": minor
---

Add `./erasure`: account erasure (pulpit#207). `defineAccountErasure` purges, reassigns to a tombstone account or anonymises a deleted member's nodes per family (`ErasurePresets`: owned leaves purged, reference contributions reassigned, comments anonymised) and erases every row naming them, in bounded, resumable and idempotent batches, over a new `AccountErasureStore` seam.

The version chain stays strictly append-only: no version row is rewritten. Each node the account wrote (or that an accepted proposal of theirs produced) gets one redacting version appended through the family's `VersionChain` (an `update` carrying the head's state, attributed to the tombstone account or to no one, with no `proposedBy`, and with the family's declared `accountColumns` redacted). Earlier versions keep their original attribution by design; `./purge` is the way to remove history. A re-run appends nothing: `AccountErasureStore.unredactedNodes` finds only the nodes with no redacting version since the account's last one.

**Breaking for store implementers:** `ProposalStore` gains `eraseAuthor`, `ReportStore` `eraseReporter` and `WorkingCopyStore` `eraseAccount`; `ReactionStore.eraseAccount` and `SocialStore.eraseAccount` take a `limit` and erase at most that many rows. The in-memory fakes in `./testing` implement each, and `makeInMemoryAccountErasureStore` fills the new seam.
