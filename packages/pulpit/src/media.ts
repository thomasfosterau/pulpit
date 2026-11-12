/**
 * **The media library** (pulpit#206) — the editorial fields a media leaf
 * carries, the upload pipeline that records what an upload's metadata says,
 * the renditions gate, and albums.
 *
 * The behavioural spec is gardeneria's `packages/models/src/models/media.ts`
 * and `apps/api/src/operations/media.ts` (image and video file leaves with
 * licence, alt text, caption and EXIF; albums in `operations/albums.ts`) and
 * website's `apps/api/src/operations/images.ts` with
 * `apps/web/src/routes/images/[id=uuid]/+server.ts` (width-bucketed
 * renditions in an `Accept`-negotiated format, served only for an image
 * some readable node references).
 *
 * ## The model
 *
 * - **A media item is a file leaf** (`./blobs`) that also spreads
 *   {@link mediaResourceFields}: the editorial fields (alt text, caption,
 *   licence) the writer sets, and the extracted ones (kind, dimensions,
 *   duration, an EXIF subset) the upload pipeline records.
 * - **The upload pipeline** ({@link defineMediaUploads}) runs the
 *   application's {@link MetadataExtractor} over the upload, records what
 *   it found, and stores the bytes through `./blobs`' commit-ordered write,
 *   so the version and its metadata land together and the bytes follow the
 *   commit. The transport (multipart, tus) is the application's.
 * - **EXIF location is kept by default** (owner decision on pulpit#206).
 *   A family opts out with `stripLocation: true`, which drops the GPS
 *   fields from what is *recorded*. It does not touch the bytes: an image's
 *   own EXIF block still carries its coordinates unless the application's
 *   transform (or its extractor's re-encode) strips them. See the package
 *   docs/media.md → `./media` for the trade-off.
 * - **A rendition is served only for bytes a node the viewer can read
 *   references** ({@link defineRenditions}): the kernel owns the width
 *   buckets, the format negotiation and that gate, and answers a blob no
 *   readable node references, or one whose bytes are still pending, with
 *   {@link RenditionNotFound} (the wire's 404), never a 403
 *   (`SEC-AUTH-ENUM-001`). The transform (Cloudflare Images, sharp, a CDN)
 *   is the application's seam.
 * - **An album is an ordered collection of media items** ({@link defineAlbum},
 *   over `./collections`), its members drawn only from the declared media
 *   leaves: anything else is not a member it can find (`NodeNotFound`), and
 *   a member the viewer can't read is omitted from the read.
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/media.md#media.
 *
 * @copyright Thomas Foster
 * @module pulpit/media
 * @since 0.2.0
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  ContentHash,
  type FileWrite,
  type FileWriteOps,
  type ReplaceInput,
  type Upload,
} from "./blobs.ts";
import { defineCollection, type CollectionDefinition, type CollectionOps } from "./collections.ts";
import { qOf } from "./internal/qvalue.ts";
import { MAX_PAGE_LIMIT, type SubtypeOps } from "./subtype.ts";
import type { ChainState } from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * What a media item is, as its extractor reads it: the broad kind its
 * renditions and players branch on. The precise type is the file's
 * `mediaType` (`./blobs`).
 *
 * @since 0.2.0
 */
export const MediaKind = Schema.Literals(["image", "video", "audio", "other"]);
/**
 * The {@link MediaKind} literal union.
 *
 * @since 0.2.0
 */
export type MediaKind = typeof MediaKind.Type;

/**
 * Where a photo or video was taken, as its EXIF GPS block records it:
 * decimal degrees, and metres above sea level when recorded.
 *
 * @since 0.2.0
 */
export const GeoLocation = Schema.Struct({
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  altitude: Schema.optional(Schema.Finite),
});
/**
 * The {@link GeoLocation} struct.
 *
 * @since 0.2.0
 */
export type GeoLocation = typeof GeoLocation.Type;

/**
 * The subset of EXIF a media item records: when and with what it was
 * captured, its orientation, and its location. Each field is present only
 * when the extractor found it; `location` is absent too on a family that
 * strips it (`stripLocation`).
 *
 * @since 0.2.0
 */
export const MediaExif = Schema.Struct({
  /** The capture time as the camera recorded it (ISO 8601). */
  capturedAt: Schema.optional(Schema.String),
  cameraMake: Schema.optional(Schema.String),
  cameraModel: Schema.optional(Schema.String),
  lens: Schema.optional(Schema.String),
  /** The EXIF orientation tag, 1–8. */
  orientation: Schema.optional(Schema.Int),
  location: Schema.optional(GeoLocation),
});
/**
 * The {@link MediaExif} struct.
 *
 * @since 0.2.0
 */
