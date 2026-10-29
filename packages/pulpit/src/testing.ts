/**
 * **In-memory fakes of the kernel's seams** — a store for each of the
 * version-chain, leaf, document, edge, proposal, path, report, publication, purge and embedding seams, an
 * endpoint view, a follower seam, a search branch (with a scope check) and a resource cache, all held in memory with no SQL. They are the reference semantics of
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
import type { BudgetCounter, BudgetRequest, WriteCountStore } from "./budgets.ts";
import { canonicalText, type DocumentHash, type DocumentStore } from "./documents.ts";
import {
  endpointColumn,
  type EdgeEnds,
  type EdgeRow,
  type EdgeStore,
  type EdgeValues,
  type EndpointView,
} from "./edges.ts";
import {
  evaluate,
  LOCALE_COLUMN,
  type EvaluationContext,
  type FilterRow,
  type ListFilter,
} from "./filter.ts";
import { byCodePoint, rowOrder } from "./internal/list-order.ts";
import type { ErasedReferences, PurgeStore } from "./purge.ts";
import {
  SearchScopeLeak,
  type EmbeddingStore,
  type RankedHit,
  type SearchBranch,
} from "./search.ts";
import { PathTaken, type PathEntry, type PathStore } from "./paths.ts";
import type { ReportRow, ReportStore } from "./moderation.ts";
import type { ProposalListing, ProposalRow, ProposalStore } from "./proposals.ts";
import type { WorkingCopy, WorkingCopyKey, WorkingCopyStore } from "./working-copy.ts";
import type {
  FollowerSeam,
  LeafRow,
  LeafStore,
  DistinctQuery,
  ListOrder,
  Page,
  LiveView,
  PublicationFact,
  PublicationStore,
  ResourceCacheSeam,
} from "./subtype.ts";
import {
  localesOf,
  VersionConflict,
  type ColumnValue,
  type LocaleStates,
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
 * A node's rows in a localised view (pulpit#56): one per locale its version
 * carries, the locale's columns over the shared row and the tag in
 * {@link LOCALE_COLUMN}; a version carrying none is its shared row alone,
 * the `NULL`-locale row a left join gives.
 */
const localeRows = (row: LeafRow, locales: LocaleStates): ReadonlyArray<LeafRow> =>
  Record.isEmptyRecord(locales)
    ? [row]
    : Arr.map(Record.toEntries(locales), ([tag, columns]): LeafRow => ({
        ...row,
        ...columns,
        [LOCALE_COLUMN]: tag,
      }));

/** The locale level of `id` at `version` in an in-memory chain, `{}` for none. */
const localesAt = (chain: InMemoryChainStore, id: string, version: bigint): LocaleStates =>
  Option.match(
    Arr.findFirst(chain.rows(), (row) => row.id === id && row.version === version),
    { onNone: () => ({}), onSome: localesOf },
  );

/**
 * The distinct string values of `column` among the rows matching `where` at
 * `now`, in code-point order, paged: `LeafStore.distinct`'s contract.
 */
const distinctPage = (
  rows: ReadonlyArray<LeafRow>,
  query: DistinctQuery<InMemoryFollowing>,
  now: Date,
): Page<string> => {
  const values = Arr.sort(
    Arr.dedupe(
      Arr.flatMap(rows, (row) => {
        const value = row[query.column];
        return evaluate(query.where, row, contextAt(now)) && Predicate.isString(value)
          ? [value]
          : [];
      }),
    ),
    byCodePoint,
  );
  return {
    rows: values.slice(query.offset, query.offset + query.limit),
    total: values.length,
  };
};

