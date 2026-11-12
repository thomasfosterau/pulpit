---
"@thomasfosterau/pulpit": patch
---

`makeContentResource`'s id parameter is constrained to `Schema.Codec<unknown, string>` instead of `Schema.Codec<any, string>`. `Codec` is covariant in its decoded type, so every id schema it accepted before is still accepted.
