# Media

File and media leaves over a content-addressed byte store (`./blobs`), and the media library over it (`./media`).

## `./blobs`

File and media leaves (pulpit#55). A file is an ordinary leaf (owned, like a member's image, or reference material) whose version row carries `fileResourceFields`: the `contentHash` of its bytes, their `byteSize` and `mediaType`, the original `filename`, and `bytesPending`. The bytes live behind a `BlobStore` the application supplies (R2, S3), under `blobKey(contentHash)`, so a version's bytes are immutable. New bytes are a new hash and a new version, `restoreVersion` restores the reference to the old bytes, and equal bytes are stored once.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineFileWrites, fileUrl } from "@thomasfosterau/pulpit/blobs";

const files = defineFileWrites({ leaf: imageOps, blobs: r2, transact });
const upload = Effect.gen(function* () {
  const written = yield* files.create({
    id: Option.none(),
    state: { visibility: "public" },
    upload: { bytes, mediaType: "image/png", filename: "fern.png" },
  });
  // written.bytesPending: true when the post-commit byte write failed
  return written;
});
fileUrl(row, r2); // none while the row's bytesPending is anything but false
```

- **Bytes are written after the chain commits.** `create` and `replace`:
  1. hash the upload (`sha256Hex`);
  2. append the version through the leaf's own operations inside `transact`, with `bytesPending: true` unless the store already holds those bytes;
  3. put the bytes once `transact` has returned;
  4. append `bytesPending: false` over exactly that version.
- **A failed byte write leaves the node pending.** If the put, or its confirmation, fails, the node stays `bytesPending` and the write still succeeds, reporting `bytesPending: true`. `fileUrl` gives no URL for it, so no reader is pointed at missing bytes.
- **`confirmBytes({ id, version, contentHash })` finishes a pending version** once the bytes are there (a retry, or a client's signed upload). It never lands over a later version (`StaleVersion`).
- **Nothing garbage-collects bytes.** They stay for as long as any version references them; purge (pulpit#58) is the one removal path, and `BlobStore.delete` is there for it.
- **Usage is an edge family.** "Where is this file used" is answered by `./edges`, using `fileUsageEnds({ user, file })` as a family's ends, so `EDGE-001` hides every use whose content the viewer can't read. Maintaining the edges is the referencing leaf's job, or an after hook's. Key the edge table uniquely on `(user_id, file_id)` and declare `onConflict: "ignore"`.
- **The writes bypass `subtypeHandlers`.** They go through the leaf's operations, so its gates, preconditions and before hooks apply, but not the handlers' cache write-through and after hooks.
- **Stays in the app:** the adapters, image transforms, EXIF extraction and video streaming.

| Export | What it is |
| --- | --- |
| `BlobStore`, `BlobHead` | The byte-store seam (see [Seams](seams.md#seams)) and what it knows of one object. |
| `ContentHash`, `sha256Hex(bytes)`, `blobKey(hash)` | The content hash (SHA-256, 64 lowercase hex characters), its Web Crypto derivation, and the store key it gives. |
| `fileResourceFields`, `FileColumns` | The file version's attribute spread (all read-only) and its columns. |
| `defineFileWrites(definition)`, `FileWriteOps`, `ReplaceInput`, `Upload`, `FileWrite` | The commit-ordered writes (`create`, `replace`, `confirmBytes`; `replace` also takes a `patch` of other columns for the same version), an upload, and what a write reports. |
| `fileUrl(file, blobs)` | A version's URL, or none while its bytes are pending. |
| `fileUsageEnds({ user, file })` | The usage index's edge ends (`userId`, `fileId`). |

## `./media`

The media library (pulpit#206), after gardeneria's media and album operations and website's image renditions. A media item is a `./blobs` file leaf that also spreads `mediaResourceFields`; the kernel records what an upload's metadata says, gates its renditions, and orders albums. Parsing the bytes, transforming them and the transport (multipart, tus) are the application's.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineFileWrites } from "@thomasfosterau/pulpit/blobs";
import { defineAlbum, defineMediaUploads, defineRenditions } from "@thomasfosterau/pulpit/media";

const media = defineMediaUploads({
  files: defineFileWrites({ leaf: imageOps, blobs: r2, transact }),
  extractor: exifReader, // the app's MetadataExtractor
  // stripLocation: true, // omitted, the default: EXIF location is recorded
});
const renditions = defineRenditions({
  policy: { widths: [320, 640, 1280, 2560], formats: ["image/avif", "image/webp", "image/jpeg"] },
  references: imageReferences, // which nodes reference a content hash
  leaves: [{ ops: imageOps, fileOf: (image) => Option.some(image.attributes) }],
  transform: cloudflareImages, // the app's RenditionTransform
});
const album = defineAlbum({
  type: "album-items",
  parent: albumOps,
  media: [imageOps, videoOps],
  store,
});

const program = Effect.gen(function* () {
  const written = yield* media.create({
    id: Option.none(),
    state: { visibility: "public", altText: "A fern unfurling" },
    upload: { bytes, mediaType: "image/jpeg", filename: "fern.jpg" },
  });
  // GET /images/:hash?w=500 with Accept: image/avif,image/webp,*/*
  const { width, format, rendition } = yield* renditions.serve({
    contentHash: written.contentHash,
    width: 500,
    accept: request.headers.accept,
  }); // width 640, format image/avif; RenditionNotFound (404) for bytes the viewer can't reach
  yield* album.append(albumId, written.id);
  return rendition;
});
```

- **The fields.** `mediaResourceFields` is the spread beside `fileResourceFields`. The editorial fields `altText`, `caption` and `license` are the writer's, optional at create and clearable with `null`. The extracted fields are read-only on the wire: `mediaKind` (`image | video | audio | other`), `width` / `height`, `durationSeconds` and `exif` (`MediaExif`: capture time, camera, lens, orientation, `location`), each `null` when the extractor found nothing.
- **The upload pipeline.** `defineMediaUploads({ files, extractor, stripLocation })` runs the extractor over the upload first (its failure writes nothing), turns the metadata into columns with `mediaColumns`, and writes them with the file columns in the one version `./blobs`' commit-ordered write appends. `replace` re-records the metadata for the new bytes; the editorial fields carry forward unless its `patch` sets them.
- **EXIF location: kept by default, stripped per family.** Owner decision on pulpit#206. A photo's GPS coordinates can reveal where its author lives, so a family that holds UGC (members' uploads) should declare `stripLocation: true`; a family of curated or field-record media (a species observation, a press photo) keeps them, because the location is the point. Know what each setting does and doesn't do:
  - `stripLocation: true` drops `location` from what the kernel _records_ in `exif`, so it is never on the resource, in search, or in a feed.
  - It does **not** change the bytes. The original file's own EXIF block still holds the coordinates, and anyone who can fetch the original can read them. Stripping them from the bytes is the application's: re-encode in the extractor before the bytes are stored, or serve only transformed renditions (most image services drop metadata) and never the original.
  - Omitting `stripLocation` records the location on the resource, where every reader of the node sees it. Gate the node accordingly.
- **Renditions.** `defineRenditions({ policy, references, leaves, transform })` serves a variant only through its gate:
  1. **The gate.** Some node the viewer can read must reference the bytes, with them confirmed. The `MediaReferences` index lists the nodes that reference a hash, each is re-read through its own leaf's `getMany` (so its access, tombstone and live-version rules apply), and the resource that read returns must point at exactly these bytes (`fileOf`), not pending. Otherwise, and for a malformed hash or a ref to an undeclared leaf, the answer is `RenditionNotFound` (404), never a 403 (`SEC-AUTH-ENUM-001`). `readable(contentHash)` is the gate alone, for a route serving the original.
  2. **The width** is `renditionWidth(widths, requested)`: the smallest declared width at or above the request, capped at the largest, and the smallest for a non-positive or missing width. Only declared widths are ever rendered, so a client can't fill a cache with arbitrary sizes.
  3. **The format** is `renditionFormat(formats, accept)`: the family's format the `Accept` header weights highest (each by its most specific matching range; ties go to the family's order), the first format with no header, and the last (the baseline, such as `image/jpeg`) when the header accepts none, rather than a 406 an `<img>` can't act on. Vary the response on `Accept`.
  4. **The transform** (`RenditionTransform.render({ contentHash, width, format })`) is called only once the gate has passed.

  A policy with no widths or formats, widths that aren't strictly ascending positive integers, or a repeated or empty format throws `MediaDeclarationError` when declared. A rendition served to a signed-in viewer may be one an anonymous reader can't have: let a shared cache hold it only when the anonymous gate passes too (`CACHE-AUTH-005`).

