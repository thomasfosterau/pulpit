---
"@thomasfosterau/pulpit": minor
---

`./audience`'s `MembershipStore.eraseAccount` is bounded (pulpit#274): it takes a `limit`, as `(accountId, limit) => Effect<number>`, and deletes at most that many rows, the account's memberships, its pending invitations and the pending invitations it sent counted together, returning how many went. `./erasure` passes its batch size, as it does to `ReactionStore` and `SocialStore.eraseAccount`, and calls it again until it deletes fewer than a batch. The in-memory fake in `./testing` honours the bound.

**Store implementers must honour the new `limit`.** A one-parameter implementation stays assignable to the seam, and erasure still completes with it, but it is no longer bounded: it deletes every row in one statement.
