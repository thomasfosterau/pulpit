---
"@thomasfosterau/pulpit": patch
---

Documentation only:

- Every export and interface member now has a TSDoc summary, and every module header leads with its description. The `SubtypeOps` operations name their failures.
- The package README has an API table for `./filter` and `./subtype`, and states the seams' expected shapes.
- The README examples are self-contained and compile.
- The README and the docs state the hidden-row rule (`NodeNotFound`, never `Forbidden`) only for `get` / `getMany` / `list`, which is where it holds.
