---
"@thomasfosterau/pulpit": minor
---

Add `./proposals` (and the `Proposals` namespace): suggested edits (pulpit#49).

- `defineProposals(definition)` binds one leaf's proposal operations over a `ProposalStore` seam: `submit` (the propose rung, a target the proposer can `get`, stamped with the target's head as `baseVersion`), `get` / `list` (the moderate rung reads all; others their own and those on targets they own), `review` (the full verdict), `accept`, `reject` and `withdraw`. A proposal is a plain row (`ProposalRow`), not a node.
- `accept` re-validates the patch, classifies it against the head (`ProposalConflict` when conflicting) and appends it through the target's own `update`, as the accepting account, with that head as its expected version and the proposer as the version's `proposedBy`.
- The two-tier classification, `classifyProposalBase` (no read) and `classifyProposalConflict` (over `diffStates`, failing closed on an attribute either state lacks), and the patch rules, `validateProposalPatch` with `PROPOSAL_FORBIDDEN_KEYS`.
- `./version-chain`: `VersionRow` gains `proposedBy`, which a store persists beside `actorId`, and `UpdateInput` an optional `proposedBy`. `./subtype`: `update` takes it too (`UpdateRequest`).
- `./testing`: `makeInMemoryProposalStore({ chain, leaves })`.
