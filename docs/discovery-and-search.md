# Discovery and search

Hybrid search and the embedding pipeline (`./search`), and the discovery feed and sitemap enumeration (`./discovery`). The searchable projection, the read scope a search runs under and hit hydration are `./subtype`'s: see [Read model → Search](read-model.md#subtype).

## `./search`

Hybrid search (pulpit#204): the parts of the apps' search pipeline that are not SQL. The ranked queries stay the application's, as [`SearchBranch`](seams.md#searchbranchfollowing-e-r-and-embeddingstoree-r-search-and-embeddings) seams; pulpit fuses them, lets a reranker reorder the result, and runs the embedding pipeline over seams.

The optional members (a branch's `weight`, `FusionOptions`' `k`, `limit` and `perBranch`, and `hybridSearch`'s `reranker`, `k` and `perBranch`) are bare `?: T` (pulpit#238): a caller that has no value omits the key rather than passing `undefined`.

```ts
import { deepStrictEqual } from "node:assert";
import * as Effect from "effect/Effect";
import { always, never } from "@thomasfosterau/pulpit/filter";
import { hybridSearch } from "@thomasfosterau/pulpit/search";

const search = hybridSearch({
  branches: [
    { name: "text", search: () => Effect.succeed([{ id: "a" }, { id: "b" }]) },
    { name: "vector", weight: 2, search: () => Effect.succeed([{ id: "b" }]) },
  ],
});
// In an application, `scope` is the leaf's `searchScopeFilter(leaf, viewer, request)`
// and `headFor` its `searchHeadFor(leaf, viewer)`.
const hits = Effect.runSync(search({ query: "tomato", scope: always, headFor: never, limit: 10 }));
deepStrictEqual(
  hits.map((hit) => hit.id),
  ["b", "a"],
);
```

- **Fusion.** `fuseRankings(branches, { k?, limit?, perBranch? })` is reciprocal rank fusion: each branch's first `perBranch` distinct hits score `weight / (k + rank)` (rank from 1, `k` defaulting to `RRF_K`, 60, the apps' constant), a hit's score is the sum over the branches that ranked it, and `ranks` records each rank. The result is ordered by score, then by id in code-point order, and capped at `limit`. A branch's `weight` defaults to 1; one that is not a finite, non-negative number scores nothing. Every count is clamped to `[1, MAX_PAGE_LIMIT]`. Pure.
- **The reranker** (`RerankerSeam`, optional) is shown the query and the fused candidates and answers their ids in its order. `applyReranking` lets it reorder only: an id that was not a candidate is dropped, and a candidate it omits follows the ones it ranked, in fused order.
- **The branches.** `hybridSearch({ branches, reranker?, k?, perBranch? })` returns a function of `{ query, scope, headFor, limit }` that hands **every branch the same `scope` and `headFor`** (the leaf's `searchScopeFilter` and `searchHeadFor` for the viewer), runs them one after another in the caller's transaction, fuses, reranks, and caps at `limit`. An empty query asks no branch. Feed the result to `hydrateSearchHits`, which re-reads it through the gated `getMany`. A branch must apply the scope in the query that ranks, the live-row rule included, so a hidden row is never ranked and never shifts another hit's rank (`SEC-AUTH-ENUM-001`). `./testing`'s `scopeCheckedBranch` wraps a branch and fails `SearchScopeLeak` on a hit outside the scope, so an application's suite can prove its own branches do.
- **Embeddings.** `enqueueEmbeddings(documents, embeddings)` queues a document on its first insert (`onDocumentInsert`, in the `put`'s transaction, so a rolled-back write queues nothing). `embedPending({ embeddings, documents, embedder, text, batchSize })` embeds one batch: one `pending` read, one `getMany`, one `Embedder.embed` call and one `write` (`PERF-DB-001`). A pending document that is missing, or whose `text` is none, is discarded rather than retried forever; an embedder answering with the wrong number of vectors fails `EmbeddingMismatch` and writes nothing. `sweepEmbeddings(pipeline, maxBatches)` runs batches until the queue drains or `maxBatches` have run: the daily sweep of the unembedded.

`/ask`-style retrieval stays application code over these reads.

| Export | What it is |
| --- | --- |
| `fuseRankings(branches, options?)`, `BranchRanking`, `RankedHit`, `FusedHit`, `FusionOptions`, `RRF_K` | Reciprocal rank fusion and its inputs, output and options. |
| `applyReranking(candidates, order)`, `RerankerSeam` | A reranker's reordering, which can't add or drop a hit, and the seam. |
| `hybridSearch(definition)`, `HybridSearchDefinition`, `SearchBranch`, `BranchRequest`, `SearchScopeLeak` | The branches under one scope, fused and reranked; the branch seam and its request; the failure `scopeCheckedBranch` raises. |
| `enqueueEmbeddings`, `embedPending`, `sweepEmbeddings`, `EmbeddingStore`, `Embedder`, `EmbeddingPipeline`, `EmbeddingBatch`, `EmbeddingMismatch` | The embedding pipeline, its seams, a batch's result and its one failure. |

## `./discovery`

Discovery (pulpit#203), after website's `packages/database/src/discovery.ts` and gardeneria's `lib/server/discovery.ts`: what a site's feeds and sitemap list. The kernel owns _what is discoverable_ and the metadata; the serialisers stay the application's.

The optional members (a cursor's and a request's `locale`, the request's `after`, and the definition's `serveable`) are bare `?: T` (pulpit#238): a caller that has no value omits the key rather than passing `undefined`, so a page loop resumes with `{ ...request, after: cursor }` only once it holds a cursor.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineDiscovery, lastModified, purgeHintHook } from "@thomasfosterau/pulpit/discovery";

const discovery = defineDiscovery({
  leaf: postsDefinition, // the leaf's own `SubtypeDefinition`
  paths: postPaths, // its `PathStore`, for each item's canonical path
  feedColumn: "publishedAt", // newest first
  project: (post) => ({
    title: post.attributes.title,
    summary: Option.some(post.attributes.excerpt),
    image: Option.none(),
    schemaType: "BlogPosting",
    published: Option.some(post.attributes.publishedAt),
    modified: Option.none(),
  }),
});

const pages = Effect.gen(function* () {
  const page = yield* discovery.feed({ limit: 50 }); // { items, next }
  const more = yield* discovery.feed({ limit: 50, after: Option.getOrUndefined(page.next) });
  const urls = yield* discovery.sitemap({ limit: 1000 }); // by id; `lastModified(item.metadata)` is `lastmod`
  return { page, more, urls };
});

// RSS / Atom / JSON Feed and the sitemap are built from the items, outside the kernel, e.g. with
// effect-ext's `@thomasfosterau/effect-ext/RssFeed`, `/AtomFeed`, `/JsonFeed` and `/Sitemap`:
// RssFeed.make({ …, items: page.items.map(({ path, metadata }) => ({ link: origin + path, title: metadata.title })) })

// The purge hint, as one of the leaf's after hooks:
const hooks = { before: [], after: [purgeHintHook({ publishGated: true, emit: purgeTags })] };
```

- **What is discoverable.** A node is listed only when **an anonymous reader may list it**, **its resource is publicly serveable** and **it has a canonical path**. The first is the leaf's own `list`, bound to the anonymous viewer: a `private`, `followers`, draft, unapproved or tombstoned row is never listed, by the filters every read uses (`SEC-AUTH-ENUM-001`). On a publish-gated leaf it is the **live** version, never the head, and a node never published, unpublished or published only at a future stamp is not listed (pulpit#46). The second is `isPubliclyServeable` (`CACHE-AUTH-005`), `serveablePolicy` at the leaf's posture unless the family declares `serveable`: whatever a feed lists, a public cache may hold. The resource is read as JSON:API (`attributes`); on a gated leaf it must carry `publishedAt`.
- **Keyset paging.** The feed orders by `feedColumn` descending, `NULL`s last, then `id` ascending; the sitemap by `id`. `next` is the cursor after the last row the page _read_, so a page the guards thinned may hold fewer items than `limit` (clamped to `MAX_PAGE_LIMIT`) and paging never skips or repeats a node. `feedColumn` must be a sortable column of the leaf (on a gated leaf one of `LeafStore.columns` the live view projects, such as `publishedAt`) holding a timestamp, text or number; anything else is a defect. Each item's path is one `PathStore.canonicalOf` read, so a page costs up to `limit` of them.
- **The metadata projection** (`DiscoveryMetadata`: title, summary, image, schema.org type, published and modified dates) is per family, read from the anonymous resource, and is what the feed item, the page head and its JSON-LD all read, so one mapping serves the three. `lastModified(metadata)` is the sitemap's `lastmod`.
- **Purge hints.** `purgeHintHook({ publishGated, emit })` is an after hook (it runs once the write has committed) emitting `{ type, id, tags: ["discovery:<type>", "node:<type>:<id>"] }` for every write that can change what the family lists: on a gated leaf `publish`, `unpublish`, `delete`, `restore` and `restoreVersion` (a `create` or `update` touches only the head); on any other leaf, every write. A scheduled publication whose stamp arrives later fires no hook: purge from the sweep over `./publication`'s `duePublications`.
- **A localised leaf** (pulpit#265) lists one item per `(node, locale)` its view lists, each carrying its `locale` (none for a node whose version carries no locale), under the same three checks on that locale's row: on a publish-gated leaf, a locale only the unpublished head carries is not listed. The **feed** orders by `feedColumn`, then the locale (`NULL`s last), then `id`, and its cursor carries the locale, so a page may end inside a node's locales without a skip or a repeat; `request.locale` narrows it to one language (`./filter`'s `locale` arm). The **sitemap** orders by node and never splits a node's locales across pages (a page that would end inside a node ends before it; a page holding only that node holds all of its locales, even past `limit`), so each item's `alternates`, the node's other listed locales by code point, is complete: the sitemap's `hreflang` set. The canonical path stays per node (pulpit#57) and is read once per node; each alternate's URL is the application's to build from the path and the locale.

| Export | What it is |
| --- | --- |
| `defineDiscovery(definition)`, `DiscoveryDefinition`, `DiscoveryOps` | The factory, its declaration and the two reads. |
| `DiscoveryRequest`, `DiscoveryCursor`, `DiscoveryPage`, `DiscoveryItem` | A page request, its cursor, a page and one item. |
| `DiscoveryMetadata`, `DiscoveryImage`, `lastModified` | The metadata projection and the sitemap's `lastmod`. |
| `purgeHintHook(options)`, `PurgeHint` | The purge-hint after hook and its event. |
| `DiscoveryDeclarationError` | The defect for a feed column that doesn't order. |
