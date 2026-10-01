---
"@thomasfosterau/pulpit": minor
---

**Breaking:** require `effect@>=4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@>=0.16.0`. Effect rc.118 moved every `effect/unstable/*` entry point to `effect/*`, and effect-jsonapi 0.16.0 is the build against that layout, so pulpit no longer resolves against rc.117 or earlier, or against an effect-jsonapi older than 0.16.

- the `effect` peer floor is now `>=4.0.0-rc.118` (was `>=4.0.0-rc.112`);
- the `@thomasfosterau/effect-jsonapi` peer floor is now `>=0.16.0` (was `>=0.14.0`);
- built and tested against `effect@4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@0.16.0`.
