---
"@thomasfosterau/pulpit": minor
---

Optimistic concurrency: an optional expected-version precondition on every write to an existing node.

- `./version-chain`: `update`, `restore`, `delete` and `restoreVersion` take an optional `expectedVersion?: bigint | undefined` (the new `Precondition`). It goes in the input for `update` / `restore` and in a trailing argument for `delete` / `restoreVersion`. When the head isn't that version, the write fails the new `StaleVersion` error, which carries the version expected and the head found (`current`), and nothing is written. Without one, behaviour is unchanged.
- `./subtype`: `defineSubtype`'s `update`, `restore`, `delete` and `restoreVersion`, and `subtypeHandlers`' `update`, `delete` and `restoreVersion`, take the same precondition. Each checks it after the write gate.
- The check runs against the same head the append extends, so a writer that wins the race in between still surfaces as `VersionConflict` from the store's `(id, version)` key. The `VersionChainStore` seam is unchanged.
