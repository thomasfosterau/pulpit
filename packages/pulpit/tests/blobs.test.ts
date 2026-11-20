/**
 * File and media leaves.
 *
 * - The content hash and its key: SHA-256 over the bytes, keyed `sha256/<hash>`.
 * - The commit-ordered write: the version first (pending), the bytes after
 *   the commit, then the confirmation; equal bytes are stored once and
 *   never pending; a failed byte write leaves the node `bytesPending` with
 *   no URL, and `confirmBytes` finishes it; a confirmation never lands over
 *   a later version; `restoreVersion` restores the reference to old bytes,
 *   which are still there.
 * - The usage index's ends.
 *
 * @module tests/blobs
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import {
  blobKey,
  ContentHash,
  defineFileWrites,
  fileResourceFields,
  fileUrl,
  fileUsageEnds,
  sha256Hex,
  type FileWrite,
} from "../src/Blobs.ts";
import { defineSubtype, ownedAccess, type LeafRow } from "../src/Subtype.ts";
import {
  makeInMemoryBlobStore,
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { decodes, gardeneriaPolicy, member, NOW } from "./fixtures.ts";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("the content hash", () => {
  it.effect("is SHA-256 over the bytes, as 64 lowercase hex characters", () =>
    Effect.gen(function* () {
      expect(yield* sha256Hex(bytesOf("abc"))).toBe(ABC);
      expect(decodes(ContentHash, ABC)).toBe(true);
      expect(decodes(ContentHash, ABC.toUpperCase())).toBe(false);
    }),
  );

  it("keys the blob by the hash alone", () => {
    expect(blobKey(ABC)).toBe(`sha256/${ABC}`);
  });

  it("the file fields are on the resource only", () => {
    expect(R.keys(fileResourceFields)).toEqual([
      "contentHash",
      "byteSize",
      "mediaType",
      "filename",
      "bytesPending",
    ]);
  });
});

const uploadOf = (text: string) => ({
  bytes: bytesOf(text),
  mediaType: "text/plain",
  filename: "a.txt",
});

const images = () => {
  const chain = makeInMemoryVersionChain("images");
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["visibility", "contentHash", "byteSize", "mediaType", "filename", "bytesPending"],
    now: NOW,
  });
  const leaf = defineSubtype({
    type: "images",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: Effect.succeedSome(member),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
  });
  const blobs = makeInMemoryBlobStore();
  const log: Array<string> = [];
  const files = defineFileWrites({
    leaf,
    blobs: {
      ...blobs,
      put: (key, bytes, head) =>
        Effect.andThen(
          Effect.sync(() => log.push(`put ${key}`)),
          blobs.put(key, bytes, head),
        ),
    },
    transact: (effect) => Effect.tap(effect, () => Effect.sync(() => log.push("commit"))),
  });
  return { chain, leaf, blobs, files, log, upload: uploadOf };
};

describe("defineFileWrites — the commit-ordered write", () => {
  it.effect("appends the version pending, commits, then puts the bytes and confirms them", () =>
    Effect.gen(function* () {
      const { chain, blobs, files, log, upload } = images();
      const written = yield* files.create({
        id: Option.none(),
        state: { visibility: "public" },
        upload: upload("abc"),
      });
      expect(written).toEqual({
        id: written.id,
        version: 1n,
        contentHash: ABC,
        bytesPending: false,
      });
      expect(log).toEqual(["commit", `put sha256/${ABC}`, "commit"]);
      expect(chain.rows().map((row) => row.state)).toEqual([
        {
          visibility: "public",
          contentHash: ABC,
          byteSize: 3,
          mediaType: "text/plain",
          filename: "a.txt",
          bytesPending: true,
        },
        {
          visibility: "public",
          contentHash: ABC,
          byteSize: 3,
          mediaType: "text/plain",
          filename: "a.txt",
          bytesPending: false,
        },
      ]);
      expect(HashMap.has(blobs.objects(), blobKey(ABC))).toBe(true);
    }),
  );

  it.effect("equal bytes are stored once, and a second upload of them is never pending", () =>
    Effect.gen(function* () {
      const { chain, files, log, upload } = images();
      yield* files.create({ id: Option.none(), state: {}, upload: upload("abc") });
      log.length = 0;
      const second = yield* files.create({ id: Option.none(), state: {}, upload: upload("abc") });
      expect(second.bytesPending).toBe(false);
      expect(log).toEqual(["commit"]);
      expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(false);
    }),
  );

  it.effect(
    "a failed byte write after the commit leaves the node pending, with no URL, until confirmed",
    () =>
      Effect.gen(function* () {
        const { chain, blobs, files, upload } = images();
        blobs.failNextPut();
        const written: FileWrite = yield* files.create({
          id: Option.none(),
          state: {},
          upload: upload("abc"),
        });
        expect(written).toMatchObject({ version: 0n, bytesPending: true });
        expect(chain.rows()).toHaveLength(1);
        const head = { contentHash: ABC, bytesPending: true };
        expect(fileUrl(head, blobs)).toEqual(Option.none());
        // Nothing is there yet: confirming writes nothing.
        expect(yield* files.confirmBytes({ id: written.id, version: 0n, contentHash: ABC })).toBe(
          true,
        );
        expect(chain.rows()).toHaveLength(1);
        // The bytes arrive (a retry, or a client's signed upload); now it confirms.
        yield* blobs.put(blobKey(ABC), bytesOf("abc"), { byteSize: 3, mediaType: "text/plain" });
        expect(yield* files.confirmBytes({ id: written.id, version: 0n, contentHash: ABC })).toBe(
          false,
        );
        expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(false);
        expect(fileUrl({ contentHash: ABC, bytesPending: false }, blobs)).toEqual(
          Option.some(`memory://sha256/${ABC}`),
        );
      }),
  );

  it.effect("a confirmation never lands over a later version", () =>
    Effect.gen(function* () {
      const { chain, blobs, files, upload } = images();
      blobs.failNextPut();
      const first = yield* files.create({ id: Option.none(), state: {}, upload: upload("abc") });
      blobs.failNextPut();
      yield* files.replace({ id: first.id, upload: upload("xyz") });
      yield* blobs.put(blobKey(ABC), bytesOf("abc"), { byteSize: 3, mediaType: "text/plain" });
      const exit = yield* Effect.exit(
        files.confirmBytes({ id: first.id, version: first.version, contentHash: ABC }),
      );
      expect(exit._tag).toBe("Failure");
      expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(true);
    }),
  );

  it.effect(
    "replace is a new version under a new hash; restoreVersion restores the old bytes' reference",
    () =>
      Effect.gen(function* () {
        const { chain, blobs, leaf, files, upload } = images();
        const first = yield* files.create({ id: Option.none(), state: {}, upload: upload("abc") });
        const second = yield* files.replace({ id: first.id, upload: upload("xyz") });
        expect(second.contentHash).not.toBe(ABC);
        yield* leaf.restoreVersion(first.id, first.version);
        expect(chain.rows().at(-1)?.state).toMatchObject({ contentHash: ABC, bytesPending: false });
        // Both byte sets are still there: nothing garbage-collects them.
        expect(HashMap.size(blobs.objects())).toBe(2);
        expect(yield* blobs.get(blobKey(ABC))).toEqual(Option.some(bytesOf("abc")));
      }),
  );

  it.effect("replace honours the expected version", () =>
    Effect.gen(function* () {
      const { files, upload } = images();
      const first = yield* files.create({ id: Option.none(), state: {}, upload: upload("abc") });
      const exit = yield* Effect.exit(
        files.replace({ id: first.id, upload: upload("xyz"), expectedVersion: 0n }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("fileUsageEnds — the usage index as an edge family", () => {
  it("names the user and file ends' columns", () => {
    const { leaf } = images();
    const nodes = { columns: HashSet.make("id", "action"), get: () => Effect.succeedNone };
    const ends = fileUsageEnds({
      user: { type: "posts", access: ownedAccess(), nodes },
      file: { type: "images", access: leaf.access, nodes },
    });
    expect(ends["user"]?.column).toBe("userId");
    expect(ends["file"]?.column).toBe("fileId");
  });
});