- **Albums.** `defineAlbum({ type, parent, media, store, mode? })` is `./collections`' `defineCollection` with its members drawn from the declared media leaves: each id is looked up through every media leaf's own `getMany`, and a member reads as `{ type, resource }`. A node of any other leaf is one the album can't find (`append` fails `NodeNotFound`, confirming nothing), and a member the viewer can't read is omitted from `list` and its total. Declaring a leaf twice throws `MediaDeclarationError`.

| Export | What it is |
| --- | --- |
| `mediaResourceFields`, `MediaKind`, `MediaExif`, `GeoLocation` | The media field spread and its vocabulary. |
| `MetadataExtractor`, `MediaMetadata`, `mediaColumns(metadata, { stripLocation })` | The extractor seam (see [Seams](seams.md#seams)), what it reads, and the columns a version records for it. |
| `defineMediaUploads(definition)`, `MediaUploadOps` | The upload pipeline over `./blobs`' file writes (`create`, `replace`). |
| `defineRenditions(definition)`, `RenditionOps`, `RenditionPolicy`, `RenditionRequest`, `RenditionTransform`, `MediaReferences`, `MediaLeaf`, `MediaFile`, `NodeRef` | The gated renditions (`readable`, `serve`), the policy, the request, and the transform and reference-index seams. |
| `renditionWidth(widths, requested)`, `renditionFormat(formats, accept)` | The width bucket and the negotiated format. |
| `defineAlbum(definition)`, `AlbumDefinition`, `MediaItem` | Albums over `./collections`, and an album member. |
| `RenditionNotFound`, `MediaDeclarationError` | The failures: 404, and a declaration against the rules (thrown). |
