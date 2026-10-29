/**
 * The reference resource cache (pulpit#205): compare-on-set over a
 * versioned KV (a late write-through below a newer version or an eviction
 * never re-caches, pulpit#121), serveability checked on both the write and
 * the read (`CACHE-AUTH-005`), decode-or-evict, the TTL backstop, a KV
 * failure read as a miss, and the cache driving `subtypeHandlers`'
 * write-through.
 *
 * @module tests/cache
 */

import { describe, expect, it } from "vite-plus/test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { makeResourceCache, type VersionedKv } from "../src/cache.ts";
import { defineSubtype, ownedAccess, subtypeHandlers, type LeafRow } from "../src/subtype.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryVersionedKv,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, NOW } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const Post = Schema.Struct({ id: Schema.String, visibility: Schema.String, title: Schema.String });
type Post = typeof Post.Type;
const post = (visibility: string, title = "t"): Post => ({ id: "p-1", visibility, title });

const setup = (
  options: {
    readonly kv?: VersionedKv<string, never>;
    readonly ttlSeconds?: number;
    readonly tombstoneTtlSeconds?: number;
  } = {},
) => {
  const kv = makeInMemoryVersionedKv();
  let serveable = (resource: Post) => resource.visibility === "public";
  const cache = makeResourceCache({
    kv: options.kv ?? kv,
    schema: Post,
    serveable: (resource) => serveable(resource),
    prefix: "posts:v1:",
    ttlSeconds: options.ttlSeconds ?? 60,
    tombstoneTtlSeconds: options.tombstoneTtlSeconds,
  });
  return {
    kv,
    cache,
    setPolicy: (policy: (resource: Post) => boolean) => {
      serveable = policy;
    },
  };
};

describe("makeResourceCache — compare-on-set", () => {
  it("caches a serveable resource and serves it back", async () => {
    const { cache } = setup();
    await run(cache.set("p-1", post("public"), 1n));
    expect(await run(cache.get("p-1"))).toEqual(Option.some(post("public")));
  });

  it("ignores a set below the version it holds, so a late write-through never wins", async () => {
    const { cache } = setup();
    await run(cache.set("p-1", post("public", "new"), 2n));
    await run(cache.set("p-1", post("public", "old"), 1n));
    expect(await run(cache.get("p-1"))).toEqual(Option.some(post("public", "new")));
  });

  it("an eviction raises the version: a set below it can't re-cache", async () => {
    const { cache, kv } = setup();
    await run(cache.set("p-1", post("public"), 1n));
    await run(cache.delete("p-1", 3n));
    await run(cache.set("p-1", post("public", "stale"), 2n));
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
    // The stored rank: 2·version + 1 for a tombstone.
    expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => entry.version)).toEqual(Option.some(7n));
    // A write after the evicted version caches again.
    await run(cache.set("p-1", post("public", "fresh"), 4n));
    expect(await run(cache.get("p-1"))).toEqual(Option.some(post("public", "fresh")));
  });

  it("an eviction wins a tie: a fill that read the row at the evicted version can't re-cache it", async () => {
    const { cache } = setup();
    // A read-through loads the row at version 5, then the row is unpublished
    // at the same version (publication appends no version) before the fill lands.
    await run(cache.delete("p-1", 5n));
    await run(cache.set("p-1", post("public", "pre-unpublish"), 5n));
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
    // A value at the same version doesn't outrank another value: a re-fill replaces it.
    await run(cache.set("p-1", post("public", "a"), 6n));
    await run(cache.set("p-1", post("public", "b"), 6n));
    expect(await run(cache.get("p-1"))).toEqual(Option.some(post("public", "b")));
  });
});

describe("makeResourceCache — serveability on both sides (CACHE-AUTH-005)", () => {
  it("refuses and evicts a resource the policy doesn't serve", async () => {
    const { cache, kv } = setup();
    await run(cache.set("p-1", post("public"), 1n));
    await run(cache.set("p-1", post("private"), 2n));
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
    expect(Option.flatMap(kv.peek("posts:v1:p-1"), (entry) => entry.value)).toEqual(Option.none());
  });

  it("re-checks on read: a policy change never serves a stale cached row", async () => {
    const { cache, kv, setPolicy } = setup();
    await run(cache.set("p-1", post("public"), 1n));
    setPolicy(() => false);
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
    // And the entry is evicted at its version.
    expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => Option.isNone(entry.value))).toEqual(
      Option.some(true),
    );
  });
});

