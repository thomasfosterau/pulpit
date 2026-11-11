/**
 * The media library (pulpit#206).
 *
 * - The media fields: editorial fields writable and clearable, extracted
 *   fields read-only, EXIF decoding.
 * - The upload pipeline: the extractor's metadata recorded in the version
 *   the bytes are written with, EXIF location kept by default and dropped
 *   under `stripLocation`, a replace re-recording it with the editorial
 *   fields carried forward, an extractor failure writing nothing.
 * - Renditions: width buckets (round up, cap, the smallest for a
 *   non-positive request), format negotiation, the declaration checks, and
 *   the gate (`SEC-AUTH-ENUM-001`): not-found for a private node, a
 *   tombstoned node, an unreferenced blob, a blob only a hidden node
 *   references, pending bytes, a ref to an undeclared leaf and a malformed
 *   hash.
 * - Albums: media members from every declared leaf, a non-media node
 *   refused as `NodeNotFound`, a hidden item omitted, a leaf declared twice
 *   thrown.
 *
 * @module tests/media
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { defineFileWrites, sha256Hex, type Upload } from "../src/blobs.ts";
import {
  defineAlbum,
  defineMediaUploads,
  defineRenditions,
  MediaDeclarationError,
  MediaExif,
  mediaColumns,
  mediaResourceFields,
  renditionFormat,
  renditionWidth,
  type MediaMetadata,
} from "../src/media.ts";
import { defineSubtype, ownedAccess, type LeafRow, type Viewer } from "../src/subtype.ts";
import {
  makeInMemoryBlobStore,
  makeInMemoryVersionChain,
  makeInMemoryCollectionStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryMediaReferences,
} from "../src/testing.ts";
import { decodes, gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const tagOf = async <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (e) => e._tag)
    : Option.none();
};
const bytesOf = (text: string) => new TextEncoder().encode(text);
const upload = (text: string): Upload => ({
  bytes: bytesOf(text),
  mediaType: "image/jpeg",
  filename: "photo.jpg",
});

const SYDNEY = { latitude: -33.8688, longitude: 151.2093, altitude: 58 };
const photo: MediaMetadata = {
  kind: "image",
  width: Option.some(4000),
  height: Option.some(3000),
  durationSeconds: Option.none(),
  exif: Option.some({ cameraModel: "X100V", orientation: 1, location: SYDNEY }),
};

const MEDIA_COLUMNS = [
  "visibility",
  "contentHash",
  "byteSize",
  "mediaType",
  "filename",
  "bytesPending",
  "mediaKind",
  "altText",
  "caption",
  "license",
  "width",
  "height",
  "durationSeconds",
  "exif",
] as const;

/** One owned media leaf per type, sharing a switchable viewer. */
const setup = () => {
  let viewer: Viewer = Option.some(member);
  const viewerOf = Effect.sync(() => viewer);
  const leaf = (type: string, columns: ReadonlyArray<string> = MEDIA_COLUMNS) => {
    const chain = makeInMemoryVersionChain(type);
    const ops = defineSubtype({
      type,
      access: ownedAccess(),
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns, now: NOW }),
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
    });
    return { chain, ops };
  };
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  return { leaf, as };
};

const anonymous: Viewer = Option.none();
const owner: Viewer = Option.some(member);
const stranger: Viewer = Option.some(otherMember);
const rung: Viewer = Option.some(moderator);

// ── The fields ────────────────────────────────────────────────────────

describe("mediaResourceFields", () => {
  it("names the editorial and extracted fields", () => {
    expect(R.keys(mediaResourceFields)).toEqual([
      "mediaKind",
      "altText",
      "caption",
      "license",
      "width",
      "height",
      "durationSeconds",
      "exif",
    ]);
  });

  it.each([
    {
      label: "a full EXIF subset",
      value: { cameraMake: "Fujifilm", orientation: 6, location: SYDNEY },
      ok: true,
    },
    { label: "no EXIF fields", value: {}, ok: true },
    { label: "a location without longitude", value: { location: { latitude: 1 } }, ok: false },
    { label: "a fractional orientation", value: { orientation: 1.5 }, ok: false },
  ])("MediaExif decodes $label: $ok", ({ value, ok }) => {
    expect(decodes(MediaExif, value)).toBe(ok);
  });

  it("the editorial fields are nullable strings", () => {
    const altText = Schema.toType(mediaResourceFields.altText);
    expect(decodes(altText, "a fern")).toBe(true);
    expect(decodes(altText, null)).toBe(true);
    expect(decodes(altText, 3)).toBe(false);
  });
});

