/**
 * **Hybrid search** (pulpit#204) — the parts of the apps' search pipeline
 * that are not SQL: reciprocal rank fusion over ranked branches, a reranker
 * seam, the branch seam a ranked query fills under the leaf's read scope,
 * and the embedding pipeline as seams.
 *
 * The behavioural spec is website's `apps/api/src/operations/search.ts`
 * (full text, trigram, vector and literal-id branches fused with RRF) and
 * gardeneria's `search.ts` and `packages/ai/src/{embeddings,reranker}.ts`,
 * with both apps' `packages/jobs/src/embedding/queue.ts` and
 * `cron/embedding-sweep.ts`.
 *
 * ## What the kernel owns
 *
 * - **Fusion.** {@link fuseRankings} is pure: each branch's rank list
 *   becomes a score `weight / (k + rank)` per hit, summed across branches,
 *   ordered by score and then by id (code point), and capped. A
 *   {@link RerankerSeam} may reorder the fused candidates, never add one.
 * - **Scope on every branch.** A {@link SearchBranch} is a store seam (the
 *   ranked query is the application's SQL) handed the leaf's
 *   `searchScopeFilter` (`./subtype`), which its SQL must apply, the
 *   live-row rule included, so no branch can rank a row `list` hides
 *   (`SEC-AUTH-ENUM-001`). {@link hybridSearch} hands every branch the same
 *   scope. `./testing`'s `scopeCheckedBranch` wraps a branch and fails
 *   {@link SearchScopeLeak} on a hit outside the scope, so an application's
 *   suite can prove its own branches. The fused hits are still re-read
 *   through `hydrateSearchHits`, so a stale index never leaks a row either.
 * - **Embeddings.** {@link enqueueEmbeddings} queues a document on its first
 *   insert (`onDocumentInsert`, inside the `put`'s transaction), and
 *   {@link embedPending} / {@link sweepEmbeddings} embed the pending
 *   documents in batches (`PERF-DB-001`): one {@link EmbeddingStore} read,
 *   one `getMany`, one {@link Embedder} call and one write per batch. The
 *   model, the document's text and the vector column are the application's.
 *
 * `/ask`-style retrieval stays application code over these reads.
 *
 * @copyright Thomas Foster
 * @module pulpit/search
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { onDocumentInsert, type DocumentHash, type DocumentStore } from "./documents.ts";
import type { ListFilter } from "./filter.ts";
import { byCodePoint } from "./internal/list-order.ts";
import { MAX_PAGE_LIMIT } from "./subtype.ts";

// ── Fusion ────────────────────────────────────────────────────────────

/**
 * The reciprocal rank fusion constant both apps use: a hit at rank `r`
 * scores `weight / (RRF_K + r)`.
 *
 * @since 0.1.0
 */
export const RRF_K = 60;

/**
 * One hit a branch ranked: the node id. A branch's hits are in rank order,
 * best first.
 *
 * @since 0.1.0
 */
export interface RankedHit {
  readonly id: string;
}

/**
 * One branch's ranked hits, as {@link fuseRankings} reads them.
 *
 * @since 0.1.0
 */
export interface BranchRanking {
  /** The branch's name, as {@link FusedHit.ranks} keys it. */
  readonly name: string;
  /**
   * The branch's weight, `1` when omitted. A weight that is not a finite,
   * non-negative number scores nothing (fails closed).
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is weight 1
  readonly weight?: number | undefined;
  /** Best first. A repeated id keeps its first, best rank. */
  readonly hits: ReadonlyArray<RankedHit>;
}

/**
 * One fused hit: its id, its summed score and its 1-based rank in each
 * branch that ranked it.
 *
 * @since 0.1.0
 */
export interface FusedHit {
  readonly id: string;
  readonly score: number;
  readonly ranks: { readonly [branch: string]: number };
}

/**
 * {@link fuseRankings}'s options.
 *
 * @since 0.1.0
 */
