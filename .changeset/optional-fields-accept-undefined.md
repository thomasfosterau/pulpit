---
"@thomasfosterau/pulpit": patch
---

Optional fields accept an explicit `undefined`. Under `exactOptionalPropertyTypes`, `RegistryEntry`'s `resource`, `id` and capability flags, `ServeabilityOptions`' `owned`, `publishGated` and `now` (and so `serveablePolicy`'s options), and `ownedAccess`'s `draft` option are now declared `?: T | undefined`, so a caller can forward its own possibly-undefined value without branching. An explicit `undefined` reads exactly as an omitted key: an `undefined` flag is unflagged (at runtime and in `PickResources` / `flaggedMembers`), an `undefined` `now` reads the wall clock.
