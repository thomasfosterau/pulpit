---
"@thomasfosterau/pulpit": minor
---

Add `EdgeOps.countBy(end, ids, where?)` (pulpit#185): the number of edges the viewer can read at each node, in one grouped store read, with `EDGE-001` applied exactly as `list` applies it. `EdgeStore` gains the matching `countBy` seam method (one `GROUP BY` over the list's joins), and `./testing`'s in-memory edge store implements it.