/** A view page: the rows matching `where` at `now`, in the list order contract's order. */
const viewPage = (
  rows: ReadonlyArray<LeafRow>,
  query: {
    readonly where: ListFilter<InMemoryFollowing>;
    readonly orderBy: ReadonlyArray<ListOrder>;
    readonly limit: number;
    readonly offset: number;
  },
  now: Date,
) => {
  const matching = Arr.sort(
    rows.filter((row) => evaluate(query.where, row, contextAt(now))),
    rowOrder(query.orderBy),
  );
  return {
    rows: matching.slice(query.offset, query.offset + query.limit),
    total: matching.length,
  };
};

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
  /**
   * Hard-delete every row of `id` and return them: what
   * {@link makeInMemoryPurgeStore} erases a node through, and nothing else
   * may call (`VERSION-CHAIN-001/002`).
   */
  readonly erase: (id: string) => ReadonlyArray<VersionRow>;
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
              (row): VersionSnapshot =>
                row.locales === undefined
                  ? { ...entryOf(row), state: row.state }
                  : { ...entryOf(row), state: row.state, locales: row.locales },
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
    erase: (id) => {
      const erased = chain(id);
      log = log.filter((row) => row.id !== id);
      return erased;
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
  /**
   * A localised leaf's view (pulpit#56): its `columns` gain
   * {@link LOCALE_COLUMN}, and `list` reads one row per `(id, locale)`.
   * `get` / `getMany` read the shared row either way.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is an unlocalised view
  readonly localised?: boolean | undefined;
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
  /** The rows `list` reads: one per `(id, locale)` on a localised view. */
  const listed = (): ReadonlyArray<LeafRow> =>
    options.localised === true
      ? Arr.flatMap(view(), (row) => localeRows(row, localesAt(chain, row.id, row.version)))
      : view();
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
    columns: new Set([
      "id",
      "version",
      "action",
      "ownerId",
      ...options.columns,
      ...(options.localised === true ? [LOCALE_COLUMN] : []),
    ]),
    get: (id) => Effect.sync(() => Arr.findFirst(view(), (row) => row.id === id)),
    getMany: (ids) => Effect.sync(() => view().filter((row) => ids.includes(row.id))),
    list: (query) => Effect.map(instantOf(fixedNow), (now) => viewPage(listed(), query, now)),
    distinct: (query) =>
      Effect.map(instantOf(fixedNow), (now) => distinctPage(listed(), query, now)),
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
  /**
   * Delete the documents at `hashes`: what {@link makeInMemoryPurgeStore}
   * deletes an unreferenced document through, and nothing else may call
   * (`DOC-001`).
   */
  readonly remove: (hashes: ReadonlyArray<DocumentHash>) => void;
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
    remove: (hashes) => {
      documents = HashMap.filter(documents, (_document, hash) => !hashes.includes(hash));
    },
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
 * responsible for. `list`, `countAt`, `members` and `countBy` join each end's view the way the SQL
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
    // The SQL store's subquery, computed eagerly over the list's joins: the
    // member end's ids of the edges whose other end is named and that
    // satisfy `where`. A non-string member id is never in the set.
    members: ({ column, otherColumn, ids, where }) =>
      Effect.map(matching(where), (rows) =>
        HashSet.fromIterable(
          Arr.flatMap(rows, (row) => {
            const member = row[column];
            const other = row[otherColumn];
            return Predicate.isString(member) && Predicate.isString(other) && ids.includes(other)
              ? [member]
              : [];
          }),
        ),
      ),
    // The SQL store's grouped count over the list's joins: per requested
    // node, the edges at it that satisfy `where`; a node with none, no key.
    countBy: ({ column, ids, where }) =>
      Effect.map(matching(where), (rows) =>
        Arr.reduce(rows, HashMap.empty<string, number>(), (counts, row) => {
          const node = row[column];
          return Predicate.isString(node) && ids.includes(node)
            ? HashMap.set(counts, node, Option.getOrElse(HashMap.get(counts, node), () => 0) + 1)
            : counts;
        }),
      ),
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

// ── Publication ───────────────────────────────────────────────────────

/**
 * A publish-gated leaf's in-memory seams, over an in-memory chain and leaf
 * store, plus the hook a test reads the log through. In memory only; not
 * for production.
 *
 * @since 0.1.0
 */
export interface InMemoryPublication {
  /** The publication log. */
  readonly facts: PublicationStore<never, never>;
  /** The live-version view. */
  readonly live: LiveView<LeafRow, InMemoryFollowing, never, never>;
  /** The leaf's current-version view, with `draft` computed from the log. */
  readonly leaves: LeafStore<LeafRow, InMemoryFollowing, never, never>;
  /** Every fact, in record order. */
  readonly recorded: () => ReadonlyArray<PublicationFact>;
}

/**
 * The in-memory seams of a publish-gated leaf: the seam contracts (README →
 * Seams → `PublicationStore`, `LiveView`). The effective fact is the last
 * recorded one whose `at` has arrived at `now` (the Effect `Clock`'s when
 * absent, so `TestClock` steers a schedule). A live row is the state at the
 * effective fact's version, with that version as its `version`, the
 * head's `action` and owner, `draft: false` and the fact's `at` as
 * `publishedAt`; a head row's `draft`
 * is whether the node has no live version. In memory only; not for
 * production.
 *
 * @since 0.1.0
 */
export const makeInMemoryPublication = (options: {
  readonly chain: InMemoryChainStore;
  readonly leaves: InMemoryLeafStore;
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the Effect `Clock`
  readonly now?: Date | undefined;
}): InMemoryPublication => {
  const fixedNow = Option.fromNullishOr(options.now);
  const localised = options.leaves.columns.has(LOCALE_COLUMN);
  /** A row as a localised view lists it: one per locale its version carries. */
  const listed = (row: LeafRow): ReadonlyArray<LeafRow> =>
    localised ? localeRows(row, localesAt(options.chain, row.id, row.version)) : [row];
  let log: ReadonlyArray<PublicationFact> = [];
  const effectiveAt = (id: string, now: Date) =>
    Arr.findLast(log, (fact) => fact.id === id && fact.at.getTime() <= now.getTime());
  const liveVersion = (id: string, now: Date) =>
    Option.flatMap(effectiveAt(id, now), (fact) =>
      Option.map(fact.version, (version) => ({ version, at: fact.at })),
    );
  const liveOf = (head: LeafRow, now: Date): Option.Option<LeafRow> =>
    Option.flatMap(liveVersion(head.id, now), ({ version, at }) =>
      Option.map(
        Arr.findFirst(options.chain.rows(), (row) => row.id === head.id && row.version === version),
        (row): LeafRow => {
          const base: LeafRow = {
            ...row.state,
            id: head.id,
            version,
            action: head.action,
            draft: false,
            publishedAt: at,
          };
          return Option.match(Option.fromUndefinedOr(head["ownerId"]), {
            onNone: () => base,
            onSome: (ownerId): LeafRow => ({ ...base, ownerId }),
          });
        },
      ),
    );
  const headOf = (head: LeafRow, now: Date): LeafRow => ({
    ...head,
    draft: Option.isNone(liveVersion(head.id, now)),
  });
  const atNow = <A>(read: (now: Date) => Effect.Effect<A>) =>
    Effect.flatMap(instantOf(fixedNow), read);
  const heads = () =>
    options.leaves.getMany(Arr.dedupe(Arr.map(options.chain.rows(), (row) => row.id)));
  /** The rows a live list reads: per node, its head for `headFor`, else its live row, else none. */
  const chosen = (headFor: ListFilter<InMemoryFollowing>, now: Date) =>
    Effect.map(heads(), (rows) =>
      Arr.flatMap(
        Arr.getSomes(
          Arr.map(rows, (head) =>
            evaluate(headFor, head, contextAt(now))
              ? Option.some(headOf(head, now))
              : liveOf(head, now),
          ),
        ),
        listed,
      ),
    );
  const facts: PublicationStore<never, never> = {
    record: (fact) =>
      Effect.sync(() => {
        log = [...log, fact];
      }),
    effective: (id) => Effect.map(instantOf(fixedNow), (now) => effectiveAt(id, now)),
    facts: (id, limit) => Effect.sync(() => log.filter((fact) => fact.id === id).slice(0, limit)),
  };
  const live: LiveView<LeafRow, InMemoryFollowing, never, never> = {
    get: (id) =>
      atNow((now) =>
        Effect.map(options.leaves.get(id), (head) =>
          Option.flatMap(head, (row) => liveOf(row, now)),
        ),
      ),
    getMany: (ids) =>
      atNow((now) =>
        Effect.map(options.leaves.getMany(ids), (rows) =>
          Arr.getSomes(Arr.map(rows, (row) => liveOf(row, now))),
        ),
      ),
    list: (query) =>
      atNow((now) => Effect.map(chosen(query.headFor, now), (rows) => viewPage(rows, query, now))),
    distinct: (query) =>
      atNow((now) =>
        Effect.map(chosen(query.headFor, now), (rows) => distinctPage(rows, query, now)),
      ),
  };
  const leaves: LeafStore<LeafRow, InMemoryFollowing, never, never> = {
    ...options.leaves,
    get: (id) =>
      atNow((now) =>
        Effect.map(options.leaves.get(id), (head) => Option.map(head, (row) => headOf(row, now))),
      ),
    getMany: (ids) =>
      atNow((now) =>
        Effect.map(options.leaves.getMany(ids), (rows) => Arr.map(rows, (row) => headOf(row, now))),
      ),
    list: (query) =>
      atNow((now) =>
        Effect.map(heads(), (rows) =>
          viewPage(
            Arr.flatMap(rows, (row) => listed(headOf(row, now))),
            query,
            now,
          ),
        ),
      ),
    distinct: (query) =>
      atNow((now) =>
        Effect.map(heads(), (rows) =>
          distinctPage(
            Arr.flatMap(rows, (row) => listed(headOf(row, now))),
            query,
            now,
          ),
        ),
      ),
  };
  return { facts, live, leaves, recorded: () => log };
};

// ── Working copies ────────────────────────────────────────────────────

/**
 * An in-memory {@link WorkingCopyStore}, plus the hook a test reads it
 * through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryWorkingCopyStore extends WorkingCopyStore<never, never> {
  /** Every copy, keyed `id:userId`. */
  readonly copies: () => HashMap.HashMap<string, WorkingCopy>;
}

