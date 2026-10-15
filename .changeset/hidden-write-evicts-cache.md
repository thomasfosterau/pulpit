---
"@thomasfosterau/pulpit": patch
---

`subtypeHandlers` now evicts a leaf's cached resource when the re-read after a committed write fails, so a write that hides the row from its own writer (a corpus writer below the view-private rung making a reference row `private`, by `update` or `restoreVersion`) no longer leaves the superseded public resource in the cache (`CACHE-AUTH-005`). Any re-read failure evicts (a store error or a defect too) and propagates unchanged. Each write now runs under `Effect.uninterruptibleMask`, so an interrupt can't come between a committed write and its write-through or eviction (`delete` included); a failure of `transact` after the operation succeeded, an interrupt included, evicts as well, while a write the gate or the precondition refuses still never touches the cache. The writer's response is unchanged: the re-read's `NodeNotFound`.
