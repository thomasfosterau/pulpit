---
"@thomasfosterau/pulpit": patch
---

`subtypeHandlers` now evicts a leaf's cached resource when the re-read after a committed write fails, so a write that hides the row from its own writer (a corpus writer below the view-private rung making a reference row `private`, by `update` or `restoreVersion`) no longer leaves the superseded public resource in the cache (`CACHE-AUTH-005`). The writer's response is unchanged: the re-read's `NodeNotFound`.
