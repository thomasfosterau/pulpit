---
"@thomasfosterau/pulpit": patch
---

`./testing`'s in-memory leaf store (`makeInMemoryLeafStore`, and the head and live views `makeInMemoryPublication` builds over it) now reads a filter node over a column outside its `columns` as `never`, as `@thomasfosterau/pulpit-drizzle-pg`'s SQL renderer does. Before, such a column read as `NULL`, so `isNull`, `notIn` and `notPublished` over it admitted every row in memory while PostgreSQL admitted none.
