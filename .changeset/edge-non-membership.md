---
"@thomasfosterau/pulpit": minor
---

Edge non-membership as a list filter (pulpit#191). `./filter` gains a `notIn` node and its constructor `isNotIn(column, set)`: `(col IS NULL OR col NOT IN (<seam subquery>))`, the exact complement of `in` over the same seam set, which `evaluate` reads with a `NULL` or absent column satisfying it. `EdgeOps` gains `nonMemberFilter(end, otherIds)`, the complement of `memberFilter` over the same `EdgeStore.members` subquery, for `?categories_exclude=` / `?tags_exclude=`. Only edges the viewer can read count as a membership (`EDGE-001`), so a hidden edge never excludes a row. It fails closed by excluding nothing (`always`, without reading the store) for no ids, more than `MAX_SET_VALUES`, an unknown end or a family of other than two ends. A `ListFilter` renderer must handle the new `notIn` node.
