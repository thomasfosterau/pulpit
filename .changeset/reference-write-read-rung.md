---
"@thomasfosterau/pulpit": patch
---

Security fix: on a reference leaf, `update`, `restore`, `delete`, `getVersion` and `restoreVersion` now require the read rung the row demands, as `get` does (pulpit#101). A corpus writer who can't `get` the row (a non-`public` row without the view-private rung, or a tombstone without the view-deleted rung) gets `NodeNotFound`, the same answer as for a missing id, before any content is read or written. Before, the corpus-write rung alone let such a caller read a hidden row's history, rewrite it and revive a tombstone. `getVersion` and `restoreVersion` on a missing reference id now fail `NodeNotFound` rather than `VersionNotFound`. Owned leaves are unchanged.
