/**
 * The reference resource cache: compare-on-set over a
 * versioned KV (a late write-through below a newer version or an eviction
 * never re-caches), serveability checked on both the write and
 * the read (`CACHE-AUTH-005`), decode-or-evict, the TTL backstop, a KV
 * failure read as a miss, and the cache driving `subtypeHandlers`'
 * write-through.
 *
 * @module tests/cache
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { makeResourceCache, type VersionedKv } from "../src/Cache.ts";
import { defineSubtype, ownedAccess, subtypeHandlers, type LeafRow } from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryVersionedKv,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, NOW, textOf } from "./fixtures.ts";

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
  const base = {
    kv: options.kv ?? kv,
    schema: Post,
    serveable: (resource: Post) => serveable(resource),
    prefix: "posts:v1:",
    ttlSeconds: options.ttlSeconds ?? 60,
  };
  const cache = makeResourceCache(
    options.tombstoneTtlSeconds === undefined
      ? base
      : { ...base, tombstoneTtlSeconds: options.tombstoneTtlSeconds },
  );
  return {
    kv,
    cache,
    setPolicy: (policy: (resource: Post) => boolean) => {
      serveable = policy;
    },
  };
};

describe("makeResourceCache — compare-on-set", () => {
  it.effect("caches a serveable resource and serves it back", () =>
    Effect.gen(function* () {
      const { cache } = setup();
      yield* cache.set("p-1", post("public"), 1n);
      expect(yield* cache.get("p-1")).toEqual(Option.some(post("public")));
    }),
  );

  it.effect("ignores a set below the version it holds, so a late write-through never wins", () =>
    Effect.gen(function* () {
      const { cache } = setup();
      yield* cache.set("p-1", post("public", "new"), 2n);
      yield* cache.set("p-1", post("public", "old"), 1n);
      expect(yield* cache.get("p-1")).toEqual(Option.some(post("public", "new")));
    }),
  );

  it.effect("an eviction raises the version: a set below it can't re-cache", () =>
    Effect.gen(function* () {
      const { cache, kv } = setup();
      yield* cache.set("p-1", post("public"), 1n);
      yield* cache.delete("p-1", 3n);
      yield* cache.set("p-1", post("public", "stale"), 2n);
      expect(yield* cache.get("p-1")).toEqual(Option.none());
      // The stored rank: 2·version + 1 for a tombstone.
      expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => entry.version)).toEqual(
        Option.some(7n),
      );
      // A write after the evicted version caches again.
      yield* cache.set("p-1", post("public", "fresh"), 4n);
      expect(yield* cache.get("p-1")).toEqual(Option.some(post("public", "fresh")));
    }),
  );

  it.effect(
    "an eviction wins a tie: a fill that read the row at the evicted version can't re-cache it",
    () =>
      Effect.gen(function* () {
        const { cache } = setup();
        // A read-through loads the row at version 5, then the row is unpublished
        // at the same version (publication appends no version) before the fill lands.
        yield* cache.delete("p-1", 5n);
        yield* cache.set("p-1", post("public", "pre-unpublish"), 5n);
        expect(yield* cache.get("p-1")).toEqual(Option.none());
        // A value at the same version doesn't outrank another value: a re-fill replaces it.
        yield* cache.set("p-1", post("public", "a"), 6n);
        yield* cache.set("p-1", post("public", "b"), 6n);
        expect(yield* cache.get("p-1")).toEqual(Option.some(post("public", "b")));
      }),
  );
});

describe("makeResourceCache — serveability on both sides (CACHE-AUTH-005)", () => {
  it.effect("refuses and evicts a resource the policy doesn't serve", () =>
    Effect.gen(function* () {
      const { cache, kv } = setup();
      yield* cache.set("p-1", post("public"), 1n);
      yield* cache.set("p-1", post("private"), 2n);
      expect(yield* cache.get("p-1")).toEqual(Option.none());
      expect(Option.flatMap(kv.peek("posts:v1:p-1"), (entry) => entry.value)).toEqual(
        Option.none(),
      );
    }),
  );

  it.effect("re-checks on read: a policy change never serves a stale cached row", () =>
    Effect.gen(function* () {
      const { cache, kv, setPolicy } = setup();
      yield* cache.set("p-1", post("public"), 1n);
      setPolicy(() => false);
      expect(yield* cache.get("p-1")).toEqual(Option.none());
      // And the entry is evicted at its version.
      expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => Option.isNone(entry.value))).toEqual(
        Option.some(true),
      );
    }),
  );
});

describe("makeResourceCache — decode, TTL and failures", () => {
  it.effect("evicts a value that no longer decodes, and reads it as a miss", () =>
    Effect.gen(function* () {
      const { cache, kv } = setup();
      kv.poke("posts:v1:p-1", { version: 8n, value: Option.some({ id: "p-1" }) });
      expect(yield* cache.get("p-1")).toEqual(Option.none());
      expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => [entry.version, entry.value])).toEqual(
        Option.some([9n, Option.none()]),
      );
    }),
  );

  it.effect("expires an entry past its TTL", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const { cache } = setup({ ttlSeconds: 10 });
        yield* cache.set("p-1", post("public"), 1n);
        const fresh = yield* cache.get("p-1");
        yield* TestClock.adjust("11 seconds");
        const expired = yield* cache.get("p-1");
        return [fresh, expired] as const;
      });
      expect(result).toEqual([Option.some(post("public")), Option.none()]);
    }),
  );

  it.effect("keeps a tombstone past the value TTL, so a late stale write is still refused", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
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
      });
      expect(result).toEqual([Option.none(), true, Option.some(post("public", "after"))]);
    }),
  );

  it.effect("defaults the tombstone TTL to a day, and never below the value TTL", () =>
    Effect.gen(function* () {
      const at = (ttlSeconds: number, wait: Duration.Input, tombstoneTtlSeconds?: number) =>
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
        });
      expect(yield* at(10, "23 hours")).toBe(false);
      expect(yield* at(10, "25 hours")).toBe(true);
      // A tombstone TTL below the value TTL is raised to it.
      expect(yield* at(100, "50 seconds", 5)).toBe(false);
    }),
  );

  it.effect("never fails: a KV failure reads as a miss and skips the write", () =>
    Effect.gen(function* () {
      const broken: VersionedKv<string, never> = {
        get: () => Effect.fail("kv down"),
        putIfNotBehind: () => Effect.fail("kv down"),
      };
      const { cache } = setup({ kv: broken });
      yield* cache.set("p-1", post("public"), 1n);
      yield* cache.delete("p-1", 2n);
      expect(yield* cache.get("p-1")).toEqual(Option.none());
    }),
  );
});

describe("makeResourceCache — locale keys", () => {
  const localeKey = (locale: string) => `posts:v1:p-1\u001f${locale}`;

  it.effect(
    "keeps each locale's entry apart, and serves none to a reader of another locale or of no locale",
    () =>
      Effect.gen(function* () {
        const { cache } = setup();
        yield* cache.set("p-1", post("public", "hello"), 1n, "en");
        yield* cache.set("p-1", post("public", "bonjour"), 1n, "fr");
        expect(yield* cache.get("p-1", "en")).toEqual(Option.some(post("public", "hello")));
        expect(yield* cache.get("p-1", "fr")).toEqual(Option.some(post("public", "bonjour")));
        expect(yield* cache.get("p-1", "de")).toEqual(Option.none());
        // The id's own key holds only the generation: no value for an unlocalised reader.
        expect(yield* cache.get("p-1")).toEqual(Option.none());
      }),
  );

  it.effect(
    "an eviction wins a tie in every locale: a fill at the evicted version can't re-cache",
    () =>
      Effect.gen(function* () {
        const { cache, kv } = setup();
        yield* cache.set("p-1", post("public", "hello"), 5n, "en");
        yield* cache.delete("p-1", 5n);
        yield* cache.set("p-1", post("public", "pre-unpublish"), 5n, "fr");
        expect(yield* cache.get("p-1", "en")).toEqual(Option.none());
        expect(yield* cache.get("p-1", "fr")).toEqual(Option.none());
        // One conditional write evicted both: the generation's tombstone rank, and no fr entry.
        expect(Option.map(kv.peek("posts:v1:p-1"), (entry) => entry.version)).toEqual(
          Option.some(11n),
        );
        expect(kv.peek(localeKey("fr"))).toEqual(Option.none());
      }),
  );

  it.effect("a locale entry written behind a newer generation is never served", () =>
    Effect.gen(function* () {
      const { cache, kv } = setup();
      yield* cache.set("p-1", post("public", "hello"), 1n, "en");
      // Another writer raised the id to version 2 (in French) between this fill's
      // generation write and its entry write: the entry at version 1 stays stored, unserved.
      yield* cache.set("p-1", post("public", "bonjour"), 2n, "fr");
      expect(Option.map(kv.peek(localeKey("en")), (entry) => entry.version)).toEqual(
        Option.some(2n),
      );
      expect(yield* cache.get("p-1", "en")).toEqual(Option.none());
      expect(yield* cache.get("p-1", "fr")).toEqual(Option.some(post("public", "bonjour")));
    }),
  );

  it.effect(
    "refuses a locale entry the policy doesn't serve, re-checks it on read, and evicts one that no longer decodes",
    () =>
      Effect.gen(function* () {
        const { cache, kv, setPolicy } = setup();
        yield* cache.set("p-1", post("private"), 1n, "en");
        expect(yield* cache.get("p-1", "en")).toEqual(Option.none());
        yield* cache.set("p-1", post("public"), 2n, "en");
        setPolicy(() => false);
        expect(yield* cache.get("p-1", "en")).toEqual(Option.none());
        expect(
          Option.map(kv.peek(localeKey("en")), (entry) => [entry.version, entry.value]),
        ).toEqual(Option.some([5n, Option.none()]));
        setPolicy((resource) => resource.visibility === "public");
        yield* cache.set("p-1", post("public"), 3n, "fr");
        kv.poke(localeKey("fr"), { version: 6n, value: Option.some({ id: "p-1" }) });
        expect(yield* cache.get("p-1", "fr")).toEqual(Option.none());
        expect(Option.map(kv.peek(localeKey("fr")), (entry) => entry.version)).toEqual(
          Option.some(7n),
        );
      }),
  );

  it.effect("never fails: a KV failure reads as a miss and writes no locale entry", () =>
    Effect.gen(function* () {
      const broken: VersionedKv<string, never> = {
        get: () => Effect.fail("kv down"),
        putIfNotBehind: () => Effect.fail("kv down"),
      };
      const { cache } = setup({ kv: broken });
      yield* cache.set("p-1", post("public"), 1n, "en");
      expect(yield* cache.get("p-1", "en")).toEqual(Option.none());
    }),
  );
});

describe("makeResourceCache as subtypeHandlers' cache", () => {
  it.effect(
    "writes each update through, evicts on a hiding write, and a replayed stale write-through changes nothing",
    () =>
      Effect.gen(function* () {
        const kv = makeInMemoryVersionedKv();
        const cache = makeResourceCache({
          kv,
          schema: Post,
          serveable: (resource) => resource.visibility === "public",
          prefix: "posts:v1:",
          ttlSeconds: 60,
        });
        const chain = makeInMemoryVersionChain("posts");
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
            title: textOf(row["title"]),
            visibility: textOf(row["visibility"]),
          }),
        });
        const handlers = subtypeHandlers(ops, {
          inTransaction: Effect.succeed(false),
          transact: (effect) => effect,
          cache: Option.some(cache),
        });
        const [id, afterEdit, afterHide, afterReplay] = yield* Effect.gen(function* () {
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
        });
        expect(afterEdit).toEqual(Option.some({ id, title: "two", visibility: "public" }));
        expect(afterReplay).toEqual(afterEdit);
        expect(afterHide).toEqual(Option.none());
      }),
  );
});