describe("mediaColumns", () => {
  it("keeps the location by default", () => {
    expect(mediaColumns(photo, { stripLocation: false })).toEqual({
      mediaKind: "image",
      width: 4000,
      height: 3000,
      durationSeconds: null,
      exif: { cameraModel: "X100V", orientation: 1, location: SYDNEY },
    });
  });

  it("drops only the location under stripLocation", () => {
    expect(mediaColumns(photo, { stripLocation: true })["exif"]).toEqual({
      cameraModel: "X100V",
      orientation: 1,
    });
  });

  it("records null for what the extractor didn't find", () => {
    expect(
      mediaColumns(
        {
          kind: "audio",
          width: Option.none(),
          height: Option.none(),
          durationSeconds: Option.some(184.5),
          exif: Option.none(),
        },
        { stripLocation: false },
      ),
    ).toEqual({
      mediaKind: "audio",
      width: null,
      height: null,
      durationSeconds: 184.5,
      exif: null,
    });
  });

  it("omits an absent altitude rather than recording undefined", () => {
    const columns = mediaColumns(
      { ...photo, exif: Option.some({ location: { latitude: 1, longitude: 2 } }) },
      { stripLocation: false },
    );
    expect(columns["exif"]).toEqual({ location: { latitude: 1, longitude: 2 } });
  });
});

// ── The upload pipeline ───────────────────────────────────────────────

const uploads = (options: { readonly stripLocation: boolean } = { stripLocation: false }) => {
  const { leaf, as } = setup();
  const images = leaf("images");
  const blobs = makeInMemoryBlobStore();
  const files = defineFileWrites({ leaf: images.ops, blobs, transact: (effect) => effect });
  const extracted: Array<string> = [];
  const media = defineMediaUploads({
    files,
    extractor: {
      extract: (file) =>
        Effect.sync(() => {
          extracted.push(file.filename);
          return photo;
        }),
    },
    stripLocation: options.stripLocation,
  });
  return { images, media, blobs, extracted, as };
};

describe("defineMediaUploads", () => {
  it("records the metadata in the version the bytes land with, location kept", async () => {
    const { images, media, extracted } = uploads();
    const written = await run(
      media.create({
        id: Option.none(),
        state: { visibility: "public", altText: "Harbour at dusk" },
        upload: upload("jpeg"),
      }),
    );
    expect(written.bytesPending).toBe(false);
    expect(extracted).toEqual(["photo.jpg"]);
    const head = await run(images.ops.get(written.id));
    expect(head).toMatchObject({
      altText: "Harbour at dusk",
      mediaKind: "image",
      width: 4000,
      height: 3000,
      bytesPending: false,
      exif: { cameraModel: "X100V", orientation: 1, location: SYDNEY },
    });
  });

  it("records no location under stripLocation", async () => {
    const { images, media } = uploads({ stripLocation: true });
    const written = await run(
      media.create({ id: Option.none(), state: { visibility: "public" }, upload: upload("jpeg") }),
    );
    const head = await run(images.ops.get(written.id));
    expect(head["exif"]).toEqual({ cameraModel: "X100V", orientation: 1 });
  });

  it("a replace re-records the metadata and carries the editorial fields forward", async () => {
    const { images, media } = uploads();
    const created = await run(
      media.create({
        id: Option.none(),
        state: { visibility: "public", caption: "First" },
        upload: upload("one"),
      }),
    );
    const replaced = await run(
      media.replace({ id: created.id, upload: upload("two"), patch: { license: "CC-BY-4.0" } }),
    );
    const head = await run(images.ops.get(created.id));
    expect(head).toMatchObject({
      caption: "First",
      license: "CC-BY-4.0",
      contentHash: replaced.contentHash,
      mediaKind: "image",
    });
    expect(replaced.contentHash).toBe(await run(sha256Hex(bytesOf("two"))));
  });

  it("an extractor failure writes nothing", async () => {
    const { leaf } = setup();
    const images = leaf("images");
    const media = defineMediaUploads({
      files: defineFileWrites({
        leaf: images.ops,
        blobs: makeInMemoryBlobStore(),
        transact: (effect) => effect,
      }),
      extractor: { extract: () => Effect.fail({ _tag: "Unparseable" as const }) },
    });
    expect(
      await tagOf(media.create({ id: Option.none(), state: {}, upload: upload("x") })),
    ).toEqual(Option.some("Unparseable"));
    expect(images.chain.rows()).toEqual([]);
  });
});

