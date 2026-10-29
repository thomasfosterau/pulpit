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
 * - **Serveability on both sides** (`CACHE-AUTH-005`). `set` refuses (and
 *   evicts) a resource the `serveable` policy refuses, and `get` checks it
 *   again, so a policy change can't serve a stale cached private row.
 * - **Decode or evict.** `get` decodes the stored value with the resource's
 *   schema; a value that no longer decodes (the schema moved) is evicted and
 *   read as a miss.
 * - **A TTL backstop.** Every write carries the configured TTL, so an entry
 *   no write ever evicted still expires.
 * - **Never fails.** A KV failure reads as a miss and skips a write: the
 *   cache is an optimisation, and the store stays the source of truth.
 *
 * The KV seam is the application's (a Durable Object, Redis, a SQL table):
 * nothing here imports a platform. Workers KV alone has no conditional
 * write, so it can't fill {@link VersionedKv.putIfNotBehind}.
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
 * One stored entry: the version it speaks for, and the encoded resource, or
 * none for an eviction (a tombstone that keeps the version).
 *
 * @since 0.1.0
 */
export interface KvEntry {
  readonly version: bigint;
  readonly value: Option.Option<Schema.Json>;
}

/**
 * The minimal versioned key-value store an application supplies. A store
 * seam: no policy, fails only with its `E`. See the package README → Seams.
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
  /** The TTL backstop every write carries, in seconds (clamped to at least 1). */
  readonly ttlSeconds: number;
}

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
   * serves (evicted likewise). Never fails.
   */
  readonly get: (id: string) => Effect.Effect<Option.Option<Resource>, never, R>;
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
  const encode = Schema.encodeOption(options.schema);
  const decode = Schema.decodeUnknownOption(options.schema);
  const keyOf = (id: string) => `${prefix}${id}`;

  /** The conditional write, a KV failure skipped (the cache never fails). */
  const write = (id: string, entry: KvEntry) =>
    Effect.ignore(kv.putIfNotBehind(keyOf(id), entry, ttl));
  const evict = (id: string, version: bigint) => write(id, { version, value: Option.none() });

  const set = (id: string, resource: Resource, version: bigint) => {
    // Refuse (and evict) what the policy doesn't serve, or what doesn't encode.
    const encoded = serveable(resource) ? encode(resource) : Option.none();
    return write(id, { version, value: encoded });
  };

  const get = (id: string) =>
    Effect.gen(function* () {
      const stored = yield* Effect.orElseSucceed(kv.get(keyOf(id)), () => Option.none<KvEntry>());
      if (Option.isNone(stored) || Option.isNone(stored.value.value))
        return Option.none<Resource>();
      const resource = decode(stored.value.value.value);
      if (Option.isNone(resource) || !serveable(resource.value)) {
        // Decode or evict, and never serve what the policy now refuses (CACHE-AUTH-005).
        yield* evict(id, stored.value.version);
        return Option.none<Resource>();
      }
      return resource;
    });

  return { set, delete: evict, get };
};
