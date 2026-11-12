---
"@thomasfosterau/pulpit": patch
---

`versionChainConformance`'s locale case now writes its translated column as `heading` (and its shared state as `title`), so a Drizzle chain can pass it: effect-drizzle-ext's `defineTree` rejects a keyed column that shares a key with a column on the leaf's path, and the case used to translate the shared `title` (pulpit#247).
