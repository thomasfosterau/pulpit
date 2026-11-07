---
"@thomasfosterau/pulpit": minor
---

Add `./discovery` (#203): `defineDiscovery` enumerates a leaf's discoverable nodes for its feed (newest first) and sitemap (by id), keyset-paged. A node is listed only when an anonymous reader may list it (the live version on a publish-gated leaf), its resource is publicly serveable (`CACHE-AUTH-005`), and it has a canonical path. Also adds a per-family metadata projection (`DiscoveryMetadata`, `lastModified`) and `purgeHintHook`, an after hook that emits the Cache-Tag purge hint for every write that can change what the family lists.
