---
"@thomasfosterau/pulpit": minor
---

Add `./edges` (and the `Edges` namespace): the edge operations factory, ported from gardeneria's `defineEdgeOpsE`.

- `defineEdgeOps(definition)` — one edge family's `list` (bounded, ordered by `createdAt` then `id`, with the unpaged total), `get`, `create` (idempotent under `onConflict: "ignore"`, `EdgeConflict` under `"fail"`) and hard `delete`, over an `EdgeStore` seam. Writes gate on `writeGate`: `corpusWriteGate` by default, `rungGate(rung)` for another rung, or a gate on an owned end's owner.
- Endpoint visibility (`EDGE-001`): an edge is readable only if the viewer can read the node at every end, by that leaf's own access rule. A hidden edge is `EdgeNotFound` from `get` and omitted from `list` and related lists; a create naming a node the viewer can't read fails `NodeNotFound` before the gate. `endpointFilter` (the list arm) and `canViewEndpoint` (the predicate) never disagree.
- Endpoint lifecycle: a tombstoned end hides its edges from every viewer; restoring the node brings them back.
- Cardinality: an end's `maxEdges` bounds the edges one node may hold, and a create past it fails `EdgeCardinalityExceeded`. A `maxEdges` that isn't a positive safe integer, or an end alias containing a `.`, throws `EdgeDeclarationError` when the family is declared. A tombstoned partner keeps its slot until it is restored (a known limitation, pulpit#77).
- The invariant `EDGE-001` (SECURITY.md). The package README documents taxonomies as a reference leaf plus an edge family.
