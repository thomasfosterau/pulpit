---
"@thomasfosterau/pulpit": minor
---

**Breaking:** `@thomasfosterau/effect-auth` (`>=0.2.0`) is now a required peer of the kernel (pulpit#5). Install it next to `effect` and `@thomasfosterau/effect-jsonapi`.

- `Unauthorized` and `Forbidden` are now effect-auth's `Guard` errors, re-exported from `./subtype` and the barrel. They carry a `message` and an optional `code`, so they encode on the wire with those fields. Code that constructs them must now pass `{ message }`.
- New `accessPolicyFromGuards(guards, axes)` and `viewerFromGuards(guards)` build the kernel's `AccessPolicy` and `Viewer` from effect-auth's `Guard.make` kit. `AccessAxes` names the four role axes.
- Peer floors rise: `effect` from `^4.0.0` to `^4.1.0`, and `@thomasfosterau/effect-jsonapi` from `>=0.17.0` to `>=0.20.0`, the ranges effect-auth itself peers on.
