---
"@thomasfosterau/pulpit": minor
---

Search's kernel half in `./subtype` (pulpit#54). The ranking stays the application's SQL.

- `defineSearchProjection({ fields, languageColumn? })` declares a leaf's indexed view columns, their `A`–`D` weights and its language column. `defineSubtype`'s new optional `search` field checks the projection against the view, throwing `SubtypeDeclarationError` as `sortable` does.
- `searchScopeFilter(leaf, viewer, { includeDeleted, where })` is the read scope a search applies to its hits. It is the very filter `list` reads under, and `list` now calls it.
- `hydrateSearchHits(ops, hits)` re-reads ranked hits through the gated `getMany`, keeping rank order and dropping a hidden or missing hit.