export interface FusionOptions {
  /** The RRF constant; {@link RRF_K} when omitted or not a finite, positive number. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is RRF_K
  readonly k?: number | undefined;
  /** How many fused hits to return, clamped to `[1, MAX_PAGE_LIMIT]`; `MAX_PAGE_LIMIT` when omitted. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is MAX_PAGE_LIMIT
  readonly limit?: number | undefined;
  /** How many of each branch's hits count, clamped as `limit` is; `MAX_PAGE_LIMIT` when omitted. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is MAX_PAGE_LIMIT
  readonly perBranch?: number | undefined;
}

/** A count clamped to `[1, MAX_PAGE_LIMIT]` (`SEC-INPUT-003`), `MAX_PAGE_LIMIT` when absent or not a number. */
const bounded = (value: Option.Option<number>): number =>
  Option.match(
    Option.filter(value, (count) => !Number.isNaN(count)),
    {
      onNone: () => MAX_PAGE_LIMIT,
      onSome: (count) => Math.max(1, Math.min(Math.trunc(count), MAX_PAGE_LIMIT)),
    },
  );

/** A branch's usable weight: a finite, non-negative number, else 0. */
const weightOf = (branch: BranchRanking): number => {
  const weight = branch.weight ?? 1;
  return Number.isFinite(weight) && weight >= 0 ? weight : 0;
};

/** Higher score first, then id in code-point order: a total order, so fusion is deterministic. */
const fusedOrder: Order.Order<FusedHit> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (hit: FusedHit) => hit.score),
  Order.mapInput(byCodePoint, (hit: FusedHit) => hit.id),
);

/**
 * Reciprocal rank fusion. Each branch's first `perBranch` distinct hits
 * score `weight / (k + rank)` (rank 1-based); a hit's score is the sum over
 * the branches that ranked it, and its `ranks` record each such rank. The
 * result is ordered by score, then by id in code-point order, and capped at
 * `limit`. Pure and total: a branch named twice keeps both contributions
 * under the later name's rank.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { fuseRankings } from "@thomasfosterau/pulpit/search";
 *
 * const fused = fuseRankings([
 *   { name: "text", hits: [{ id: "a" }, { id: "b" }] },
 *   { name: "vector", hits: [{ id: "b" }, { id: "c" }] },
 * ]);
 * deepStrictEqual(
 *   fused.map((hit) => hit.id),
 *   ["b", "a", "c"],
 * );
 * deepStrictEqual(fused[0]?.ranks, { text: 2, vector: 1 });
 * ```
 *
 * @since 0.1.0
 */
export const fuseRankings = (
  branches: ReadonlyArray<BranchRanking>,
  options: FusionOptions = {},
): ReadonlyArray<FusedHit> => {
  const k =
    options.k !== undefined && Number.isFinite(options.k) && options.k > 0 ? options.k : RRF_K;
  const perBranch = bounded(Option.fromUndefinedOr(options.perBranch));
  const contributions = Arr.flatMap(branches, (branch) => {
    const weight = weightOf(branch);
    return Arr.map(
      Arr.take(
        Arr.dedupeWith(branch.hits, (a, b) => a.id === b.id),
        perBranch,
      ),
      (hit, index) => ({ id: hit.id, branch: branch.name, rank: index + 1, weight }),
    );
  });
  const fused = Arr.reduce(contributions, HashMap.empty<string, FusedHit>(), (acc, entry) => {
    const before = Option.getOrElse(HashMap.get(acc, entry.id), () => ({
      id: entry.id,
      score: 0,
      ranks: {},
    }));
    return HashMap.set(acc, entry.id, {
      id: entry.id,
      score: before.score + entry.weight / (k + entry.rank),
      ranks: { ...before.ranks, [entry.branch]: entry.rank },
    });
  });
  return Arr.take(
    Arr.sort(HashMap.toValues(fused), fusedOrder),
    bounded(Option.fromUndefinedOr(options.limit)),
  );
};

/**
 * The optional reranker an application fills (gardeneria's
 * `packages/ai/src/reranker.ts`): given the query and the fused candidates,
 * their ids in its preferred order. The kernel only lets it reorder:
 * {@link applyReranking} drops an id it returns that was not a candidate, and
 * keeps a candidate it omits after the ones it ranked, in fused order.
 *
 * @since 0.1.0
 */
export interface RerankerSeam<E, R> {
  readonly rerank: (
    query: string,
    candidates: ReadonlyArray<FusedHit>,
  ) => Effect.Effect<ReadonlyArray<string>, E, R>;
}

