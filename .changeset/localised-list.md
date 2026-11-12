---
"@thomasfosterau/pulpit": minor
---

A localised list that falls back per node (pulpit#272). `SubtypeOps.listLocalised` (and `SubtypeHandlers.listLocalised`) lists one item per node in the first of the requested locales it carries, under `list`'s own read gate and head-or-live choice, with the total counting nodes. `subtypeResourceHandlers` given a `LocaleWire` now answers `list` through it from `Accept-Language`, reporting a shared locale through `served` and any other page through the new `LocaleWire.varied` (set `Vary: Accept-Language` alone).

**Breaking for seam implementers:** `LeafStore` and `LiveView` gain a required `listLocalised(query)` (`LocalisedListQuery`: one row per node, the most preferred locale, `DISTINCT ON (id)` ordered by the locale's position; see docs/seams.md). `LocaleWire` gains the required `varied`.
