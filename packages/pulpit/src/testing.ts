/**
 * **In-memory fakes of the kernel's seams** — a store for each of the
 * version-chain, leaf, document, edge, proposal, path and report seams, an endpoint view, a
 * follower seam and a resource cache, all held in memory with no SQL. They are the reference semantics of
 * each seam's contract in the package README → Seams, and the fakes the
 * kernel's own suites run against; an adapter's or an application's tests can
 * run the kernel's operations over them too.
 *
 * **Not for production.** Every store here keeps its rows in a closure for the
 * life of the value, persists nothing, never opens a transaction and has no
 * concurrency control beyond what a single JavaScript thread gives it. Each
 * store enforces what the real table's schema enforces (a primary or unique
 * key) and nothing the operations are responsible for, so a test of the
 * operations over a fake exercises the operations' policy, not the store's.
 * Each also carries a few test hooks (`rows`, `dropState`, `raceNextAppend`,
 * …) that a real store has no counterpart for: they read what was written,
 * or simulate a state a real database reaches only through a race or a
 * missing row.
 *
 * The follower seam's `in` set is a `HashSet` of account ids
 * ({@link InMemoryFollowing}) throughout, where a SQL store's is a subquery.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
 * import { makeInMemoryChainStore } from "@thomasfosterau/pulpit/testing";
 *
 * const store = makeInMemoryChainStore();
 * const chain = defineVersionChain("notes", store);
 * const { id } = Effect.runSync(
 *   chain.create({ id: Option.none(), state: { title: "Hello" }, actorId: Option.none() }),
 * );
 *
 * // The chain operations appended version 0, and the fake recorded it.
 * deepStrictEqual(
 *   store.rows().map((row) => [row.id, row.version, row.action]),
 *   [[id, 0n, "create"]],
 * );
 * ```
 *
 * @copyright Thomas Foster
 * @module pulpit/testing
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { sha256Hex, type BlobHead, type BlobStore } from "./blobs.ts";
import { canonicalText, type DocumentHash, type DocumentStore } from "./documents.ts";
import {
  endpointColumn,
  type EdgeEnds,
  type EdgeRow,
  type EdgeStore,
  type EdgeValues,
  type EndpointView,
} from "./edges.ts";
import { evaluate, type EvaluationContext, type FilterRow, type ListFilter } from "./filter.ts";
import { rowOrder } from "./internal/list-order.ts";
import { PathTaken, type PathEntry, type PathStore } from "./paths.ts";
import type { ReportRow, ReportStore } from "./moderation.ts";
import type { ProposalListing, ProposalRow, ProposalStore } from "./proposals.ts";
import type { FollowerSeam, LeafRow, LeafStore, ResourceCacheSeam } from "./subtype.ts";
import {
  VersionConflict,
  type ColumnValue,
  type VersionChainEntry,
  type VersionChainStore,
  type VersionRow,
  type VersionSnapshot,
} from "./version-chain.ts";

// ── The clock and the follower set ────────────────────────────────────

/**
 * The follower seam's `in` set in every fake here: the ids of the accounts a
 * viewer follows. A SQL store's is a subquery; the in-memory list filters
 * test membership in this set instead.
 *
 * @since 0.1.0
 */
export type InMemoryFollowing = HashSet.HashSet<string>;

/** The instant a fake's `published` / `notPublished` compare against: the fixed `now`, else the Effect `Clock`'s. */
const instantOf = (now: Option.Option<Date>): Effect.Effect<Date> =>
  Option.match(now, {
    onNone: () =>
      Effect.map(Clock.currentTimeMillis, (millis) => DateTime.toDate(DateTime.makeUnsafe(millis))),
    onSome: Effect.succeed,
  });

/** The list filter's evaluation context at `now`, over an {@link InMemoryFollowing} set. */
const contextAt = (now: Date): EvaluationContext<InMemoryFollowing> => ({
  now,
  contains: (set, value: ColumnValue) => Predicate.isString(value) && HashSet.has(set, value),
});

