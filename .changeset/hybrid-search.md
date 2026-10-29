---
"@thomasfosterau/pulpit": minor
---

Hybrid search (pulpit#204): a new `./search` module (also the root's `Search` namespace). `fuseRankings` is reciprocal rank fusion over ranked branches (`weight / (k + rank)`, `RRF_K` = 60, ties by id, capped at `MAX_PAGE_LIMIT`); `applyReranking` and the `RerankerSeam` let a reranker reorder the fused candidates but never add or drop one; `hybridSearch` runs `SearchBranch` seams under one read scope (the leaf's `searchScopeFilter`), fuses and reranks. The embedding pipeline runs over `EmbeddingStore` and `Embedder` seams: `enqueueEmbeddings` (a document queued on its first insert), `embedPending` (one batched read, embed and write) and `sweepEmbeddings`, failing `EmbeddingMismatch` on a short answer. `./testing` adds `makeInMemorySearchBranch`, `scopeCheckedBranch` (failing `SearchScopeLeak` on a hit outside the scope) and `makeInMemoryEmbeddingStore`.
