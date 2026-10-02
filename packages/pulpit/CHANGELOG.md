# @thomasfosterau/pulpit

## 0.1.0

### Minor Changes

- [#7](https://github.com/thomasfosterau/pulpit/pull/7) [`bb13dc5`](https://github.com/thomasfosterau/pulpit/commit/bb13dc59532a0afdb87a3d1bd2cc06fbc2c3e843) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - First release: the Content model half of the versioned-content kernel, on `@thomasfosterau/effect-jsonapi`. Requires `effect@>=4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@>=0.16.0` (peers); built and tested against `effect@4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@0.16.0`.

  - `./content` — the three-state `Visibility` axis; the `visibility` / `draft`, timestamp and tombstone field spreads a Content subtype opens its `Resource.make` attributes with (`contentVisibilityResourceFields`, `ownedVisibilityResourceFields`, `referenceLeafResourceFields`, `ownedContentLeafResourceFields`, …); `ownerRef` for the owned leaves' `owner` linkage; the base `content` resource with an injectable id brand.
  - `./registry` — the registry flag vocabulary (`pageable`, `agent`, `owned` ⊕ `referenceData`, `searchable`), `validateRegistry` with application-supplied extra checks, the literal-preserving `parent` / `root` helpers, and the typed family / branch projections (`flaggedMembers`, `branchMembers`, `identifiersOf`, `registryWireTypes`).

  Ported from gardeneria's `packages/models/src/models/content.ts` and `registry.ts`, with its registry tests.

- [#7](https://github.com/thomasfosterau/pulpit/pull/7) [`59fc9d1`](https://github.com/thomasfosterau/pulpit/commit/59fc9d1a1cd76fb4e102e1c6fe3a9b7a5f1ef8c4) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The versioned-content kernel's operations, written against explicit seams while the layers beneath publish.

  - `./version-chain` — `defineVersionChain` over a `VersionChainStore` seam: create (never an upsert), tri-state update with carry-forward, restore, idempotent tombstone, `getVersion`, `restoreVersion` (a new version; no partial restore) and bounded `history`, with the tagged errors `NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `VersionConflict`.
  - `./filter` — the `ListFilter` vocabulary the read predicates render into, and its in-memory `evaluate`.
  - `./subtype` — `LeafAccess`, the viewer / `AccessPolicy` / follower seams, `readScopeFor`, `canViewOwned`, `ownedListFilter`, the reference list predicates, the write gates, `defineSubtype` over a `LeafStore` seam, and `subtypeHandlers` with cache write-through.
  - `./publication` — `isPublishedAt` / `isNotPublishedAt`, `publishedFilter`, `ModerationState`, and the cache serveability policy `isPubliclyServeable` / `serveablePolicy`.

  The Drizzle stores, effect-auth's read scope and effect-jsonapi's resource handlers fill the seams in follow-up releases; the seams' expected shapes are in the package README's Seams section.

### Patch Changes

- [#23](https://github.com/thomasfosterau/pulpit/pull/23) [`1c89577`](https://github.com/thomasfosterau/pulpit/commit/1c8957748a202436614933494102a1da10132000) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Documentation only:

  - Every export and interface member now has a TSDoc summary, and every module header leads with its description. The `SubtypeOps` operations name their failures.
  - The package README has an API table for `./filter` and `./subtype`, and states the seams' expected shapes.
  - The README examples are self-contained and compile.
  - The README and the docs state the hidden-row rule (`NodeNotFound`, never `Forbidden`) only for `get` / `getMany` / `list`, which is where it holds.

- [#23](https://github.com/thomasfosterau/pulpit/pull/23) [`64e0834`](https://github.com/thomasfosterau/pulpit/commit/64e0834e952ddd66d8549b55744c43bec72a6ea0) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Stop shipping the package's `CLAUDE.md` (agent guidance) to npm. The content consumers need, the seams' expected shapes, is in the package README.

- [#29](https://github.com/thomasfosterau/pulpit/pull/29) [`8808e98`](https://github.com/thomasfosterau/pulpit/commit/8808e9873599a3760f91596cfa3be0f1a51a3b30) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tested against `effect@4.0.0`; the peer floor is unchanged (`effect@>=4.0.0-rc.118`). No source changes were needed.
