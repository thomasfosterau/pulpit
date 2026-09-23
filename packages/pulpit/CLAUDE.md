# packages/pulpit — `@thomasfosterau/pulpit`

The versioned-content kernel. Peers: `effect`, `@thomasfosterau/effect-jsonapi`.

## Terms

- **Node** — a stable identity (`id`) with an append-only chain of versions. The apps spell it `core.node` + `core.node_version`; the kernel knows only the shape.
- **Version chain** — the `(version, action, timestamp)` rows a node accumulates. `action` is `create` (version 0), `update` (an appended version, a restore included) or `delete` (a tombstone that still carries the leaf columns forward).
- **Leaf** — a concrete subtype (a post, a garden, an image): its own version table keyed `(id, version)` and its current-version view.
- **Content axes** — `visibility` (`public | followers | private`) and the binary `draft` flag, both on the Content branch's version row; a tombstone is the third, orthogonal axis.
- **Registry** — an application's ordered list of `RegistryEntry` (marker levels without a resource, leaves with one). The kernel owns the flag vocabulary and `validateRegistry`; the tree is the application's.
- **Access kind** — `reference` (corpus material written at the corpus-write rung, publicly readable) or `owned` (a member's own row, `owner_id` + `visibility`, gated per viewer). Mirrors the registry's `referenceData` ⊕ `owned` flags.

## Local invariants

- Declare a registry entry's parent with `parent("key")`, never `Option.some("key")`: `Option.some` widens the literal to `string` even under `as const`, and every `PickChildren` derivation silently goes empty.
- A registry violation is thrown at import (`RegistryDeclarationError`), never an Effect failure — no runtime exists when a registry is declared.
- `ownerRef`'s `owner` is a `Relationship.one`, which effect-jsonapi 0.14 lists as **required** in the generated `createPayload`. The operation layer stamps the owner from the viewer; a handler serving the generated payload strips the linkage. Pinned in `tests/content.test.ts` so the day effect-jsonapi#172 ships a read-only linkage descriptor is visible.

- The version chain is append-only (`VERSION-CHAIN-001/002`); the only write over a tombstone is the explicit restore (`VERSION-CHAIN-006`).
- A hidden row is `NotFound`, never `Forbidden` (`SEC-AUTH-ENUM-001`).
- Nothing owned-private is ever cache-serveable (`CACHE-AUTH-005`).

## Seams

Filled in as the slices land (pulpit#4, #5, #6): the version-chain store, the read scope and viewer seam, the handlers config, the `serveable` hook.

## Boundary

Imports nothing from this workspace (`.fallowrc.json` zone `pulpit`, no outbound rule).
