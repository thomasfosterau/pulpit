---
"@thomasfosterau/pulpit": minor
---

`./subtype`'s operations gain `compare(id, from, to)`: the chain's field-level `compare` behind exactly `getVersion`'s gate (`READ-009`). `getVersion` and `compare` share one history-read path, so the gate runs before any version is read and `compare` answers as `getVersion` would for `from` and then `to`: `Unauthorized` when anonymous, `Forbidden` below the write rung (on an owned leaf, for any row the caller doesn't own), `NodeNotFound` for an ownerless owned row or a missing reference row or one `get` hides from the caller, and `VersionNotFound` (naming `from` first) only to a caller the gate admits. `subtypeHandlers` doesn't expose it.
