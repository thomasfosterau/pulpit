---
"@thomasfosterau/pulpit": patch
---

Document that a publish-gated leaf's publication operations must serialise per node (pulpit#164). `subtypeHandlers`' `publish` / `unpublish` stamp the cache with the node's head, so two of them on one head compare equal in the compare-on-set. The application runs them one at a time per node, with the lock held across the whole handler call (the transaction and the cache refresh after it). The `SubtypeHandlers.publication` doc comment and README → Seams say so.
