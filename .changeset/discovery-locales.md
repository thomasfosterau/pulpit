---
"@thomasfosterau/pulpit": minor
---

`./discovery` enumerates localised leaves (pulpit#265): one item per `(node, locale)` with its `locale`, a feed keyset on the feed key, the locale and the node, a per-locale feed (`DiscoveryRequest.locale`), and sitemap items whose `alternates` list the node's other locales (`hreflang`), with sitemap pages that never split a node's locales. `defineDiscovery` no longer refuses a localised leaf.
