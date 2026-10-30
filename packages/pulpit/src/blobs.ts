/**
 * **File and media leaves** — the blob-store seam a file leaf's bytes live
 * behind, the field spread a file version carries, the commit-ordered byte
 * write, and the usage index as an edge family.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/media.ts`
 * (bytes written only after the transaction commits) and `apps/api/src/files.ts`
 * (the content hash), and website's `apps/api/src/operations/file-chain.ts`.
 *
 * ## The model (owner decisions on pulpit#55)
 *
 * - **Bytes are keyed by their content hash** ({@link blobKey}), so a
 *   version's bytes are immutable: new bytes are a new hash and a new
 *   version, and `restoreVersion` restores the reference to the old bytes,
 *   which are still there. Equal bytes are stored once.
 * - **Bytes are written after the chain commits.** {@link defineFileWrites}
 *   appends the version first, marked `bytesPending: true` unless the store
 *   already holds the bytes, puts the bytes once the transaction has
 *   returned, and then appends `bytesPending: false`. A byte write that
 *   fails leaves the node visibly incomplete: `bytesPending` stays `true`
 *   and {@link fileUrl} gives no URL, so no reader is ever pointed at
 *   missing bytes. `confirmBytes` finishes it later, once the bytes are
 *   there.
 * - **Nothing garbage-collects bytes.** They stay for as long as any
 *   version references them; purge (pulpit#58) is the only removal path,
 *   which is what {@link BlobStore.delete} is for.
 * - **"Where is this file used" is an edge family** ({@link fileUsageEnds}),
 *   so the endpoint-visibility gate (`EDGE-001`) applies: a "used by" list
 *   never reveals content the viewer can't see. Maintaining those edges is
 *   the referencing leaf's job (or an after hook's).
 *
 * The adapters (R2, S3), image transforms, EXIF extraction and video
 * streaming are the application's.
 *
 * @copyright Thomas Foster
 * @module pulpit/blobs
 * @since 0.1.0
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { EdgeEnd, EdgeEnds } from "./edges.ts";
import type { Forbidden, SubtypeOps, Unauthorized, WriteRejected } from "./subtype.ts";
import type {
  ChainState,
  ChainWrite,
  NodeAlreadyExists,
  NodeNotFound,
  Precondition,
  StaleVersion,
  VersionConflict,
} from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * A file's content hash: the SHA-256 digest of its bytes as 64 lowercase
 * hexadecimal characters ({@link sha256Hex}).
 *
 * @since 0.1.0
 */
export const ContentHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    description: "a SHA-256 content hash as 64 lowercase hexadecimal characters",
  }),
);
/**
 * The {@link ContentHash} string.
 *
 * @since 0.1.0
 */
export type ContentHash = typeof ContentHash.Type;

/**
 * The SHA-256 content hash of `bytes`, through the platform's Web Crypto
 * (`globalThis.crypto.subtle`, in browsers, Node 22+ and Workers alike).
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { sha256Hex } from "@thomasfosterau/pulpit/blobs";
 *
 * strictEqual(
 *   await Effect.runPromise(sha256Hex(new TextEncoder().encode("abc"))),
 *   "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
 * );
 * ```
 *
 * @since 0.1.0
 */