/**
 * An in-memory {@link FollowerSeam} over an explicit table of who follows
 * whom: each entry is a follower's id and the ids of the accounts it
 * follows. `isFollower` answers from the table and `following` returns the
 * follower's row as an {@link InMemoryFollowing} set (empty for an account the
 * table doesn't name), the in-memory reading of effect-auth's `IsFollower`
 * (README → Seams → the follower seam). In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryFollowers = (
  table: Iterable<readonly [follower: string, followed: ReadonlyArray<string>]>,
): FollowerSeam<InMemoryFollowing, never> => {
  const follows = HashMap.fromIterable(table);
  const followedBy = (followerId: string): ReadonlyArray<string> =>
    Option.getOrElse(HashMap.get(follows, followerId), Arr.empty);
  return {
    isFollower: (followerId, ownerId) => Effect.succeed(followedBy(followerId).includes(ownerId)),
    following: (followerId) => HashSet.fromIterable(followedBy(followerId)),
  };
};

// ── The version chain ─────────────────────────────────────────────────

/**
 * An in-memory {@link VersionChainStore}, plus the hooks a test reads and
 * steers it through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryChainStore extends VersionChainStore<never, never> {
  /** Every row ever appended, in append order — what the append-only assertions read. */
  readonly rows: () => ReadonlyArray<VersionRow>;
  /** Simulate a partial chain: the state at `(id, version)` is no longer reconstructable. */
  readonly dropState: (id: string, version: bigint) => void;
  /** Simulate a concurrent writer: the next append for `id` finds its version taken. */
  readonly raceNextAppend: (id: string) => void;
}

/**
 * An in-memory {@link VersionChainStore}: the seam's contract (README → Seams
 * → `VersionChainStore`) over an append log. It enforces what the Drizzle
 * store's schema enforces, the `(id, version)` primary key (an `append` at a
 * taken pair fails `VersionConflict`), and nothing the operations are
 * responsible for. `mintId` mints sequential UUID-shaped ids.
 *
 * `dropState` simulates a partial chain (a level with no row at a version),
 * which a real database reaches through a missing leaf row, and
 * `raceNextAppend` a writer that takes the next version first. In memory
 * only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryChainStore = (): InMemoryChainStore => {
  let log: ReadonlyArray<VersionRow> = [];
  let dropped = HashSet.empty<string>();
  let raced = HashSet.empty<string>();
  let minted = 0;
  const key = (id: string, version: bigint) => `${id}@${version}`;
  const chain = (id: string) => log.filter((row) => row.id === id);

  const entryOf = (row: VersionRow): VersionChainEntry => ({
    version: row.version,
    action: row.action,
    timestamp: row.timestamp,
  });

  /** Whether the next append for `id` is raced, consuming the race. */
  const takeRace = (id: string): boolean => {
    const wasRaced = HashSet.has(raced, id);
    raced = HashSet.remove(raced, id);
    return wasRaced;
  };

  return {
    head: (id) => Effect.sync(() => Option.map(Arr.last(chain(id)), entryOf)),
    snapshot: (id, version) =>
      Effect.sync(() =>
        HashSet.has(dropped, key(id, version))
          ? Option.none()
          : Option.map(
              Arr.findFirst(chain(id), (candidate) => candidate.version === version),
              (row): VersionSnapshot => ({ ...entryOf(row), state: row.state }),
            ),
      ),
    append: (row) =>
      Effect.suspend(() => {
        if (takeRace(row.id) || chain(row.id).some((taken) => taken.version === row.version)) {
          return Effect.fail(new VersionConflict({ id: row.id, version: row.version }));
        }
        log = [...log, row];
        return Effect.void;
      }),
    entries: (id, limit) => Effect.sync(() => chain(id).slice(0, limit).map(entryOf)),
    mintId: Effect.sync(() => {
      minted += 1;
      return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
    }),
    rows: () => log,
    dropState: (id, version) => {
      dropped = HashSet.add(dropped, key(id, version));
    },
    raceNextAppend: (id) => {
      raced = HashSet.add(raced, id);
    },
  };
};

// ── The leaf view ─────────────────────────────────────────────────────

/**
 * An in-memory {@link LeafStore} over an {@link InMemoryChainStore}, plus the
 * hooks a test reads and steers its owner stamps through. In memory only; not
 * for production.
 *
 * @since 0.1.0
 */
export interface InMemoryLeafStore extends LeafStore<LeafRow, InMemoryFollowing, never, never> {
  /** Every owner stamp, node id → owner id — what the owner-stamp assertions read. */
  readonly owners: () => HashMap.HashMap<string, string>;
  /** Simulate an ownerless owned node: drop `id`'s owner stamp (the apps' `core.node_owner` row). */
  readonly dropOwner: (id: string) => void;
}

