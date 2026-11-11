---
"@thomasfosterau/pulpit": minor
---

Add `./relations` (pulpit#200): `defineReshares` reads what a node reshares through the target's own read gate, answering a placeholder (`Unavailable`, with no target id or content) for a target the viewer can't read; `nodeWriteGate` gates an edge on the write gate of the node at one end; `acceptedAnswerGate` gates an accepted-answer edge on the question's write gate and refuses an answer of another question (`AnswerNotOfQuestion`). Bylines are an ordered collection over `./collections` and stay credit only.
