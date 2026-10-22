---
"@thomasfosterau/pulpit": minor
---

The head version on the wire, for `If-Match` (pulpit#65).

- `./subtype`: `LeafRow` now requires `version: bigint`, the head version. The current-version view projects it from the same head row as `action`. This is a seam change: a `LeafStore` (and an edge end's `EndpointView`) must now project the column, and no leaf column may be named `version`.
- `./subtype`: the new `versionMeta(row)` is the resource-object `meta` a `toResource` mapper stamps (`{ version: "3" }`, a decimal string). The new `versionEtag(resource)` reads that `meta.version` back as a single-resource response's strong `ETag` value (`'"3"'`), or none.
- `./testing`: `makeInMemoryLeafStore`'s rows carry their head `version`, and its `columns`, like `makeInMemoryNodes`', include `version`.
