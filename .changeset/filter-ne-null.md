---
"@thomasfosterau/pulpit": patch
---

`./filter`'s `evaluate` now reads `ne` the way the SQL rendering contract (`col <> $v`) does: a row whose column is `null` or absent satisfies no `ne`, as it already satisfied no `eq`. Previously such a row satisfied every `ne`, so an in-memory fake could list a row a conforming SQL renderer would not.
