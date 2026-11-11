---
"@thomasfosterau/pulpit": minor
---

Carry a localised leaf's locale on the JSON:API wire (pulpit#184). The locale travels in `Accept-Language` / `Content-Language`.

- `subtypeResourceHandlers` takes an optional `LocaleWire` third argument. With it, `get` answers through `getLocalised`, trying the request's `Content-Language` first, then its `Accept-Language` preferences with their prefixes, then the leaf's default, and reports the locale served so the application can set `Content-Language` and `Vary: Accept-Language`. `create` and `update` land the translated columns in the `Content-Language` locale.
- New `acceptLanguage(header)` and `localePreferences(requested, defaultLocale)`.
- `SubtypeHandlers` gains `getLocalised`.
- `SubtypeHandlersConfig` gains `localised`: with it set, a write evicts every locale's cache entry instead of writing through.
- `ResourceCacheSeam.set` takes an optional `locale`. The cache is keyed by `(id, locale)` under one compare-on-set version per id, and `makeInMemoryResourceCache` honours it.
- `./cache`'s `makeResourceCache` evicts on a localised `set`. It doesn't key by locale yet (pulpit#271).