describe("makeResourceCache — decode, TTL and failures", () => {
  it("evicts a value that no longer decodes, and reads it as a miss", async () => {
    const { cache, kv } = setup();
    kv.poke("posts:v1:p-1", { version: 8n, value: Option.some({ id: "p-1" }) });
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
    expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => [entry.version, entry.value])).toEqual(
      Option.some([9n, Option.none()]),
    );
  });

  it("expires an entry past its TTL", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { cache } = setup({ ttlSeconds: 10 });
        yield* cache.set("p-1", post("public"), 1n);
        const fresh = yield* cache.get("p-1");
        yield* TestClock.adjust("11 seconds");
        const expired = yield* cache.get("p-1");
        return [fresh, expired] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toEqual([Option.some(post("public")), Option.none()]);
  });

  it("keeps a tombstone past the value TTL, so a late stale write is still refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { cache, kv } = setup({ ttlSeconds: 10, tombstoneTtlSeconds: 100 });
        yield* cache.set("p-1", post("public"), 1n);
        yield* cache.delete("p-1", 2n);
        yield* TestClock.adjust("50 seconds");
        // A write-through that read version 1 lands long after the value TTL.
        yield* cache.set("p-1", post("public", "stale"), 1n);
        const late = yield* cache.get("p-1");
        const held = Option.isSome(kv.peek("posts:v1:p-1"));
        yield* TestClock.adjust("51 seconds");
        // Past the tombstone TTL the bound no longer holds: that is the documented limit.
        yield* cache.set("p-1", post("public", "after"), 1n);
        const after = yield* cache.get("p-1");
        return [late, held, after] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toEqual([Option.none(), true, Option.some(post("public", "after"))]);
  });

  it("defaults the tombstone TTL to a day, and never below the value TTL", async () => {
    const at = (ttlSeconds: number, wait: Duration.Input, tombstoneTtlSeconds?: number) =>
      run(
        Effect.gen(function* () {
          const { cache } = setup(
            tombstoneTtlSeconds === undefined
              ? { ttlSeconds }
              : { ttlSeconds, tombstoneTtlSeconds },
          );
          yield* cache.delete("p-1", 2n);
          yield* TestClock.adjust(wait);
          yield* cache.set("p-1", post("public"), 1n);
          return Option.isSome(yield* cache.get("p-1"));
        }).pipe(Effect.provide(TestClock.layer())),
      );
    expect(await at(10, "23 hours")).toBe(false);
    expect(await at(10, "25 hours")).toBe(true);
    // A tombstone TTL below the value TTL is raised to it.
    expect(await at(100, "50 seconds", 5)).toBe(false);
  });

  it("never fails: a KV failure reads as a miss and skips the write", async () => {
    const broken: VersionedKv<string, never> = {
      get: () => Effect.fail("kv down"),
      putIfNotBehind: () => Effect.fail("kv down"),
    };
    const { cache } = setup({ kv: broken });
    await run(cache.set("p-1", post("public"), 1n));
    await run(cache.delete("p-1", 2n));
    expect(await run(cache.get("p-1"))).toEqual(Option.none());
  });
});

describe("makeResourceCache as subtypeHandlers' cache", () => {
  it("writes each update through, evicts on a hiding write, and a replayed stale write-through changes nothing", async () => {
    const kv = makeInMemoryVersionedKv();
    const cache = makeResourceCache({
      kv,
      schema: Post,
      serveable: (resource) => resource.visibility === "public",
      prefix: "posts:v1:",
      ttlSeconds: 60,
    });
    const chain = makeInMemoryChainStore();
    const ops = defineSubtype({
      type: "posts",
      access: ownedAccess(),
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns: ["title", "visibility"], now: NOW }),
      viewer: Effect.succeedSome(member),
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow): Post => ({
        id: row.id,
        title: String(row["title"]),
        visibility: String(row["visibility"]),
      }),
    });
    const handlers = subtypeHandlers(ops, {
      inTransaction: Effect.succeed(false),
      transact: (effect) => effect,
      cache: Option.some(cache),
    });
    const [id, afterEdit, afterHide, afterReplay] = await run(
      Effect.gen(function* () {
        const write = yield* handlers.create({
          id: Option.none(),
          state: { title: "one", visibility: "public" },
        });
        yield* handlers.update({ id: write.id, patch: { title: "two" } });
        const edited = yield* cache.get(write.id);
        // A late write-through of version 0 arrives after version 1: ignored.
        yield* cache.set(write.id, { id: write.id, title: "one", visibility: "public" }, 0n);
        const replayed = yield* cache.get(write.id);
        yield* handlers.update({ id: write.id, patch: { visibility: "private" } });
        const hidden = yield* cache.get(write.id);
        return [write.id, edited, hidden, replayed] as const;
      }),
    );
    expect(afterEdit).toEqual(Option.some({ id, title: "two", visibility: "public" }));
    expect(afterReplay).toEqual(afterEdit);
    expect(afterHide).toEqual(Option.none());
  });
});
