---
"@thomasfosterau/pulpit": minor
---

`subtypeResourceHandlers(handlers, config)` in `./subtype` wires a leaf's handler record onto effect-jsonapi's `ResourceHandlers.make` (part of pulpit#5).

- It returns the five CRUD handlers that `Group.flat` names (`list`, `get`, `create`, `update`, `delete`).
- Its config is `make`'s without `ops`, `cache` or `transact`, plus three mappings from the decoded inputs: `listRequest`, `createInput` and `updateInput`.
- Every write goes through the record, so it keeps the record's `transact`, writer re-read, after hooks and cache write-through.