/**
 * Options for {@link makeInMemoryLeafStore}.
 *
 * @since 0.1.0
 */
export interface InMemoryLeafStoreOptions {
  /** The view's leaf columns; `id`, `action` and `ownerId` are always in its `columns`. */
  readonly columns: ReadonlyArray<string>;
  /** The instant `published` / `notPublished` compare against; the Effect `Clock`'s at each `list` when absent. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such by every reader, so there is no value to model as an `Option`
  readonly now?: Date | undefined;
}

/**
 * An in-memory {@link LeafStore}: the seam's contract (README → Seams →
 * `LeafStore`) as a current-version view over an {@link InMemoryChainStore}.
 * Each node's row is its head version's state with its head `version` and `action`, and
 * `ownerId` merged in from the owner stamps (the apps' `core.node_owner`
 * join); `list` evaluates its {@link ListFilter} in memory, orders by its
 * `orderBy` keys then `id` ascending as the seam's contract renders it
 * (`NULLS LAST` in both directions, a string by code point as `COLLATE "C"`
 * sorts it, a `Date` by its instant), and returns the unpaged total. Like a
 * SQL store, it takes `orderBy` as already checked against `columns`. It
 * applies no visibility policy, as a real view applies none. In memory only;
 * not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryLeafStore = (
  chain: InMemoryChainStore,
  options: InMemoryLeafStoreOptions,
): InMemoryLeafStore => {
  const fixedNow = Option.fromNullishOr(options.now);
  let owners = HashMap.empty<string, string>();
  const headOf = (row: VersionRow): LeafRow => {
    const base: LeafRow = { ...row.state, id: row.id, version: row.version, action: row.action };
    return Option.match(HashMap.get(owners, row.id), {
      onNone: () => base,
      onSome: (ownerId): LeafRow => ({ ...base, ownerId }),
    });
  };
  const view = (): ReadonlyArray<LeafRow> =>
    Arr.sort(
      HashMap.toValues(
        Arr.reduce(chain.rows(), HashMap.empty<string, LeafRow>(), (heads, row) =>
          HashMap.set(heads, row.id, headOf(row)),
        ),
      ),
      rowOrder([]),
    );
  return {
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- the seam's column set is the native `ReadonlySet` `LeafStore.columns` names
    columns: new Set(["id", "version", "action", "ownerId", ...options.columns]),
    get: (id) => Effect.sync(() => Arr.findFirst(view(), (row) => row.id === id)),
    getMany: (ids) => Effect.sync(() => view().filter((row) => ids.includes(row.id))),
    list: ({ where, orderBy, limit, offset }) =>
      Effect.map(instantOf(fixedNow), (now) => {
        const matching = Arr.sort(
          view().filter((row) => evaluate(where, row, contextAt(now))),
          rowOrder(orderBy),
        );
        return { rows: matching.slice(offset, offset + limit), total: matching.length };
      }),
    ownerOf: (id) => Effect.sync(() => HashMap.get(owners, id)),
    stampOwner: (id, ownerId) =>
      Effect.sync(() => {
        owners = HashMap.set(owners, id, ownerId);
      }),
    owners: () => owners,
    dropOwner: (id) => {
      owners = HashMap.remove(owners, id);
    },
  };
};

// ── Paths ─────────────────────────────────────────────────────────────

/**
 * An in-memory {@link PathStore}, plus the read a test checks it through. In
 * memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryPathStore extends PathStore<never, never> {
  /** Every stored path and its entry, aliases included. */
  readonly entries: () => HashMap.HashMap<string, PathEntry>;
}

