---
"@thomasfosterau/pulpit": minor
---

`./edges`: the view-deleted rung reads edges to tombstoned ends, and a create no longer discloses hidden edges (pulpit#77, pulpit#93).

- **The view-deleted rung reads an edge whose only hidden end is tombstoned.** It can `list`, `get` and `delete` the edge, so a moderator can find and remove a retired node's stale edges. An end hidden for any other reason, such as a `private` node below the view-private rung, still hides the edge from that rung. `canViewEndpoint` and `endpointFilter` change together. A create naming a tombstoned node is still `NodeNotFound`, to the rung too.
- **`maxEdges` counts only the edges the caller can read whose every end is live.** A tombstoned partner frees its slot at once, rather than freezing the node until it is restored. A refusal no longer tells a writer how many hidden edges the node holds. In exchange, the limit holds per caller, so a writer who can't read every edge can take a node past it. A restore can also bring a node past its limit; the node keeps its edges, and the next create there still fails.
- **The `EdgeStore` seam: `countAt` now takes `{ column, nodeId, where }`.** It counts the edges `list` would match under `where` at that node, over the same joins. The factory passes the viewer's `EDGE-001` filter and every end's liveness. A store that counted with no join must join each end's view, as `list` does.
- **A collision with a hidden edge answers exactly as one with a readable edge** (`EdgeConflict`, carrying only the family's type). A collision still says that the key is taken; README → `./edges` → What a write discloses states that residue, which arises only when a family's unique key leaves an end out.
