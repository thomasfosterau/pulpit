# packages/pulpit — `@thomasfosterau/pulpit`

The versioned-content kernel. The optional packages build on it; it never imports them. Invariant IDs are defined in [docs/SECURITY.md](../../docs/SECURITY.md#invariant-ids).

## Boundary

- Import only `effect`, `@thomasfosterau/effect-jsonapi` and `@thomasfosterau/effect-auth` (all peers). Never Drizzle, a framework or `node:*`: the stores are the application's.
- `./registry` and `./content` load in the browser, so they never reach `@thomasfosterau/effect-auth` (its root re-exports `node:crypto` modules), directly or through another kernel module. The rule `pulpit/browser-entries-stay-off-effect-auth` in `fallow-rules.json` enforces it.
- The in-memory fakes are public as `./testing`, one copy shared by the kernel's suites, the adapters and the applications. It is off the root barrel, imported by no other kernel module, and carries no application vocabulary. Each fake implements its seam's contract in [docs/seams.md](../../docs/seams.md) and enforces only what the real schema does: change a seam's contract and its fake together.
- **Seams before dependencies.** Write against a seam interface, state its expected shape in docs/seams.md and keep its fake in `./testing`; never vendor code from an unpublished package. effect-auth decisions are reached through `src/internal/delegated-access.ts`; `tests/effect-auth.test.ts` is the parity suite.

## Invariants

- **The version chain is append-only** (`VERSION-CHAIN-001/002`). Every write lands at `N_max + 1`; a restore is a new version; only `restore` / `restoreVersion` write over a tombstone (`VERSION-CHAIN-006`). The one exception is `./purge`, which hard-deletes a node's whole chain, never part of one. Never add a second path that deletes a version row, a document or bytes.
- **An expected version is checked against the head the append extends**, never a separate earlier read. `defineVersionChain`'s hook layer pins `expectedVersion` to the head its hooks see; don't add a write between that read and the append.
- **A stored document is never rewritten** (`DOC-001`). `canonicalText` in `src/documents.ts`, the fake's hashing and `tests/documents.test.ts` (Postgres-derived hashes) change together.
- **Update inputs are tri-state**: a value sets, `null` clears, `undefined` carries forward. Never spell `input.x ?? null`.
- **A read never reveals a hidden row** (`SEC-AUTH-ENUM-001`): `get` fails `NodeNotFound`, `list` omits. The write gate's `Forbidden` on an existing owned row is deliberate ([docs/SECURITY.md](../../docs/SECURITY.md#existence-disclosure-by-the-write-gates)); don't extend it to a read.
- **One rule, one function.** The reference privacy arm (`referenceListFilter` / `canViewReferenceRow`, `PUB-009`), the owned facts and predicate (`declaresColumns`, `ownedFacts`, `canViewOwnedRow`) and the group arm live in `src/internal/`; never re-spell them in a module. Each list filter and its row predicate fail closed in the same places; `tests/subtype.test.ts` and `tests/edges.test.ts` check every row × viewer, so change both together. An owner or group column holding no string, or `""`, names nobody.
- **An edge is readable only if every end is** (`EDGE-001`), and answers like a missing one otherwise. A create checks its ends before the write gate and discloses nothing beyond a taken key.
- **An edge is not a version-chain row**: hard-deleted, never updated except by `closeValidity` (`EDGE-002`). Never give it a version or tombstone column.
- **On a publish-gated leaf, readers read the live version**; the view-private rung, the corpus-write rung (reference leaves) and the owner read the head. The handlers write a gated leaf's cache only from the anonymous read.
- **Nothing owned-private is ever cache-serveable** (`CACHE-AUTH-005`); `isPubliclyServeable` in `./publication` is the one gate.
- **Declare a registry parent with `parent("key")`**, never `Option.some("key")`, which widens the literal and empties every `PickChildren`.
- **Declaration errors are thrown at import** (`RegistryDeclarationError`, `EdgeDeclarationError`): no runtime exists yet.
- **`ownerRef`'s `owner` is required in effect-jsonapi's generated `createPayload`**; the operation layer stamps it from the viewer, so a handler strips the linkage. `tests/content.test.ts` pins this.

## Terms

- **Node**: a stable `id` with an append-only chain of versions `(version, action, timestamp)`; `action` is `create`, `update` or `delete` (a tombstone carrying the columns forward).
- **Leaf**: a concrete subtype with its own version table keyed `(id, version)` and current-version view.
- **Document**: a content-addressed JSON value stored once by its hash; a version row carries the hash.
- **Edge**: a relation row outside both nodes' tables; each **end** declares the endpoint leaf's access and an optional `maxEdges`. Taxonomies are a reference leaf plus an edge family.
- **Content axes**: `visibility` (`public | followers | group | private`), `draft`, and the orthogonal tombstone.
- **Registry**: the application's ordered `RegistryEntry` list; the kernel owns the flags and `validateRegistry`.
- **Store**: a seam implementation that persists and applies no policy. `VersionChain` is a port, not a store: its invariants are its contract.
- **Access kind**: `reference` (corpus material, public unless the view says otherwise) or `owned` (`owner_id` + `visibility`, gated per viewer); either may declare a `groupColumn`.