/**
 * An in-memory {@link PathStore}: the seam's contract (README → Seams →
 * `PathStore`) as one map from path to entry, its key the path table's
 * primary key, so each path is stored once. `claim` fails {@link PathTaken}
 * for another node's canonical path, replaces an alias at the path, and
 * demotes the node's previous canonical path to its alias, in one step;
 * `release` drops the node's canonical path and keeps its aliases. In memory
 * only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryPathStore = (): InMemoryPathStore => {
  let entries = HashMap.empty<string, PathEntry>();
  const canonicalOf = (nodeId: string) =>
    Option.map(
      Arr.findFirst(
        HashMap.toEntries(entries),
        ([, entry]) => entry.canonical && entry.nodeId === nodeId,
      ),
      ([path]) => path,
    );
  return {
    lookup: (path) => Effect.sync(() => HashMap.get(entries, path)),
    canonicalOf: (nodeId) => Effect.sync(() => canonicalOf(nodeId)),
    claim: (nodeId, path) =>
      Effect.suspend(() => {
        const held = HashMap.get(entries, path);
        if (Option.exists(held, (entry) => entry.canonical && entry.nodeId !== nodeId)) {
          return Effect.fail(new PathTaken({ path }));
        }
        entries = Option.match(canonicalOf(nodeId), {
          onNone: () => entries,
          onSome: (previous) => HashMap.set(entries, previous, { nodeId, canonical: false }),
        });
        entries = HashMap.set(entries, path, { nodeId, canonical: true });
        return Effect.void;
      }),
    release: (nodeId) =>
      Effect.sync(() => {
        entries = Option.match(canonicalOf(nodeId), {
          onNone: () => entries,
          onSome: (path) => HashMap.remove(entries, path),
        });
      }),
    entries: () => entries,
  };
};

// ── The resource cache ────────────────────────────────────────────────

/**
 * An in-memory {@link ResourceCacheSeam}, plus the reads a test checks it
 * through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryResourceCache<Resource> extends ResourceCacheSeam<Resource, never> {
  /** The resource the cache would serve for `id`: none when evicted, refused or never set. */
  readonly get: (id: string) => Option.Option<Resource>;
  /** The highest version the cache holds for `id`, set or evicted, or none. */
  readonly versionOf: (id: string) => Option.Option<bigint>;
}

/**
 * An in-memory {@link ResourceCacheSeam}: the seam's compare-on-set contract
 * (README → Seams → the resource cache, pulpit#121). It keeps, per id, the
 * highest version either call has given it: a `set` below it is a no-op, a
 * `set` at or above it stores the resource when `serveable` admits it and
 * evicts it otherwise, and a `delete` evicts and raises the version. Each
 * call compares and writes in one step, as the real cache's conditional write
 * must. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryResourceCache = <Resource>(
  serveable: (resource: Resource) => boolean,
): InMemoryResourceCache<Resource> => {
  let entries = HashMap.empty<
    string,
    { readonly version: bigint; readonly resource: Option.Option<Resource> }
  >();
  const versionOf = (id: string) => Option.map(HashMap.get(entries, id), (entry) => entry.version);
  const behind = (id: string, version: bigint) =>
    Option.exists(versionOf(id), (held) => version < held);
  return {
    set: (id, resource, version) =>
      Effect.sync(() => {
        if (behind(id, version)) return;
        entries = HashMap.set(entries, id, {
          version,
          resource: serveable(resource) ? Option.some(resource) : Option.none(),
        });
      }),
    delete: (id, version) =>
      Effect.sync(() => {
        if (behind(id, version)) return;
        entries = HashMap.set(entries, id, { version, resource: Option.none() });
      }),
    get: (id) => Option.flatMap(HashMap.get(entries, id), (entry) => entry.resource),
    versionOf,
  };
};

// ── Documents ─────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

/** SHA-256 over the canonical text's UTF-8 bytes, as 64 lowercase hex characters. */
const hashOf = (document: Schema.Json): Effect.Effect<DocumentHash> =>
  sha256Hex(utf8.encode(canonicalText(document)));

/**
 * An in-memory {@link DocumentStore}, plus the hooks a test reads it through.
 * In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryDocumentStore<Document extends Schema.Json> extends DocumentStore<
  Document,
  never,
  never
> {
  /** Every stored document by hash — what the never-rewritten assertions read. */
  readonly stored: () => HashMap.HashMap<DocumentHash, Document>;
  /**
   * How many times `put` wrote a row: a real insert counts, a no-op `put` of a
   * stored hash does not. The never-rewritten assertions read it, because
   * `HashMap.set` with a structurally equal value is indistinguishable from no
   * write in {@link InMemoryDocumentStore.stored}.
   */
  readonly writes: () => number;
}

