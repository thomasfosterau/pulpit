---
"@thomasfosterau/pulpit": patch
---

Trace more operations and adopt Effect idioms internally, with no type changes. `defineDiscovery`'s `feed` and `sitemap`, `defineReferenceImport`'s `run` and `attach`, and `defineTranslation`'s `sweep` now open spans (`<type>.discovery.feed`, `<type>.discovery.sitemap`, `<type>.import.run`, `<type>.import.attach`, `translation.sweep`). Internal helpers move from `(…) => Effect.gen(…)` to `Effect.fnUntraced`, `sweepEmbeddings` repeats with `Effect.repeat` instead of hand recursion, and `sha256Hex` encodes with `effect/encoding`'s `Hex`. No migration is needed.