export type MediaExif = typeof MediaExif.Type;

/**
 * The attributes a media leaf's resource carries beside `./blobs`'
 * `fileResourceFields`:
 *
 * - the editorial fields, which the writer sets and may clear (`null`):
 *   `altText`, `caption`, `license` (a licence name or SPDX id);
 * - the extracted fields, server-set by {@link defineMediaUploads} and
 *   read-only on the wire: `mediaKind`, `width` / `height` (pixels),
 *   `durationSeconds`, and `exif`, each `null` when the extractor found
 *   nothing.
 *
 * Spread into the media leaf's `Resource.make({ attributes })`.
 *
 * @since 0.2.0
 */
export const mediaResourceFields = {
  mediaKind: Resource.readOnlyAttribute(MediaKind),
  altText: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
  caption: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
  license: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
  width: Resource.readOnlyAttribute(Schema.NullOr(Schema.Int)),
  height: Resource.readOnlyAttribute(Schema.NullOr(Schema.Int)),
  durationSeconds: Resource.readOnlyAttribute(Schema.NullOr(Schema.Finite)),
  exif: Resource.readOnlyAttribute(Schema.NullOr(MediaExif)),
} as const;

// ── Errors ────────────────────────────────────────────────────────────

/**
 * A media declaration against the rules: an empty, unsorted, duplicated or
 * non-positive width list, an empty or duplicated format list, or an album
 * with no media leaves or a leaf type twice. Thrown when the family is
 * declared, never an Effect failure, like `./edges`' `EdgeDeclarationError`.
 *
 * @since 0.2.0
 */
export class MediaDeclarationError extends Schema.TaggedError<
  MediaDeclarationError,
  { readonly brand: unique symbol }
>()("MediaDeclarationError", { message: Schema.String }) {}

/**
 * No rendition for these bytes, for this viewer: no node the viewer can
 * read references them, or their bytes are still pending, or the hash is
 * malformed. The wire's 404, never a 403, so it confirms no blob
 * (`SEC-AUTH-ENUM-001`).
 *
 * @since 0.2.0
 */
export class RenditionNotFound extends Schema.TaggedError<
  RenditionNotFound,
  { readonly brand: unique symbol }
>()("RenditionNotFound", { contentHash: Schema.String }) {}

// ── The upload pipeline ───────────────────────────────────────────────

/**
 * What an extractor reads off an upload. Every measurement is optional; an
 * extractor that can't parse the bytes returns the kind alone.
 *
 * @since 0.2.0
 */
export interface MediaMetadata {
  readonly kind: MediaKind;
  readonly width: Option.Option<number>;
  readonly height: Option.Option<number>;
  readonly durationSeconds: Option.Option<number>;
  readonly exif: Option.Option<MediaExif>;
}

/**
 * The metadata seam the application fills (an EXIF parser, `ffprobe`, a
 * media service's probe). It reads the upload and applies no policy; a
 * failure (its `E`) fails the upload before anything is written.
 *
 * @since 0.2.0
 */
export interface MetadataExtractor<E, R> {
  readonly extract: (upload: Upload) => Effect.Effect<MediaMetadata, E, R>;
}

/** Drop the `undefined` entries, so the value is a JSON object. */
const compact = (
  // oxlint-disable-next-line effect/prefer-option-over-null -- the input is an object literal whose optional fields read `undefined` when absent; dropping those keys is this function's whole job
  entries: Readonly<Record<string, Schema.Json | undefined>>,
): { readonly [key: string]: Schema.Json } =>
  R.filter(entries, (value): value is Schema.Json => value !== undefined);

/**
 * The columns a media version records for `metadata`: `exif` as a JSON
 * object (`null` when the extractor found none), without `location` when
 * `stripLocation`, and `null` for each measurement it didn't find.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Option from "effect/Option";
 * import { mediaColumns } from "@thomasfosterau/pulpit/media";
 *
 * const metadata = {
 *   kind: "image" as const,
 *   width: Option.some(1200),
 *   height: Option.some(800),
 *   durationSeconds: Option.none(),
 *   exif: Option.some({ cameraModel: "X100", location: { latitude: -33.86, longitude: 151.21 } }),
 * };
 * deepStrictEqual(mediaColumns(metadata, { stripLocation: true }), {
 *   mediaKind: "image",
 *   width: 1200,
 *   height: 800,
 *   durationSeconds: null,
 *   exif: { cameraModel: "X100" },
 * });
 * ```
 *
 * @since 0.2.0
 */