/**
 * An in-memory {@link DocumentStore}: the seam's contract (README → Seams →
 * `DocumentStore`), hash contract included. It hashes exactly as a Postgres
 * store does, SHA-256 over the UTF-8 bytes of the document's
 * {@link canonicalText}, so its hashes are the ones the database generates
 * (the kernel's suite pins it to hashes taken from Postgres). Like a store's
 * primary key on the hash with `ON CONFLICT DO NOTHING`, it keeps the first
 * document stored at a hash and never replaces it (`DOC-001`). It hashes with
 * Web Crypto (`crypto.subtle`), which Node.js 22 and every browser provide.
 * In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryDocumentStore = <
  Document extends Schema.Json,
>(): InMemoryDocumentStore<Document> => {
  let documents = HashMap.empty<DocumentHash, Document>();
  let writes = 0;
  return {
    put: (document) =>
      Effect.map(hashOf(document), (hash) => {
        // `ON CONFLICT DO NOTHING`: the first document at a hash is kept.
        const inserted = !HashMap.has(documents, hash);
        if (inserted) {
          documents = HashMap.set(documents, hash, document);
          writes += 1;
        }
        return { hash, inserted };
      }),
    get: (hash) => Effect.sync(() => HashMap.get(documents, hash)),
    getMany: (hashes) =>
      Effect.sync(() => HashMap.filter(documents, (_document, hash) => hashes.includes(hash))),
    stored: () => documents,
    writes: () => writes,
  };
};

// ── Edges ─────────────────────────────────────────────────────────────

/**
 * An in-memory {@link EndpointView} whose nodes a test writes directly. In
 * memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryNodes extends EndpointView<never, never> {
  /** Store (or replace) a node's current-version row. */
  readonly put: (row: LeafRow) => void;
}

/**
 * An in-memory {@link EndpointView}: an edge end's current-version view
 * (README → Seams → `EdgeStore`) as rows a test puts by hand, for an edge
 * suite that doesn't need the endpoint leaf's version chain. Its `columns`
 * are `id`, `version`, `action` and `columns`. An {@link InMemoryLeafStore} is an
 * endpoint view too. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryNodes = (columns: ReadonlyArray<string>): InMemoryNodes => {
  let nodes = HashMap.empty<string, LeafRow>();
  return {
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- the seam's column set is a `ReadonlySet`, the type `LeafStore.columns` already has, so a `LeafStore` satisfies `EndpointView`
    columns: new Set(["id", "version", "action", ...columns]),
    get: (id) => Effect.sync(() => HashMap.get(nodes, id)),
    put: (row) => {
      nodes = HashMap.set(nodes, row.id, row);
    },
  };
};

/**
 * An in-memory {@link EdgeStore}, plus the hooks a test reads and steers it
 * through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryEdgeStore extends EdgeStore<EdgeRow, InMemoryFollowing, never, never> {
  /** Every stored edge, hidden ones included, in insertion order. */
  readonly rows: () => ReadonlyArray<EdgeRow>;
  /**
   * Simulate a concurrent writer: the next insert finds its unique key just
   * taken by `winner`, which is stored in its place (the racing writer's
   * values, which share the key and may differ elsewhere).
   */
  readonly raceNextInsert: (winner: EdgeValues) => void;
}

/**
 * Options for {@link makeInMemoryEdgeStore}.
 *
 * @since 0.1.0
 */
