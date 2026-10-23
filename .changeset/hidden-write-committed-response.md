---
"@thomasfosterau/pulpit": minor
---

A committed write the writer can no longer read answers the committed write, not a 404 (pulpit#107).

- **`subtypeHandlers`**: `create`, `update`, `restore` and `restoreVersion` now answer a `CommittedWrite<Resource>`, `{ id, version, resource }`, where `resource` is the row as the writer re-read it, or `Option.none()` when the write hid it from them (a corpus writer below the view-private rung making a reference row `private`, say). They used to answer the resource and fail `NodeNotFound` for such a write. The cache entry is still evicted first (`CACHE-AUTH-005`), and any other re-read failure still fails the write.
- **`subtypeResourceHandlers`**: takes the resource's JSON:API `type`, and a hidden `create` / `update` answers effect-jsonapi's committed identifier document, `{ data: { type, id, meta: { version } } }` at `201` / `200`, through effect-jsonapi's `hiddenWrite`. Declare the group with `Group.flat({ …, hiddenWrites: true })`.
- The `@thomasfosterau/effect-jsonapi` peer floor is now `>=0.17.0`, the first release with the hidden-write document.
