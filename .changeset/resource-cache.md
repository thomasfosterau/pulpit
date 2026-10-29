---
"@thomasfosterau/pulpit": minor
---

The reference resource cache (pulpit#205): a new `./cache` module (also the root's `Cache` namespace). `makeResourceCache` implements `./subtype`'s `ResourceCacheSeam` (the compare-on-set write-through `subtypeHandlers` drives) plus a read-through `get`, over a minimal `VersionedKv` seam whose one conditional write keeps the highest version. Serveability is checked on both the write and the read (`CACHE-AUTH-005`), a stored value that no longer decodes is evicted, every write carries a TTL backstop, and a KV failure reads as a miss, so the cache never fails. `./testing` adds `makeInMemoryVersionedKv`.
