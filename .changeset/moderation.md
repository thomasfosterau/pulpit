---
"@thomasfosterau/pulpit": minor
---

Add `./moderation` (and the `Moderation` namespace): the moderation workflow (pulpit#51).

- `moderationHook(declaration, policy)`: the transition rules as a before hook on the lifecycle seam. A create starts `pending`; only the moderate rung changes the state (`isModerationTransition`), stamping `moderatedAt` / `moderatedBy`; an edit to one of the leaf's `reReviewOn` attributes sends an `approved` row back to `pending`; a `restoreVersion` below the rung keeps the current decision. Anyone else's change fails `WriteRejected`. `moderatePatch` is the same rules as a pure function, and `moderatedColumns(reReviewOn)` the declaration with the conventional names.
- `defineModeration({ target, declaration, viewer, policy }).moderate(id, decision)`: the decision, gated to the moderate rung.
- `reviewQueueFilter(viewer, policy, column?)`: the review queue's pending rows, the moderate rung's alone.
- `gradeScores(scores, thresholds, defaultThreshold?)`: threshold grading of a classifier's per-category scores (exceeded categories, top score, a priority band), with `DEFAULT_MODERATION_THRESHOLD`.
- `defineReports(...)`: member reports over a `ReportStore` seam (`file` against a target the reporter can read, `get` / `list` for the reporter and the rung, `resolve` for the rung).
- `./testing`: `makeInMemoryReportStore()`.
