---
"@thomasfosterau/pulpit": patch
---

Brand every schema class and tagged error (`{ readonly brand: unique symbol }`), so a structurally identical value no longer type-checks where one is expected, and decode the numeric error and attribute fields (`CollectionFull.max`, `CommentDepthExceeded.maxDepth`, `EmbeddingMismatch`'s sizes, `fileResourceFields.byteSize`) as `Schema.Finite`, refusing `NaN` and the infinities (pulpit#238).
