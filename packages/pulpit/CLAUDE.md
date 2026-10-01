# packages/pulpit — `@thomasfosterau/pulpit`

The versioned-content kernel: the only published package in this repo.

## Boundary

- Import only `effect` and `@thomasfosterau/effect-jsonapi`, both peers. Never import Drizzle, a framework or `node:*`: `./registry` and `./content` load in the browser, and the stores are the application's. Nothing from this workspace either (`.fallowrc.json` zone `pulpit`, no outbound rule).
- Never vendor code from an unpublished package to fill a seam. Write against the seam interface, state its expected shape in [README.md → Seams](README.md#seams), and keep the in-memory fakes under `tests/` as its reference semantics; the real implementation is a follow-up once its package publishes.

## Invariants

The IDs below are defined in the root [SECURITY.md → Invariant IDs](../../SECURITY.md#invariant-ids).

- **The version chain is append-only** (`VERSION-CHAIN-001/002`). Every write lands at `N_max + 1`; no version row is ever rewritten, deleted or reordered. A restore is a new version whose content came from history, and the only write over a tombstone is the explicit `restore` / `restoreVersion` (`VERSION-CHAIN-006`).
- **Update inputs are tri-state**: a value sets, `null` clears a nullable column, `undefined` carries forward. Declare it on the `Resource.make` descriptor; never spell `input.x ?? null`, which turns a carry-forward into a clear.
- **A hidden row is `NotFound`, never `Forbidden`** (`SEC-AUTH-ENUM-001`), because a 403 would confirm the row exists. A write gate may say `Forbidden`: it only runs on a row the caller has named, and an owned write first loads the owner (`NotFound` when there is none).
- **The owned list filter and `canViewOwned` never disagree.** `tests/subtype.test.ts` checks every row × viewer; change one, change both.
- **Nothing owned-private is ever cache-serveable** (`CACHE-AUTH-005`). `isPubliclyServeable` in `./publication` is the one place the rule is spelled; every axis it checks is one the operation layer gates on.
- **Declare a registry entry's parent with `parent("key")`, never `Option.some("key")`.** `Option.some` widens the literal to `string` even under `as const`, and every `PickChildren` derivation silently goes empty.
- **A registry violation is thrown at import** (`RegistryDeclarationError`), never an Effect failure: no runtime exists when a registry is declared.
- **`ownerRef`'s `owner` is a `Relationship.one`**, which effect-jsonapi lists as **required** in the generated `createPayload`. The operation layer stamps the owner from the viewer, so a handler serving the generated payload strips the linkage. `tests/content.test.ts` pins this, so the day effect-jsonapi#172 ships a read-only linkage descriptor is visible.

## Terms

- **Node** — a stable identity (`id`) with an append-only chain of versions. The apps spell it `core.node` + `core.node_version`; the kernel knows only the shape.
- **Version chain** — the `(version, action, timestamp)` rows a node accumulates. `action` is `create` (version 0), `update` (an appended version, a restore included) or `delete` (a tombstone that still carries the leaf columns forward).
- **Leaf** — a concrete subtype (a post, a garden, an image): its own version table keyed `(id, version)` and its current-version view.
- **Content axes** — `visibility` (`public | followers | private`) and the binary `draft` flag, both on the Content branch's version row; a tombstone is the third, orthogonal axis.
- **Registry** — an application's ordered list of `RegistryEntry` (marker levels without a resource, leaves with one). The kernel owns the flag vocabulary and `validateRegistry`; the tree is the application's.
- **Store** — a seam implementation that persists and applies no policy (`VersionChainStore`, `LeafStore`). Policy is the kernel's; persistence is the store's.
- **List filter** — a read predicate as data (`ListFilter`), rendered to SQL by a store and evaluated in memory by the fakes.
- **Access kind** — `reference` (corpus material written at the corpus-write rung, publicly readable) or `owned` (a member's own row, `owner_id` + `visibility`, gated per viewer). Mirrors the registry's `referenceData` ⊕ `owned` flags.
