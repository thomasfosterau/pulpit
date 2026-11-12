---
"@thomasfosterau/pulpit": minor
---

`./search`'s `BranchRequest` gains `headFor` (pulpit#346), the heads a branch over a publish-gated leaf ranks: per node, its head when it matches `headFor`, else its live row, exactly as `LiveView.list` reads. `hybridSearch` forwards it to every branch beside `scope`, and `./subtype`'s new `searchHeadFor(leaf, viewer)` computes it as the leaf's `list` does (every head on a head-reading rung, the viewer's own on an owned leaf, none otherwise). A gated `SearchBranch` is now one value, and a reader's search never scores a head's unpublished text. **Breaking for branch implementers and `hybridSearch` callers:** every `BranchRequest` now carries `headFor`; pass `searchHeadFor(leaf, viewer)` (or `never` on an ungated leaf, where branches ignore it).
