/**
 * **The reference resource cache** (pulpit#205) — `./subtype`'s
 * {@link ResourceCacheSeam}, with a read-through `get`, over a minimal
 * versioned key-value seam ({@link VersionedKv}).
 *
 * The behavioural spec is the four apps' own caches (website's, gardeneria's,
 * preferenceflow's and in-the-dark's `apps/api/src/cache.ts`), which this
 * replaces: one implementation of the contract the kernel already states.
 *
 * - **Compare-on-set** (pulpit#121). Every entry carries the version it
 *   speaks for, and the KV seam's one conditional write keeps the highest:
 *   a `set` or `delete` below the stored version changes nothing, and an
 *   eviction raises the version, so a racing writer's late write-through can
 *   never re-cache a resource older than one already replaced or evicted.
 * - **An eviction wins a tie.** A tombstone outranks a value at the same
 *   version: only a strictly newer write clears it, so a read-through that
 *   loaded the row before an unpublish at that version can't re-cache it.
 *   The cache stores a rank, `2·version` for a value and `2·version + 1` for
 *   a tombstone, as the entry's `version`, so the seam still compares one
 *   number.
 * - **Tombstones outlive values.** A tombstone is kept for
 *   `tombstoneTtlSeconds` (by default a day, and never less than the value
 *   TTL), which must exceed the longest a write can be in flight: a late
 *   write-through that arrives after its tombstone has expired is no longer
 *   ordered against it.
 * - **Serveability on both sides** (`CACHE-AUTH-005`). `set` refuses (and
 *   evicts) a resource the `serveable` policy refuses, and `get` checks it
 *   again, so a policy change can't serve a stale cached private row.
 * - **Decode or evict.** `get` decodes the stored value with the resource's
 *   schema; a value that no longer decodes (the schema moved) is evicted and
 *   read as a miss.
 * - **A TTL backstop.** Every write carries the configured TTL, so an entry
 *   no write ever evicted still expires.
 * - **Locale keys under one generation** (pulpit#271). A localised leaf's
 *   entry (a `set` or `get` that names a locale, pulpit#184) lives at its own
 *   `(id, locale)` key, and the id's own key holds the **generation**: the
 *   rank of the newest write the id has seen. A locale `set` raises the
 *   generation first, with the same conditional write, and writes its entry
 *   only if that succeeded; a locale entry is served only while its rank
 *   equals the generation. So a fill behind the id's version, in any locale,
 *   is a no-op, a newer version in one locale retires every other locale's
 *   entry, an eviction wins a tie in every locale, and `delete`, which raises
 *   the generation, evicts every locale with one conditional write. An id's
 *   unlocalised entry is the generation key's own value, exactly as before.
 * - **Never fails.** A KV failure reads as a miss and skips a write: the
 *   cache is an optimisation, and the store stays the source of truth.
 *
 * The KV seam is the application's (a Durable Object, Redis, a SQL table):
 * nothing here imports a platform. Workers KV alone has no conditional
 * write, so it can't fill {@link VersionedKv.putIfNotBehind}.
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#cache.
 *
 * @copyright Thomas Foster
 * @module pulpit/cache
 * @since 0.1.0
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ResourceCacheSeam } from "./subtype.ts";

// ── The KV seam ───────────────────────────────────────────────────────

/**
 * One stored entry: the rank it is ordered by, and the encoded resource, or
 * none for an eviction (a tombstone that keeps the rank). `makeResourceCache`
 * stores `2·version` for a value and `2·version + 1` for a tombstone, so a
 * tombstone outranks a value at the same node version.
 *
 * @since 0.1.0
 */
export interface KvEntry {
  readonly version: bigint;
  readonly value: Option.Option<Schema.Json>;
}

/**
 * The minimal versioned key-value store an application supplies. A store
 * seam: no policy, fails only with its `E`. See docs/seams.md.
 *
 * @since 0.1.0
 */
