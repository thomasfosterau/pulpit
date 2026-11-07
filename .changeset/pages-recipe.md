---
"@thomasfosterau/pulpit": minor
---

Add `./pages`, the page recipe's resolution read (pulpit#201): `resolveLocalised` resolves a path and a requested locale over a routable, localised leaf to the node in the best locale it carries (`localeFallbacks`: the tag, its base language, then the family's default), a redirect from an alias, or `PathNotFound`. A hidden, unpublished, scheduled or tombstoned page answers as a missing path does.
