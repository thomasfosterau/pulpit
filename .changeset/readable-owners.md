---
"@thomasfosterau/pulpit": minor
---

Add distinct readable owners (pulpit#186). `SubtypeOps.owners({ limit, offset, includeDeleted, among? })` returns the accounts that own at least one row the viewer may list, read under exactly `list`'s scope (and its head-or-live choice on a publish-gated leaf). `readableOwners(leaves, request)` returns the exact union across leaves, failing `OwnerSetTooLarge` rather than answer a short one. `LeafStore` and `LiveView` gain the `distinct` seam method (`DistinctQuery`), which `./testing`'s leaf and publication fakes implement.
