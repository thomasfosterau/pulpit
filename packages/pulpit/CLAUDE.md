# packages/pulpit — `@thomasfosterau/pulpit`

The versioned-content kernel. Peers: `effect`, `@thomasfosterau/effect-jsonapi`.

## Terms

- **Node** — a stable identity (`id`) with an append-only chain of versions. The apps spell it `core.node` + `core.node_version`; the kernel knows only the shape.
- **Version chain** — the `(version, action, timestamp)` rows a node accumulates. `action` is `create` (version 0), `update` (an appended version, a restore included) or `delete` (a tombstone that still carries the leaf columns forward).
- **Leaf** — a concrete subtype (a post, a garden, an image): its own version table keyed `(id, version)` and its current-version view.
- **Content axes** — `visibility` (`public | followers | private`) and the binary `draft` flag, both on the Content branch's version row; a tombstone is the third, orthogonal axis.
- **Registry** — an application's ordered list of `RegistryEntry` (marker levels without a resource, leaves with one). The kernel owns the flag vocabulary and `validateRegistry`; the tree is the application's.
- **Store** — a seam implementation that persists and applies no policy (`VersionChainStore`, `LeafStore`). Policy is the kernel's; persistence is the store's.
- **List filter** — a read predicate as data (`ListFilter`), rendered to SQL by a store and evaluated in memory by the fakes.
- **Access kind** — `reference` (corpus material written at the corpus-write rung, publicly readable) or `owned` (a member's own row, `owner_id` + `visibility`, gated per viewer). Mirrors the registry's `referenceData` ⊕ `owned` flags.

## Local invariants

- Declare a registry entry's parent with `parent("key")`, never `Option.some("key")`: `Option.some` widens the literal to `string` even under `as const`, and every `PickChildren` derivation silently goes empty.
- A registry violation is thrown at import (`RegistryDeclarationError`), never an Effect failure — no runtime exists when a registry is declared.
- `ownerRef`'s `owner` is a `Relationship.one`, which effect-jsonapi 0.14 lists as **required** in the generated `createPayload`. The operation layer stamps the owner from the viewer; a handler serving the generated payload strips the linkage. Pinned in `tests/content.test.ts` so the day effect-jsonapi#172 ships a read-only linkage descriptor is visible.

- The version chain is append-only (`VERSION-CHAIN-001/002`); the only write over a tombstone is the explicit restore (`VERSION-CHAIN-006`).
- A hidden row is `NotFound`, never `Forbidden` (`SEC-AUTH-ENUM-001`). A write gate may say `Forbidden`: it only runs on a row the caller has named, and an owned write first loads the owner (`NotFound` when there is none).
- The owned list filter and `canViewOwned` never disagree; `tests/subtype.test.ts` checks every row × viewer. Change one, change both.
- Nothing owned-private is ever cache-serveable (`CACHE-AUTH-005`).

## Seams

Slices 3–5 are written against explicit interfaces because the packages that will fill them are not published. Each seam below states the shape the real implementation must have. Never vendor code from the unpublished packages to fill one; the in-memory fakes under `tests/` are the reference semantics, and a seam's real implementation is a follow-up once its package publishes.

### `VersionChainStore<E, R>` — filled by effect-drizzle-ext's `./versioned-chain` (pulpit#4)

The Drizzle store is built over `makeSubtypeTables` / `makeCurrentVersionView` and the application's root tables. Expected schema:

- a root version table (the apps' `core.node_version`) keyed `(id, version bigint)`, carrying `action` (`create | update | delete`, the single home of currency and tombstone state), `timestamp` and `user_id`; plus the identity row (`core.node`: `id`, `type`) inserted at version 0;
- one version table per chain level keyed `(id, version)` with the `(id, version)` → parent-version FK, carrying that level's domain columns (6NF fact tables for a fact-scoped level).

Method contract: `head` is `SELECT … ORDER BY version DESC LIMIT 1` on the root table; `snapshot` reads every level at `(id, version)` and returns none when ANY level is missing (no partial state); `append` inserts the root row and every level's row at the given version (at version 0 the identity row too) and maps a primary-key violation on `(id, version)` to `VersionConflict`; `entries` is `ORDER BY version ASC LIMIT $limit`; `mintId` is a UUID. `E` is `EffectDrizzleQueryError`; `R` is `CurrentTransaction` — the store never opens a transaction.

### `LeafStore<Row, Following, E, R>` — filled by a Drizzle store over the current-version view (pulpit#5)

`columns` is the view's column-name set (`getColumns(view)`); `get` / `getMany` are `id = $id` / `id = ANY($ids)` reads with `LIMIT`; `list` renders its `ListFilter` (below), orders totally (the caller's order closed by `id`), and returns the page plus the unpaged total as a window column; `ownerOf` / `stampOwner` read and insert `core.node_owner`.

### `ListFilter<Following>` → SQL — filled by effect-drizzle-ext's query helpers / effect-auth-drizzle (pulpit#5, #6)

The rendering contract is the table in `src/filter.ts`. `Following` is the follower seam's subquery (`SQLWrapper`), rendered as `col IN (<subquery>)`, never a materialised array (gardeneria #1107). `published` / `notPublished` use the database's `now()` and are parenthesised.

### The viewer, the role axes and the follower seam — filled by effect-auth#221 (pulpit#5)

- `Viewer = Option<{ id, role }>` — effect-auth's session context, suggestion (b).
- `AccessPolicy` — four predicates over a signed-in account (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`), each an application-named rung compared by the role-ladder factory's `hasRoleAtLeast`, suggestion (a). Must fail closed on an unknown role.
- `FollowerSeam<Following, R>` — `isFollower(followerId, ownerId)` and `following(followerId)`, suggestion (c); `nobodyFollows(nobody)` is the fail-closed default when a runtime provides none.
- `ReadScope` and `canViewOwned` live here until effect-auth ships (c); when it does, pulpit consumes its read scope and keeps only the rendering into `ListFilter`.
- `Unauthorized` / `Forbidden` are defined here until effect-auth's (a) owns them.

### `SubtypeHandlers` — the record effect-jsonapi#172's `resourceHandlers` is expected to accept (pulpit#5)

One entry per endpoint (`list`, `get`, `create`, `update`, `delete`) returning the resource the document assembler wraps, plus `restoreVersion`, which has no JSON:API endpoint and runs SSR-direct. Each write runs inside the handler seam's `transact` (always-open, website #1883), re-reads the row outside it, and writes it through the cache. When #172 lands, `subtypeHandlers` maps onto its real handler signatures (the request context, the query decode, the document assembly) and its error catalogue replaces the tags here.

### `ResourceCacheSeam` and the `serveable` hook — filled by effect-web#4 (pulpit#5, #6)

The cache's write side is `set(id, resource)` / `delete(id)`, both never failing (a KV fault is swallowed by the cache). Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as `makeResourceCache`'s `serveable` option; the cache applies it on both paths and evicts on a non-serveable write.

## Boundary

Imports nothing from this workspace (`.fallowrc.json` zone `pulpit`, no outbound rule).