export const mediaColumns = (
  metadata: MediaMetadata,
  options: { readonly stripLocation: boolean },
): ChainState => ({
  mediaKind: metadata.kind,
  width: Option.getOrNull(metadata.width),
  height: Option.getOrNull(metadata.height),
  durationSeconds: Option.getOrNull(metadata.durationSeconds),
  exif: Option.match(metadata.exif, {
    onNone: () => null,
    onSome: (exif) =>
      compact({
        capturedAt: exif.capturedAt,
        cameraMake: exif.cameraMake,
        cameraModel: exif.cameraModel,
        lens: exif.lens,
        orientation: exif.orientation,
        location:
          options.stripLocation || exif.location === undefined
            ? undefined
            : compact({
                latitude: exif.location.latitude,
                longitude: exif.location.longitude,
                altitude: exif.location.altitude,
              }),
      }),
  }),
});

/**
 * The operations {@link defineMediaUploads} produces: `./blobs`' file
 * writes, with the upload's metadata recorded in the same version.
 *
 * @since 0.2.0
 */
export interface MediaUploadOps<FE, XE, R> {
  /**
   * Create a media node from an upload, its editorial fields (and any other
   * leaf column) in `state`. Fails with the extractor's `XE` before anything
   * is written, and as the file write's `create` does.
   */
  readonly create: (
    input: Parameters<FileWriteOps<FE, R>["create"]>[0],
  ) => Effect.Effect<FileWrite, Effect.Error<ReturnType<FileWriteOps<FE, R>["create"]>> | XE, R>;
  /**
   * Replace a media node's bytes, re-recording their metadata in the same
   * version; the editorial fields carry forward unless `patch` sets them.
   * Fails with the extractor's `XE`, and as the file write's `replace` does.
   */
  readonly replace: (
    input: ReplaceInput,
  ) => Effect.Effect<FileWrite, Effect.Error<ReturnType<FileWriteOps<FE, R>["replace"]>> | XE, R>;
}

/**
 * Bind a media leaf's upload pipeline over its file writes: extract the
 * upload's metadata, record it (stripped of its location when the family
 * says so), then write the version and its bytes through `files`' commit
 * ordering. Traced as `media.create` / `media.replace`.
 *
 * @since 0.2.0
 */
export const defineMediaUploads = <FE, XE, R>(definition: {
  readonly files: Pick<FileWriteOps<FE, R>, "create" | "replace">;
  readonly extractor: MetadataExtractor<XE, R>;
  /** Drop EXIF location from what is recorded (pulpit#206: kept by default). */
  readonly stripLocation?: true;
}): MediaUploadOps<FE, XE, R> => {
  const { files, extractor } = definition;
  const stripLocation = definition.stripLocation === true;
  const columnsOf = (upload: Upload) =>
    Effect.map(extractor.extract(upload), (metadata) => mediaColumns(metadata, { stripLocation }));

  const create = Effect.fn("media.create")(function* (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
    readonly upload: Upload;
  }) {
    const columns = yield* columnsOf(input.upload);
    return yield* files.create({ ...input, state: { ...input.state, ...columns } });
  });

  const replace = Effect.fn("media.replace")(function* (input: ReplaceInput) {
    const columns = yield* columnsOf(input.upload);
    return yield* files.replace({ ...input, patch: { ...input.patch, ...columns } });
  });

  return { create, replace };
};

// ── Renditions ────────────────────────────────────────────────────────

/**
 * A family's rendition policy: the widths it renders (pixels, strictly
 * ascending) and the formats it serves (media types, in its order of
 * preference, the last being the baseline every client takes, such as
 * `image/jpeg`).
 *
 * @since 0.2.0
 */
export interface RenditionPolicy {
  readonly widths: Arr.NonEmptyReadonlyArray<number>;
  readonly formats: Arr.NonEmptyReadonlyArray<string>;
}

/**
 * Check a {@link RenditionPolicy}, throwing {@link MediaDeclarationError}
 * for one against the rules.
 */
