---
"@thomasfosterau/pulpit": minor
---

Edge membership as a list filter (pulpit#113, option A). `EdgeOps` gains `memberFilter(end, otherIds)`. It returns an `Effect` of `isIn("id", <members>)` for the leaf at `end`: the node ids holding an edge whose other end is one of `otherIds`. It counts only edges the viewer can read (`EDGE-001`, the same `endpointFilter` as `list`). It answers `never` without reading the store for no ids, more than `MAX_SET_VALUES`, an unknown end, or a family of other than two ends. `EdgeStore` gains a required `members({ column, otherColumn, ids, where })` returning the subquery as the store's `Following`, and `makeInMemoryEdgeStore` implements it. `EdgeOps` takes an optional fifth type parameter, `Following` (default `never`). The `in` node's documented meaning widens from "the follower seam's subquery" to "a seam-provided subquery".
