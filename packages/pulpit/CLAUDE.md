# packages/pulpit — `@thomasfosterau/pulpit`

The versioned-content kernel: the only published package in this repo.

## Boundary

- Import only `effect` and `@thomasfosterau/effect-jsonapi`, both peers. Never import Drizzle, a framework or `node:*`: `./registry` and `./content` load in the browser, and the stores are the application's. Nothing from this workspace either (`.fallowrc.json` zone `pulpit`, no outbound rule).
- **Seams before dependencies.** The kernel is written against explicit seam interfaces (the version-chain store, the read scope, the handlers config, the `serveable` hook) because the packages that will fill them were not published when it was written. As of 2026-10-08: effect-jsonapi's server skeleton (`ResourceHandlers`, `Assemble`, `ServerErrors`, `Negotiation`, `Registry`, `Group.flat`, `FlatQuery`) has shipped (exported since 0.15.0; pulpit's peer is `>=0.16.0`), so the handlers seam can be wired (pulpit#5); effect-auth's read scope is on its `trunk` but unpublished (release PR effect-auth#177); effect-drizzle-ext is unpublished; and the resource cache has no planned library (effect-web dropped its Cloudflare package on effect-web#33), so the application fills that seam. Never vendor code from an unpublished package to fill a seam: write against the interface, state its expected shape in [README.md → Seams](README.md#seams), keep the in-memory fakes under `tests/` as its reference semantics, and stop-and-report where a real dependency is needed. The real implementation is a follow-up once its package publishes.

## Invariants

The IDs below are defined in the root [SECURITY.md → Invariant IDs](../../SECURITY.md#invariant-ids).

- **The version chain is append-only** (`VERSION-CHAIN-001/002`). Every write lands at `N_max + 1`; no version row is ever rewritten, deleted or reordered. A restore is a new version whose content came from history, and the only write over a tombstone is the explicit `restore` / `restoreVersion` (`VERSION-CHAIN-006`).
- **Update inputs are tri-state**: a value sets, `null` clears a nullable column, `undefined` carries forward. Declare it on the `Resource.make` descriptor; never spell `input.x ?? null`, which turns a carry-forward into a clear.
- **A read never reveals a hidden row** (`SEC-AUTH-ENUM-001`): `get` fails `NodeNotFound`, never `Forbidden`, and `getMany` / `list` omit the row, because a 403 would confirm it exists. The write and history gate (`requireWriter`) currently answers `Forbidden` for an existing owned row the caller doesn't own, which does confirm existence; pulpit#24 asks whether that is intended. Don't extend that behaviour to a read.
- **The owned list filter and `canViewOwned` never disagree.** `tests/subtype.test.ts` checks every row × viewer; change one, change both.
- **Nothing owned-private is ever cache-serveable** (`CACHE-AUTH-005`). `isPubliclyServeable` in `./publication` is the one place pulpit spells the rule; every axis it checks is one the operation layer gates on. effect-auth's unpublished `Cacheability.publiclyServeable` is a second spelling that must converge with it (see SECURITY.md's `CACHE-AUTH-005` row).
- **Declare a registry entry's parent with `parent("key")`, never `Option.some("key")`.** `Option.some` widens the literal to `string` even under `as const`, and every `PickChildren` derivation silently goes empty.
- **A registry violation is thrown at import** (`RegistryDeclarationError`), never an Effect failure: no runtime exists when a registry is declared.
- **`ownerRef`'s `owner` is a `Relationship.one`**, which effect-jsonapi lists as **required** in the generated `createPayload`. The operation layer stamps the owner from the viewer, so a handler serving the generated payload strips the linkage. `tests/content.test.ts` pins this, so the day effect-jsonapi ships a read-only linkage descriptor is visible (effect-jsonapi#172 closed without one; 0.16.3 has none).

## Terms

- **Node** — a stable identity (`id`) with an append-only chain of versions. The apps spell it `core.node` + `core.node_version`; the kernel knows only the shape.
- **Version chain** — the `(version, action, timestamp)` rows a node accumulates. `action` is `create` (version 0), `update` (an appended version, a restore included) or `delete` (a tombstone that still carries the leaf columns forward).
- **Leaf** — a concrete subtype (a post, a garden, an image): its own version table keyed `(id, version)` and its current-version view.
- **Content axes** — `visibility` (`public | followers | private`) and the binary `draft` flag, both on the Content branch's version row; a tombstone is the third, orthogonal axis.
- **Registry** — an application's ordered list of `RegistryEntry` (marker levels without a resource, leaves with one). The kernel owns the flag vocabulary and `validateRegistry`; the tree is the application's.
- **Store** — a seam implementation that persists and applies no policy (`VersionChainStore`, `LeafStore`). Policy is the kernel's; persistence is the store's.
- **List filter** — a read predicate as data (`ListFilter`), rendered to SQL by a store and evaluated in memory by the fakes.
- **Access kind** — `reference` (corpus material written at the corpus-write rung, publicly readable) or `owned` (a member's own row, `owner_id` + `visibility`, gated per viewer). Mirrors the registry's `referenceData` ⊕ `owned` flags.
