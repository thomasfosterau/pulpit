---
"@thomasfosterau/pulpit": minor
---

Reactions (pulpit#196): a new `./reactions` module (also the root's `Reactions` namespace). `defineReactions` binds a family's `react` / `unreact` (one reaction per account per node: reacting again replaces the kind, unreacting hard-deletes it, with no history), `tally` (the count per kind for every node of a page the viewer can read, in one `getMany` and one grouped store read) and `mine` (the viewer's own reactions, omitting nodes since hidden from them), each behind the target leaf's read gate (`NodeNotFound`, never `Forbidden`). `reactionKinds` declares the family's vocabulary and throws `ReactionDeclarationError` at import for a malformed one; an undeclared kind fails `InvalidReactionKind`. The `ReactionStore` seam includes `eraseAccount` for account erasure. `./testing` adds `makeInMemoryReactionStore`.
