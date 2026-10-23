---
"@thomasfosterau/pulpit": minor
---

`./filter` gains `isNull(column)`, a `ListFilter` node a SQL renderer renders as `col IS NULL` and `evaluate` reads as true for a column that is `null` or absent. It is the one node a `NULL` column satisfies on its own, so `or(isNull(col), noneOf(col, values))` is an exclusion that keeps an unset column, which a bare `noneOf` drops (`NULL <> ALL(…)` is `NULL`). A renderer that matches `ListFilter` exhaustively must add the arm. (pulpit#170)
