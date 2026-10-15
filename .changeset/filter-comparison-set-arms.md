---
"@thomasfosterau/pulpit": minor
---

`./filter` gains comparison and literal-set arms (pulpit#113):

- `gt` / `gte` / `lt` / `lte` over a new `Comparable` (`string | number | Date`), rendered `col > $v` and so on. A string orders by code point (SQL's `"C"` collation), a `Date` by its instant. A `NULL` or absent column, or one of another type than the comparand, satisfies none, in `evaluate` as in SQL.
- `anyOf` / `noneOf` over a literal set of `Scalar`s, rendered `col = ANY($values)` / `col <> ALL($values)`. A `NULL` or absent column satisfies neither. An empty `anyOf` is `never`, an empty `noneOf` is `always`, and a set of more than `MAX_SET_VALUES` (1000) values is `never` (`SEC-INPUT-003`).

`Scalar` is unchanged. A SQL renderer of `ListFilter` must handle the six new node kinds; the rendering contract in the README states them.
