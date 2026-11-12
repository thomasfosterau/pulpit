/**
 * **In-memory fakes of the kernel's seams** — a store for each of the
 * version-chain, leaf, document, edge, proposal, path, report, publication, purge and embedding seams, an
 * endpoint view, a follower seam, a search branch (with a scope check) and a resource cache, all held in memory with no SQL. They are the reference semantics of
 * each seam's contract in docs/seams.md, and the fakes the
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
 * import { makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";
 *
 * const store = makeInMemoryVersionChain("notes");
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
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md#testing.
 *
 * @copyright Thomas Foster
 * @module pulpit/testing
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
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
import type { AccountErasureStore } from "./erasure.ts";
import type { ErasedReferences, PurgeStore } from "./purge.ts";
import {
  SearchScopeLeak,
  type EmbeddingStore,
  type RankedHit,
  type SearchBranch,
} from "./search.ts";
import type { ReactionRow, ReactionStore } from "./reactions.ts";
import type { KvEntry, VersionedKv } from "./cache.ts";
import type { CollectionEntry, CollectionStore } from "./collections.ts";
import type {
  GroupOwnerStore,
  GroupOwnership,
  Invitation,
  Membership,
  MembershipStore,
} from "./audience.ts";
import type {
  DeliverySeam,
  InboxEntry,
  InboxStore,
  MentionExtractor,
  NotificationEvent,
  NotificationPreferences,
  OutboxStore,
  PreferenceStore,
} from "./notifications.ts";

import type { MediaReferences, NodeRef } from "./media.ts";
import type { ExternalIdLink, ExternalIdStore } from "./reference-import.ts";
import type { Relationship, SocialStore } from "./social.ts";
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
  LocalisedListQuery,
  Page,
  LiveView,
  PublicationFact,
  PublicationStore,
  ResourceCacheSeam,
} from "./subtype.ts";
import {
  applyLocalePatch,
  applyPatch,
  BrokenChain,
  localesOf,
  MAX_HISTORY_LIMIT,
  NodeAlreadyExists,
  NodeNotFound,
  StaleVersion,
  VersionConflict,
  VersionNotFound,
  type ChainPatch,
  type ChainState,
  type ColumnValue,
  type LocalePatch,
  type LocaleStates,
  type Precondition,
  type UpdateInput,
  type VersionAction,
  type VersionChain,
  type VersionChainEntry,
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
  contains: (set, value: ColumnValue) => P.isString(value) && HashSet.has(set, value),
});

/**
 * A node's rows in a localised view (pulpit#56): one per locale its version
 * carries, the locale's columns over the shared row and the tag in
 * {@link LOCALE_COLUMN}; a version carrying none is its shared row alone,
 * the `NULL`-locale row a left join gives.
 */
const localeRows = (row: LeafRow, locales: LocaleStates): ReadonlyArray<LeafRow> =>
  R.isEmptyRecord(locales)
    ? [row]
    : Arr.map(R.toEntries(locales), ([tag, columns]): LeafRow => ({
        ...row,
        ...columns,
        [LOCALE_COLUMN]: tag,
      }));

/** The locale level of `id` at `version` in an in-memory chain, `{}` for none. */
const localesAt = (chain: InMemoryVersionChain, id: string, version: bigint): LocaleStates =>
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
        return evaluate(query.where, row, contextAt(now)) && P.isString(value) ? [value] : [];
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
 * A localised list page (pulpit#272): of the rows matching `where` whose
 * locale is one of `locales`, per node the one whose locale comes first in
 * `locales`, then ordered and paged as {@link viewPage} does, `total`
 * counting nodes. `LeafStore.listLocalised`'s contract.
 */
const fallbackPage = (
  rows: ReadonlyArray<LeafRow>,
  query: LocalisedListQuery<InMemoryFollowing>,
  now: Date,
): Page<LeafRow> => {
  const rank = (row: LeafRow): number => {
    const tag = row[LOCALE_COLUMN];
    return P.isString(tag) ? query.locales.indexOf(tag) : -1;
  };
  const chosen = Arr.reduce(
    rows.filter((row) => rank(row) >= 0 && evaluate(query.where, row, contextAt(now))),
    HashMap.empty<string, LeafRow>(),
    (best, row) =>
      Option.match(HashMap.get(best, row.id), {
        onNone: () => HashMap.set(best, row.id, row),
        onSome: (held) => (rank(row) < rank(held) ? HashMap.set(best, row.id, row) : best),
      }),
  );
  return viewPage(HashMap.toValues(chosen), query, now);
};

/**
 * An in-memory {@link FollowerSeam} over an explicit table of who follows
 * whom: each entry is a follower's id and the ids of the accounts it
 * follows. `isFollower` answers from the table and `following` returns the
 * follower's row as an {@link InMemoryFollowing} set (empty for an account the
 * table doesn't name), the in-memory reading of effect-auth's `IsFollower`
 * (docs/seams.md → the follower seam). In memory only; not for production.
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
 * An in-memory {@link VersionChain} for one leaf, plus the hooks a test
 * reads and steers it through. In memory only; not for production.
 *
 * @since 0.2.0
 */
export interface InMemoryVersionChain extends VersionChain<never, never> {
  /** The leaf's wire type, which every error the chain raises names. */
  readonly type: string;
  /** Every row ever appended, in append order — what the append-only assertions read. */
  readonly rows: () => ReadonlyArray<VersionRow>;
  /** Simulate a partial chain: the state at `(id, version)` is no longer reconstructable. */
  readonly dropState: (id: string, version: bigint) => void;
  /** Simulate a concurrent writer: the next append for `id` finds its version taken. */
  readonly raceNextAppend: (id: string) => void;
}

/** The write clock: the current instant, as the `Date` a version row stores. */
const writeClock: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.toDate(DateTime.makeUnsafe(millis)),
);

/** What a write stores: the shared state and, when it carries any locale, the locale level. */
type Written = Pick<VersionSnapshot, "state" | "locales">;

/** The state a write stores: `patch` over `base`, and the locale patch over its locale level. */
const nextContent = (
  base: Pick<VersionSnapshot, "state" | "locales">,
  patch: ChainPatch,
  locales: LocalePatch,
): Written => {
  const state = applyPatch(base.state, patch);
  const level = applyLocalePatch(localesOf(base), locales);
  return R.isEmptyRecord(level) ? { state } : { state, locales: level };
};