export interface InMemoryEdgeStoreOptions {
  /** The ends the list joins, by alias (the family declaration's `ends`). */
  readonly ends: EdgeEnds<never, never>;
  /** The unique key's columns; empty for a family with none. */
  readonly uniqueKey: ReadonlyArray<string>;
  /**
   * The instant `published` / `notPublished` compare against, and the base of
   * the minted `createdAt`s; the Effect `Clock`'s at each call when absent.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such by every reader, so there is no value to model as an `Option`
  readonly now?: Date | undefined;
}

/** Two column values the unique key treats as equal: `NULLS NOT DISTINCT`, an absent key read as `NULL`. */
const sameKey = (row: EdgeRow, values: EdgeValues, column: string): boolean =>
  (row[column] ?? null) === (values[column] ?? null);

/** The edge list's total order: `createdAt`, then `id`. */
const byCreation = Order.combine(
  Order.mapInput(Order.Date, (row: EdgeRow) => row.createdAt),
  Order.mapInput(Order.String, (row: EdgeRow) => row.id),
);

/**
 * An in-memory {@link EdgeStore}: the seam's contract (README → Seams →
 * `EdgeStore`) over one edge family's rows. It enforces what an edge table's
 * schema enforces, the family's unique key (with `NULLS NOT DISTINCT`, as
 * gardeneria's `page_slugs_unique_variant`), and nothing the operations are
 * responsible for. `list` and `countAt` join each end's view the way the SQL
 * store's INNER JOIN does: under the end's alias, dropping an edge whose end
 * has no row. `list` orders by `createdAt` then `id` and reports the unpaged
 * total as the SQL store's window column does (`0` for an empty page).
 *
 * Ids are minted `edge-0001`, `edge-0002`, …; the n-th insert is stamped
 * `now + n` milliseconds, except that every third shares its predecessor's
 * instant, so the `id` tie-break of the list order is exercised. In memory
 * only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryEdgeStore = (options: InMemoryEdgeStoreOptions): InMemoryEdgeStore => {
  const fixedNow = Option.fromNullishOr(options.now);
  let stored: ReadonlyArray<EdgeRow> = [];
  let minted = 0;
  let race = Option.none<EdgeValues>();

  const collides = (values: EdgeValues) =>
    Arr.findFirst(
      stored,
      (row) =>
        Arr.isReadonlyArrayNonEmpty(options.uniqueKey) &&
        options.uniqueKey.every((column) => sameKey(row, values, column)),
    );

  const write = (values: EdgeValues, now: Date): string => {
    minted += 1;
    const id = `edge-${String(minted).padStart(4, "0")}`;
    const createdAt = DateTime.toDate(
      DateTime.makeUnsafe(now.getTime() + minted - (minted % 3 === 0 ? 1 : 0)),
    );
    stored = [...stored, { ...values, id, createdAt }];
    return id;
  };

  /** The edge joined with each end's node under its alias, or none when an end has no row (INNER JOIN). */
  const joined = (row: EdgeRow): Effect.Effect<Option.Option<FilterRow>> =>
    Effect.map(
      Effect.forEach(
        Record.toEntries(options.ends),
        ([alias, end]) => {
          const nodeId = row[end.column];
          return Predicate.isString(nodeId)
            ? Effect.map(
                end.nodes.get(nodeId),
                Option.map((node) =>
                  Record.mapKeys(node, (column): string => endpointColumn(alias, column)),
                ),
              )
            : Effect.succeedNone;
        },
        { concurrency: 1 },
      ),
      (nodes) =>
        Option.map(
          Option.all(nodes),
          Arr.reduce<FilterRow, FilterRow>(row, (acc, node) => ({ ...acc, ...node })),
        ),
    );

  /** The stored edges whose join satisfies `where`, in the list's total order. */
  const matching = (where: ListFilter<InMemoryFollowing>) =>
    Effect.flatMap(instantOf(fixedNow), (now) =>
      Effect.filter(Arr.sort(stored, byCreation), (row) =>
        Effect.map(
          joined(row),
          Option.exists((present) => evaluate(where, present, contextAt(now))),
        ),
      ),
    );

  return {
    get: (id) => Effect.sync(() => Arr.findFirst(stored, (row) => row.id === id)),
    // The total as the SQL store's window column reads it: every matching
    // row when the page has one, and 0 for an empty page (past the end too).
    list: ({ where, limit, offset }) =>
      Effect.map(matching(where), (rows) => {
        const page = rows.slice(offset, offset + limit);
        return { rows: page, total: Arr.isReadonlyArrayNonEmpty(page) ? rows.length : 0 };
      }),
    // The count over the list's joins, as the SQL store's `count(*)` reads
    // them: the edges at the node that satisfy `where`.
    countAt: ({ column, nodeId, where }) =>
      Effect.map(matching(where), (rows) => rows.filter((row) => row[column] === nodeId).length),
    existing: (values) => Effect.sync(() => Option.map(collides(values), (row) => row.id)),
    insert: (values) =>
      Effect.map(instantOf(fixedNow), (now) => {
        if (Option.isSome(race)) {
          write(race.value, now);
          race = Option.none();
          return Option.none();
        }
        return Option.isSome(collides(values)) ? Option.none() : Option.some(write(values, now));
      }),
    delete: (id) =>
      Effect.sync(() => {
        const before = stored.length;
        stored = stored.filter((row) => row.id !== id);
        return stored.length < before;
      }),
    rows: () => stored,
    raceNextInsert: (winner) => {
      race = Option.some(winner);
    },
  };
};

