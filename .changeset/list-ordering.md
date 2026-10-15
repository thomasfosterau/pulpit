---
"@thomasfosterau/pulpit": minor
---

`list` takes a sort order (pulpit#112). **Seam change:** every `LeafStore` implementation must now honour `orderBy`.

- `ListRequest` gains an optional `orderBy`: `{ column, direction: "asc" | "desc" }` keys (`ListOrder`). Absent or empty is today's order, `id` ascending.
- `defineSubtype`'s `list` checks each column against the view's `LeafStore.columns` before it reads the viewer or the store. An undeclared column (or another direction) fails with the new tagged error `InvalidListOrder` (`{ type, column }`), so `list`'s error channel (and `SubtypeHandlers.list`'s) gains it. A repeated column is dropped, and each key is rebuilt to just its column and direction.
- `LeafStore.list`'s query gains the required, already checked `orderBy`. The contract is `ORDER BY <column> ASC|DESC NULLS LAST, …, id ASC`: `NULLS LAST` in both directions, `id` ascending closing every order, and string keys under `COLLATE "C"` (code-point order). The order never changes which rows match or the total. See README → Seams → `LeafStore`.
- `makeInMemoryLeafStore` (`./testing`) sorts by that contract. It shares one code-point comparator with `./filter`'s comparison arms, and places `NaN` after every number as PostgreSQL's `float8` does.
