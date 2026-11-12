---
"@thomasfosterau/pulpit": minor
---

**Breaking for store implementers:** `LeafStore.columns`, `EndpointView.columns` and `searchScopeFilter`'s `columns` are an Effect `HashSet.HashSet<string>` instead of a native `ReadonlySet<string>` (pulpit#302, `effect/avoid-native-object-helpers`). A Drizzle store builds its set as `HashSet.fromIterable(Object.keys(getColumns(view)))`. The in-memory fakes in `./testing` (`makeInMemoryLeafStore`, `makeInMemoryNodes`) build theirs with `HashSet.make`.
