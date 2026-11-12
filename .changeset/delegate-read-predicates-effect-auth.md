---
"@thomasfosterau/pulpit": minor
---

The kernel's read predicates now delegate to `@thomasfosterau/effect-auth` (#5, option (c)), and the effect-auth peer floor rises from `>=0.2.0` to `>=0.3.0`. That is the first release with `ReferenceAccess`, `OwnedAccess.IsMember` and the extended `OwnedRow` / `serveableAxes`.

**What delegates where.** Every signature is unchanged; an internal bridge does the delegation.

- `canViewOwned`, and the owned reading in `defineSubtype`'s `get` / `getMany` and in `./edges`' `canViewEndpoint`, are now `OwnedAccess.canView`.
- The reference reading in the same places is now `ReferenceAccess.canView`.
- The kind of scope `readScopeFor` returns (`all`, `public` or `member`) is decided as effect-auth's `OwnedAccess.readScope` decides it. A `member` scope's `following` and `groups` sets still come from the kernel's follower seam.
- The owned arm of `isPubliclyServeable` (`{ owned: true }`) is now `Cacheability.publiclyServeable(OwnedAccess.serveableAxes)`.
- The list filters (`ownedListFilter`, `referencePrivacyFilter`, `endpointFilter`, `searchScopeFilter`) are still the kernel's, because effect-auth's drizzle filter renders no group or moderation arm (effect-auth#638).

**Behaviour changes.** Each one only refuses more; nothing that was refused before is now admitted.

- **A viewer whose id is `""` reads as anonymous** (effect-auth#661). This holds on every read path in `./subtype` and `./edges`: the row predicates, `readScopeFor`, `referencePrivacyFilter`, `searchScopeFilter`, `searchHeadFor`, `softDeleteFilter`, head selection on a publish-gated leaf, and the view-deleted rung at an edge's end.
  - Before: `{ id: "", role: "user" }` got a `member` scope and read rows whose owner was `""`; `{ id: "", role: "moderator" }` got `all`.
  - After: both get `public` and read only public, published rows.
- **An owner or followers-of value of `""` names nobody**, as a `NULL` already did.
  - Before: a row whose owner was `""` was readable by the viewer whose id was `""`, and by that id's followers through the follower seam.
  - After: no viewer owns it, the seam is never asked about it, and it reads like a row with no owner.
- **An `unapproved` attribute of `true` or `null` is no longer publicly serveable** on an owned family (`CACHE-AUTH-005`). Before, `isPubliclyServeable` ignored that attribute; now, when present, it must be exactly `false`.
- **An explicit `deletedAt: undefined` is refused** on an owned family. Before, it was admitted, the same as an absent key; now any `deletedAt` key refuses.

The publish-stamp arm (`publishGated`), and families that aren't owned, keep the kernel's rule unchanged.
