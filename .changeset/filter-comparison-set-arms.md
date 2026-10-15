---
"@thomasfosterau/pulpit": minor
---

`./filter` gains comparison and literal-set arms (pulpit#113):

- `gt` / `gte` / `lt` / `lte` over a new `Comparable` (`string | number | Date`), rendered `col > $v` and so on. A string orders by code point (SQL's `"C"` collation), a `Date` by its instant, a number numerically, with `Infinity` and `-Infinity` each equal to itself. A `NULL` or absent column satisfies none, in `evaluate` as in SQL.
- `anyOf` / `noneOf` over a literal set of `Scalar`s, rendered `col = ANY($values)` / `col <> ALL($values)`. A `NULL` or absent column satisfies neither non-empty arm. An empty `anyOf` is `never`, an empty `noneOf` is `always`, and a set of more than `MAX_SET_VALUES` (1000) values, duplicates counted, is `never` (`SEC-INPUT-003`). A renderer never binds a `NULL` element.

Outside the contract, `evaluate` fails closed rather than guess at SQL:

- A column of another type than the comparand, or than any of a literal set's values, is a caller or schema error: PostgreSQL may coerce the parameter or raise, and `evaluate` reads the row as satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`. For `ne` this is a change: `ne(col, 1)` was satisfied by a column holding `"2"`, and is no longer.
- `NaN` (and an invalid `Date`), which PostgreSQL orders equal to itself and above every number. Every constructor, `eq` and `ne` included, returns `never` for a `NaN` or invalid-`Date` comparand, as `anyOf` / `noneOf` do for a set holding a `NaN`, and `evaluate` reads a `NaN` comparand, set element or column as satisfying none of those arms. A renderer must never bind `NaN`. This changes `eq` and `ne`, including the pending `ne` reading (pulpit#75, #95): `eq(col, NaN)` and `ne(col, NaN)` now return `never` (`ne(col, NaN)` was satisfied by every non-null row, `NaN` included, where PostgreSQL's `'NaN' <> 'NaN'` is false), and a `NaN` column no longer satisfies `ne(col, v)`.
- A PostgreSQL timestamp keeps microseconds and a JavaScript `Date` milliseconds, so instants within one millisecond can compare differently.

`Scalar` is unchanged. A SQL renderer of `ListFilter` must handle the six new node kinds; the rendering contract in the README states them.
