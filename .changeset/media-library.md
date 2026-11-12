---
"@thomasfosterau/pulpit": minor
---

Add `./media`, a media library (pulpit#206):

- `mediaResourceFields`: alt text, caption and licence, plus the extracted kind, dimensions, duration and an EXIF subset.
- `defineMediaUploads`: records an app-filled extractor's metadata in the version `./blobs` writes. EXIF location is kept by default; set `stripLocation: true` to drop it.
- `defineRenditions`: width buckets and `Accept` format negotiation. A rendition is served only for bytes a node the viewer can read references, and anything else answers `RenditionNotFound`.
- `defineAlbum`: ordered media collections over `./collections`.

`./blobs`' `FileWriteOps.replace` also takes a `patch` of other columns for the same version.
