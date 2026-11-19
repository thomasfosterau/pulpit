---
"@thomasfosterau/pulpit": minor
---

Member reports now integrate with content moderation (#360), and the report lifecycle has an explicit state machine.

- **`isReportTransition(from, to)`** (`./moderation`) is the report state machine: a report is filed `open` and closes once, as `resolved` (upheld) or `dismissed`. `defineReports`' `resolve` checks it.
- **`defineReports` takes an optional `moderation`**: the leaf's `defineModeration` ops. When it is given, `resolve(id, "resolved", note)` is a content decision. It moderates the target `rejected`, then closes every open report against the target `resolved` with the same note. `resolve` can now also fail as `moderate` does (`StaleVersion`, `VersionConflict`, `WriteRejected`). A target that is already deleted still closes its reports. Dismissing a report still closes only that report.
- **`withReports({ moderation, reports, viewer })`** wraps a leaf's `ModerationOps`. Its `moderate(id, decision)` runs the decision, then settles the target's open reports as **`reportOutcomeOf(decision)`** says: `rejected` resolves them, `approved` dismisses them, and `pending` leaves them open.

**Breaking for `ReportStore` implementations:** the seam gains **`closeOpen(targetId, resolution)`**, which closes every open report against a target and returns how many it closed (docs/seams.md → `ReportStore`). `makeInMemoryReportStore` in `./testing` implements it.
