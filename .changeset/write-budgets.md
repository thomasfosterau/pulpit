---
"@thomasfosterau/pulpit": minor
---

Write budgets (pulpit#199), a new `./budgets` module: a declared ceiling on an account's writes of one kind in a rolling window (`bindBudget`), spent inside the write by a before hook (`budgetHook`) or by `./proposals`' `submit` and `./moderation`'s report `file` through their new optional `budget`. Over budget, the write fails `WriteRejected` with the reason `RATE_LIMITED` (`isRateLimited`, the wire's 429). The moderate rung is exempt by default. The `BudgetCounter` seam takes a count within the write's transaction (`countingCounter` over a `WriteCountStore`) or an atomic counter; `./testing` adds `makeInMemoryBudgetCounter` and `makeInMemoryWriteCountStore`.
