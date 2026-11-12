---
"@thomasfosterau/pulpit": minor
---

Add `./reference-import` (pulpit#209): `defineReferenceImport` upserts a reference leaf's nodes from a feed by `(authority, externalId)` identifiers through an `ExternalIdStore` seam, as ordinary chain writes made as a declared bot at the corpus-write rung. Each declared field takes a merge mode (`overwrite`, `coalesce`, `curated-wins`); a re-import of identical data appends nothing; an admin can pre-attach an id to a curated node (`attach`); and a batch (at most `MAX_IMPORT_BATCH` records) answers a summary whose races, tombstones and hook refusals are conflict entries. `./testing` adds `makeInMemoryExternalIdStore`.