/** One plain row (a proposal, a report): an id, a status, a filing instant. */
interface PlainRow {
  readonly id: string;
  readonly status: string;
}

/**
 * The table both plain-row fakes keep: insert order, sequential UUID-shaped
 * ids under `prefix`, `close` on an `open`-status row only, and a page
 * newest first by `at`, `id` descending on a tie, evaluated in memory.
 */
const plainRowTable = <Row extends PlainRow>(options: {
  readonly prefix: string;
  readonly open: Row["status"];
  readonly at: (row: Row) => Date;
  readonly filterRow: (row: Row) => FilterRow;
}) => {
  let rows: ReadonlyArray<Row> = [];
  let minted = 0;
  const newestFirst = Order.combine(
    Order.flip(Order.mapInput(Order.Date, options.at)),
    Order.flip(Order.mapInput(Order.String, (row: Row) => row.id)),
  );
  // No plain-row column is a publication stamp, so `now` is never read.
  const context: EvaluationContext<never> = {
    now: DateTime.toDate(DateTime.makeUnsafe(0)),
    contains: () => false,
  };
  const find = (id: string) => Arr.findFirst(rows, (row) => row.id === id);
  return {
    rows: () => rows,
    find,
    mintId: Effect.sync(() => {
      minted += 1;
      return `00000000-0000-4000-${options.prefix}-${String(minted).padStart(12, "0")}`;
    }),
    insert: (row: Row) =>
      Effect.sync(() => {
        rows = [...rows, row];
      }),
    lock: (id: string) => Effect.sync(() => find(id)),
    close: (id: string, closed: (row: Row) => Row) =>
      Effect.sync(() => {
        rows = Arr.map(rows, (row) =>
          row.id === id && row.status === options.open ? closed(row) : row,
        );
      }),
    matching: (where: ListFilter<never>) =>
      Arr.sort(
        Arr.filter(rows, (row) => evaluate(where, options.filterRow(row), context)),
        newestFirst,
      ),
  };
};

// ── Proposals ─────────────────────────────────────────────────────────

/**
 * An in-memory {@link ProposalStore}, plus the hook a test reads it through.
 * In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryProposalStore extends ProposalStore<never, never> {
  /** Every row, in insert order, as it now stands. */
  readonly rows: () => ReadonlyArray<ProposalRow>;
}

/**
 * An in-memory {@link ProposalStore}: the seam's contract (README → Seams →
 * `ProposalStore`). A listing's `targetVersion` is the `chain`'s head for
 * the target, and the `targetOwnerId` its `list` filters on is `leaves`'
 * owner stamp (or `null`), as the SQL store's joins read them. `lock`
 * locks nothing (one JavaScript thread has no concurrent decision to
 * serialise). `mintId` mints sequential UUID-shaped ids. In memory only;
 * not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryProposalStore = (options: {
  readonly chain: InMemoryChainStore;
  readonly leaves: InMemoryLeafStore;
}): InMemoryProposalStore => {
  const table = plainRowTable<ProposalRow>({
    prefix: "9000",
    open: "pending",
    at: (row) => row.submittedAt,
    filterRow: (row) => ({
      id: row.id,
      authorId: row.authorId,
      targetId: row.targetId,
      targetType: row.targetType,
      status: row.status,
      submittedAt: row.submittedAt,
      targetOwnerId: Option.getOrElse(
        HashMap.get(options.leaves.owners(), row.targetId),
        () => null,
      ),
    }),
  });
  const listingOf = (row: ProposalRow): Effect.Effect<ProposalListing> =>
    Effect.map(options.chain.head(row.targetId), (head) => ({
      row,
      targetVersion: Option.map(head, (entry) => entry.version),
    }));
  return {
    mintId: table.mintId,
    insert: table.insert,
    get: (id) =>
      Effect.suspend(() =>
        Option.match(table.find(id), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => Effect.map(listingOf(row), Option.some),
        }),
      ),
    lock: table.lock,
    close: (id, decision) =>
      table.close(id, (row) => ({
        ...row,
        status: decision.status,
        decidedAt: Option.some(decision.decidedAt),
        decidedBy: Option.some(decision.decidedBy),
        decisionNote: decision.decisionNote,
        appliedVersion: decision.appliedVersion,
      })),
    list: ({ where, limit, offset }) =>
      Effect.suspend(() => {
        const matching = table.matching(where);
        return Effect.map(
          Effect.forEach(matching.slice(offset, offset + limit), listingOf, { concurrency: 1 }),
          (page) => ({ rows: page, total: matching.length }),
        );
      }),
    rows: table.rows,
  };
};

// ── Member reports ────────────────────────────────────────────────────

/**
 * An in-memory {@link ReportStore}, plus the hook a test reads it through.
 * In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryReportStore extends ReportStore<never, never> {
  /** Every report, in filing order, as it now stands. */
  readonly rows: () => ReadonlyArray<ReportRow>;
}

