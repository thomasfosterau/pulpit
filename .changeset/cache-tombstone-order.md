---
"@thomasfosterau/pulpit": patch
---

`./cache`: an eviction now wins a tie and outlives the value TTL. `makeResourceCache` orders a tombstone above a value at the same node version (it stores the rank `2·version`, plus one for a tombstone, as the entry's `version`), so a read-through that loaded a row before an unpublish at that version can no longer re-cache it. Tombstones are kept for the new `tombstoneTtlSeconds` option (default `DEFAULT_TOMBSTONE_TTL_SECONDS`, one day, and never less than `ttlSeconds`), so a late stale write that arrives after the value TTL is still refused.
