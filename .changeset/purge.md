---
"@thomasfosterau/pulpit": minor
---

New `./purge` subpath (and `Purge` namespace): erasure, the one sanctioned destructive path through a node's history (pulpit#58). `definePurge({ type, chain, store, viewer, canPurge, transact, blobs?, cache? })` gives `purge(id)`, which checks its own rung before reading anything. It then hard-deletes the node's whole chain, together with every row the other seams keep for it, through the new `PurgeStore` seam, in the caller's transaction. Documents and bytes are deleted only when no other version references their hash; bytes go after the commit, and a failed delete is reported in `bytesLeft`. `./testing` gains `makeInMemoryPurgeStore`, plus `erase` / `remove` test hooks on the in-memory chain and document stores. `VERSION-CHAIN-001/002` and `DOC-001` now name purge as their one exception.
