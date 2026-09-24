---
"@thomasfosterau/pulpit": minor
---

First release: the Content model half of the versioned-content kernel, on `@thomasfosterau/effect-jsonapi@0.14`.

- `./content` — the three-state `Visibility` axis; the `visibility` / `draft`, timestamp and tombstone field spreads a Content subtype opens its `Resource.make` attributes with (`contentVisibilityResourceFields`, `ownedVisibilityResourceFields`, `referenceLeafResourceFields`, `ownedContentLeafResourceFields`, …); `ownerRef` for the owned leaves' `owner` linkage; the base `content` resource with an injectable id brand.
- `./registry` — the registry flag vocabulary (`pageable`, `agent`, `owned` ⊕ `referenceData`, `searchable`), `validateRegistry` with application-supplied extra checks, the literal-preserving `parent` / `root` helpers, and the typed family / branch projections (`flaggedMembers`, `branchMembers`, `identifiersOf`, `registryWireTypes`).

Ported from gardeneria's `packages/models/src/models/content.ts` and `registry.ts`, with its registry tests.