// ── Renditions ────────────────────────────────────────────────────────

describe("renditionWidth", () => {
  const widths = [320, 640, 1280] as const;
  it.each([
    { requested: 1, bucket: 320 },
    { requested: 320, bucket: 320 },
    { requested: 321, bucket: 640 },
    { requested: 1280, bucket: 1280 },
    { requested: 5000, bucket: 1280 },
    { requested: 0, bucket: 320 },
    { requested: -40, bucket: 320 },
    { requested: Number.NaN, bucket: 320 },
    { requested: Number.POSITIVE_INFINITY, bucket: 1280 },
  ])("$requested → $bucket", ({ requested, bucket }) => {
    expect(renditionWidth(widths, requested)).toBe(bucket);
  });
});

describe("renditionFormat", () => {
  const formats = ["image/avif", "image/webp", "image/jpeg"] as const;
  it.each([
    { accept: undefined, format: "image/avif" },
    { accept: "  ", format: "image/avif" },
    { accept: "image/avif,image/webp,*/*", format: "image/avif" },
    { accept: "image/webp,image/*;q=0.8", format: "image/webp" },
    { accept: "image/avif;q=0.5,image/webp;q=0.9", format: "image/webp" },
    { accept: "image/*", format: "image/avif" },
    { accept: "*/*", format: "image/avif" },
    { accept: "image/avif;q=0,image/*", format: "image/webp" },
    { accept: "text/html", format: "image/jpeg" },
    { accept: "IMAGE/WEBP", format: "image/webp" },
    { accept: "image/webp;q=2,image/jpeg", format: "image/jpeg" },
    { accept: "garbage,;q=1", format: "image/jpeg" },
  ])("$accept → $format", ({ accept, format }) => {
    expect(renditionFormat(formats, accept)).toBe(format);
  });
});

const renditions = () => {
  const { leaf, as } = setup();
  const images = leaf("images");
  const blobs = makeInMemoryBlobStore();
  const files = defineFileWrites({ leaf: images.ops, blobs, transact: (effect) => effect });
  const references = makeInMemoryMediaReferences();
  const rendered: Array<string> = [];
  const ops = defineRenditions({
    policy: { widths: [320, 640, 1280], formats: ["image/webp", "image/jpeg"] },
    references,
    leaves: [
      {
        ops: images.ops,
        fileOf: (row: LeafRow) => {
          const { contentHash, bytesPending } = row;
          return P.isString(contentHash)
            ? Option.some({ contentHash, bytesPending: bytesPending !== false })
            : Option.none();
        },
      },
    ],
    transform: {
      render: ({ contentHash, width, format }) =>
        Effect.sync(() => {
          const key = `${contentHash.slice(0, 8)}@${width}.${format}`;
          rendered.push(key);
          return key;
        }),
    },
  });
  /** An image node at `visibility`, its bytes referenced; its id and hash. */
  const image = async (text: string, visibility: string) => {
    const written = await run(
      as(owner, files.create({ id: Option.none(), state: { visibility }, upload: upload(text) })),
    );
    references.add(written.contentHash, { type: "images", id: written.id });
    return written;
  };
  const serve = (who: Viewer, contentHash: string) =>
    as(who, ops.serve({ contentHash, width: 500, accept: "image/webp,*/*" }));
  return { images, blobs, files, references, rendered, ops, image, serve, as };
};

