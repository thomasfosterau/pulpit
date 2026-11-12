---
"@thomasfosterau/pulpit": minor
---

**Breaking:** `./edges`, `./publication`, `./cache` and `./search` spell their optional members as bare `?: T` (pulpit#238). Each was `?: T | undefined`; under `exactOptionalPropertyTypes` an explicit `undefined` no longer type-checks, so a caller with no value omits the key. The values and their defaults are unchanged, and every reader treats an absent key as before.

- `./edges`: `EdgeEnd.maxEdges` (`?: number`), `EdgeStore.closeValidity` (`?: CloseValidity<E, R>`), and `EdgeDefinition`'s `onConflict` (`?: "fail" | "ignore"`), `writeGate` (`?: EdgeWriteGate<E, R>`) and `validity` (`?: EdgeValidity`).
- `./publication`: `ServeabilityOptions`' `owned` and `publishGated` (`?: boolean`) and `now` (`?: Date`), so `isPubliclyServeable` and `serveablePolicy` take no explicit `undefined`.
- `./cache`: `ResourceCacheOptions.tombstoneTtlSeconds` (`?: number`).
- `./search`: `BranchRanking.weight` and `SearchBranch.weight` (`?: number`), `FusionOptions`' `k`, `limit` and `perBranch` (`?: number`), and `HybridSearchDefinition`'s `reranker` (`?: RerankerSeam<E, R>`), `k` and `perBranch` (`?: number`).

`./testing`: `InMemoryEdgeStoreOptions.now`, `makeInMemoryPublication`'s `now` and `makeInMemorySearchBranch`'s `weight` (which now omits the branch's `weight` key when given none).
