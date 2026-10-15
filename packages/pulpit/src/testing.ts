/**
 * **In-memory fakes of the kernel's seams** — a store for each of the
 * version-chain, leaf, document and edge seams, an endpoint view and a follower
 * seam, all held in memory with no SQL. They are the reference semantics of
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
import type * as Schema from "effect/Schema";
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
import type { FollowerSeam, LeafRow, LeafStore } from "./subtype.ts";
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
 * Each node's row is its head version's state with its head `action`, and
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
    const base: LeafRow = { ...row.state, id: row.id, action: row.action };
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
    columns: new Set(["id", "action", "ownerId", ...options.columns]),
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

// ── Documents ─────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

/** SHA-256 over the canonical text's UTF-8 bytes, as 64 lowercase hex characters. */
const hashOf = (document: Schema.Json): Effect.Effect<DocumentHash> =>
  Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", utf8.encode(canonicalText(document))),
  ).pipe(
    // Web Crypto's SHA-256 over bytes has no failure a caller could act on.
    Effect.orDie,
    Effect.map((digest) =>
      Arr.map(Arr.fromIterable(new Uint8Array(digest)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

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
        if (!HashMap.has(documents, hash)) {
          documents = HashMap.set(documents, hash, document);
          writes += 1;
        }
        return hash;
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
 * are `id`, `action` and `columns`. An {@link InMemoryLeafStore} is an
 * endpoint view too. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryNodes = (columns: ReadonlyArray<string>): InMemoryNodes => {
  let nodes = HashMap.empty<string, LeafRow>();
  return {
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- the seam's column set is a `ReadonlySet`, the type `LeafStore.columns` already has, so a `LeafStore` satisfies `EndpointView`
    columns: new Set(["id", "action", ...columns]),
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
