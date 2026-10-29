---
"@thomasfosterau/pulpit": minor
---

The social graph (pulpit#195): a new `./social` module (also the root's `Social` namespace). `defineSocial` binds follow / unfollow, mute / unmute and block / unblock as the viewer's own facts (idempotent, no history; `SelfRelationship` for oneself), the public `followers` / `following` lists (through an optional `AccountVisibility` seam) and the viewer's own `muted` / `blocked` lists. Following is immediate; a block suppresses interaction only: it ends both follows, refuses a new one either way (`InteractionBlocked`) and answers `interactionAllowed` for other modules, while `silencedFilter(column)` is the opt-in read filter over the authors a viewer muted or blocked. `socialFollowers(store)` fills `./subtype`'s `FollowerSeam` from the graph. The `SocialStore` seam includes `eraseAccount`; `./testing` adds `makeInMemorySocialStore`.