describe("defineRenditions", () => {
  it("serves a public image's rendition at the bucket and negotiated format, to anyone", async () => {
    const { image, serve, rendered } = renditions();
    const { contentHash } = await image("public", "public");
    expect(await run(serve(anonymous, contentHash))).toEqual({
      width: 640,
      format: "image/webp",
      rendition: `${contentHash.slice(0, 8)}@640.image/webp`,
    });
    expect(rendered).toHaveLength(1);
  });

  it.each([
    { label: "the owner", who: owner, served: true },
    { label: "the view-private rung", who: rung, served: true },
    { label: "a stranger", who: stranger, served: false },
    { label: "anonymous", who: anonymous, served: false },
  ])("a private image: $label → served $served", async ({ who, served }) => {
    const { image, serve } = renditions();
    const { contentHash } = await image("private", "private");
    expect(await tagOf(serve(who, contentHash))).toEqual(
      served ? Option.none() : Option.some("RenditionNotFound"),
    );
  });

  it("a tombstoned image's bytes answer not-found below the view-deleted rung", async () => {
    const { image, serve, images, as } = renditions();
    const { id, contentHash } = await image("gone", "public");
    await run(as(owner, images.ops.delete(id)));
    expect(await tagOf(serve(anonymous, contentHash))).toEqual(Option.some("RenditionNotFound"));
    expect(await tagOf(serve(owner, contentHash))).toEqual(Option.some("RenditionNotFound"));
  });

  it("unreferenced bytes answer not-found even when the store holds them", async () => {
    const { image, serve, references } = renditions();
    const { id, contentHash } = await image("orphan", "public");
    references.removeNode({ type: "images", id });
    expect(await tagOf(serve(owner, contentHash))).toEqual(Option.some("RenditionNotFound"));
  });

  it("bytes only a hidden node references answer not-found; a readable reference opens them", async () => {
    const { image, serve, files, references, as } = renditions();
    const hidden = await image("shared", "private");
    expect(await tagOf(serve(stranger, hidden.contentHash))).toEqual(
      Option.some("RenditionNotFound"),
    );
    const open = await run(
      as(
        owner,
        files.create({
          id: Option.none(),
          state: { visibility: "public" },
          upload: upload("shared"),
        }),
      ),
    );
    references.add(open.contentHash, { type: "images", id: open.id });
    expect(open.contentHash).toBe(hidden.contentHash);
    expect(await tagOf(serve(stranger, hidden.contentHash))).toEqual(Option.none());
  });

  it("a node whose readable version points at other bytes doesn't open these", async () => {
    const { image, serve, files, as } = renditions();
    const first = await image("v1", "public");
    // The reference index still lists the node against its old bytes.
    await run(as(owner, files.replace({ id: first.id, upload: upload("v2") })));
    expect(await tagOf(serve(anonymous, first.contentHash))).toEqual(
      Option.some("RenditionNotFound"),
    );
  });

  it("pending bytes answer not-found", async () => {
    const { blobs, files, references, serve, as } = renditions();
    blobs.failNextPut();
    const written = await run(
      as(
        owner,
        files.create({ id: Option.none(), state: { visibility: "public" }, upload: upload("p") }),
      ),
    );
    expect(written.bytesPending).toBe(true);
    references.add(written.contentHash, { type: "images", id: written.id });
    expect(await tagOf(serve(owner, written.contentHash))).toEqual(
      Option.some("RenditionNotFound"),
    );
  });

  it("a ref to an undeclared leaf never opens the gate", async () => {
    const { serve, references, image } = renditions();
    const { contentHash } = await image("x", "private");
    references.add(contentHash, { type: "posts", id: "p-1" });
    expect(await tagOf(serve(stranger, contentHash))).toEqual(Option.some("RenditionNotFound"));
  });

  it("a malformed hash answers not-found and reads nothing", async () => {
    const { ops, rendered } = renditions();
    expect(await run(ops.readable("not-a-hash"))).toBe(false);
    expect(await tagOf(ops.serve({ contentHash: "../etc/passwd", width: 100 }))).toEqual(
      Option.some("RenditionNotFound"),
    );
    expect(rendered).toEqual([]);
  });

  it.each([
    { label: "an empty width list", policy: { widths: [], formats: ["image/jpeg"] } },
    { label: "descending widths", policy: { widths: [640, 320], formats: ["image/jpeg"] } },
    { label: "a repeated width", policy: { widths: [320, 320], formats: ["image/jpeg"] } },
    { label: "a fractional width", policy: { widths: [320.5], formats: ["image/jpeg"] } },
    { label: "a zero width", policy: { widths: [0, 320], formats: ["image/jpeg"] } },
    {
      label: "a repeated format",
      policy: { widths: [320], formats: ["image/jpeg", "image/jpeg"] },
    },
    { label: "an empty format", policy: { widths: [320], formats: [""] } },
  ])("throws MediaDeclarationError for $label", ({ policy }) => {
    expect(() =>
      defineRenditions({
        // SAFETY: the empty width list is the case under test; the declaration check must refuse it at runtime.
        policy: policy as never,
        references: makeInMemoryMediaReferences(),
        leaves: [],
        transform: { render: () => Effect.void },
      }),
    ).toThrow(MediaDeclarationError);
  });
});