/**
 * Reorder `candidates` by a reranker's answer: its ids first, in its order
 * (an unknown or repeated id dropped), then every candidate it omitted, in
 * their fused order. Pure: a reranker can reorder, never add or remove a
 * hit.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { applyReranking } from "@thomasfosterau/pulpit/search";
 *
 * const candidates = [
 *   { id: "a", score: 3, ranks: {} },
 *   { id: "b", score: 2, ranks: {} },
 *   { id: "c", score: 1, ranks: {} },
 * ];
 * deepStrictEqual(
 *   applyReranking(candidates, ["c", "zzz", "a"]).map((hit) => hit.id),
 *   ["c", "a", "b"],
 * );
 * ```
 *
 * @since 0.1.0
 */
export const applyReranking = (
  candidates: ReadonlyArray<FusedHit>,
  order: ReadonlyArray<string>,
): ReadonlyArray<FusedHit> => {
  const byId = HashMap.fromIterable(Arr.map(candidates, (hit) => [hit.id, hit] as const));
  const ranked = Arr.getSomes(Arr.map(Arr.dedupe(order), (id) => HashMap.get(byId, id)));
  const named = HashSet.fromIterable(Arr.map(ranked, (hit) => hit.id));
  return [...ranked, ...Arr.filter(candidates, (hit) => !HashSet.has(named, hit.id))];
};

// ── Branches ──────────────────────────────────────────────────────────

/**
 * What a {@link SearchBranch} is asked: the query, the leaf's read scope and
 * how many hits it may return.
 *
 * @since 0.1.0
 */
export interface BranchRequest<Following> {
  readonly query: string;
  /**
   * The leaf's `searchScopeFilter` for the viewer (`./subtype`). The branch
   * must apply it in the same query that ranks (rendered as the leaf's
   * `list` renders its filter), so a row outside it is never ranked and its
   * rank never shifts another hit's (`SEC-AUTH-ENUM-001`).
   */
  readonly scope: ListFilter<Following>;
  /** At most this many hits, best first; never more than `MAX_PAGE_LIMIT`. */
  readonly limit: number;
}

/**
 * One ranked query an application supplies: full text, trigram, a vector
 * nearest-neighbour search or a literal-identifier match, over its own
 * search view. A store seam: it applies the scope it is given and no other
 * policy, and fails only with its `E`. See the package README → Seams.
 *
 * @since 0.1.0
 */
export interface SearchBranch<Following, E, R> {
  /** The branch's name, as {@link FusedHit.ranks} keys it. */
  readonly name: string;
  /** Its fusion weight; `1` when omitted (see {@link BranchRanking.weight}). */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is weight 1
  readonly weight?: number | undefined;
  /** The hits in scope, best first, at most `request.limit`. */
  readonly search: (
    request: BranchRequest<Following>,
  ) => Effect.Effect<ReadonlyArray<RankedHit>, E, R>;
}

/**
 * A branch returned a hit outside the scope it was handed. Raised by
 * `./testing`'s `scopeCheckedBranch`, which an application's suite wraps
 * around its own branches; the kernel's {@link hybridSearch} never checks
 * a production branch's rows itself (it has none to check against).
 *
 * @since 0.1.0
 */
export class SearchScopeLeak extends Schema.TaggedError<SearchScopeLeak>()("SearchScopeLeak", {
  branch: Schema.String,
  id: Schema.String,
}) {}

/**
 * {@link hybridSearch}'s configuration: the branches, the optional reranker
 * and the fusion options.
 *
 * @since 0.1.0
 */
export interface HybridSearchDefinition<Following, E, R> {
  readonly branches: ReadonlyArray<SearchBranch<Following, E, R>>;
  /** Reorders the fused candidates; omitted, the fused order stands. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no reranker"
  readonly reranker?: RerankerSeam<E, R> | undefined;
  /** The RRF constant ({@link FusionOptions.k}). */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is RRF_K
  readonly k?: number | undefined;
  /** How many hits each branch is asked for ({@link FusionOptions.perBranch}). */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is MAX_PAGE_LIMIT
  readonly perBranch?: number | undefined;
}