/**
 * An in-memory {@link WorkingCopyStore}: the seam's contract (README →
 * Seams → `WorkingCopyStore`), one copy per `(id, userId)`. In memory only;
 * not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryWorkingCopyStore = (): InMemoryWorkingCopyStore => {
  let copies = HashMap.empty<string, WorkingCopy>();
  const keyOf = (key: WorkingCopyKey) => `${key.id}:${key.userId}`;
  return {
    put: (key, copy) =>
      Effect.sync(() => {
        copies = HashMap.set(copies, keyOf(key), copy);
      }),
    get: (key) => Effect.sync(() => HashMap.get(copies, keyOf(key))),
    discard: (key) =>
      Effect.sync(() => {
        copies = HashMap.remove(copies, keyOf(key));
      }),
    copies: () => copies,
  };
};

// ── Purge ─────────────────────────────────────────────────────────────

/**
 * Options for {@link makeInMemoryPurgeStore}.
 *
 * @since 0.1.0
 */
export interface InMemoryPurgeStoreOptions {
  /**
   * Every chain whose version rows may reference a document or bytes: the
   * purged node's rows are erased from each, and a hash is unreferenced when
   * no row left in any of them carries it.
   */
  readonly chains: ReadonlyArray<InMemoryChainStore>;
  /** The documents an unreferenced hash is deleted from; omitted, none is deleted (or reported). */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no document store"
  readonly documents?: Pick<InMemoryDocumentStore<Schema.Json>, "remove"> | undefined;
  /** The state columns that carry a `DocumentHash`; omitted, none do. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no document columns"
  readonly documentColumns?: ReadonlyArray<string> | undefined;
  /** The state columns that carry a `ContentHash` (a file leaf's `contentHash`); omitted, none do. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no content columns"
  readonly blobColumns?: ReadonlyArray<string> | undefined;
  /**
   * What else `eraseNode` deletes for the node: the rows other fakes keep
   * for it (an owner stamp through `InMemoryLeafStore.dropOwner`, working
   * copies, edges, …), as a real store's `ON DELETE CASCADE` would.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "nothing else"
  readonly dependents?: ReadonlyArray<(id: string) => void> | undefined;
}

/** The string values `columns` hold across `rows`, each once. */
const hashesIn = (
  rows: ReadonlyArray<VersionRow>,
  columns: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Arr.dedupe(
    Arr.flatMap(rows, (row) =>
      Arr.flatMap(columns, (column) => {
        const value = row.state[column];
        return Predicate.isString(value) ? [value] : [];
      }),
    ),
  );

/**
 * An in-memory {@link PurgeStore} over in-memory chains and a document
 * store: the seam's contract (README → Seams → `PurgeStore`). `eraseNode`
 * erases the node's rows from every chain and runs the `dependents`;
 * a hash is referenced while any row left in any chain carries it in a
 * declared column. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryPurgeStore = (
  options: InMemoryPurgeStoreOptions,
): PurgeStore<never, never> => {
  const documentColumns = options.documentColumns ?? [];
  const blobColumns = options.blobColumns ?? [];
  const remaining = () => Arr.flatMap(options.chains, (chain) => chain.rows());
  const unreferenced = <A extends string>(
    hashes: ReadonlyArray<A>,
    columns: ReadonlyArray<string>,
  ) => {
    const referenced = hashesIn(remaining(), columns);
    return hashes.filter((hash) => !referenced.includes(hash));
  };
  return {
    eraseNode: (id) =>
      Effect.sync((): ErasedReferences => {
        const erased = Arr.flatMap(options.chains, (chain) => chain.erase(id));
        Arr.forEach(options.dependents ?? [], (dependent) => dependent(id));
        return {
          documents: hashesIn(erased, documentColumns),
          blobs: hashesIn(erased, blobColumns),
        };
      }),
    deleteUnreferencedDocuments: (hashes) =>
      Effect.sync(() => {
        if (options.documents === undefined) return [];
        const deleted = unreferenced(hashes, documentColumns);
        options.documents.remove(deleted);
        return deleted;
      }),
    unreferencedBlobs: (hashes) => Effect.sync(() => unreferenced(hashes, blobColumns)),
  };
};

// ── Search (pulpit#204) ───────────────────────────────────────────────

/** A scored row, as the in-memory branch ranks it. */
interface ScoredRow {
  readonly row: { readonly id: string };
  readonly score: number;
}

/** Best score first, ties by id in code-point order. */
const scoredOrder: Order.Order<ScoredRow> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (hit: ScoredRow) => hit.score),
  Order.mapInput(byCodePoint, (hit: ScoredRow) => hit.row.id),
);

