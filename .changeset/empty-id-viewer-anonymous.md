---
"@thomasfosterau/pulpit": minor
---

An account whose id is `""` is now anonymous kernel-wide, not only on the read paths. Every module reads its viewer seam through the same rule, so a hand-built `{ id: "", … }` viewer gets `Unauthorized` from the write gates in `./subtype`, `./edges`, `./comments`, `./moderation`, `./proposals`, `./social`, `./reactions`, `./audience`, `./notifications` and `./working-copy`. `accessPolicyFromGuards` also answers `false` on every axis for an empty id, so `{ id: "", role: "moderator" }` no longer passes `canModerate`.

Migration: a viewer built with `viewerFromGuards` is unaffected, because effect-auth's `Guard.make` already reads an empty id as none. If you build a `Viewer` by hand, give every signed-in account a non-empty id.
