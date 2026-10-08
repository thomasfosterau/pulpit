---
"@thomasfosterau/pulpit": minor
---

Add `./documents` (and the `Documents` namespace): the content-addressed document store seam.

- `DocumentStore<Document, E, R>` — `put(document)` stores a document once and returns its hash (idempotent), `get(hash)`, and `getMany(hashes)`. The document type is a parameter; hashing is the store's job.
- `DocumentHash` — a SHA-256 hash as 64 lowercase hex characters. The hash contract (SHA-256 over the UTF-8 bytes of the document's PostgreSQL `jsonb` text) is in the README → Seams.
- `documentRef(key)` — the attribute spread for a version row's document reference.
- The invariant `DOC-001` (SECURITY.md): a stored document is never rewritten, and a changed document is a new hash.