/**
 * Run every branch under the same scope, one after another in the caller's
 * transaction, fuse their rankings ({@link fuseRankings}) and, with a
 * reranker, reorder the fused candidates ({@link applyReranking}). Returns
 * at most `request.limit` hits (clamped to `[1, MAX_PAGE_LIMIT]`), for the
 * caller to re-read through `hydrateSearchHits`. An empty query asks no
 * branch and finds nothing. Fails with a branch's or the reranker's `E`.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { always } from "@thomasfosterau/pulpit/filter";
 * import { hybridSearch } from "@thomasfosterau/pulpit/search";
 *
 * const search = hybridSearch({
 *   branches: [
 *     { name: "text", search: () => Effect.succeed([{ id: "a" }, { id: "b" }]) },
 *     { name: "vector", weight: 2, search: () => Effect.succeed([{ id: "b" }]) },
 *   ],
 * });
 * const hits = await Effect.runPromise(search({ query: "tomato", scope: always, limit: 10 }));
 * deepStrictEqual(
 *   hits.map((hit) => hit.id),
 *   ["b", "a"],
 * );
 * ```
 *
 * @since 0.1.0
 */
export const hybridSearch =
  <Following, E, R>(definition: HybridSearchDefinition<Following, E, R>) =>
  (request: BranchRequest<Following>): Effect.Effect<ReadonlyArray<FusedHit>, E, R> =>
    Effect.gen(function* () {
      if (request.query.trim() === "") return [];
      const perBranch = bounded(Option.fromUndefinedOr(definition.perBranch));
      const rankings = yield* Effect.forEach(
        definition.branches,
        (branch) =>
          Effect.map(
            branch.search({ query: request.query, scope: request.scope, limit: perBranch }),
            (hits): BranchRanking => ({ name: branch.name, weight: branch.weight, hits }),
          ),
        { concurrency: 1 },
      );
      const fused = fuseRankings(rankings, {
        k: definition.k,
        perBranch,
        limit: MAX_PAGE_LIMIT,
      });
      const limit = bounded(Option.some(request.limit));
      const reranker = definition.reranker;
      if (reranker === undefined || !Arr.isReadonlyArrayNonEmpty(fused)) {
        return Arr.take(fused, limit);
      }
      const order = yield* reranker.rerank(request.query, fused);
      return Arr.take(applyReranking(fused, order), limit);
    }).pipe(Effect.withSpan("search.hybrid"));

// ── Embeddings ────────────────────────────────────────────────────────

/**
 * The embedding queue and vector column an application supplies (the apps'
 * `embedding` job table and the document table's nullable `embedding`
 * column). A store seam: no policy, never opens a transaction, fails only
 * with its `E`. See the package README → Seams.
 *
 * @since 0.1.0
 */
export interface EmbeddingStore<E, R> {
  /** Queue a document for embedding (an outbox row the caller's transaction writes); idempotent. */
  readonly enqueue: (hash: DocumentHash) => Effect.Effect<void, E, R>;
  /**
   * Up to `limit` documents with no vector yet, oldest first: the queued
   * ones and, for the sweep, any stored document whose vector is still
   * `NULL`. One bounded read (`LIMIT $limit`).
   */
  readonly pending: (limit: number) => Effect.Effect<ReadonlyArray<DocumentHash>, E, R>;
  /** Write each document's vector and dequeue it, in one statement. */
  readonly write: (
    vectors: ReadonlyArray<{ readonly hash: DocumentHash; readonly vector: ReadonlyArray<number> }>,
  ) => Effect.Effect<void, E, R>;
  /** Dequeue documents that can no longer be embedded (missing, or with no text). */
  readonly discard: (hashes: ReadonlyArray<DocumentHash>) => Effect.Effect<void, E, R>;
}

/**
 * The embedding model an application supplies: one call for a batch of
 * texts, one vector per text, in order.
 *
 * @since 0.1.0
 */
export interface Embedder<E, R> {
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, E, R>;
}

/**
 * The embedder answered with a number of vectors other than the number of
 * texts it was given, so no vector can be matched to its document. Nothing
 * of the batch is written.
 *
 * @since 0.1.0
 */
export class EmbeddingMismatch extends Schema.TaggedError<EmbeddingMismatch>()(
  "EmbeddingMismatch",
  { expected: Schema.Number, received: Schema.Number },
) {}

/**
 * The document store with embedding enqueued on a document's first insert:
 * `onDocumentInsert` with `embeddings.enqueue`, so the queue row lands in
 * the `put`'s own transaction and a rolled-back write queues nothing.
 *
 * @since 0.1.0
 */
export const enqueueEmbeddings = <Document, E, R>(
  documents: DocumentStore<Document, E, R>,
  embeddings: Pick<EmbeddingStore<E, R>, "enqueue">,
): DocumentStore<Document, E, R> =>
  onDocumentInsert(documents, ({ hash }) => embeddings.enqueue(hash));

