---
"@thomasfosterau/pulpit": minor
---

**Breaking:** the version chain's seam is now an operation-level port, `VersionChain<E, R>` (pulpit#246). It replaces the storage-level `VersionChainStore` (`head` / `snapshot` / `append` / `entries` / `mintId`), whose rules (append-only, never an upsert, carry-forward, tombstones, no resurrection, no partial restore, bounded history, the expected-version precondition) are now the port's contract, held by its implementation.

- The port has effect-drizzle-ext `-pg/chain`'s operations (`create`, `update`, `restore`, `delete`, `restoreVersion`, `getVersion`, `history`, `head`), in the kernel's input types, plus `purge` for `./purge`'s whole-chain erasure. Every kernel definition that took a `VersionChainStore` (`defineSubtype`, `definePurge`, `routable`, `defineProposals`, `defineWorkingCopy`, versioned collections) now takes the leaf's `VersionChain`.
- `defineVersionChain(type, chain, hooks?)` binds a leaf's operations over the port. It runs the before-append hooks in the kernel: a hooked write reads the head and its state, runs the hooks, and appends with `expectedVersion` pinned to that head. Without a caller precondition, a race lost by a hooked write is therefore `StaleVersion` rather than `VersionConflict` (both the wire's 409). A hooked create without an id is shown a freshly minted UUID, a `restoreVersion` whose state a hook changes is appended through `restore`, and a hook may refuse a `delete` but not change it: a non-empty patch for one is now a defect.
- `PurgeStore.eraseNode` no longer deletes the chain. It reads the node's references and erases its dependents, and `definePurge` then deletes the chain through `VersionChain.purge`.
- `./testing`: `makeInMemoryChainStore()` / `InMemoryChainStore` become `makeInMemoryVersionChain(type)` / `InMemoryVersionChain`, a per-leaf fake holding every invariant. Its `erase` is gone; use `purge`. New: `versionChainConformance(harness, runner)`, the port's conformance suite, which takes `describe` / `it` / `expect` as parameters, so no test-runner dependency is added.

Migration for a store implementer: implement `VersionChain` per leaf (pulpit-drizzle-pg will, over `-pg/chain`, pulpit#247), and run `versionChainConformance` against it.