export interface VersionedKv<E, R> {
  /** The entry at `key`, or none (never written, or expired). */
  readonly get: (key: string) => Effect.Effect<Option.Option<KvEntry>, E, R>;
  /**
   * Write `entry` at `key` with a TTL of `ttlSeconds`, **in one atomic
   * step**, unless the stored entry's version is above `entry.version`;
   * whether it wrote. A store with no conditional write cannot fill this
   * seam.
   */
  readonly putIfNotBehind: (
    key: string,
    entry: KvEntry,
    ttlSeconds: number,
  ) => Effect.Effect<boolean, E, R>;
}

// ── The cache ─────────────────────────────────────────────────────────

/**
 * {@link makeResourceCache}'s configuration.
 *
 * @since 0.1.0
 */
export interface ResourceCacheOptions<Resource, E, R> {
  readonly kv: VersionedKv<E, R>;
  /** The resource's schema: its JSON encoding in the store, decoded on every read. */
  readonly schema: Schema.Codec<Resource, Schema.Json>;
  /** The `CACHE-AUTH-005` serveability policy (typically `./publication`'s `serveablePolicy`). */
  readonly serveable: (resource: Resource) => boolean;
  /** The key prefix, typically the leaf's type and a schema generation (`posts:v3:`). */
  readonly prefix: string;
  /** The TTL backstop every value write carries, in seconds (clamped to at least 1). */
  readonly ttlSeconds: number;
  /**
   * How long an eviction's tombstone is kept, in seconds: it must exceed the
   * longest a write-through or read-through fill can be in flight, since a
   * stale write that lands after its tombstone expired is no longer refused.
   * Defaults to a day ({@link DEFAULT_TOMBSTONE_TTL_SECONDS}), and is never
   * less than `ttlSeconds`.
   */
  readonly tombstoneTtlSeconds?: number;
}

/**
 * The default time an eviction's tombstone is kept: one day, far longer than
 * any request can be in flight.
 *
 * @since 0.1.0
 */
export const DEFAULT_TOMBSTONE_TTL_SECONDS = 86_400;

/**
 * A resource cache: the kernel's write-through seam plus the read-through
 * `get`.
 *
 * @since 0.1.0
 */
export interface ResourceCache<Resource, R> extends ResourceCacheSeam<Resource, R> {
  /**
   * The cached resource for `id`: none on a miss, an eviction, a value that
   * no longer decodes (evicted at its version) or one the policy no longer
   * serves (evicted likewise). On a localised leaf `locale` names the entry
   * (since 0.2.0, pulpit#271), served only while it speaks for the id's
   * newest version. Never fails.
   */
  readonly get: (id: string, locale?: string) => Effect.Effect<Option.Option<Resource>, never, R>;
}

/**
 * The reference {@link ResourceCacheSeam} over a {@link VersionedKv}.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import * as Schema from "effect/Schema";
 * import { makeResourceCache } from "@thomasfosterau/pulpit/cache";
 * import { makeInMemoryVersionedKv } from "@thomasfosterau/pulpit/testing";
 *
 * const Post = Schema.Struct({ id: Schema.String, visibility: Schema.String });
 * const cache = makeResourceCache({
 *   kv: makeInMemoryVersionedKv(),
 *   schema: Post,
 *   serveable: (post) => post.visibility === "public",
 *   prefix: "posts:v1:",
 *   ttlSeconds: 3600,
 * });
 * const program = Effect.gen(function* () {
 *   yield* cache.set("p-1", { id: "p-1", visibility: "public" }, 1n);
 *   yield* cache.set("p-1", { id: "p-1", visibility: "private" }, 0n); // behind: no-op
 *   return yield* cache.get("p-1");
 * });
 * deepStrictEqual(Effect.runSync(program), Option.some({ id: "p-1", visibility: "public" }));
 * ```
 *
 * @since 0.1.0
 */
