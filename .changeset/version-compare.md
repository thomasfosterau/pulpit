---
"@thomasfosterau/pulpit": minor
---

Field-level version compare on `./version-chain`.

- `diffStates(from, to)` is a pure function over two `ChainState`s. It returns a `StateDiff`, keyed by column: each column that differs is `added`, `removed` or `changed` (an `AttributeChange` with its `before` and `after` values), and unchanged columns are omitted. A `null` is a present value, so a clear is `changed`; only a column with no key is absent. Values compare structurally (`Equal.equals`: JSON by content, a `Date` by its instant, a `bigint` by value), and a `documentRef` column compares by hash.
- `defineVersionChain`'s operations gain `compare(id, from, to)`: two `getVersion` reads plus `diffStates`. It returns a `VersionComparison` with both snapshots and the `changes`, and fails `VersionNotFound` for either version. A tombstone shows as `from.action` / `to.action` being `"delete"`, never as a change.
