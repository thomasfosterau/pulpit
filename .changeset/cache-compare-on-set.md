---
"@thomasfosterau/pulpit": minor
---

A version-stamped resource cache, compare-on-set (pulpit#121). A racing write-through or read-through fill can no longer re-cache a stale public resource.

- `./subtype`: `ResourceCacheSeam` now takes a version on both calls, `set(id, resource, version)` and `delete(id, version)`. The cache keeps, per id, the highest version either call gave it, and a `set` below that version is a no-op. The compare and the write must be one atomic step. This is a seam change: a cache that ignores the version leaves the race open.
- `./subtype`: `cacheWriteThrough` and `subtypeHandlers` pass the version the write landed at, including to the eviction after a failed re-read or boundary, and a repeated delete's eviction at the tombstone's version.
- `./testing`: the new `makeInMemoryResourceCache(serveable)` is the seam's reference fake, with `get(id)` and `versionOf(id)`.