/**
 * An in-memory {@link VersionChain} for leaf `type` (pulpit#246): the port's
 * contract (docs/seams.md → `VersionChain`) over an append log, holding
 * every invariant `./version-chain`'s module doc states, as
 * `versionChainConformance` checks. The log's `(id, version)` pair is
 * unique, as the Drizzle tables' primary key is: an append at a taken pair
 * fails `VersionConflict`, which is what makes the expected-version check
 * atomic. An id it is not given is minted sequentially, UUID-shaped.
 *
 * `dropState` simulates a partial chain (a level with no row at a version),
 * which a real database reaches through a missing leaf row, and
 * `raceNextAppend` a writer that takes the next version first. In memory
 * only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryVersionChain = (type: string): InMemoryVersionChain => {
  let log: ReadonlyArray<VersionRow> = [];
  let dropped = HashSet.empty<string>();
  let raced = HashSet.empty<string>();
  let minted = 0;
  const key = (id: string, version: bigint) => `${id}@${version}`;
  const rowsOf = (id: string) => log.filter((row) => row.id === id);

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

  const head = (id: string) => Effect.sync(() => Option.map(Arr.last(rowsOf(id)), entryOf));

  /** The full state at `(id, version)`, or none when it cannot be reconstructed. */
  const snapshot = (id: string, version: bigint) =>
    Effect.sync(() =>
      HashSet.has(dropped, key(id, version))
        ? Option.none<VersionSnapshot>()
        : Option.map(
            Arr.findFirst(rowsOf(id), (candidate) => candidate.version === version),
            (row): VersionSnapshot =>
              row.locales === undefined
                ? { ...entryOf(row), state: row.state }
                : { ...entryOf(row), state: row.state, locales: row.locales },
          ),
    );

  /** Append one row; a taken `(id, version)` (or a raced append) is `VersionConflict`. */
  const append = (row: VersionRow) =>
    Effect.suspend(() => {
      if (takeRace(row.id) || rowsOf(row.id).some((taken) => taken.version === row.version)) {
        return Effect.fail(new VersionConflict({ id: row.id, version: row.version }));
      }
      log = [...log, row];
      return Effect.void;
    });

  /** The head and its full state. A head without a state is a broken chain: a defect. */
  const current = (id: string) =>
    Effect.gen(function* () {
      const entry = yield* head(id);
      if (Option.isNone(entry)) return Option.none<VersionSnapshot>();
      const state = yield* snapshot(id, entry.value.version);
      if (Option.isNone(state)) {
        return yield* Effect.die(new BrokenChain({ type, id, version: entry.value.version }));
      }
      return state;
    });

  /**
   * Append at `previous + 1`, after checking the precondition against that
   * same `previous`: the check and the append's version come from one read,
   * so a writer that lands in between takes `previous + 1` first and this
   * append fails the log's key.
   */
  const appendNext = (
    id: string,
    previous: VersionChainEntry,
    action: VersionAction,
    content: Written,
    actorId: Option.Option<string>,
    precondition: Precondition,
    proposedBy: Option.Option<string> = Option.none(),
  ) =>
    Effect.gen(function* () {
      const expected = precondition.expectedVersion;
      if (expected !== undefined && expected !== previous.version) {
        return yield* new StaleVersion({ type, id, expected, current: previous.version });
      }
      const version = previous.version + 1n;
      const timestamp = yield* writeClock;
      yield* append({ id, type, version, action, timestamp, ...content, actorId, proposedBy });
      return { id, version };
    });

  const merge = (input: UpdateInput, allowDeleted: boolean) =>
    Effect.gen(function* () {
      const prior = yield* current(input.id);
      if (Option.isNone(prior) || (prior.value.action === "delete" && !allowDeleted)) {
        return yield* new NodeNotFound({ type, id: input.id });
      }
      return yield* appendNext(
        input.id,
        prior.value,
        "update",
        nextContent(prior.value, input.patch, input.locales ?? {}),
        input.actorId,
        input,
        input.proposedBy,
      );
    });

  return {
    type,
    create: (input) =>
      Effect.gen(function* () {
        const id = Option.isSome(input.id)
          ? input.id.value
          : yield* Effect.sync(() => {
              minted += 1;
              return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
            });
        if (Option.isSome(yield* head(id))) return yield* new NodeAlreadyExists({ type, id });
        const timestamp = yield* writeClock;
        yield* append({
          id,
          type,
          version: 0n,
          action: "create",
          timestamp,
          ...nextContent({ state: {} }, input.state, input.locales ?? {}),
          actorId: input.actorId,
          proposedBy: Option.none(),
        }).pipe(
          // A racing create that took the id between the check above and
          // this append surfaces as the version-0 collision.
          Effect.mapError((error) =>
            error.version === 0n ? new NodeAlreadyExists({ type, id }) : error,
          ),
        );
        return { id, version: 0n };
      }),
    update: (input) => merge(input, false),
    restore: (input) => merge(input, true),
    delete: (id, actorId, precondition = {}) =>
      Effect.gen(function* () {
        const prior = yield* current(id);
        if (Option.isNone(prior)) return yield* new NodeNotFound({ type, id });
        if (prior.value.action === "delete") {
          return { id, version: prior.value.version, alreadyDeleted: true };
        }
        const written = yield* appendNext(
          id,
          prior.value,
          "delete",
          nextContent(prior.value, {}, {}),
          actorId,
          precondition,
        );
        return { ...written, alreadyDeleted: false };
      }),
    restoreVersion: (id, version, actorId, precondition = {}) =>
      Effect.gen(function* () {
        // Read the whole historical state FIRST, so an unreconstructable
        // version fails before the chain is touched at all.
        const restored = yield* snapshot(id, version);
        if (Option.isNone(restored)) return yield* new VersionNotFound({ type, id, version });
        const entry = yield* head(id);
        if (Option.isNone(entry)) return yield* new VersionNotFound({ type, id, version });
        // `update`, not a fourth action: a restore is an ordinary edit whose
        // content came from history; every locale is restored together with
        // the shared columns, over nothing.
        return yield* appendNext(
          id,
          entry.value,
          "update",
          nextContent({ state: {} }, restored.value.state, localesOf(restored.value)),
          actorId,
          precondition,
        );
      }),
    getVersion: (id, version) =>
      Effect.flatMap(snapshot(id, version), (found) =>
        Effect.fromOption(found, () => new VersionNotFound({ type, id, version })),
      ),
    history: (id, limit = MAX_HISTORY_LIMIT) =>
      Effect.suspend(() => {
        const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_HISTORY_LIMIT));
        return Arr.match(rowsOf(id).slice(0, bounded).map(entryOf), {
          onEmpty: () => Effect.fail(new NodeNotFound({ type, id })),
          onNonEmpty: (entries) => Effect.succeed<ReadonlyArray<VersionChainEntry>>(entries),
        });
      }),
    head,
    purge: (id) =>
      Effect.sync(() => {
        log = log.filter((row) => row.id !== id);
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

// ── The version chain's conformance suite ─────────────────────────────

/**
 * How a {@link versionChainConformance} case fails when the chain answers
 * other than the case expects: thrown at the test runner's Promise boundary,
 * which reports it as the case's failure.
 */
class ConformanceFailure extends Schema.TaggedError<
  ConformanceFailure,
  { readonly brand: unique symbol }
>()("ConformanceFailure", { message: Schema.String }) {}

/**
 * The slice of a test runner {@link versionChainConformance} registers its
 * cases through, passed in rather than imported so `./testing` needs no
 * test-runner dependency (pulpit#246, owner decision (b)): vitest's (and
 * vite-plus/test's) `describe`, `it` and `expect` fit it as they are.
 *
 * @since 0.2.0
 */
export interface ConformanceRunner {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
  readonly expect: <A>(actual: A) => {
    readonly toEqual: (expected: A) => void;
    readonly toBe: (expected: A) => void;
    readonly toMatchObject: (expected: Partial<A>) => void;
  };
}

/**
 * One fresh {@link VersionChain} for a conformance case, and the faults the
 * harness can inject into it. Each simulation is optional: a case that needs
 * one the harness lacks is not registered (a real database reaches a partial
 * chain only through a broken table, and a lost race through a second
 * connection, which its own integration suite drives).
 *
 * @since 0.2.0
 */
export interface ConformanceChain<E, R> {
  readonly chain: VersionChain<E, R>;
  /** Make the state at `(id, version)` unreconstructable (a level with no row there). */
  readonly dropState?: (id: string, version: bigint) => void | Promise<void>;
  /** Make the next append for `id` find its version taken by a concurrent writer. */
  readonly raceNextAppend?: (id: string) => void | Promise<void>;
}

/**
 * How {@link versionChainConformance} reaches the implementation under test.
 *
 * @since 0.2.0
 */
export interface ConformanceHarness<E, R> {
  /** The leaf's wire type: every error the chain raises must name it. */
  readonly type: string;
  /** A fresh, empty chain for one case (a new in-memory chain; a truncated table). */
  readonly make: () => Promise<ConformanceChain<E, R>>;
  /** Run one of the chain's effects to its exit (providing its transaction, for a database). */
  readonly run: <A, E2>(effect: Effect.Effect<A, E2, R>) => Promise<Exit.Exit<A, E2>>;
}

/**
 * The version chain's conformance suite (pulpit#246): every invariant
 * `./version-chain`'s module doc states, as cases registered through
 * `runner`, against whatever `harness` makes. The kernel's unit suite runs
 * it against {@link makeInMemoryVersionChain}, and pulpit-drizzle-pg's
 * integration suite against its Drizzle chain, so the two cannot drift.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { makeInMemoryVersionChain, versionChainConformance } from "@thomasfosterau/pulpit/testing";
 *
 * // A runner that only counts the cases, where a test file passes vitest's.
 * let cases = 0;
 * versionChainConformance(
 *   {
 *     type: "posts",
 *     make: async () => ({ chain: makeInMemoryVersionChain("posts") }),
 *     run: (effect) => Effect.runPromiseExit(effect),
 *   },
 *   {
 *     describe: (_name, body) => body(),
 *     it: () => {
 *       cases += 1;
 *     },
 *     expect: () => ({ toEqual: () => {}, toBe: () => {}, toMatchObject: () => {} }),
 *   },
 * );
 * strictEqual(cases > 30, true);
 * ```
 *
 * @since 0.2.0
 */
export const versionChainConformance = <E, R>(
  harness: ConformanceHarness<E, R>,
  runner: ConformanceRunner,
): void => {
  const { type } = harness;
  const { describe, it, expect } = runner;
  const ACTOR = Option.some("u-author");
  const ID = "00000000-0000-4000-8000-00000000abcd";
  const OTHER = "00000000-0000-4000-8000-00000000beef";
  const initial: ChainState = { title: "First", body: "Hello", summary: "s" };

  // The suite's helpers live at the test runner's Promise boundary: a thrown
  // `ConformanceFailure` is how a case fails.
  /** Run to the value, or throw the failure (so a case fails on it). */
  const value = async <A, E2>(effect: Effect.Effect<A, E2, R>): Promise<A> => {
    const exit = await harness.run(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    throw new ConformanceFailure({
      message: `${type} conformance: unexpected failure ${String(exit.cause)}`,
    });
  };
  /** The failure's `_tag`, `"success"`, or `"defect"` for a die. */
  const outcome = async <A, E2>(effect: Effect.Effect<A, E2, R>): Promise<string> => {
    const exit = await harness.run(effect);
    if (Exit.isSuccess(exit)) return "success";
    return Option.match(Exit.findErrorOption(exit), {
      onNone: () => "defect",
      onSome: (error) =>
        P.hasProperty(error, "_tag") && P.isString(error._tag) ? error._tag : "error",
    });
  };
  /** The typed failure itself, or throw (so a case fails) when there is none. */
  const failure = async <A, E2>(effect: Effect.Effect<A, E2, R>): Promise<E2> => {
    const error = Exit.findErrorOption(await harness.run(effect));
    if (Option.isSome(error)) return error.value;
    throw new ConformanceFailure({ message: `${type} conformance: expected a typed failure` });
  };

  /** A fresh chain holding node `ID` at version 0 with `initial`. */
  const created = async () => {
    const context = await harness.make();
    await value(context.chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    return context;
  };
  /** The chain's versions and actions, oldest first. */
  const actions = async (chain: VersionChain<E, R>, id: string = ID) =>
    Arr.map(await value(chain.history(id)), (entry) => [entry.version, entry.action] as const);
  const stateAt = async (chain: VersionChain<E, R>, version: bigint, id: string = ID) =>
    (await value(chain.getVersion(id, version))).state;

  /** Each write that extends an existing chain, under a precondition. */
  const extending: ReadonlyArray<
    readonly [
      string,
      (
        chain: VersionChain<E, R>,
        precondition: Precondition,
      ) => Effect.Effect<
        unknown,
        E | NodeNotFound | StaleVersion | VersionConflict | VersionNotFound,
        R
      >,
    ]
  > = [
    [
      "update",
      (chain, precondition) =>
        chain.update({ id: ID, patch: { title: "Next" }, actorId: ACTOR, ...precondition }),
    ],
    [
      "restore",
      (chain, precondition) =>
        chain.restore({ id: ID, patch: { title: "Next" }, actorId: ACTOR, ...precondition }),
    ],
    ["delete", (chain, precondition) => chain.delete(ID, ACTOR, precondition)],
    ["restoreVersion", (chain, precondition) => chain.restoreVersion(ID, 0n, ACTOR, precondition)],
  ];

  describe(`VersionChain conformance: ${type}`, () => {
    describe("create — never an upsert", () => {
      it("inserts the node at version 0, minting an id when none is given", async () => {
        const { chain } = await harness.make();
        const written = await value(
          chain.create({ id: Option.none(), state: initial, actorId: ACTOR }),
        );
        expect(written.version).toBe(0n);
        expect(await actions(chain, written.id)).toEqual([[0n, "create"]]);
        expect(await stateAt(chain, 0n, written.id)).toEqual(initial);
      });
      it("uses a caller's id, and fails NodeAlreadyExists on a taken one, writing nothing", async () => {
        const { chain } = await created();
        expect(
          await failure(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR })),
        ).toMatchObject({
          _tag: "NodeAlreadyExists",
          type,
          id: ID,
        });
        expect(await actions(chain)).toEqual([[0n, "create"]]);
      });
    });

    describe("update — append-only, tri-state (VERSION-CHAIN-001/002)", () => {
      it("appends at N_max + 1: a value sets, null clears, an absent or undefined key carries forward", async () => {
        const { chain } = await created();
        const written = await value(
          chain.update({
            id: ID,
            patch: { title: "Second", summary: null, body: undefined },
            actorId: ACTOR,
          }),
        );
        expect(written).toEqual({ id: ID, version: 1n });
        expect(await stateAt(chain, 1n)).toEqual({ title: "Second", body: "Hello", summary: null });
      });
      it("never rewrites an existing version", async () => {
        const { chain } = await created();
        const before = await value(chain.history(ID));
        await value(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
        await value(chain.update({ id: ID, patch: { title: "Third" }, actorId: ACTOR }));
        expect(await stateAt(chain, 0n)).toEqual(initial);
        expect<typeof before>((await value(chain.history(ID))).slice(0, 1)).toEqual(before);
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "update"],
          [2n, "update"],
        ]);
      });
      it("fails NodeNotFound for an unknown id", async () => {
        const { chain } = await harness.make();
        expect(await failure(chain.update({ id: OTHER, patch: {}, actorId: ACTOR }))).toMatchObject(
          {
            _tag: "NodeNotFound",
            type,
            id: OTHER,
          },
        );
      });
      it("never resurrects a tombstone (VERSION-CHAIN-006)", async () => {
        const { chain } = await created();
        await value(chain.delete(ID, ACTOR));
        expect(
          await outcome(chain.update({ id: ID, patch: { title: "Back" }, actorId: ACTOR })),
        ).toBe("NodeNotFound");
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "delete"],
        ]);
      });
    });

    describe("restore — the explicit resurrection surface", () => {
      it("writes over a tombstone as an update, carrying the tombstone's state forward", async () => {
        const { chain } = await created();
        await value(chain.delete(ID, ACTOR));
        expect(
          await value(chain.restore({ id: ID, patch: { title: "Back" }, actorId: ACTOR })),
        ).toEqual({
          id: ID,
          version: 2n,
        });
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "delete"],
          [2n, "update"],
        ]);
        expect(await stateAt(chain, 2n)).toEqual({ ...initial, title: "Back" });
      });
      it("fails NodeNotFound for an unknown id", async () => {
        const { chain } = await harness.make();
        expect(await outcome(chain.restore({ id: OTHER, patch: {}, actorId: ACTOR }))).toBe(
          "NodeNotFound",
        );
      });
    });

    describe("delete — the tombstone", () => {
      it("appends a delete version that carries the full state forward", async () => {
        const { chain } = await created();
        expect(await value(chain.delete(ID, ACTOR))).toEqual({
          id: ID,
          version: 1n,
          alreadyDeleted: false,
        });
        expect(await stateAt(chain, 1n)).toEqual(initial);
      });
      it("is idempotent: on a tombstone it returns it and writes nothing, whatever the precondition", async () => {
        const { chain } = await created();
        await value(chain.delete(ID, ACTOR));
        expect(await value(chain.delete(ID, ACTOR, { expectedVersion: 99n }))).toEqual({
          id: ID,
          version: 1n,
          alreadyDeleted: true,
        });
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "delete"],
        ]);
      });
      it("fails NodeNotFound for an unknown id", async () => {
        const { chain } = await harness.make();
        expect(await outcome(chain.delete(OTHER, ACTOR))).toBe("NodeNotFound");
      });
    });

    describe("getVersion / restoreVersion — history as data", () => {
      it("getVersion reconstructs any version, and fails VersionNotFound for an unknown one", async () => {
        const { chain } = await created();
        await value(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
        const first = await value(chain.getVersion(ID, 0n));
        expect(first).toMatchObject({ version: 0n, action: "create", state: initial });
        expect(first.timestamp instanceof Date).toBe(true);
        expect(await failure(chain.getVersion(ID, 7n))).toMatchObject({
          _tag: "VersionNotFound",
          type,
          id: ID,
          version: 7n,
        });
        expect(await outcome(chain.getVersion(OTHER, 0n))).toBe("VersionNotFound");
      });
      it("restoreVersion re-applies a version as a NEW update version", async () => {
        const { chain } = await created();
        await value(
          chain.update({ id: ID, patch: { title: "Second", summary: null }, actorId: ACTOR }),
        );
        expect(await value(chain.restoreVersion(ID, 0n, ACTOR))).toEqual({ id: ID, version: 2n });
        expect(await stateAt(chain, 2n)).toEqual(initial);
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "update"],
          [2n, "update"],
        ]);
      });
      it("restoreVersion restores over a tombstone, and from one", async () => {
        const { chain } = await created();
        await value(chain.delete(ID, ACTOR));
        await value(chain.restoreVersion(ID, 1n, ACTOR));
        expect(await actions(chain)).toEqual([
          [0n, "create"],
          [1n, "delete"],
          [2n, "update"],
        ]);
        expect(await stateAt(chain, 2n)).toEqual(initial);
      });
      it("restoreVersion fails VersionNotFound for an unknown version, writing nothing", async () => {
        const { chain } = await created();
        expect(await failure(chain.restoreVersion(ID, 5n, ACTOR))).toMatchObject({
          _tag: "VersionNotFound",
          type,
          version: 5n,
        });
        expect(await outcome(chain.restoreVersion(OTHER, 0n, ACTOR))).toBe("VersionNotFound");
        expect(await actions(chain)).toEqual([[0n, "create"]]);
      });
    });

    describe("history — bounded (PERF-DB-001)", () => {
      it("lists the chain oldest first, every entry with its timestamp", async () => {
        const { chain } = await created();
        await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
        await value(chain.delete(ID, ACTOR));
        const entries = await value(chain.history(ID));
        expect(Arr.map(entries, (entry) => [entry.version, entry.action])).toEqual([
          [0n, "create"],
          [1n, "update"],
          [2n, "delete"],
        ]);
        expect(entries.every((entry) => entry.timestamp instanceof Date)).toBe(true);
      });
      it("applies the limit, clamping a non-positive one to 1 and an oversized one to the cap", async () => {
        const { chain } = await created();
        await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
        await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
        expect((await value(chain.history(ID, 2))).length).toBe(2);
        expect((await value(chain.history(ID, 0))).length).toBe(1);
        expect((await value(chain.history(ID, 1_000_000))).length).toBe(3);
        expect((await value(chain.history(ID))).length).toBe(3);
      });
      it("fails NodeNotFound for an id with no versions", async () => {
        const { chain } = await harness.make();
        expect(await failure(chain.history(OTHER))).toMatchObject({
          _tag: "NodeNotFound",
          type,
          id: OTHER,
        });
      });
    });

    describe("head", () => {
      it("is none for an unknown id, and the latest entry once written", async () => {
        const { chain } = await created();
        expect(await value(chain.head(OTHER))).toEqual(Option.none());
        await value(chain.delete(ID, ACTOR));
        expect(
          Option.map(await value(chain.head(ID)), (entry) => [entry.version, entry.action]),
        ).toEqual(Option.some([1n, "delete"]));
      });
    });

    describe("expectedVersion — a precondition on the append", () => {
      Arr.forEach(extending, ([name, write]) => {
        it(`${name}: writes when the expected version is the head`, async () => {
          const { chain } = await created();
          expect(await outcome(write(chain, { expectedVersion: 0n }))).toBe("success");
          expect((await value(chain.history(ID))).length).toBe(2);
        });
        it(`${name}: a stale or ahead expected version is StaleVersion, carrying the head, and writes nothing`, async () => {
          const { chain } = await created();
          await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
          expect(await failure(write(chain, { expectedVersion: 0n }))).toMatchObject({
            _tag: "StaleVersion",
            type,
            id: ID,
            expected: 0n,
            current: 1n,
          });
          expect(await outcome(write(chain, { expectedVersion: 9n }))).toBe("StaleVersion");
          expect((await value(chain.history(ID))).length).toBe(2);
        });
        it(`${name}: without one it extends whatever the head is`, async () => {
          const { chain } = await created();
          await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
          expect(await outcome(write(chain, {}))).toBe("success");
        });
      });
      it("restore over a tombstone checks the tombstone's version; update still refuses it", async () => {
        const { chain } = await created();
        await value(chain.delete(ID, ACTOR));
        expect(
          await outcome(chain.restore({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 0n })),
        ).toBe("StaleVersion");
        expect(
          await outcome(chain.update({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 1n })),
        ).toBe("NodeNotFound");
        expect(
          await outcome(chain.restore({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 1n })),
        ).toBe("success");
      });
      it("an unknown id is NodeNotFound, and an unknown restore target VersionNotFound, before the precondition", async () => {
        const { chain } = await created();
        expect(
          await outcome(
            chain.update({ id: OTHER, patch: {}, actorId: ACTOR, expectedVersion: 3n }),
          ),
        ).toBe("NodeNotFound");
        expect(await outcome(chain.delete(OTHER, ACTOR, { expectedVersion: 3n }))).toBe(
          "NodeNotFound",
        );
        expect(await outcome(chain.restoreVersion(ID, 8n, ACTOR, { expectedVersion: 3n }))).toBe(
          "VersionNotFound",
        );
      });
      it("is race-safe: two writers expecting the same head cannot both write", async () => {
        const { chain } = await created();
        const results = await Promise.all([
          outcome(
            chain.update({ id: ID, patch: { title: "A" }, actorId: ACTOR, expectedVersion: 0n }),
          ),
          outcome(
            chain.update({ id: ID, patch: { title: "B" }, actorId: ACTOR, expectedVersion: 0n }),
          ),
        ]);
        expect(Arr.filter(results, (result) => result === "success").length).toBe(1);
        expect(
          Arr.filter(results, (result) => result === "StaleVersion" || result === "VersionConflict")
            .length,
        ).toBe(1);
        expect((await value(chain.history(ID))).length).toBe(2);
      });
    });

    describe("locales — the keyed level (pulpit#56)", () => {
      // A translated column is never a shared one (a tree rejects a key both
      // levels of one path declare), so the locale level writes `heading`.
      it("a version carries its locale level: set, drop (null) and carry forward, restored together", async () => {
        const { chain } = await harness.make();
        await value(
          chain.create({
            id: Option.some(ID),
            state: { title: "a" },
            locales: { en: { heading: "Hello" }, fr: { heading: "Salut" } },
            actorId: ACTOR,
          }),
        );
        await value(
          chain.update({
            id: ID,
            patch: {},
            locales: { en: { heading: "Hi" }, fr: null },
            actorId: ACTOR,
          }),
        );
        expect(localesOf(await value(chain.getVersion(ID, 1n)))).toEqual({ en: { heading: "Hi" } });
        await value(chain.restoreVersion(ID, 0n, ACTOR));
        expect(localesOf(await value(chain.getVersion(ID, 2n)))).toEqual({
          en: { heading: "Hello" },
          fr: { heading: "Salut" },
        });
      });
    });

    describe("purge — the erasure's whole-chain delete (pulpit#58)", () => {
      it("deletes the node's whole chain and nothing else; an unknown id is a no-op", async () => {
        const { chain } = await created();
        await value(chain.create({ id: Option.some(OTHER), state: initial, actorId: ACTOR }));
        await value(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
        await value(chain.purge(ID));
        expect(await value(chain.head(ID))).toEqual(Option.none());
        expect(await outcome(chain.history(ID))).toBe("NodeNotFound");
        expect(await outcome(chain.getVersion(ID, 0n))).toBe("VersionNotFound");
        expect(await actions(chain, OTHER)).toEqual([[0n, "create"]]);
        expect(await outcome(chain.purge("00000000-0000-4000-8000-0000000000ff"))).toBe("success");
      });
    });

    describe("faults the harness can inject", () => {
      Arr.forEach(extending, ([name, write]) => {
        it(`${name}: a lost race at the append is VersionConflict, never retried over`, async () => {
          const context = await created();
          if (context.raceNextAppend === undefined) return;
          await context.raceNextAppend(ID);
          expect(await failure(write(context.chain, { expectedVersion: 0n }))).toMatchObject({
            _tag: "VersionConflict",
            id: ID,
            version: 1n,
          });
          expect(await actions(context.chain)).toEqual([[0n, "create"]]);
        });
      });
      it("a create that loses the race for its id is NodeAlreadyExists", async () => {
        const context = await harness.make();
        if (context.raceNextAppend === undefined) return;
        await context.raceNextAppend(ID);
        expect(
          await outcome(context.chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR })),
        ).toBe("NodeAlreadyExists");
      });
      it("no partial restore: a version some level cannot rebuild is VersionNotFound, before anything is written", async () => {
        const context = await created();
        if (context.dropState === undefined) return;
        await value(context.chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
        await context.dropState(ID, 0n);
        expect(await outcome(context.chain.getVersion(ID, 0n))).toBe("VersionNotFound");
        expect(await outcome(context.chain.restoreVersion(ID, 0n, ACTOR))).toBe("VersionNotFound");
        expect(await actions(context.chain)).toEqual([
          [0n, "create"],
          [1n, "update"],
        ]);
      });
      it("a head with no reconstructable state is a defect, not a typed miss", async () => {
        const context = await created();
        if (context.dropState === undefined) return;
        await context.dropState(ID, 0n);
        expect(await outcome(context.chain.update({ id: ID, patch: {}, actorId: ACTOR }))).toBe(
          "defect",
        );
      });
    });
  });
};