/**
 * An in-memory {@link SearchBranch} over `rows`: each row the scope admits
 * (evaluated at `now` over {@link InMemoryFollowing}) and `score` gives a
 * score for the query is a hit, best score first, ties by id, at most
 * `request.limit`. The reference semantics of the branch contract: it
 * applies the scope it is handed in the same pass that ranks.
 *
 * @since 0.1.0
 */
export const makeInMemorySearchBranch = (options: {
  readonly name: string;
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is weight 1
  readonly weight?: number | undefined;
  readonly rows: () => ReadonlyArray<FilterRow & { readonly id: string }>;
  /** The row's score for `query`, or none when it doesn't match. */
  readonly score: (row: FilterRow, query: string) => Option.Option<number>;
  readonly now: Date;
}): SearchBranch<InMemoryFollowing, never, never> => ({
  name: options.name,
  weight: options.weight,
  search: (request) =>
    Effect.sync(() =>
      Arr.take(
        Arr.sort(
          Arr.getSomes(
            Arr.map(
              Arr.filter(options.rows(), (row) =>
                evaluate(request.scope, row, contextAt(options.now)),
              ),
              (row) => Option.map(options.score(row, request.query), (score) => ({ row, score })),
            ),
          ),
          scoredOrder,
        ).map(({ row }): RankedHit => ({ id: row.id })),
        Math.max(0, request.limit),
      ),
    ),
});

