---
"@thomasfosterau/pulpit": minor
---

**Breaking:** `RegistryWireTypes.branches` (what `registryWireTypes` returns) is a `HashMap.HashMap<Root, ReadonlyArray<string>>` instead of a `Root`-keyed record. Building that record from `roots` took a type assertion; the `HashMap` is built directly. Read a branch with `HashMap.get(wire.branches, "content")`, which gives an `Option`.