// ── The leaf view ─────────────────────────────────────────────────────

/**
 * An in-memory {@link LeafStore} over an {@link InMemoryVersionChain}, plus the
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
  readonly localised?: boolean;
  /** The instant `published` / `notPublished` compare against; the Effect `Clock`'s at each `list` when absent. */
  readonly now?: Date;
}

/**
 * An in-memory {@link LeafStore}: the seam's contract (docs/seams.md →
 * `LeafStore`) as a current-version view over an {@link InMemoryVersionChain}.
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
  chain: InMemoryVersionChain,
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
    columns: HashSet.make(
      "id",
      "version",
      "action",
      "ownerId",
      ...options.columns,
      ...(options.localised === true ? [LOCALE_COLUMN] : []),
    ),
    get: (id) => Effect.sync(() => Arr.findFirst(view(), (row) => row.id === id)),
    getMany: (ids) => Effect.sync(() => view().filter((row) => ids.includes(row.id))),
    list: (query) => Effect.map(instantOf(fixedNow), (now) => viewPage(listed(), query, now)),
    listLocalised: (query) =>
      Effect.map(instantOf(fixedNow), (now) => fallbackPage(listed(), query, now)),
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
 * An in-memory {@link PathStore}: the seam's contract (docs/seams.md →
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
  /**
   * The resource the cache would serve for `id` (in `locale`, on a
   * localised leaf): none when evicted, refused or never set.
   */
  readonly get: (id: string, locale?: string) => Option.Option<Resource>;
  /** The highest version the cache holds for `id`, set or evicted, or none. */
  readonly versionOf: (id: string) => Option.Option<bigint>;
}

