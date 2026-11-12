---
"@thomasfosterau/pulpit": minor
---

Tighter boundary types, so `effect/no-unknown-parameters` needs no inline disable (pulpit#302):

- `isPubliclyServeable` and the hook that `serveablePolicy` returns are now type predicates. An admitted resource narrows to the new `PubliclyServeableResource`, an object with an `attributes` object. Their answers are unchanged.
- `./testing`'s `ConformanceRunner.expect` is generic: `expect<A>(actual: A)` returns `toEqual` / `toBe` taking an `A` and `toMatchObject` taking a `Partial<A>`. Vitest's `expect` still fits it as it is.