/**
 * Wrap a {@link SearchBranch} so it fails {@link SearchScopeLeak} when it
 * returns a hit whose row (looked up in `rows` by id) the scope it was
 * handed does not admit, or that `rows` lacks: the test seam an
 * application wraps around its own SQL branches to prove each applies the
 * scope (`SEC-AUTH-ENUM-001`).
 *
 * @since 0.1.0
 */
export const scopeCheckedBranch = <E, R>(
  branch: SearchBranch<InMemoryFollowing, E, R>,
  options: {
    readonly rows: () => ReadonlyArray<FilterRow & { readonly id: string }>;
    readonly now: Date;
  },
): SearchBranch<InMemoryFollowing, E | SearchScopeLeak, R> => ({
  ...branch,
  search: (request) =>
    Effect.flatMap(branch.search(request), (hits) => {
      const byId = HashMap.fromIterable(Arr.map(options.rows(), (row) => [row.id, row] as const));
      const leak = Arr.findFirst(
        hits,
        (hit) =>
          !Option.exists(HashMap.get(byId, hit.id), (row) =>
            evaluate(request.scope, row, contextAt(options.now)),
          ),
      );
      return Option.match(leak, {
        onNone: () => Effect.succeed(hits),
        onSome: (hit) => Effect.fail(new SearchScopeLeak({ branch: branch.name, id: hit.id })),
      });
    }),
});

/**
 * {@link makeInMemoryEmbeddingStore}'s fake: the seam plus test hooks.
 *
 * @since 0.1.0
 */
