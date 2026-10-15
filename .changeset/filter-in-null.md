---
"@thomasfosterau/pulpit": patch
---

`./filter`'s `evaluate` now reads `in` the way the SQL rendering contract (`col IN (<subquery>)`) does: a row whose column is `null` or absent satisfies no `in`, and `context.contains` is never asked about it. Previously the answer was left to `contains`, so one that answered `true` for `null` let an in-memory fake list a row a conforming SQL renderer would not.
