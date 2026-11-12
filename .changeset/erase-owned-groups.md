---
"@thomasfosterau/pulpit": minor
---

Account erasure reassigns the groups the erased account owns (pulpit#274, owner decision 2026-11-12). `./audience` adds the `GroupOwnerStore` seam, one bounded `reassignOwner(accountId, to, limit) => Effect<number>`, and `defineAccountErasure` takes it as the optional `groups?: GroupOwnerStore`. Every group the account owns goes to the tombstone account in bounded, resumable batches, before the account's memberships are deleted, so the group's other members keep reading its `group` rows. An application overrides this with the optional `disposeGroups`, a bounded erase shaped like an `AccountRelation`'s, which runs in the reassignment's place (to delete the groups, say). `./testing` adds `makeInMemoryGroupOwners`, which fills both `GroupOwnership` and `GroupOwnerStore`.