export interface InMemoryEmbeddingStore extends EmbeddingStore<never, never> {
  /** The queued hashes, in queue order. */
  readonly queued: () => ReadonlyArray<DocumentHash>;
  /** The written vectors, by hash. */
  readonly vectors: () => HashMap.HashMap<DocumentHash, ReadonlyArray<number>>;
}

/**
 * An in-memory {@link EmbeddingStore}: a queue in insertion order
 * (`enqueue` is idempotent, and a hash with a vector is never queued again),
 * `pending` the oldest `limit` queued, `write` storing each vector and
 * dequeuing it, and `discard` dequeuing.
 *
 * @since 0.1.0
 */
export const makeInMemoryEmbeddingStore = (): InMemoryEmbeddingStore => {
  let queue: ReadonlyArray<DocumentHash> = [];
  let vectors = HashMap.empty<DocumentHash, ReadonlyArray<number>>();
  const dequeue = (hashes: ReadonlyArray<DocumentHash>) => {
    queue = Arr.filter(queue, (hash) => !Arr.contains(hashes, hash));
  };
  return {
    enqueue: (hash) =>
      Effect.sync(() => {
        if (!Arr.contains(queue, hash) && !HashMap.has(vectors, hash)) queue = [...queue, hash];
      }),
    pending: (limit) => Effect.sync(() => Arr.take(queue, Math.max(0, limit))),
    write: (written) =>
      Effect.sync(() => {
        vectors = Arr.reduce(written, vectors, (acc, { hash, vector }) =>
          HashMap.set(acc, hash, vector),
        );
        dequeue(Arr.map(written, ({ hash }) => hash));
      }),
    discard: (hashes) => Effect.sync(() => dequeue(hashes)),
    queued: () => queue,
    vectors: () => vectors,
  };
};

// ── Write budgets ─────────────────────────────────────────────────────

/**
 * One write {@link makeInMemoryWriteCountStore} has recorded.
 *
 * @since 0.1.0
 */
export interface RecordedWrite {
  readonly type: string;
  readonly action: string;
  readonly accountId: string;
  readonly at: Date;
}

type BudgetKey = Pick<RecordedWrite, "type" | "action" | "accountId">;
const sameBudgetKey = (left: BudgetKey, right: BudgetKey) =>
  left.type === right.type && left.action === right.action && left.accountId === right.accountId;

/**
 * An in-memory atomic {@link BudgetCounter}, plus the hook a test reads it
 * through. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryBudgetCounter extends BudgetCounter<never, never> {
  /** Every spend it admitted, in order. */
  readonly spends: () => ReadonlyArray<BudgetRequest>;
}

/**
 * An in-memory atomic {@link BudgetCounter} (README → Seams →
 * `BudgetCounter`): it counts the spends it admitted at or after the
 * request's `since`, and records a spend only when it answers `true`. One
 * JavaScript thread makes its check-and-record atomic. In memory only; not
 * for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryBudgetCounter = (): InMemoryBudgetCounter => {
  let spends: ReadonlyArray<BudgetRequest> = [];
  return {
    take: (request) =>
      Effect.sync(() => {
        const used = Arr.filter(
          spends,
          (spend) =>
            sameBudgetKey(spend, request) && spend.now.getTime() >= request.since.getTime(),
        ).length;
        if (used >= request.limit) return false;
        spends = [...spends, request];
        return true;
      }),
    spends: () => spends,
  };
};

/**
 * An in-memory {@link WriteCountStore}, plus `record`, the row a write
 * inserts. In memory only; not for production.
 *
 * @since 0.1.0
 */
export interface InMemoryWriteCountStore extends WriteCountStore<never, never> {
  /** Record one write, as the family's own row would. */
  readonly record: (write: RecordedWrite) => void;
}

/**
 * An in-memory {@link WriteCountStore} (README → Seams →
 * `WriteCountStore`): `countSince` counts the recorded writes of the key at
 * or after `since`. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryWriteCountStore = (): InMemoryWriteCountStore => {
  let writes: ReadonlyArray<RecordedWrite> = [];
  return {
    countSince: (query) =>
      Effect.sync(
        () =>
          Arr.filter(
            writes,
            (write) => sameBudgetKey(write, query) && write.at.getTime() >= query.since.getTime(),
          ).length,
      ),
    record: (write) => {
      writes = [...writes, write];
    },
  };
};
