---
"@thomasfosterau/pulpit": minor
---

Add `./testing`: in-memory fakes of the kernel's seams, for tests (not for production, and not on the root export). They are the fakes the kernel's own suites run against, so an adapter's or an application's tests can run the real operations without a database.

- `makeInMemoryChainStore()` — a `VersionChainStore` with the `(id, version)` key, plus `rows`, `dropState` and `raceNextAppend` hooks.
- `makeInMemoryLeafStore(chain, { columns, now? })` — a `LeafStore`: the current-version view over an in-memory chain and its owner stamps, plus `owners` and `dropOwner` hooks.
- `makeInMemoryDocumentStore()` — a `DocumentStore` that hashes exactly as the README's hash contract states: SHA-256 over `canonicalText`.
- `makeInMemoryEdgeStore({ ends, uniqueKey, now? })` and `makeInMemoryNodes(columns)` — an `EdgeStore` with the unique key, the INNER JOIN of each end's view and the window-column total, and a hand-written `EndpointView`.
- `makeInMemoryFollowers(table)` and `InMemoryFollowing` — a `FollowerSeam` over an explicit table, whose `in` set is a `HashSet` of account ids.

`now` (the instant `published` / `notPublished` compare against) is a fixed `Date`, or the Effect `Clock` at each call when left out.

Add `canonicalText(json)` to `./documents`: the canonical text the `DocumentStore` hash contract takes SHA-256 over (PostgreSQL's `jsonb` text output), so a store that doesn't run on Postgres can reproduce the contract's hashes without importing `./testing`.
