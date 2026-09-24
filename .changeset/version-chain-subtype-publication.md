---
"@thomasfosterau/pulpit": minor
---

The versioned-content kernel's operations, written against explicit seams while the layers beneath publish.

- `./version-chain` — `defineVersionChain` over a `VersionChainStore` seam: create (never an upsert), tri-state update with carry-forward, restore, idempotent tombstone, `getVersion`, `restoreVersion` (a new version; no partial restore) and bounded `history`, with the tagged errors `NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `VersionConflict`.
- `./filter` — the `ListFilter` vocabulary the read predicates render into, and its in-memory `evaluate`.
- `./subtype` — `LeafAccess`, the viewer / `AccessPolicy` / follower seams, `readScopeFor`, `canViewOwned`, `ownedListFilter`, the reference list predicates, the write gates, `defineSubtype` over a `LeafStore` seam, and `subtypeHandlers` with cache write-through.
- `./publication` — `isPublishedAt` / `isNotPublishedAt`, `publishedFilter`, `ModerationState`, and the cache serveability policy `isPubliclyServeable` / `serveablePolicy`.

The Drizzle stores, effect-auth's read scope and effect-jsonapi's resource handlers fill the seams in follow-up releases; the seams' expected shapes are in the package `CLAUDE.md`.
