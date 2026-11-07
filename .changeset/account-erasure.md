---
"@thomasfosterau/pulpit": minor
---

Add `./erasure`: account erasure (pulpit#207). `defineAccountErasure` purges, reassigns to a tombstone account or anonymises a deleted member's nodes per family (`ErasurePresets`: owned leaves purged, reference contributions reassigned, comments anonymised), rewrites the attribution on the versions they wrote, and erases every row naming them, in bounded, resumable and idempotent batches, over a new `AccountErasureStore` seam.

**Breaking for store implementers:** `ProposalStore` gains `eraseAuthor`, `ReportStore` `eraseReporter` and `WorkingCopyStore` `eraseAccount`; `ReactionStore.eraseAccount` and `SocialStore.eraseAccount` take a `limit` and erase at most that many rows. The in-memory fakes in `./testing` implement each, and `makeInMemoryAccountErasureStore` fills the new seam.