/** The key of an unlocalised entry: no locale tag is empty (`defineLocaleLevel`'s writes refuse one). */
const NO_LOCALE = "";

/**
 * An in-memory {@link ResourceCacheSeam}: the seam's compare-on-set contract
 * (docs/seams.md → the resource cache, pulpit#121). It keeps, per id, the
 * highest version either call has given it: a `set` below it is a no-op, a
 * `set` at or above it stores the resource when `serveable` admits it and
 * evicts it otherwise, and a `delete` evicts and raises the version. Each
 * call compares and writes in one step, as the real cache's conditional write
 * must. A localised leaf's entries are keyed by locale under the one
 * per-id version (pulpit#184): a `set` above the held version drops the id's
 * other locales, and a `delete` evicts them all. In memory only; not for
 * production.
 *
 * @since 0.1.0
 */
export const makeInMemoryResourceCache = <Resource>(
  serveable: (resource: Resource) => boolean,
): InMemoryResourceCache<Resource> => {
  let entries = HashMap.empty<
    string,
    { readonly version: bigint; readonly resources: HashMap.HashMap<string, Resource> }
  >();
  const versionOf = (id: string) => Option.map(HashMap.get(entries, id), (entry) => entry.version);
  const behind = (id: string, version: bigint) =>
    Option.exists(versionOf(id), (held) => version < held);
  return {
    set: (id, resource, version, locale) =>
      Effect.sync(() => {
        if (behind(id, version)) return;
        // The same version keeps the id's other locales; a newer one drops them.
        const kept = Option.match(HashMap.get(entries, id), {
          onNone: () => HashMap.empty<string, Resource>(),
          onSome: (entry) =>
            entry.version === version ? entry.resources : HashMap.empty<string, Resource>(),
        });
        const key = locale ?? NO_LOCALE;
        entries = HashMap.set(entries, id, {
          version,
          resources: serveable(resource)
            ? HashMap.set(kept, key, resource)
            : HashMap.remove(kept, key),
        });
      }),
    delete: (id, version) =>
      Effect.sync(() => {
        if (behind(id, version)) return;
        entries = HashMap.set(entries, id, { version, resources: HashMap.empty() });
      }),
    get: (id, locale) =>
      Option.flatMap(HashMap.get(entries, id), (entry) =>
        HashMap.get(entry.resources, locale ?? NO_LOCALE),
      ),
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
 * An in-memory {@link DocumentStore}: the seam's contract (docs/seams.md →
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
 * (docs/seams.md → `EdgeStore`) as rows a test puts by hand, for an edge
 * suite that doesn't need the endpoint leaf's version chain. Its `columns`
 * are `id`, `version`, `action` and `columns`. An {@link InMemoryLeafStore} is an
 * endpoint view too. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryNodes = (columns: ReadonlyArray<string>): InMemoryNodes => {
  let nodes = HashMap.empty<string, LeafRow>();
  return {
    columns: HashSet.make("id", "version", "action", ...columns),
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
  readonly now?: Date;
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
 * An in-memory {@link EdgeStore}: the seam's contract (docs/seams.md →
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
        R.toEntries(options.ends),
        ([alias, end]) => {
          const nodeId = row[end.column];
          return P.isString(nodeId)
            ? Effect.map(
                end.nodes.get(nodeId),
                Option.map((node) =>
                  R.mapKeys(node, (column): string => endpointColumn(alias, column)),
                ),
              )
            : Effect.succeedNone;
        },
        { concurrency: 1 },
      ),
      (nodes) => Option.map(Option.all(nodes), (all): FilterRow => Object.assign({}, row, ...all)),
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
    closeValidity: (id, column, to) =>
      Effect.sync(() => {
        const found = stored.some((row) => row.id === id);
        stored = stored.map((row) => (row.id === id ? { ...row, [column]: to } : row));
        return found;
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
            return P.isString(member) && P.isString(other) && ids.includes(other) ? [member] : [];
          }),
        ),
      ),
    // The SQL store's grouped count over the list's joins: per requested
    // node, the edges at it that satisfy `where`; a node with none, no key.
    countBy: ({ column, ids, where }) =>
      Effect.map(matching(where), (rows) =>
        Arr.reduce(rows, HashMap.empty<string, number>(), (counts, row) => {
          const node = row[column];
          return P.isString(node) && ids.includes(node)
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
    /**
     * Account erasure: apply `erase` to at most `limit` rows it touches (a
     * row it answers `"delete"` for goes, one it returns a new row for is
     * replaced, one it answers `"keep"` for is untouched); how many changed.
     */
    erase: (limit: number, erase: (row: Row) => Row | "delete" | "keep") =>
      Effect.sync(() => {
        const touched = Arr.take(
          Arr.filter(rows, (row) => erase(row) !== "keep"),
          limit,
        );
        rows = Arr.filterMap(rows, (row) => {
          if (!touched.includes(row)) return Result.succeed(row);
          const next = erase(row);
          return next === "delete" ? Result.failVoid : Result.succeed(next === "keep" ? row : next);
        });
        return touched.length;
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
 * An in-memory {@link ProposalStore}: the seam's contract (docs/seams.md →
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
  readonly chain: InMemoryVersionChain;
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
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(listingOf(row)),
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
    eraseAuthor: ({ accountId, replacement, limit }) =>
      table.erase(limit, (row) => {
        if (row.authorId === accountId && row.status !== "accepted") return "delete";
        const author = row.authorId === accountId;
        const decider = Option.contains(row.decidedBy, accountId);
        if (!author && !decider) return "keep";
        return {
          ...row,
          authorId: author ? replacement : row.authorId,
          decidedBy: decider ? Option.some(replacement) : row.decidedBy,
        };
      }),
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
 * An in-memory {@link ReportStore}: the seam's contract (docs/seams.md →
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
    eraseReporter: ({ accountId, replacement, limit }) =>
      table.erase(limit, (row) => {
        if (row.reporterId === accountId) return "delete";
        return Option.contains(row.resolvedBy, accountId)
          ? { ...row, resolvedBy: Option.some(replacement) }
          : "keep";
      }),
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
export class InMemoryBlobFailure extends Schema.TaggedError<
  InMemoryBlobFailure,
  { readonly brand: unique symbol }
>()("InMemoryBlobFailure", { key: Schema.String }) {}

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
 * An in-memory {@link BlobStore}: the seam's contract (docs/seams.md →
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

// ── Media ─────────────────────────────────────────────────────────────

/**
 * {@link makeInMemoryMediaReferences}' fake: the seam plus the test hooks
 * that record and drop a node's reference to a content hash.
 *
 * @since 0.2.0
 */
export interface InMemoryMediaReferences extends MediaReferences<never, never> {
  /** Record that `ref`'s versions reference `contentHash`. */
  readonly add: (contentHash: string, ref: NodeRef) => void;
  /** Drop every reference `ref` holds (a purge). */
  readonly removeNode: (ref: NodeRef) => void;
}

/**
 * An in-memory `MediaReferences` (docs/seams.md → `MediaReferences`): the
 * nodes recorded against each content hash, at most `limit` of them, in
 * insertion order. In memory only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryMediaReferences = (): InMemoryMediaReferences => {
  let refs: ReadonlyArray<{ readonly contentHash: string; readonly ref: NodeRef }> = [];
  return {
    referencing: (contentHash, limit) =>
      Effect.sync(() =>
        Arr.take(
          Arr.map(
            Arr.filter(refs, (entry) => entry.contentHash === contentHash),
            (entry) => entry.ref,
          ),
          Math.max(0, limit),
        ),
      ),
    add: (contentHash, ref) => {
      refs = [...refs, { contentHash, ref }];
    },
    removeNode: (ref) => {
      refs = Arr.filter(refs, (entry) => entry.ref.type !== ref.type || entry.ref.id !== ref.id);
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
 * The in-memory seams of a publish-gated leaf: the seam contracts (docs/seams.md → `PublicationStore`, `LiveView`). The effective fact is the last
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
  readonly chain: InMemoryVersionChain;
  readonly leaves: InMemoryLeafStore;
  readonly now?: Date;
}): InMemoryPublication => {
  const fixedNow = Option.fromNullishOr(options.now);
  const localised = HashSet.has(options.leaves.columns, LOCALE_COLUMN);
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
    scheduled: (ids) =>
      Effect.map(instantOf(fixedNow), (now) =>
        Arr.flatMap(Arr.dedupe(ids), (id) => {
          const own = Arr.filter(log, (fact) => fact.id === id);
          // The latest record naming a version, still ahead, that no later record overtakes.
          return Option.toArray(
            Arr.findLast(
              own,
              (fact, index) =>
                Option.isSome(fact.version) &&
                fact.at.getTime() > now.getTime() &&
                !Arr.some(
                  Arr.drop(own, index + 1),
                  (later) => later.at.getTime() <= fact.at.getTime(),
                ),
            ),
          );
        }),
      ),
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
    listLocalised: (query) =>
      atNow((now) =>
        Effect.map(chosen(query.headFor, now), (rows) => fallbackPage(rows, query, now)),
      ),
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
    listLocalised: (query) =>
      atNow((now) =>
        Effect.map(heads(), (rows) =>
          fallbackPage(
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
 * An in-memory {@link WorkingCopyStore}: the seam's contract (docs/seams.md → `WorkingCopyStore`), one copy per `(id, userId)`. In memory only;
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
    eraseAccount: (userId, limit) =>
      Effect.sync(() => {
        const erased = Arr.take(
          Arr.filter(HashMap.keys(copies), (key) => key.endsWith(`:${userId}`)),
          limit,
        );
        copies = HashMap.removeMany(copies, erased);
        return erased.length;
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
  readonly chains: ReadonlyArray<InMemoryVersionChain>;
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
        return P.isString(value) ? [value] : [];
      }),
    ),
  );

/**
 * An in-memory {@link PurgeStore} over in-memory chains and a document
 * store: the seam's contract (docs/seams.md → `PurgeStore`). `eraseNode`
 * reads the node's rows from every chain (`definePurge` then deletes them
 * through the leaf's chain's `purge`) and runs the `dependents`;
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
        const erased = Arr.flatMap(options.chains, (chain) =>
          chain.rows().filter((row) => row.id === id),
        );
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

// ── Account erasure (pulpit#207) ──────────────────────────────────────

/**
 * One leaf an {@link makeInMemoryAccountErasureStore} reads: its wire
 * type, its chain and its owner stamps.
 *
 * @since 0.2.0
 */
export interface InMemoryErasureLeaf {
  readonly type: string;
  readonly chain: InMemoryVersionChain;
  readonly leaves: InMemoryLeafStore;
}

/**
 * An in-memory {@link AccountErasureStore} over in-memory leaves: the
 * seam's contract (docs/seams.md → `AccountErasureStore`). `ownedNodes`
 * reads a leaf's owner stamps in id order, `setOwner` restamps or drops
 * one, and `unredactedNodes` reads the leaf's chain rows for the nodes
 * still to redact, in id order; it writes no version row. In memory only;
 * not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryAccountErasureStore = (
  leaves: ReadonlyArray<InMemoryErasureLeaf>,
): AccountErasureStore<never, never> => {
  const leafOf = (type: string) => Arr.findFirst(leaves, (leaf) => leaf.type === type);
  return {
    ownedNodes: ({ accountId, type, limit }) =>
      Effect.sync(() =>
        Option.match(leafOf(type), {
          onNone: () => [],
          onSome: (leaf) =>
            Arr.take(
              Arr.sort(
                Arr.filterMap(HashMap.toEntries(leaf.leaves.owners()), ([id, owner]) =>
                  owner === accountId ? Result.succeed(id) : Result.failVoid,
                ),
                byCodePoint,
              ),
              limit,
            ),
        }),
      ),
    setOwner: ({ type, id, ownerId }) =>
      Effect.suspend(() =>
        Option.match(leafOf(type), {
          onNone: () => Effect.void,
          onSome: (leaf) =>
            Option.match(ownerId, {
              onNone: () => Effect.sync(() => leaf.leaves.dropOwner(id)),
              onSome: (owner) => leaf.leaves.stampOwner(id, owner),
            }),
        }),
      ),
    unredactedNodes: ({ accountId, type, redactedAs, limit }) =>
      Effect.sync(() =>
        Option.match(leafOf(type), {
          onNone: () => [],
          onSome: (leaf) => {
            const rows = leaf.chain.rows();
            const ids = Arr.sort(Arr.dedupe(Arr.map(rows, (row) => row.id)), byCodePoint);
            return Arr.take(
              Arr.filter(ids, (id) =>
                needsRedaction(
                  Arr.filter(rows, (row) => row.id === id),
                  accountId,
                  redactedAs,
                ),
              ),
              limit,
            );
          },
        }),
      ),
  };
};

/**
 * `AccountErasureStore.unredactedNodes`' marker over one node's rows,
 * oldest first: the head is live, a version names the account (actor or
 * `proposedBy`), and no later version has actor `redactedAs` and no
 * `proposedBy`.
 */
const needsRedaction = (
  chain: ReadonlyArray<VersionRow>,
  accountId: string,
  redactedAs: Option.Option<string>,
): boolean => {
  const live = Option.exists(Arr.last(chain), (head) => head.action !== "delete");
  const named = Arr.findLastIndex(
    chain,
    (row) => Option.contains(row.actorId, accountId) || Option.contains(row.proposedBy, accountId),
  );
  return (
    live &&
    Option.exists(
      named,
      (index) =>
        !chain
          .slice(index + 1)
          .some((row) => Eq.equals(row.actorId, redactedAs) && Option.isNone(row.proposedBy)),
    )
  );
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
  readonly weight?: number;
  readonly rows: () => ReadonlyArray<FilterRow & { readonly id: string }>;
  /** The row's score for `query`, or none when it doesn't match. */
  readonly score: (row: FilterRow, query: string) => Option.Option<number>;
  readonly now: Date;
}): SearchBranch<InMemoryFollowing, never, never> => {
  const branch: SearchBranch<InMemoryFollowing, never, never> = {
    name: options.name,
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
  };
  return options.weight === undefined ? branch : { ...branch, weight: options.weight };
};

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
 * An in-memory atomic {@link BudgetCounter} (docs/seams.md →
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
 * An in-memory {@link WriteCountStore} (docs/seams.md →
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

// ── Reactions (pulpit#196) ────────────────────────────────────────────

/**
 * {@link makeInMemoryReactionStore}'s fake: the seam plus a test hook.
 *
 * @since 0.1.0
 */
export interface InMemoryReactionStore extends ReactionStore<never, never> {
  /** Every stored reaction. */
  readonly rows: () => ReadonlyArray<ReactionRow>;
}

/**
 * An in-memory {@link ReactionStore}, keyed `(nodeId, accountId)` as the
 * real table is: `upsert` replaces, `tally` groups by node and kind,
 * `byAccount` is newest first (`nodeId` breaking a tie).
 *
 * @since 0.1.0
 */
export const makeInMemoryReactionStore = (): InMemoryReactionStore => {
  let rows: ReadonlyArray<ReactionRow> = [];
  const same = (nodeId: string, accountId: string) => (row: ReactionRow) =>
    row.nodeId === nodeId && row.accountId === accountId;
  const newestFirst = Order.combine(
    Order.mapInput(Order.flip(Order.Number), (row: ReactionRow) => row.reactedAt.getTime()),
    Order.mapInput(byCodePoint, (row: ReactionRow) => row.nodeId),
  );
  return {
    upsert: (row) =>
      Effect.sync(() => {
        const before = Arr.findFirst(rows, same(row.nodeId, row.accountId));
        rows = [...Arr.filter(rows, (held) => !same(row.nodeId, row.accountId)(held)), row];
        return Option.map(before, (held) => held.kind);
      }),
    delete: (nodeId, accountId) =>
      Effect.sync(() => {
        const before = rows.length;
        rows = Arr.filter(rows, (held) => !same(nodeId, accountId)(held));
        return rows.length < before;
      }),
    tally: (nodeIds) =>
      Effect.sync(() =>
        Arr.reduce(
          Arr.filter(rows, (row) => Arr.contains(nodeIds, row.nodeId)),
          HashMap.empty<string, { readonly [kind: string]: number }>(),
          (acc, row) => {
            const counts = Option.getOrElse(HashMap.get(acc, row.nodeId), () => ({}));
            return HashMap.set(acc, row.nodeId, {
              ...counts,
              [row.kind]: Option.getOrElse(R.get(counts, row.kind), () => 0) + 1,
            });
          },
        ),
      ),
    byAccount: ({ accountId, limit, offset }) =>
      Effect.sync(() =>
        Arr.sort(
          Arr.filter(rows, (row) => row.accountId === accountId),
          newestFirst,
        ).slice(offset, offset + limit),
      ),
    eraseAccount: (accountId, limit) =>
      Effect.sync(() => {
        const erased = Arr.take(
          Arr.filter(rows, (row) => row.accountId === accountId),
          limit,
        );
        rows = Arr.filter(rows, (row) => !erased.includes(row));
        return erased.length;
      }),
    rows: () => rows,
  };
};

// ── The versioned KV (pulpit#205) ─────────────────────────────────────

/**
 * {@link makeInMemoryVersionedKv}'s fake: the seam plus test hooks.
 *
 * @since 0.1.0
 */
export interface InMemoryVersionedKv extends VersionedKv<never, never> {
  /** The stored entry at `key` with its expiry instant (ms), expired or not. */
  readonly peek: (key: string) => Option.Option<KvEntry & { readonly expiresAt: number }>;
  /** Overwrite `key` unconditionally (a corrupt or foreign value, for a decode test). */
  readonly poke: (key: string, entry: KvEntry) => void;
}

/**
 * An in-memory {@link VersionedKv}: `putIfNotBehind` compares and writes in
 * one step, and an entry past its TTL reads as absent (the Effect `Clock`,
 * so `TestClock` steers expiry). In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemoryVersionedKv = (): InMemoryVersionedKv => {
  let entries = HashMap.empty<string, KvEntry & { readonly expiresAt: number }>();
  const live = (key: string, now: number) =>
    Option.filter(HashMap.get(entries, key), (entry) => entry.expiresAt > now);
  return {
    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        Option.map(live(key, now), ({ version, value }) => ({ version, value })),
      ),
    putIfNotBehind: (key, entry, ttlSeconds) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (Option.exists(live(key, now), (held) => held.version > entry.version)) return false;
        entries = HashMap.set(entries, key, { ...entry, expiresAt: now + ttlSeconds * 1000 });
        return true;
      }),
    peek: (key) => HashMap.get(entries, key),
    poke: (key, entry) => {
      entries = HashMap.set(entries, key, { ...entry, expiresAt: Number.POSITIVE_INFINITY });
    },
  };
};

// ── Ordered collections (pulpit#193) ─────────────────────────────────

/**
 * {@link makeInMemoryCollectionStore}'s fake: the seam plus a test hook.
 *
 * @since 0.1.0
 */
export interface InMemoryCollectionStore extends CollectionStore<never, never> {
  /** Every parent's entries, as stored. */
  readonly rows: () => HashMap.HashMap<string, ReadonlyArray<CollectionEntry>>;
}

/**
 * An in-memory {@link CollectionStore}: each parent's entries, replaced
 * whole, read back by position then member id. In memory only; not for
 * production.
 *
 * @since 0.1.0
 */
export const makeInMemoryCollectionStore = (): InMemoryCollectionStore => {
  let byParent = HashMap.empty<string, ReadonlyArray<CollectionEntry>>();
  const entryOrder = Order.combine(
    Order.mapInput(Order.Number, (entry: CollectionEntry) => entry.position),
    Order.mapInput(byCodePoint, (entry: CollectionEntry) => entry.memberId),
  );
  return {
    entries: (parentId, limit) =>
      Effect.sync(() =>
        Arr.take(
          Arr.sort(Option.getOrElse(HashMap.get(byParent, parentId), Arr.empty), entryOrder),
          Math.max(0, limit),
        ),
      ),
    replace: (parentId, entries) =>
      Effect.sync(() => {
        byParent = HashMap.set(byParent, parentId, [...entries]);
      }),
    rows: () => byParent,
  };
};

// ── The social graph (pulpit#195) ─────────────────────────────────────

/**
 * {@link makeInMemorySocialStore}'s fake: the seam plus a test hook.
 *
 * @since 0.1.0
 */
export interface InMemorySocialStore extends SocialStore<InMemoryFollowing, never, never> {
  /** Every stored relationship. */
  readonly rows: () => ReadonlyArray<Relationship>;
}

/**
 * An in-memory {@link SocialStore}, keyed `(kind, from, to)` as the real
 * table is; `followingOf` and `silencedBy` return {@link InMemoryFollowing}
 * sets, where SQL's are subqueries. `addFollow` and `addBlock` each run as
 * one synchronous step, so they are atomic against each other as the seam
 * requires. In memory only; not for production.
 *
 * @since 0.1.0
 */
export const makeInMemorySocialStore = (): InMemorySocialStore => {
  let rows: ReadonlyArray<Relationship> = [];
  const matches = (kind: string, from: string, to: string) => (row: Relationship) =>
    row.kind === kind && row.from === from && row.to === to;
  const toIds = (from: string, kinds: ReadonlyArray<string>) =>
    HashSet.fromIterable(
      Arr.map(
        Arr.filter(rows, (row) => row.from === from && kinds.includes(row.kind)),
        (row) => row.to,
      ),
    );
  type Related = { readonly accountId: string; readonly at: Date };
  const newestFirst = Order.combine(
    Order.mapInput(Order.flip(Order.Number), (row: Related) => row.at.getTime()),
    Order.mapInput(byCodePoint, (row: Related) => row.accountId),
  );
  return {
    add: (relationship) =>
      Effect.sync(() => {
        if (rows.some(matches(relationship.kind, relationship.from, relationship.to))) return false;
        rows = [...rows, relationship];
        return true;
      }),
    addFollow: (relationship) =>
      Effect.sync(() => {
        const { from, to } = relationship;
        if (rows.some(matches("block", from, to)) || rows.some(matches("block", to, from))) {
          return "blocked" as const;
        }
        if (rows.some(matches("follow", from, to))) return "present" as const;
        rows = [...rows, relationship];
        return "added" as const;
      }),
    addBlock: (relationship) =>
      Effect.sync(() => {
        const { from, to } = relationship;
        const written = !rows.some(matches("block", from, to));
        rows = [
          ...Arr.filter(
            rows,
            (row) => !matches("follow", from, to)(row) && !matches("follow", to, from)(row),
          ),
          ...(written ? [relationship] : []),
        ];
        return written;
      }),
    remove: (kind, from, to) =>
      Effect.sync(() => {
        const before = rows.length;
        rows = Arr.filter(rows, (row) => !matches(kind, from, to)(row));
        return rows.length < before;
      }),
    has: (kind, from, to) => Effect.sync(() => rows.some(matches(kind, from, to))),
    list: ({ kind, side, accountId, limit, offset }) =>
      Effect.sync(() => {
        const related = Arr.sort(
          Arr.map(
            Arr.filter(rows, (row) => row.kind === kind && row[side] === accountId),
            (row) => ({ accountId: side === "from" ? row.to : row.from, at: row.at }),
          ),
          newestFirst,
        );
        return { rows: related.slice(offset, offset + limit), total: related.length };
      }),
    isFollowing: (follower, followed) =>
      Effect.sync(() => rows.some(matches("follow", follower, followed))),
    followingOf: (follower) => toIds(follower, ["follow"]),
    silencedBy: (viewer) => toIds(viewer, ["mute", "block"]),
    eraseAccount: (accountId, limit) =>
      Effect.sync(() => {
        const erased = Arr.take(
          Arr.filter(rows, (row) => row.from === accountId || row.to === accountId),
          limit,
        );
        rows = Arr.filter(rows, (row) => !erased.includes(row));
        return erased.length;
      }),
    rows: () => rows,
  };
};

// ── Audiences ─────────────────────────────────────────────────────────

/**
 * An in-memory {@link MembershipStore}, plus the rows a test reads. In
 * memory only; not for production.
 *
 * @since 0.2.0
 */
export interface InMemoryMembershipStore extends MembershipStore<InMemoryFollowing, never, never> {
  /** Every stored active membership, in insertion order. */
  readonly rows: () => ReadonlyArray<Membership>;
  /** Every pending invitation, in insertion order (pulpit#227). */
  readonly pending: () => ReadonlyArray<Invitation>;
}

/**
 * An in-memory {@link MembershipStore}: the seam's contract (docs/seams.md
 * → the membership store) over an array of active memberships and one of
 * pending invitations (pulpit#227), sharing the key `(groupId, accountId)`:
 * every membership read sees the active rows alone. `groupsOf` returns {@link InMemoryFollowing}, the
 * set the list filter's `in` node takes in memory. In memory only; not for
 * production.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashSet from "effect/HashSet";
 * import { makeInMemoryMembershipStore } from "@thomasfosterau/pulpit/testing";
 *
 * const store = makeInMemoryMembershipStore();
 * Effect.runSync(store.add({ groupId: "g-1", accountId: "u-1", role: "admin", at: new Date(0) }));
 * strictEqual(HashSet.has(store.groupsOf("u-1"), "g-1"), true);
 * ```
 *
 * @since 0.2.0
 */
export const makeInMemoryMembershipStore = (): InMemoryMembershipStore => {
  let rows: ReadonlyArray<Membership> = [];
  let pending: ReadonlyArray<Invitation> = [];
  const matches =
    (groupId: string, accountId: string) =>
    (row: { readonly groupId: string; readonly accountId: string }) =>
      row.groupId === groupId && row.accountId === accountId;
  /** Drop the matching rows of both statuses; how many went. */
  const removeWhere = (
    dropActive: (row: Membership) => boolean,
    dropPending: (row: Invitation) => boolean = () => false,
  ) =>
    Effect.sync(() => {
      const before = rows.length + pending.length;
      rows = Arr.filter(rows, (row) => !dropActive(row));
      pending = Arr.filter(pending, (row) => !dropPending(row));
      return before - rows.length - pending.length;
    });
  const oldestFirst = <A extends { readonly at: Date }>(key: (row: A) => string) =>
    Order.combine(
      Order.mapInput(Order.Number, (row: A) => row.at.getTime()),
      Order.mapInput(byCodePoint, key),
    );
  const takenKey = (groupId: string, accountId: string) =>
    rows.some(matches(groupId, accountId)) || pending.some(matches(groupId, accountId));
  return {
    add: (membership) =>
      Effect.sync(() => {
        if (rows.some(matches(membership.groupId, membership.accountId))) return false;
        // A direct add supersedes a pending invitation at the same key.
        pending = Arr.filter(
          pending,
          (row) => !matches(membership.groupId, membership.accountId)(row),
        );
        rows = [...rows, membership];
        return true;
      }),
    setRole: (groupId, accountId, role) =>
      Effect.sync(() => {
        const changed = rows.some((row) => matches(groupId, accountId)(row) && row.role !== role);
        rows = Arr.map(rows, (row) => (matches(groupId, accountId)(row) ? { ...row, role } : row));
        return changed;
      }),
    remove: (groupId, accountId) =>
      Effect.map(removeWhere(matches(groupId, accountId)), (count) => count > 0),
    roleOf: (groupId, accountId) =>
      Effect.sync(() =>
        Option.map(Arr.findFirst(rows, matches(groupId, accountId)), (row) => row.role),
      ),
    list: ({ groupId, limit, offset }) =>
      Effect.sync(() => {
        const members = Arr.map(
          Arr.sort(
            Arr.filter(rows, (row) => row.groupId === groupId),
            oldestFirst((row: Membership) => row.accountId),
          ),
          ({ accountId, role, at }) => ({ accountId, role, at }),
        );
        return { rows: members.slice(offset, offset + limit), total: members.length };
      }),
    removeGroup: (groupId) =>
      removeWhere(
        (row) => row.groupId === groupId,
        (row) => row.groupId === groupId,
      ),
    isMember: (accountId, groupId) => Effect.sync(() => rows.some(matches(groupId, accountId))),
    groupsOf: (accountId) =>
      HashSet.fromIterable(
        Arr.map(
          Arr.filter(rows, (row) => row.accountId === accountId),
          (row) => row.groupId,
        ),
      ),
    eraseAccount: (accountId, limit) =>
      Effect.sync(() => {
        // One `limit` across both statuses: the active rows first, then the
        // pending invitations to or from the account (pulpit#274).
        const active = Arr.take(
          Arr.filter(rows, (row) => row.accountId === accountId),
          limit,
        );
        const invitations = Arr.take(
          Arr.filter(pending, (row) => row.accountId === accountId || row.invitedBy === accountId),
          Math.max(0, limit - active.length),
        );
        rows = Arr.filter(rows, (row) => !active.includes(row));
        pending = Arr.filter(pending, (row) => !invitations.includes(row));
        return active.length + invitations.length;
      }),
    invite: (invitation) =>
      Effect.sync(() => {
        if (takenKey(invitation.groupId, invitation.accountId)) return false;
        pending = [...pending, invitation];
        return true;
      }),
    invitationOf: (groupId, accountId) =>
      Effect.sync(() => Arr.findFirst(pending, matches(groupId, accountId))),
    accept: (groupId, accountId, at) =>
      Effect.sync(() =>
        Option.match(Arr.findFirst(pending, matches(groupId, accountId)), {
          onNone: () => false,
          onSome: (invitation) => {
            pending = Arr.filter(pending, (row) => !matches(groupId, accountId)(row));
            rows = [...rows, { groupId, accountId, role: invitation.role, at }];
            return true;
          },
        }),
      ),
    removeInvitation: (groupId, accountId) =>
      Effect.map(
        removeWhere(() => false, matches(groupId, accountId)),
        (count) => count > 0,
      ),
    invitations: (query) =>
      Effect.sync(() => {
        const selected = Arr.sort(
          Arr.filter(pending, (row) =>
            query.by === "group"
              ? row.groupId === query.groupId
              : row.accountId === query.accountId,
          ),
          oldestFirst((row: Invitation) => (query.by === "group" ? row.accountId : row.groupId)),
        );
        return {
          rows: selected.slice(query.offset, query.offset + query.limit),
          total: selected.length,
        };
      }),
    rows: () => rows,
    pending: () => pending,
  };
};

/**
 * In-memory groups: a {@link GroupOwnership} and a {@link GroupOwnerStore}
 * over one map of group id to owner, plus the test hooks. In memory only;
 * not for production.
 *
 * @since 0.2.0
 */
export interface InMemoryGroupOwners
  extends GroupOwnership<never, never>, GroupOwnerStore<never, never> {
  /** Every group's owner, by group id. */
  readonly owners: () => HashMap.HashMap<string, string>;
  /** Record a group and its owner (the application creating one), or replace its owner. */
  readonly put: (groupId: string, ownerId: string) => Effect.Effect<void>;
  /** Delete a group's record; whether it existed. `ownerOf` then answers none. */
  readonly remove: (groupId: string) => Effect.Effect<boolean>;
}

/**
 * In-memory groups seeded with `owners` (`[groupId, ownerId]` pairs): the
 * group-owner store's contract (docs/seams.md → the group-owner store).
 * `reassignOwner` takes the account's groups in group-id order, so a
 * bounded batch is deterministic, and `ownerOf` reads the same map, so a
 * reassigned group answers its new owner. In memory only; not for
 * production.
 *
 * @example
 * ```ts
 * import { deepStrictEqual, strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { makeInMemoryGroupOwners } from "@thomasfosterau/pulpit/testing";
 *
 * const groups = makeInMemoryGroupOwners([
 *   ["g-1", "u-1"],
 *   ["g-2", "u-1"],
 * ]);
 * strictEqual(Effect.runSync(groups.reassignOwner("u-1", "u-deleted", 1)), 1);
 * deepStrictEqual(Effect.runSync(groups.ownerOf("g-1")), Option.some("u-deleted"));
 * deepStrictEqual(Effect.runSync(groups.ownerOf("g-2")), Option.some("u-1"));
 * ```
 *
 * @since 0.2.0
 */
export const makeInMemoryGroupOwners = (
  owners: Iterable<readonly [groupId: string, ownerId: string]> = [],
): InMemoryGroupOwners => {
  let groups = HashMap.fromIterable(owners);
  return {
    ownerOf: (groupId) => Effect.sync(() => HashMap.get(groups, groupId)),
    reassignOwner: (accountId, to, limit) =>
      Effect.sync(() => {
        const owned = Arr.take(
          Arr.sort(
            Arr.filterMap(HashMap.toEntries(groups), ([groupId, ownerId]) =>
              ownerId === accountId ? Result.succeed(groupId) : Result.failVoid,
            ),
            byCodePoint,
          ),
          limit,
        );
        groups = Arr.reduce(owned, groups, (map, groupId) => HashMap.set(map, groupId, to));
        return owned.length;
      }),
    owners: () => groups,
    put: (groupId, ownerId) =>
      Effect.sync(() => {
        groups = HashMap.set(groups, groupId, ownerId);
      }),
    remove: (groupId) =>
      Effect.sync(() => {
        const existed = HashMap.has(groups, groupId);
        groups = HashMap.remove(groups, groupId);
        return existed;
      }),
  };
};

// ── Notifications ─────────────────────────────────────────────────────

/**
 * An in-memory {@link OutboxStore}, plus the reads a test checks it by and a
 * `transact` that rolls the outbox back when the wrapped effect fails, as
 * the caller's transaction does in SQL. In memory only; not for production.
 *
 * @since 0.2.0
 */
export interface InMemoryOutbox<Kind extends string> extends OutboxStore<Kind, never, never> {
  /** Every stored event, oldest first, processed or not. */
  readonly events: () => ReadonlyArray<NotificationEvent<Kind>>;
  /** The ids marked processed. */
  readonly processed: () => HashSet.HashSet<string>;
  /** Run `effect`; when it fails, every event it enqueued is gone (a rolled-back transaction). */
  readonly transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * An in-memory {@link OutboxStore}: the seam's contract (docs/seams.md →
 * `OutboxStore`). Ids are sequential (`n-000001`, …), so `pending`'s order
 * is insertion order on equal instants. In memory only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryOutbox = <Kind extends string>(): InMemoryOutbox<Kind> => {
  const events: Array<NotificationEvent<Kind>> = [];
  let processed = HashSet.empty<string>();
  const oldestFirst = Order.combine(
    Order.mapInput(Order.Date, (event: NotificationEvent<Kind>) => event.at),
    Order.mapInput(Order.String, (event: NotificationEvent<Kind>) => event.id),
  );
  return {
    enqueue: (drafts, at) =>
      Effect.sync(() => {
        events.push(
          ...Arr.map(drafts, (draft, index) => ({
            ...draft,
            id: `n-${String(events.length + index + 1).padStart(6, "0")}`,
            at,
          })),
        );
      }),
    pending: (limit) =>
      Effect.sync(() =>
        Arr.take(
          Arr.sort(
            Arr.filter(events, (event) => !HashSet.has(processed, event.id)),
            oldestFirst,
          ),
          limit,
        ),
      ),
    markProcessed: (ids) =>
      Effect.sync(() => {
        processed = HashSet.union(processed, HashSet.fromIterable(ids));
      }),
    events: () => events,
    processed: () => processed,
    transact: (effect) =>
      Effect.suspend(() => {
        const before = events.length;
        return Effect.tapError(effect, () =>
          Effect.sync(() => {
            events.splice(before);
          }),
        );
      }),
  };
};

/**
 * An in-memory {@link InboxStore}: the seam's contract (docs/seams.md →
 * `InboxStore`), newest first with `id` descending on a tie. In memory
 * only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryInbox = <Kind extends string>(): InboxStore<Kind, never, never> & {
  /** Every entry, in the order it was added. */
  readonly entries: () => ReadonlyArray<InboxEntry<Kind>>;
} => {
  const entries: Array<InboxEntry<Kind>> = [];
  const newestFirst = Order.flip(
    Order.combine(
      Order.mapInput(Order.Date, (entry: InboxEntry<Kind>) => entry.event.at),
      Order.mapInput(Order.String, (entry: InboxEntry<Kind>) => entry.event.id),
    ),
  );
  const mine = (recipientId: string, unreadOnly: boolean) =>
    Arr.filter(
      entries,
      (entry) =>
        entry.event.recipientId === recipientId && (!unreadOnly || Option.isNone(entry.readAt)),
    );
  return {
    add: (event) =>
      Effect.sync(() => {
        if (entries.some((entry) => entry.event.id === event.id)) return false;
        entries.push({ event, readAt: Option.none() });
        return true;
      }),
    list: ({ recipientId, unreadOnly, limit, offset }) =>
      Effect.sync(() => {
        const rows = Arr.sort(mine(recipientId, unreadOnly), newestFirst);
        return { rows: rows.slice(offset, offset + limit), total: rows.length };
      }),
    markRead: (recipientId, ids, at) =>
      Effect.sync(() => {
        const wanted = HashSet.fromIterable(ids);
        const unread = Arr.filter(mine(recipientId, true), (entry) =>
          HashSet.has(wanted, entry.event.id),
        );
        Arr.forEach(unread, (entry) => {
          entries[entries.indexOf(entry)] = { ...entry, readAt: Option.some(at) };
        });
        return unread.length;
      }),
    unreadCount: (recipientId) => Effect.sync(() => mine(recipientId, true).length),
    entries: () => entries,
  };
};

/**
 * An in-memory {@link PreferenceStore}. In memory only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryPreferenceStore = (): PreferenceStore<never, never> => {
  let stored = HashMap.empty<string, NotificationPreferences>();
  return {
    get: (accountId) => Effect.sync(() => HashMap.get(stored, accountId)),
    set: (accountId, preferences) =>
      Effect.sync(() => {
        stored = HashMap.set(stored, accountId, preferences);
      }),
  };
};

/**
 * One delivery an {@link InMemoryDelivery} recorded.
 *
 * @since 0.2.0
 */
export interface RecordedDelivery<Kind extends string> {
  readonly channel: string;
  readonly event: NotificationEvent<Kind>;
}

/**
 * A {@link DeliverySeam} that records each delivery instead of sending it.
 *
 * @since 0.2.0
 */
export interface InMemoryDelivery<Kind extends string> extends DeliverySeam<Kind, never, never> {
  readonly deliveries: () => ReadonlyArray<RecordedDelivery<Kind>>;
}

/**
 * An in-memory {@link DeliverySeam}: records `(channel, event)` in order.
 * In memory only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryDelivery = <Kind extends string>(): InMemoryDelivery<Kind> => {
  const deliveries: Array<RecordedDelivery<Kind>> = [];
  return {
    deliver: (channel, event) =>
      Effect.sync(() => {
        deliveries.push({ channel, event });
      }),
    deliveries: () => deliveries,
  };
};

/** A JSON value's members, when it is an object (not an array). */
const jsonMembers = (value: Schema.Json): Option.Option<{ readonly [key: string]: Schema.Json }> =>
  value === null ||
  P.isBoolean(value) ||
  P.isNumber(value) ||
  P.isString(value) ||
  Arr.isArray<Schema.Json>(value)
    ? Option.none()
    : Option.some(value);

/** The `attrs.id` string of a mention node's members, if any. */
const mentionId = (members: { readonly [key: string]: Schema.Json }): ReadonlyArray<string> =>
  Option.toArray(
    Option.flatMap(Option.flatMap(R.get(members, "attrs"), jsonMembers), (attrs) =>
      Option.filter(R.get(attrs, "id"), P.isString),
    ),
  );

/**
 * The reference {@link MentionExtractor} over a JSON document tree: the
 * `attrs.id` string of every object whose `type` is `"mention"`, at any
 * depth, in document order (the shape of an editor's inline mention atom,
 * `{ type: "mention", attrs: { id, label } }`). A mention without a string
 * id mentions nobody. In memory only; an application fills the seam with
 * its own grammar's extractor.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { jsonMentionExtractor } from "@thomasfosterau/pulpit/testing";
 *
 * deepStrictEqual(
 *   jsonMentionExtractor({
 *     type: "doc",
 *     content: [
 *       { type: "paragraph", content: [{ type: "mention", attrs: { id: "u-1", label: "Ada" } }] },
 *       { type: "mention", attrs: { label: "no id" } },
 *     ],
 *   }),
 *   ["u-1"],
 * );
 * ```
 *
 * @since 0.2.0
 */
export const jsonMentionExtractor: MentionExtractor<Schema.Json> = (document) =>
  Arr.isArray<Schema.Json>(document)
    ? Arr.flatMap(document, jsonMentionExtractor)
    : Option.match(jsonMembers(document), {
        onNone: () => [],
        onSome: (members) =>
          Arr.appendAll(
            members["type"] === "mention" ? mentionId(members) : [],
            Arr.flatMap(R.values(members), jsonMentionExtractor),
          ),
      });

/**
 * An in-memory {@link ExternalIdStore}, plus the hook a test reads it
 * through. In memory only; not for production.
 *
 * @since 0.2.0
 */
export interface InMemoryExternalIdStore extends ExternalIdStore<never, never> {
  /** Every stored link, in insertion order. */
  readonly links: () => ReadonlyArray<ExternalIdLink>;
}

/**
 * An in-memory {@link ExternalIdStore}: the seam's contract (docs/seams.md
 * → `ExternalIdStore`) over a list of links. It enforces what the table's
 * schema does, the two unique keys `(authority, externalId)` and
 * `(authority, nodeId)`, and nothing the import is responsible for. In
 * memory only; not for production.
 *
 * @since 0.2.0
 */
export const makeInMemoryExternalIdStore = (): InMemoryExternalIdStore => {
  let links: ReadonlyArray<ExternalIdLink> = [];
  const named = (authority: string, externalId: string) => (link: ExternalIdLink) =>
    link.authority === authority && link.externalId === externalId;
  return {
    lookup: (authority, externalIds) =>
      Effect.sync(() =>
        HashMap.fromIterable(
          Arr.flatMap(externalIds, (externalId) =>
            Option.toArray(
              Option.map(
                Arr.findFirst(links, named(authority, externalId)),
                (link) => [externalId, link] as const,
              ),
            ),
          ),
        ),
      ),
    link: (authority, externalId, nodeId) =>
      Effect.sync(() => {
        const byId = Arr.findFirst(links, named(authority, externalId));
        if (Option.isSome(byId)) return byId.value.nodeId === nodeId ? "present" : "taken";
        if (links.some((link) => link.authority === authority && link.nodeId === nodeId)) {
          return "taken";
        }
        links = [...links, { authority, externalId, nodeId, baseline: Option.none() }];
        return "linked";
      }),
    recordBaseline: (authority, externalId, baseline) =>
      Effect.sync(() => {
        links = Arr.map(links, (link) =>
          named(authority, externalId)(link) ? { ...link, baseline: Option.some(baseline) } : link,
        );
      }),
    links: () => links,
  };
};