export const makeResourceCache = <Resource, E, R>(
  options: ResourceCacheOptions<Resource, E, R>,
): ResourceCache<Resource, R> => {
  const { kv, serveable, prefix } = options;
  const ttl = Math.max(1, Math.trunc(options.ttlSeconds) || 1);
  const tombstoneTtl = Math.max(
    ttl,
    Math.trunc(options.tombstoneTtlSeconds ?? DEFAULT_TOMBSTONE_TTL_SECONDS) || ttl,
  );
  const encode = Schema.encodeOption(options.schema);
  const decode = Schema.decodeUnknownOption(options.schema);
  const keyOf = (id: string) => `${prefix}${id}`;
  // A locale entry's key: the id's key, the ASCII unit separator, the locale.
  // An id holding U+001F could collide with another id's locale key; node ids
  // (UUIDs, slugs) never do.
  const localeKeyOf = (id: string, locale: string) => `${keyOf(id)}\u001f${locale}`;
  const valueRank = (version: bigint) => version * 2n;

  /**
   * The conditional write at the entry's rank (`2·version`, plus one for a
   * tombstone, so an eviction wins a tie), a KV failure skipped (the cache
   * never fails). A tombstone carries the longer TTL.
   */
  const write = (id: string, version: bigint, value: Option.Option<Schema.Json>) =>
    Effect.ignore(
      kv.putIfNotBehind(
        keyOf(id),
        { version: version * 2n + (Option.isNone(value) ? 1n : 0n), value },
        Option.isNone(value) ? tombstoneTtl : ttl,
      ),
    );
  const evict = (id: string, version: bigint) => write(id, version, Option.none());

  /**
   * A locale entry's write: raise the id's generation to this version's value
   * rank first (no value: the generation carries the rank alone, and an
   * eviction already at this version outranks it), then write the entry at
   * the same rank, a tombstone rank when it isn't serveable. Nothing is
   * written to the entry when the generation is ahead, or its write failed.
   */
  const setLocale = (
    id: string,
    locale: string,
    version: bigint,
    encoded: Option.Option<Schema.Json>,
  ) =>
    Effect.gen(function* () {
      const current = yield* Effect.orElseSucceed(
        kv.putIfNotBehind(
          keyOf(id),
          { version: valueRank(version), value: Option.none() },
          tombstoneTtl,
        ),
        () => false,
      );
      if (!current) return;
      yield* Effect.ignore(
        kv.putIfNotBehind(
          localeKeyOf(id, locale),
          { version: valueRank(version) + (Option.isNone(encoded) ? 1n : 0n), value: encoded },
          Option.isNone(encoded) ? tombstoneTtl : ttl,
        ),
      );
    });

  const set = (id: string, resource: Resource, version: bigint, locale?: string) => {
    // Refuse (and evict) what the policy doesn't serve, or what doesn't encode.
    const encoded = serveable(resource) ? encode(resource) : Option.none();
    return locale === undefined
      ? write(id, version, encoded)
      : setLocale(id, locale, version, encoded);
  };

  const read = (key: string) => Effect.orElseSucceed(kv.get(key), () => Option.none<KvEntry>());

  /** Serve a stored value, or evict it (with `evictIt`) when it no longer decodes or serves. */
  const serve = (entry: KvEntry, evictIt: Effect.Effect<void, never, R>) =>
    Effect.gen(function* () {
      if (Option.isNone(entry.value)) return Option.none<Resource>();
      const resource = decode(entry.value.value);
      if (Option.isNone(resource) || !serveable(resource.value)) {
        // Decode or evict, and never serve what the policy now refuses (CACHE-AUTH-005).
        yield* evictIt;
        return Option.none<Resource>();
      }
      return resource;
    });

  const get = (id: string, locale?: string) =>
    Effect.gen(function* () {
      const generation = yield* read(keyOf(id));
      if (Option.isNone(generation)) return Option.none<Resource>();
      if (locale === undefined) {
        return yield* serve(generation.value, evict(id, generation.value.version / 2n));
      }
      // A locale entry speaks for the id only at the generation's own value rank.
      const entry = yield* read(localeKeyOf(id, locale));
      if (Option.isNone(entry) || entry.value.version !== generation.value.version) {
        return Option.none<Resource>();
      }
      const version = entry.value.version / 2n;
      return yield* serve(
        entry.value,
        Effect.ignore(
          kv.putIfNotBehind(
            localeKeyOf(id, locale),
            { version: valueRank(version) + 1n, value: Option.none() },
            tombstoneTtl,
          ),
        ),
      );
    });

  return { set, delete: evict, get };
};
