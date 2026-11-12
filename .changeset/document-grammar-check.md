---
"@thomasfosterau/pulpit": minor
---

Add a grammar-check seam to `./documents` (pulpit#264): `DocumentCheck` and `DocumentViolation`, `checkedDocumentStore` (the check before `put`, so an off-grammar document is never stored) and `documentCheckHook` (a before-write hook that refuses, with `WriteRejected`, a create, update or restore referencing a document that fails its field's grammar). The application fills the check, typically with prosekit-utilities' allow-lists.
