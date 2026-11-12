---
"@thomasfosterau/pulpit": minor
---

**Breaking:** `./registry`'s `RegistryEntry` models absence with `Option` (pulpit#238).

- `RegistryEntry.resource` is `?: Option.Option<Resource.Any>` and `RegistryEntry.id` is `?: Option.Option<BrandedId>` (were `?: Resource.Any | undefined` and `?: BrandedId | undefined`). A leaf declares `resource: Option.some(PostResource), id: Option.some(PostResource.Id)`; a marker level omits both or passes `Option.none()`.
- The capability flags (`pageable`, `agent`, `owned`, `referenceData`, `searchable`, `routable`, `localised`) are `?: true` (were `?: true | undefined`): a flag is literal `true` or omitted, and an explicit `undefined` no longer type-checks.
- `PickResources` and `PickChildren` read the resource out of the `Option`, so `flaggedMembers`, `branchMembers` and `identifiersOf` keep their precise member tuples; an `Option.none()` resource is a marker level there, as at runtime.
- New `resourceOf(entry)`: the entry's resource as an `Option`, `Option.none()` for a marker level whether `resource` is omitted or `Option.none()`, for an application's `RegistryCheck`s.

`validateRegistry`, `registryWireTypes` and `branchOf` keep their signatures and checks. `./filter` and `./content` had no `T | null` or `?: T | undefined` member to convert and are unchanged.