const checkPolicy = (policy: RenditionPolicy): RenditionPolicy => {
  const { widths, formats } = policy;
  // The types say non-empty; a declaration built at runtime may not be.
  if (Arr.isReadonlyArrayEmpty(widths) || Arr.isReadonlyArrayEmpty(formats)) {
    throw new MediaDeclarationError({ message: "a rendition policy needs a width and a format" });
  }
  if (!Arr.every(widths, (width) => Number.isInteger(width) && width > 0)) {
    throw new MediaDeclarationError({ message: "rendition widths must be positive integers" });
  }
  if (!Arr.every(Arr.zip(widths, Arr.drop(widths, 1)), ([lower, upper]) => upper > lower)) {
    throw new MediaDeclarationError({ message: "rendition widths must be strictly ascending" });
  }
  if (Arr.dedupe(formats).length !== formats.length || !Arr.every(formats, Str.isNonEmpty)) {
    throw new MediaDeclarationError({ message: "rendition formats must be distinct media types" });
  }
  return policy;
};

/**
 * The width bucket a request renders at: the smallest declared width at or
 * above `requested`, capped at the largest. A requested width that isn't a
 * positive number (absent, `0`, `NaN`) takes the smallest, so the bucket
 * set is the only set of variants ever rendered.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { renditionWidth } from "@thomasfosterau/pulpit/media";
 *
 * const widths = [320, 640, 1280] as const;
 * strictEqual(renditionWidth(widths, 500), 640);
 * strictEqual(renditionWidth(widths, 640), 640);
 * strictEqual(renditionWidth(widths, 4000), 1280);
 * strictEqual(renditionWidth(widths, Number.NaN), 320);
 * ```
 *
 * @since 0.2.0
 */
export const renditionWidth = (
  widths: Arr.NonEmptyReadonlyArray<number>,
  requested: number,
): number =>
  requested > 0
    ? Option.getOrElse(
        Arr.findFirst(widths, (width) => width >= requested),
        () => Arr.lastNonEmpty(widths),
      )
    : Arr.headNonEmpty(widths);

/** One media range of an `Accept` header: its type, subtype and weight. */
interface MediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

/** Parse one `Accept` media range; malformed ranges are skipped. */
const mediaRange = (range: string): Option.Option<MediaRange> => {
  const [value = "", ...parameters] = Arr.map(range.split(";"), Str.trim);
  const [type = "", subtype = ""] = Arr.map(value.toLowerCase().split("/"), Str.trim);
  if (type === "" || subtype === "") return Option.none();
  const q = qOf(parameters);
  return Number.isNaN(q) ? Option.none() : Option.some({ type, subtype, q });
};

/**
 * How well `range` matches `format`: 2 for an exact match, 1 for
 * `type/*`, 0 for `*\/*`, none otherwise.
 */
const specificity = (range: MediaRange, format: string): Option.Option<number> => {
  const [type = "", subtype = ""] = format.toLowerCase().split("/");
  if (range.type === "*" && range.subtype === "*") return Option.some(0);
  if (range.type !== type) return Option.none();
  if (range.subtype === "*") return Option.some(1);
  return range.subtype === subtype ? Option.some(2) : Option.none();
};

/**
 * The format a request renders in: of the family's `formats`, the one the
 * `Accept` header weights highest, each format taking the weight of its
 * most specific matching range (exact, then `type/*`, then `*\/*`), ties
 * going to the family's order. With no `Accept` header the family's first
 * (preferred) format; when the header accepts none of them, its last (the
 * baseline), rather than a 406 an `<img>` can't act on.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { renditionFormat } from "@thomasfosterau/pulpit/media";
 *
 * const formats = ["image/avif", "image/webp", "image/jpeg"] as const;
 * strictEqual(renditionFormat(formats, "image/webp,image/*;q=0.8"), "image/webp");
 * strictEqual(renditionFormat(formats, undefined), "image/avif");
 * strictEqual(renditionFormat(formats, "text/html"), "image/jpeg");
 * ```
 *
 * @since 0.2.0
 */
