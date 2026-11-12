---
"@thomasfosterau/pulpit": minor
---

Add `./links` (#266): `defineLinkList` reads a flat, ordered, localised list of links under a parent node (a navigation menu, for one) over a `./collections` collection. Each entry targets a path (through `./pages`' `resolveLocalised`) or a node and carries a per-locale label. The one read omits every entry the viewer can't read or whose target they can't follow (hidden, unpublished, scheduled or tombstoned, an unclaimed path, an alias to a hidden node), leaving no gap and revealing neither the target nor the entry id (`SEC-AUTH-ENUM-001`); the owner and the view-private rung see what others can't.
