---
"@thomasfosterau/pulpit": minor
---

`subtypeHandlers` no longer writes a resource through the cache from inside an outer transaction (pulpit#124). There, `transact` is a SAVEPOINT and its return is not a commit, so a write the outer transaction later rolled back could stay cached and be served. `SubtypeHandlersConfig` takes a new, required `inTransaction: Effect<boolean, never, R>`, read once a write's `transact` has returned. Over `effect/sql` it is whether the fiber's context holds the client's `TransactionConnection`. When it reads true, the cache step evicts at the write's version instead of writing through.
