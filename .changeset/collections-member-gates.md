---
"@thomasfosterau/pulpit": patch
---

`./collections`: `resync` now adopts only the members the writer can read, as `append` does, so an id planted in the order column through the parent's own `update` never reaches the store. A versioned family's recorded order names every member, so the new `hideRecordedOrder(column, toResource)` keeps it out of the parent's resource (`EDGE-001`).
