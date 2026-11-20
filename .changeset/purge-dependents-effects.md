---
"@thomasfosterau/pulpit": minor
---

`./testing`: `makeInMemoryPurgeStore`'s `dependents` are now Effects, `(id) => Effect.Effect<void>`, run in order after the chains' rows are read, instead of synchronous callbacks. Wrap an existing callback in `Effect.sync`.