export const renditionFormat = (
  formats: Arr.NonEmptyReadonlyArray<string>,
  // oxlint-disable-next-line effect/prefer-option-over-null -- an HTTP header read off a request is `string | undefined`; the parameter takes it as it comes
  accept: string | undefined,
): string => {
  if (accept === undefined || Str.trim(accept) === "") return Arr.headNonEmpty(formats);
  const ranges = Arr.getSomes(Arr.map(accept.split(","), mediaRange));
  const weighted = Arr.map(formats, (format) => {
    const matches = Arr.getSomes(
      Arr.map(ranges, (range) =>
        Option.map(specificity(range, format), (score) => ({ score, q: range.q })),
      ),
    );
    const best = Arr.reduce(matches, Option.none<{ score: number; q: number }>(), (acc, match) =>
      Option.match(acc, {
        onNone: () => Option.some(match),
        onSome: (current) => (match.score > current.score ? Option.some(match) : acc),
      }),
    );
    return { format, q: Option.match(best, { onNone: () => 0, onSome: (match) => match.q }) };
  });
  const chosen = Arr.reduce(weighted, Option.none<{ format: string; q: number }>(), (acc, entry) =>
    entry.q > 0 && Option.match(acc, { onNone: () => true, onSome: (best) => entry.q > best.q })
      ? Option.some(entry)
      : acc,
  );
  return Option.match(chosen, {
    onNone: () => Arr.lastNonEmpty(formats),
    onSome: (entry) => entry.format,
  });
};

/**
 * A node that may reference a blob: its leaf type and id.
 *
 * @since 0.2.0
 */
export interface NodeRef {
  readonly type: string;
  readonly id: string;
}

/**
 * The reference index the application supplies: which nodes' versions
 * reference a content hash (a `file_versions.content_hash` index, or the
 * file-usage edges). It applies no policy; the gate re-reads each node
 * through its own leaf. At most `limit` refs, any order.
 *
 * @since 0.2.0
 */
