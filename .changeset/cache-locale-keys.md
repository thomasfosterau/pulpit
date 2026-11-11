---
"@thomasfosterau/pulpit": minor
---

`./cache`'s `makeResourceCache` now caches a localised leaf per locale (pulpit#271). A `set` / `get` that names a locale uses its own `(id, locale)` key, under a per-id generation that keeps compare-on-set (pulpit#121) across locales: a fill behind the id's version in any locale is a no-op, an eviction wins a tie in every locale, and `delete` evicts every locale with one conditional write. `ResourceCache.get` takes an optional `locale`. Unlocalised use is unchanged; a localised `set` no longer evicts instead of caching.
