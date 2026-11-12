---
"@thomasfosterau/pulpit": minor
---

`PublicationOps.scheduled(ids)` (pulpit#220): the pending scheduled publication per node, in one batched read. For each node the viewer reads the head of (the view-private rung, a reference leaf's corpus writers, a row's own owner), visible and not tombstoned, it returns the most recently recorded `publish` whose `at` is still ahead of the `Clock` and which no later record overtakes; any other node, a hidden one and an unknown id are absent. It lets a consumer show a scheduled-but-not-yet-live node as `future` with its publication time, instead of every application re-deriving it.

**Breaking for store implementers:** `PublicationStore` gains `scheduled(ids)`, one `SELECT DISTINCT ON (node_id)` over the log (the contract is in docs/seams.md). `makeInMemoryPublication` in `./testing` implements it.
