/**
 * File and media leaves (pulpit#55).
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

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import {
  blobKey,
  ContentHash,
  defineFileWrites,
  fileResourceFields,
  fileUrl,
  fileUsageEnds,
  sha256Hex,
  type FileWrite,
} from "../src/blobs.ts";
import { defineSubtype, ownedAccess, type LeafRow } from "../src/subtype.ts";
import {
  makeInMemoryBlobStore,
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { decodes, gardeneriaPolicy, member, NOW } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const bytesOf = (text: string) => new TextEncoder().encode(text);
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("the content hash", () => {
  it("is SHA-256 over the bytes, as 64 lowercase hex characters", async () => {
    expect(await run(sha256Hex(bytesOf("abc")))).toBe(ABC);
    expect(decodes(ContentHash, ABC)).toBe(true);
    expect(decodes(ContentHash, ABC.toUpperCase())).toBe(false);
  });

  it("keys the blob by the hash alone", () => {
    expect(blobKey(ABC)).toBe(`sha256/${ABC}`);
  });

  it("the file fields are on the resource only", () => {
    expect(Record.keys(fileResourceFields)).toEqual([
      "contentHash",
      "byteSize",
      "mediaType",
      "filename",
      "bytesPending",
    ]);
  });
});

const images = () => {
  const chain = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["visibility", "contentHash", "byteSize", "mediaType", "filename", "bytesPending"],
    now: NOW,
  });
  const leaf = defineSubtype({
    type: "images",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: Effect.succeed(Option.some(member)),
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
  const upload = (text: string) => ({
    bytes: bytesOf(text),
    mediaType: "text/plain",
    filename: "a.txt",
  });
  return { chain, leaf, blobs, files, log, upload };
};

describe("defineFileWrites — the commit-ordered write", () => {
  it("appends the version pending, commits, then puts the bytes and confirms them", async () => {
    const { chain, blobs, files, log, upload } = images();
    const written = await run(
      files.create({ id: Option.none(), state: { visibility: "public" }, upload: upload("abc") }),
    );
    expect(written).toEqual({ id: written.id, version: 1n, contentHash: ABC, bytesPending: false });
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
  });

  it("equal bytes are stored once, and a second upload of them is never pending", async () => {
    const { chain, files, log, upload } = images();
    await run(files.create({ id: Option.none(), state: {}, upload: upload("abc") }));
    log.length = 0;
    const second = await run(files.create({ id: Option.none(), state: {}, upload: upload("abc") }));
    expect(second.bytesPending).toBe(false);
    expect(log).toEqual(["commit"]);
    expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(false);
  });

  it("a failed byte write after the commit leaves the node pending, with no URL, until confirmed", async () => {
    const { chain, blobs, files, upload } = images();
    blobs.failNextPut();
    const written: FileWrite = await run(
      files.create({ id: Option.none(), state: {}, upload: upload("abc") }),
    );
    expect(written).toMatchObject({ version: 0n, bytesPending: true });
    expect(chain.rows()).toHaveLength(1);
    const head = { contentHash: ABC, bytesPending: true };
    expect(fileUrl(head, blobs)).toEqual(Option.none());
    // Nothing is there yet: confirming writes nothing.
    expect(await run(files.confirmBytes({ id: written.id, version: 0n, contentHash: ABC }))).toBe(
      true,
    );
    expect(chain.rows()).toHaveLength(1);
    // The bytes arrive (a retry, or a client's signed upload); now it confirms.
    await run(blobs.put(blobKey(ABC), bytesOf("abc"), { byteSize: 3, mediaType: "text/plain" }));
    expect(await run(files.confirmBytes({ id: written.id, version: 0n, contentHash: ABC }))).toBe(
      false,
    );
    expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(false);
    expect(fileUrl({ contentHash: ABC, bytesPending: false }, blobs)).toEqual(
      Option.some(`memory://sha256/${ABC}`),
    );
  });

  it("a confirmation never lands over a later version", async () => {
    const { chain, blobs, files, upload } = images();
    blobs.failNextPut();
    const first = await run(files.create({ id: Option.none(), state: {}, upload: upload("abc") }));
    blobs.failNextPut();
    await run(files.replace({ id: first.id, upload: upload("xyz") }));
    await run(blobs.put(blobKey(ABC), bytesOf("abc"), { byteSize: 3, mediaType: "text/plain" }));
    const exit = await Effect.runPromiseExit(
      files.confirmBytes({ id: first.id, version: first.version, contentHash: ABC }),
    );
    expect(exit._tag).toBe("Failure");
    expect(chain.rows().at(-1)?.state["bytesPending"]).toBe(true);
  });

  it("replace is a new version under a new hash; restoreVersion restores the old bytes' reference", async () => {
    const { chain, blobs, leaf, files, upload } = images();
    const first = await run(files.create({ id: Option.none(), state: {}, upload: upload("abc") }));
    const second = await run(files.replace({ id: first.id, upload: upload("xyz") }));
    expect(second.contentHash).not.toBe(ABC);
    await run(leaf.restoreVersion(first.id, first.version));
    expect(chain.rows().at(-1)?.state).toMatchObject({ contentHash: ABC, bytesPending: false });
    // Both byte sets are still there: nothing garbage-collects them.
    expect(HashMap.size(blobs.objects())).toBe(2);
    expect(await run(blobs.get(blobKey(ABC)))).toEqual(Option.some(bytesOf("abc")));
  });

  it("replace honours the expected version", async () => {
    const { files, upload } = images();
    const first = await run(files.create({ id: Option.none(), state: {}, upload: upload("abc") }));
    const exit = await Effect.runPromiseExit(
      files.replace({ id: first.id, upload: upload("xyz"), expectedVersion: 0n }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("fileUsageEnds — the usage index as an edge family", () => {
  it("names the user and file ends' columns", () => {
    const { leaf } = images();
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- an endpoint view's column set is the native `ReadonlySet` `EndpointView.columns` names
    const nodes = { columns: new Set(["id", "action"]), get: () => Effect.succeedNone };
    const ends = fileUsageEnds({
      user: { type: "posts", access: ownedAccess(), nodes },
      file: { type: "images", access: leaf.access, nodes },
    });
    expect(ends["user"]?.column).toBe("userId");
    expect(ends["file"]?.column).toBe("fileId");
  });
});
