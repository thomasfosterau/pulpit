---
"@thomasfosterau/pulpit": minor
---

Add `./blobs` (and the `Blobs` namespace): file and media leaves (pulpit#55).

- `BlobStore<E, R>` — the byte-store seam (`put`, `get`, `head`, `delete`, `publicUrl`, an optional `signedUploadUrl`), keyed by `blobKey(contentHash)`, so a version's bytes are immutable and equal bytes are stored once.
- `ContentHash` and `sha256Hex(bytes)` (Web Crypto).
- `fileResourceFields` — `contentHash`, `byteSize`, `mediaType`, `filename` and `bytesPending`, all read-only on the resource.
- `defineFileWrites({ leaf, blobs, transact })` — commit-ordered writes: `create` / `replace` append the version (pending unless the bytes are already stored), put the bytes after the commit, then confirm; a failed byte write leaves the node `bytesPending`, and `confirmBytes` finishes it over exactly that version. `fileUrl` gives no URL while bytes are pending. Nothing garbage-collects bytes.
- `fileUsageEnds({ user, file })` — the usage index as an edge family's ends.
- `./testing`: `makeInMemoryBlobStore()`.
