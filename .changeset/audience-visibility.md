---
"@thomasfosterau/pulpit": minor
---

Add audience visibility (pulpit#194): share a row with a named group.

- `Visibility` gains `group` (`public | followers | group | private`).
- `FollowerSeam` gains the optional audience pair `isMember` / `groups`, and `ReadScope`'s `member` scope carries `groups` when the seam answers it. Without them no `group` row opens beyond its owner and the view-private rung.
- `LeafAccess` (both kinds) gains an optional `groupColumn`, and `ownedAccess({ group: true })` names `groupId`. A `group` row reads, when published, to the members of the group that column names, through `get`, `getMany`, `list`, search scope and `./edges`' endpoint checks alike; a non-string value (a deleted group) leaves it `private`. It is never cache-serveable (`CACHE-AUTH-005`).
- New `./audience` module: `defineAudience` over a `MembershipStore` (add, remove and re-role members as the group's owner or an admin; leave; the member list; delete a group's memberships), `audienceSeam`, and `makeInMemoryMembershipStore` in `./testing`.
