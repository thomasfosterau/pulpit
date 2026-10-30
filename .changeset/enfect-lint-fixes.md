---
"@thomasfosterau/pulpit": patch
---

Error messages no longer print a non-string column value as `[object Object]`: an edge whose end column holds a non-string value fails with a `NodeNotFound` whose `id` is the value formatted, and a refused moderation transition names a non-string target the same way. Found by the new type-aware lint (`typescript/no-base-to-string`); no signature changes.