export const sha256Hex = (bytes: Uint8Array): Effect.Effect<ContentHash> =>
  Effect.tryPromise(() => globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).pipe(
    // Web Crypto's SHA-256 over bytes has no failure a caller could act on.
    Effect.orDie,
    Effect.map((digest) =>
      Arr.map(Arr.fromIterable(new Uint8Array(digest)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

/**
 * The blob-store key for a content hash: `sha256/<hash>`. The key is
 * derived from the bytes alone, never from a node id, so a node's history
 * can point at every set of bytes it has ever had.
 *
 * @since 0.1.0
 */
export const blobKey = (hash: ContentHash): string => `sha256/${hash}`;

/**
 * What the blob store knows of one stored object.
 *
 * @since 0.1.0
 */
export interface BlobHead {
  readonly byteSize: number;
  readonly mediaType: string;
}

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The byte store an application supplies (R2, S3, a local directory). It
 * applies no policy and fails only with its `E`. Keys come from
 * {@link blobKey}; see the package README → Seams for the contract.
 *
 * @since 0.1.0
 */
export interface BlobStore<E, R> {
  /** Store `bytes` at `key`. Idempotent: the same key always holds the same bytes. */
  readonly put: (key: string, bytes: Uint8Array, head: BlobHead) => Effect.Effect<void, E, R>;
  /** The bytes at `key`, or none. */
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, E, R>;
  /** The object's size and media type, or none when nothing is stored at `key`. */
  readonly head: (key: string) => Effect.Effect<Option.Option<BlobHead>, E, R>;
  /** Remove the object at `key`. Purge's alone (pulpit#58): nothing else deletes bytes. */
  readonly delete: (key: string) => Effect.Effect<void, E, R>;
  /** The URL a reader fetches `key` from, when the store serves one. */
  readonly publicUrl: (key: string) => Option.Option<string>;
  /** A signed URL a client may upload `key`'s bytes to directly, when the store offers one. */
  readonly signedUploadUrl: Option.Option<
    (key: string, head: BlobHead) => Effect.Effect<string, E, R>
  >;
}

// ── The field spread ──────────────────────────────────────────────────

/**
 * The attributes every file version carries, all server-computed from the
 * upload and present on the resource only (`readOnlyAttribute`): the
 * `contentHash` its bytes are stored under, their `byteSize` and
 * `mediaType`, the original `filename`, and `bytesPending`, `true` while the
 * bytes are not yet confirmed in the blob store. Spread into a file leaf's
 * `Resource.make({ attributes })`.
 *
 * @since 0.1.0
 */
export const fileResourceFields = {
  contentHash: Resource.readOnlyAttribute(ContentHash),
  byteSize: Resource.readOnlyAttribute(Schema.Number),
  mediaType: Resource.readOnlyAttribute(Schema.String),
  filename: Resource.readOnlyAttribute(Schema.String),
  bytesPending: Resource.readOnlyAttribute(Schema.Boolean),
} as const;

/**
 * A file version's columns, as {@link defineFileWrites} writes them.
 *
 * @since 0.1.0
 */
export interface FileColumns {
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly filename: string;
  readonly bytesPending: boolean;
}

/**
 * The URL a file version's bytes are read from: none while `bytesPending`
 * (anything but an explicit `false`), and none when the store serves no
 * URL, so no reader is pointed at bytes that may not be there.
 *
 * @since 0.1.0
 */
export const fileUrl = <E, R>(
  file: { readonly contentHash: ContentHash; readonly bytesPending: boolean },
  blobs: Pick<BlobStore<E, R>, "publicUrl">,
): Option.Option<string> =>
  !file.bytesPending ? blobs.publicUrl(blobKey(file.contentHash)) : Option.none();

// ── The commit-ordered write ──────────────────────────────────────────

/**
 * An upload: the bytes and what the client said they are.
 *
 * @since 0.1.0
 */
export interface Upload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly filename: string;
}

/**
 * What a file write reports: the version it landed at, its content hash,
 * and whether its bytes are still pending (the post-commit byte write
 * failed, or its confirmation did).
 *
 * @since 0.1.0
 */
export interface FileWrite extends ChainWrite {
  readonly contentHash: ContentHash;
  readonly bytesPending: boolean;
}

type WriteFailure = Unauthorized | Forbidden | WriteRejected | VersionConflict;

/**
 * The operations {@link defineFileWrites} produces.
 *
 * @since 0.1.0
 */
export interface FileWriteOps<E, R> {
  /**
   * Create a file node from an upload, with the leaf's other columns in
   * `state`. Fails as the leaf's `create` does; a failure to store the
   * bytes after the commit does not fail it (the node is left
   * `bytesPending`).
   */
  readonly create: (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
    readonly upload: Upload;
  }) => Effect.Effect<FileWrite, WriteFailure | NodeAlreadyExists | E, R>;
  /**
   * Replace a file node's bytes with a new version. Fails as the leaf's
   * `update` does (`StaleVersion` against `expectedVersion`, `NodeNotFound`
   * for a missing or tombstoned node).
   */
  readonly replace: (
    input: { readonly id: string; readonly upload: Upload } & Precondition,
  ) => Effect.Effect<FileWrite, WriteFailure | NodeNotFound | StaleVersion | E, R>;
  /**
   * Finish a pending version (`version`, whose bytes `contentHash` names,
   * as a {@link FileWrite} reports them): when the store now holds those
   * bytes, append `bytesPending: false` over exactly that version and
   * report `false`; otherwise write nothing and report `true`. Gated as the
   * leaf's `update` is; `StaleVersion` when the node has moved past
   * `version` (its head names other bytes).
   */
  readonly confirmBytes: (input: {
    readonly id: string;
    readonly version: bigint;
    readonly contentHash: ContentHash;
  }) => Effect.Effect<boolean, WriteFailure | NodeNotFound | StaleVersion | E, R>;
}

/**
 * Bind a file leaf's commit-ordered writes: the version is appended (in
 * `transact`, the caller's write boundary) before any byte is written, and
 * the bytes go to the blob store only once it has returned. Each version
 * write goes through the leaf's own operations, so their gates,
 * preconditions and before hooks apply; the cache write-through and after
 * hooks are `subtypeHandlers`', which an application that caches the leaf
 * runs itself.
 *
 * @since 0.1.0
 */
export const defineFileWrites = <Resource, E, R>(definition: {
  readonly leaf: SubtypeOps<Resource, E, R>;
  readonly blobs: BlobStore<E, R>;
  readonly transact: <A, E2>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>;
}): FileWriteOps<E, R> => {
  const { leaf, blobs, transact } = definition;

  /** The upload's columns, pending unless the store already holds its bytes. */
  const columnsOf = (upload: Upload) =>
    Effect.gen(function* () {
      const contentHash = yield* sha256Hex(upload.bytes);
      const stored = yield* blobs.head(blobKey(contentHash));
      const columns: FileColumns = {
        contentHash,
        byteSize: upload.bytes.byteLength,
        mediaType: upload.mediaType,
        filename: upload.filename,
        bytesPending: Option.isNone(stored),
      };
      return columns;
    });

  /**
   * `bytesPending: false`, appended in its own transaction over exactly the
   * pending version: if another write has landed since, it names other
   * bytes, so the confirmation fails `StaleVersion` and confirms nothing.
   */
  const confirm = (id: string, pending: bigint) =>
    transact(leaf.update({ id, patch: { bytesPending: false }, expectedVersion: pending }));

  /**
   * After the commit: put the bytes and confirm them. A failure of either
   * leaves the node pending, never failing the write that committed.
   */
  const afterCommit = (written: ChainWrite, columns: FileColumns, upload: Upload) =>
    Effect.gen(function* () {
      if (!columns.bytesPending) {
        return { ...written, contentHash: columns.contentHash, bytesPending: false };
      }
      const confirmed = yield* Effect.exit(
        Effect.andThen(
          blobs.put(blobKey(columns.contentHash), upload.bytes, {
            byteSize: columns.byteSize,
            mediaType: columns.mediaType,
          }),
          confirm(written.id, written.version),
        ),
      );
      if (Exit.isFailure(confirmed)) {
        yield* Effect.logWarning(`${leaf.type} ${written.id}: bytes left pending`, confirmed.cause);
        return { ...written, contentHash: columns.contentHash, bytesPending: true };
      }
      return { ...confirmed.value, contentHash: columns.contentHash, bytesPending: false };
    });

  const create = Effect.fn(`${leaf.type}.files.create`)(function* (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
    readonly upload: Upload;
  }) {
    const columns = yield* columnsOf(input.upload);
    const written = yield* transact(
      leaf.create({ id: input.id, state: { ...input.state, ...columns } }),
    );
    return yield* afterCommit(written, columns, input.upload);
  });

  const replace = Effect.fn(`${leaf.type}.files.replace`)(function* (
    input: { readonly id: string; readonly upload: Upload } & Precondition,
  ) {
    const columns = yield* columnsOf(input.upload);
    const written = yield* transact(
      leaf.update({ id: input.id, patch: { ...columns }, expectedVersion: input.expectedVersion }),
    );
    return yield* afterCommit(written, columns, input.upload);
  });

  const confirmBytes = Effect.fn(`${leaf.type}.files.confirmBytes`)(function* (input: {
    readonly id: string;
    readonly version: bigint;
    readonly contentHash: ContentHash;
  }) {
    if (Option.isNone(yield* blobs.head(blobKey(input.contentHash)))) return true;
    yield* confirm(input.id, input.version);
    return false;
  });

  return { create, replace, confirmBytes };
};

// ── The usage index ───────────────────────────────────────────────────

/**
 * The ends of a file-usage edge family: `user` (the content node that uses
 * the file) and `file` (the file node), each declared with its own leaf's
 * access and view, for `./edges`' `defineEdgeOps`. The family's edge table
 * keys `(user_id, file_id)` uniquely, so a re-asserted use is a no-op under
 * `onConflict: "ignore"`. A "used by" list is then an edge list at the file
 * end, and `EDGE-001` hides every use whose content the viewer can't read.
 *
 * @since 0.1.0
 */
export const fileUsageEnds = <E, R>(ends: {
  readonly user: Omit<EdgeEnd<E, R>, "column">;
  readonly file: Omit<EdgeEnd<E, R>, "column">;
}): EdgeEnds<E, R> => ({
  user: { ...ends.user, column: "userId" },
  file: { ...ends.file, column: "fileId" },
});
