---
"@thomasfosterau/pulpit": minor
---

The publication lifecycle (pulpit#46): a live-version pointer, opt-in per leaf, and the working copy.

- `./subtype`: a leaf that declares `publication: { live, facts, preview? }` is publish-gated. The view-private rung, a reference leaf's corpus-write rung and a row's own owner read the head; everyone else reads the version the append-only `PublicationStore` makes live (the most recently recorded `PublicationFact` whose `at` has arrived), through a `LiveView` beside the current-version view. On such a leaf `draft` means "no live version". `SubtypeOps.publication` (an `Option`) is `publish(id, { version?, at? })` (a future `at` schedules), `unpublish(id)`, `discardDraft(id)` (an appended restore of the live version; `NotPublished` with none) and `facts(id)`, each gated like a write and run through the before hooks; `SubtypeHandlers.publication` runs them in `transact` with the after hooks. A preview grant (`preview`) lets `get` serve exactly one node's head. On a gated leaf the handlers write the cache only from `publicResource` (the anonymous, live read). `SubtypeOps` also gains `authorize(id)`, the write gate on its own. `AfterWriteEvent` gains `publication`.
- `./version-chain`: `WriteAction` gains `publish` and `unpublish` (emitted by the publication operations, never the chain).
- `./working-copy` (and the `WorkingCopy` namespace): `defineWorkingCopy({ leaf, chain, store })` — an editor's autosave buffer over a `WorkingCopyStore`, one per (node, editor), outside the chain; `commit` appends it as one `update` expecting the head it was based on.
- `./testing`: `makeInMemoryPublication({ chain, leaves, now? })` and `makeInMemoryWorkingCopyStore()`.
