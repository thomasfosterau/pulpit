---
"@thomasfosterau/pulpit": minor
---

Edge validity intervals (pulpit#210). An edge family may declare `validity: { from, to }`: a create refuses an interval that starts after it ends or a bound that is not a date (`InvalidValidity`), `maxEdges` counts only the edges whose intervals overlap the new one, `validAt(validity, at)` filters a list to the edges valid at an instant, and the new `EdgeOps.closeValidity(id, at)` narrows an interval's end, the one update an edge takes (`EDGE-002`). A store serving such a family implements the new optional `EdgeStore.closeValidity`; the in-memory fake does.
