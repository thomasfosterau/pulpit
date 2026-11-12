---
"@thomasfosterau/pulpit": minor
---

`./links` reads nested lists (pulpit#313): a sub-menu is an entry whose target is another list, `{ kind: "list", id }`, so it needs no new storage. `list` reads it in place, as `{ kind: "list", id, links }`, and omits it like any hidden entry (`SEC-AUTH-ENUM-001`) when the viewer can't read its parent, when it is left empty, when it is the list it sits in or one above it (a cycle, cut at read time), and when it would nest past the definition's `maxDepth` (`DEFAULT_LINK_DEPTH`, 3, when absent). The whole read, every level together, reads at most `MAX_COLLECTION_SIZE` entries. `FollowedTarget` now takes the entry type, `FollowedTarget<Entry>`.