export interface MediaReferences<E, R> {
  readonly referencing: (
    contentHash: ContentHash,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<NodeRef>, E, R>;
}

/**
 * The bytes a readable media resource points at: its `contentHash`, and
 * whether its bytes are still pending (`./blobs`' `bytesPending`).
 *
 * @since 0.2.0
 */
export interface MediaFile {
  readonly contentHash: string;
  readonly bytesPending: boolean;
}

/**
 * One media leaf the rendition gate reads through: its gated batch read
 * and how to find the file a resource it returns points at.
 *
 * @since 0.2.0
 */
export interface MediaLeaf<Resource, E, R> {
  readonly ops: Pick<SubtypeOps<Resource, E, R>, "type" | "getMany">;
  readonly fileOf: (resource: Resource) => Option.Option<MediaFile>;
}

/**
 * The transform seam the application fills: render `key`'s bytes at
 * `width` in `format`, returning whatever its transport serves (a URL, a
 * response, bytes). It applies no policy; it is called only once the gate
 * has passed.
 *
 * @since 0.2.0
 */
export interface RenditionTransform<A, E, R> {
  readonly render: (request: {
    readonly contentHash: ContentHash;
    readonly width: number;
    readonly format: string;
  }) => Effect.Effect<A, E, R>;
}

/**
 * A rendition request: the bytes' hash, the width asked for, and the
 * request's `Accept` header.
 *
 * @since 0.2.0
 */
export interface RenditionRequest {
  readonly contentHash: string;
  readonly width: number;
  /** The request's `Accept` header; omitted, no header. */
  readonly accept?: string;
}

/**
 * The operations {@link defineRenditions} produces.
 *
 * @since 0.2.0
 */
export interface RenditionOps<A, E, R> {
  /**
   * Whether some node the viewer can read references these bytes, with
   * them confirmed (not `bytesPending`): the gate alone, for a route that
   * serves the original. Never fails but with the stores' `E`.
   */
  readonly readable: (contentHash: string) => Effect.Effect<boolean, E, R>;
  /**
   * The rendition at the request's width bucket and negotiated format,
   * through the transform, once the gate has passed; {@link RenditionNotFound}
   * otherwise (`SEC-AUTH-ENUM-001`).
   */
  readonly serve: (
    request: RenditionRequest,
  ) => Effect.Effect<
    { readonly width: number; readonly format: string; readonly rendition: A },
    RenditionNotFound | E,
    R
  >;
}

const isContentHash = Schema.is(ContentHash);

/**
 * Bind a media family's renditions: the bucket and format policy (checked
 * when declared, {@link MediaDeclarationError}), the gate over the
 * reference index and each media leaf's own read, and the application's
 * transform. A ref to a leaf type not in `leaves` never opens the gate.
 *
 * A rendition served to a signed-in viewer may be one an anonymous reader
 * can't have: put it in a shared cache only when the anonymous gate passes
 * too (as `CACHE-AUTH-005` puts it for resources).
 *
 * @since 0.2.0
 */
export const defineRenditions = <Resource, A, E, R>(definition: {
  readonly policy: RenditionPolicy;
  readonly references: MediaReferences<E, R>;
  readonly leaves: ReadonlyArray<MediaLeaf<Resource, E, R>>;
  readonly transform: RenditionTransform<A, E, R>;
}): RenditionOps<A, E, R> => {
  const policy = checkPolicy(definition.policy);
  const { references, leaves, transform } = definition;

  const readable = Effect.fn("renditions.readable")(function* (contentHash: string) {
    if (!isContentHash(contentHash)) return false;
    const refs = yield* references.referencing(contentHash, MAX_PAGE_LIMIT);
    const checks = Arr.map(leaves, (leaf) => {
      const ids = Arr.dedupe(
        Arr.map(
          Arr.filter(refs, (ref) => ref.type === leaf.ops.type),
          (ref) => ref.id,
        ),
      );
      return Arr.isReadonlyArrayNonEmpty(ids)
        ? Effect.map(leaf.ops.getMany(ids), (found) =>
            Arr.some(Arr.fromIterable(HashMap.values(found)), (resource) =>
              Option.exists(
                leaf.fileOf(resource),
                (file) => file.contentHash === contentHash && !file.bytesPending,
              ),
            ),
          )
        : Effect.succeed(false);
    });
    return Arr.some(yield* Effect.all(checks, { concurrency: "unbounded" }), P.isTruthy);
  });

  const serve = Effect.fn("renditions.serve")(function* (request: RenditionRequest) {
    if (!isContentHash(request.contentHash) || !(yield* readable(request.contentHash))) {
      return yield* new RenditionNotFound({ contentHash: request.contentHash });
    }
    const width = renditionWidth(policy.widths, request.width);
    const format = renditionFormat(policy.formats, request.accept);
    const rendition = yield* transform.render({ contentHash: request.contentHash, width, format });
    return { width, format, rendition };
  });

  return { readable, serve };
};

// ── Albums ────────────────────────────────────────────────────────────

/**
 * One album member as a read returns it: the media leaf it belongs to and
 * its resource.
 *
 * @since 0.2.0
 */
export interface MediaItem<Resource> {
  readonly type: string;
  readonly resource: Resource;
}

/**
 * One album family: `./collections`' declaration, its members drawn from
 * the declared media leaves (each read through its own gate) rather than
 * one member leaf.
 *
 * @since 0.2.0
 */
export interface AlbumDefinition<Parent, Item, E, R> extends Omit<
  CollectionDefinition<Parent, MediaItem<Item>, E, R>,
  "members"
> {
  readonly media: Arr.NonEmptyReadonlyArray<Pick<SubtypeOps<Item, E, R>, "type" | "getMany">>;
}

/**
 * Bind an album: an ordered collection whose members are media items
 * (`./collections`' `defineCollection`, with its gates and order model).
 * A member is looked up in each declared media leaf in turn, through that
 * leaf's own `getMany`, so a node of any other leaf is a member the album
 * can't find (`append` fails `NodeNotFound`, confirming nothing) and a
 * member the viewer can't read is omitted from `list`. Throws
 * {@link MediaDeclarationError} for an album declaring a leaf type twice.
 *
 * @since 0.2.0
 */
export const defineAlbum = <Parent, Item, E, R>(
  definition: AlbumDefinition<Parent, Item, E, R>,
): CollectionOps<MediaItem<Item>, E, R> => {
  const { media, ...collection } = definition;
  const types = Arr.map(media, (leaf) => leaf.type);
  if (Arr.dedupe(types).length !== types.length) {
    throw new MediaDeclarationError({ message: `album ${definition.type} declares a leaf twice` });
  }
  const getMany = (ids: ReadonlyArray<string>) =>
    Effect.map(
      Effect.all(
        Arr.map(media, (leaf) =>
          Effect.map(leaf.getMany(ids), (found) =>
            HashMap.map(found, (resource): MediaItem<Item> => ({ type: leaf.type, resource })),
          ),
        ),
        { concurrency: "unbounded" },
      ),
      // The first leaf that finds an id wins; ids are node ids, so at most one does.
      (maps) =>
        Arr.reduce(maps, HashMap.empty<string, MediaItem<Item>>(), (acc, map) =>
          HashMap.union(map, acc),
        ),
    );
  return defineCollection({ ...collection, members: { getMany } });
};
