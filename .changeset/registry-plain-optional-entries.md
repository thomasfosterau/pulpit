---
"@thomasfosterau/pulpit": minor
---

**Breaking (reverses part of #308):** `./registry`'s `RegistryEntry.resource` and `RegistryEntry.id` are plain optional declaration members again, `?: Resource.Any` and `?: BrandedId`, not `?: Option.Option<…>` (pulpit#238, owner refinement: an options-bag or declaration member is `readonly x?: T`, with `Option` kept for genuinely Option-shaped values). A leaf declares `resource: PostResource, id: PostResource.Id`; a marker level omits both. An explicit `undefined` still does not type-check: omit the key. If you adopted the unreleased `Option.some(…)` / `Option.none()` spelling from #308, unwrap it. The flags stay `?: true`, `resourceOf(entry)` still returns an `Option`, and `flaggedMembers` / `branchMembers` / `identifiersOf` keep their exact tuples.