/**
 * What {@link embedPending} and {@link sweepEmbeddings} need: the queue, the
 * documents, the model and the document's text.
 *
 * @since 0.1.0
 */
export interface EmbeddingPipeline<Document, E, R> {
  readonly embeddings: EmbeddingStore<E, R>;
  readonly documents: Pick<DocumentStore<Document, E, R>, "getMany">;
  readonly embedder: Embedder<E, R>;
  /** The text to embed for a document (its plain-text serialisation), or none to skip it. */
  readonly text: (document: Document) => Option.Option<string>;
  /** Documents per batch, clamped to `[1, MAX_PAGE_LIMIT]`. */
  readonly batchSize: number;
}

/**
 * What one batch did: how many documents it embedded and how many it
 * discarded (missing, or with no text).
 *
 * @since 0.1.0
 */
export interface EmbeddingBatch {
  readonly embedded: number;
  readonly discarded: number;
}

/**
 * Embed one batch of pending documents: one `pending` read, one `getMany`,
 * one embedder call and one `write` (`PERF-DB-001`). A pending hash whose
 * document is missing, or whose `text` is none, is discarded rather than
 * retried forever. Fails {@link EmbeddingMismatch} (writing nothing) when
 * the embedder answers with the wrong number of vectors, else with the
 * stores' and the embedder's `E`.
 *
 * @since 0.1.0
 */
export const embedPending = <Document, E, R>(
  pipeline: EmbeddingPipeline<Document, E, R>,
): Effect.Effect<EmbeddingBatch, E | EmbeddingMismatch, R> =>
  Effect.gen(function* () {
    const hashes = yield* pipeline.embeddings.pending(bounded(Option.some(pipeline.batchSize)));
    if (!Arr.isReadonlyArrayNonEmpty(hashes)) return { embedded: 0, discarded: 0 };
    const found = yield* pipeline.documents.getMany(hashes);
    const textOf = (hash: DocumentHash) => Option.flatMap(HashMap.get(found, hash), pipeline.text);
    const skipped = Arr.filter(hashes, (hash) => Option.isNone(textOf(hash)));
    const texts = Arr.getSomes(
      Arr.map(hashes, (hash) => Option.map(textOf(hash), (text) => ({ hash, text }))),
    );
    if (Arr.isReadonlyArrayNonEmpty(skipped)) yield* pipeline.embeddings.discard(skipped);
    if (!Arr.isReadonlyArrayNonEmpty(texts)) return { embedded: 0, discarded: skipped.length };
    const vectors = yield* pipeline.embedder.embed(Arr.map(texts, ({ text }) => text));
    if (vectors.length !== texts.length) {
      return yield* new EmbeddingMismatch({ expected: texts.length, received: vectors.length });
    }
    yield* pipeline.embeddings.write(
      Arr.zipWith(texts, vectors, ({ hash }, vector) => ({ hash, vector })),
    );
    return { embedded: texts.length, discarded: skipped.length };
  }).pipe(Effect.withSpan("search.embedPending"));

/**
 * Embed batches until the queue is drained or `maxBatches` (clamped to at
 * least 1) have run: the daily sweep of the unembedded. A batch that
 * embeds and discards nothing ends the sweep. Returns the totals.
 *
 * @since 0.1.0
 */
export const sweepEmbeddings = <Document, E, R>(
  pipeline: EmbeddingPipeline<Document, E, R>,
  maxBatches: number,
): Effect.Effect<EmbeddingBatch, E | EmbeddingMismatch, R> => {
  const step = (
    left: number,
    total: EmbeddingBatch,
  ): Effect.Effect<EmbeddingBatch, E | EmbeddingMismatch, R> =>
    Effect.flatMap(embedPending(pipeline), (batch) => {
      const next = {
        embedded: total.embedded + batch.embedded,
        discarded: total.discarded + batch.discarded,
      };
      const done = batch.embedded + batch.discarded === 0 || left <= 1;
      return done ? Effect.succeed(next) : step(left - 1, next);
    });
  return step(Math.max(1, Math.trunc(maxBatches) || 1), { embedded: 0, discarded: 0 }).pipe(
    Effect.withSpan("search.sweepEmbeddings"),
  );
};