// ── Albums ────────────────────────────────────────────────────────────

const albums = () => {
  const { leaf, as } = setup();
  const lists = leaf("albums", ["visibility"]);
  const images = leaf("images", ["visibility"]);
  const videos = leaf("videos", ["visibility"]);
  const posts = leaf("posts", ["visibility"]);
  const album = defineAlbum({
    type: "album-items",
    parent: lists.ops,
    media: [images.ops, videos.ops],
    store: makeInMemoryCollectionStore(),
  });
  // Node ids are unique across leaves (one node table); each in-memory chain
  // mints its own sequence, so the fixture names them.
  let next = 0;
  const create = (ops: typeof images.ops, visibility: string) =>
    run(
      as(
        owner,
        ops.create({ id: Option.some(`${ops.type}-${(next += 1)}`), state: { visibility } }),
      ),
    ).then(({ id }) => id);
  const listed = async (albumId: string, who: Viewer) =>
    Arr.map(
      (await run(as(who, album.list(albumId, { limit: 50, offset: 0 })))).rows,
      (row) => [row.memberId, row.resource.type] as const,
    );
  return { lists, images, videos, posts, album, create, listed, as };
};

describe("defineAlbum", () => {
  it("holds media items from every declared leaf, in order, tagged with their leaf", async () => {
    const { lists, images, videos, album, create, listed, as } = albums();
    const albumId = await create(lists.ops, "public");
    const photoId = await create(images.ops, "public");
    const clipId = await create(videos.ops, "public");
    await run(as(owner, album.append(albumId, clipId)));
    await run(as(owner, album.append(albumId, photoId)));
    expect(await listed(albumId, anonymous)).toEqual([
      [clipId, "videos"],
      [photoId, "images"],
    ]);
  });

  it("refuses a non-media node as one it can't find", async () => {
    const { lists, posts, album, create, as } = albums();
    const albumId = await create(lists.ops, "public");
    const postId = await create(posts.ops, "public");
    expect(await tagOf(as(owner, album.append(albumId, postId)))).toEqual(
      Option.some("NodeNotFound"),
    );
  });

  it("omits an item the viewer can't read", async () => {
    const { lists, images, album, create, listed, as } = albums();
    const albumId = await create(lists.ops, "public");
    const shown = await create(images.ops, "public");
    const hidden = await create(images.ops, "private");
    await run(as(owner, album.append(albumId, shown)));
    await run(as(owner, album.append(albumId, hidden)));
    expect(await listed(albumId, owner)).toEqual([
      [shown, "images"],
      [hidden, "images"],
    ]);
    expect(await listed(albumId, stranger)).toEqual([[shown, "images"]]);
  });

  it("throws MediaDeclarationError for a leaf declared twice", () => {
    const { lists, images } = albums();
    expect(() =>
      defineAlbum({
        type: "dup",
        parent: lists.ops,
        media: [images.ops, images.ops],
        store: makeInMemoryCollectionStore(),
      }),
    ).toThrow(MediaDeclarationError);
  });
});