/**
 * An in-memory {@link ReportStore}: the seam's contract (README → Seams →
 * `ReportStore`). `list` evaluates the filter in memory, newest first with
 * `id` descending on a tie; `lock` locks nothing (one JavaScript thread has
 * no concurrent resolution to serialise); `mintId` mints sequential
 * UUID-shaped ids. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryReportStore = (): InMemoryReportStore => {
  const table = plainRowTable<ReportRow>({
    prefix: "a000",
    open: "open",
    at: (row) => row.filedAt,
    filterRow: (row) => ({
      id: row.id,
      reporterId: row.reporterId,
      targetId: row.targetId,
      targetType: row.targetType,
      status: row.status,
    }),
  });
  return {
    mintId: table.mintId,
    insert: table.insert,
    get: (id) => Effect.sync(() => table.find(id)),
    lock: table.lock,
    close: (id, resolution) =>
      table.close(id, (row) => ({
        ...row,
        status: resolution.status,
        resolvedAt: Option.some(resolution.resolvedAt),
        resolvedBy: Option.some(resolution.resolvedBy),
        resolutionNote: resolution.resolutionNote,
      })),
    list: ({ where, limit, offset }) =>
      Effect.sync(() => {
        const matching = table.matching(where);
        return { rows: matching.slice(offset, offset + limit), total: matching.length };
      }),
    rows: table.rows,
  };
};

// ── Blobs ─────────────────────────────────────────────────────────────

/**
 * The in-memory blob store's one failure: a simulated outage.
 *
 * @since 0.1.0
 */
export class InMemoryBlobFailure extends Schema.TaggedError<InMemoryBlobFailure>()(
  "InMemoryBlobFailure",
  { key: Schema.String },
) {}

/**
 * One object in an {@link InMemoryBlobStore}.
 *
 * @since 0.1.0
 */
export interface InMemoryBlob {
  readonly bytes: Uint8Array;
  readonly head: BlobHead;
}

/**
 * An in-memory {@link BlobStore}, plus the hooks a test reads and steers it
 * through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryBlobStore extends BlobStore<InMemoryBlobFailure, never> {
  /** Every stored object by key. */
  readonly objects: () => HashMap.HashMap<string, InMemoryBlob>;
  /** Simulate an outage: the next `put` fails with {@link InMemoryBlobFailure}. */
  readonly failNextPut: () => void;
}

/**
 * An in-memory {@link BlobStore}: the seam's contract (README → Seams →
 * `BlobStore`). `publicUrl` is `memory://<key>`; there is no signed upload
 * URL. `failNextPut` simulates the byte write failing after the commit. In
 * memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryBlobStore = (): InMemoryBlobStore => {
  let objects = HashMap.empty<string, InMemoryBlob>();
  let failing = false;
  return {
    put: (key, bytes, head) =>
      Effect.suspend(() => {
        if (failing) {
          failing = false;
          return Effect.fail(new InMemoryBlobFailure({ key }));
        }
        objects = HashMap.set(objects, key, { bytes: Uint8Array.from(bytes), head });
        return Effect.void;
      }),
    get: (key) =>
      Effect.sync(() => Option.map(HashMap.get(objects, key), (object) => object.bytes)),
    head: (key) =>
      Effect.sync(() => Option.map(HashMap.get(objects, key), (object) => object.head)),
    delete: (key) =>
      Effect.sync(() => {
        objects = HashMap.remove(objects, key);
      }),
    publicUrl: (key) => Option.some(`memory://${key}`),
    signedUploadUrl: Option.none(),
    objects: () => objects,
    failNextPut: () => {
      failing = true;
    },
  };
};
