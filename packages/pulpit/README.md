# @thomasfosterau/pulpit

The kernel of a general-purpose Effect headless CMS: versioned content of any shape, with its history and review, publication, structure and routing, participation and user-generated content, discovery and search, media, localisation and erasure, each a module of its own behind seams the application fills. The kernel names no application type: a `page`, a `post` or an `album` is a leaf the application declares and binds to the capabilities it needs. Optional packages (the WordPress-compatible read API, [`@thomasfosterau/pulpit-wordpress`](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit-wordpress/README.md), today) build on it; it imports none of them.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi @thomasfosterau/effect-auth
```

`effect` (`^4.0.0`) and `@thomasfosterau/effect-jsonapi` (`>=0.17.0`) are required peer dependencies; the package is built against `effect@4.0.0` and `@thomasfosterau/effect-jsonapi@0.17.0`. Node.js 22 or newer is required.

## Example

A version chain over the in-memory chain from `./testing`; an application binds the same operations to its own `VersionChain` (pulpit-drizzle-pg's, once it publishes).

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
import { makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";

const chain = defineVersionChain("posts", makeInMemoryVersionChain("posts"));
const actorId = Option.none<string>();

const program = Effect.gen(function* () {
  const { id } = yield* chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
  yield* chain.update({ id, patch: { title: "Hi" }, actorId }); // appends version 1
  yield* chain.delete(id, actorId); // a tombstone, version 2
  yield* chain.restoreVersion(id, 0n, actorId); // version 3, with version 0's state
  return yield* chain.compare(id, 0n, 1n); // changes: { title: "Hello" → "Hi" }
});

Effect.runPromise(program).then(({ changes }) => console.log(changes));
```

## Entry points

Every module is a namespace on the root export (`import { Content, Registry } from "@thomasfosterau/pulpit"`) and a subpath of its own, except `./testing`, which is a subpath only, so that nothing imports the fakes by accident.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Content`, `Registry`, `VersionChain`, `Filter`, `Subtype`, `Publication`, `Documents`, `Edges`, `Proposals`, `Blobs`, `Paths`, `Pages`, `Moderation`, `WorkingCopy`, `Comments`, `Purge`, `Search`, `Budgets`, `Reactions`, `Cache`, `Collections`, `Links`, `Social`, `Discovery`, `ReferenceImport`, `Notifications`). |
| **Content model** |  |
| [`./content`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/content-model.md#content) | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| [`./registry`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/content-model.md#registry) | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`, `routable`, `localised`) and `validateRegistry`. |
| [`./documents`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/content-model.md#documents) | The content-addressed `DocumentStore` seam and its first-insert hook, the `DocumentHash` it is keyed by, the `documentRef` field spread, and the hash contract's `canonicalText`. |
| [`./filter`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/content-model.md#filter) | `ListFilter`, the read-predicate tree a store renders to SQL, and its in-memory `evaluate`. |
| [`./subtype`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#subtype) | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`, `subtypeHandlers`, and the lifecycle hook seam (before / after every write). |
| **History and review** |  |
| [`./version-chain`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/history-and-review.md#version-chain) | The append-only node/version chain: the operation-level `VersionChain` port, the before-append hook layer over it (`defineVersionChain`), and the field-level version compare (`diffStates`, `compare`). |
| [`./working-copy`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/history-and-review.md#working-copy) | An editor's autosave buffer outside the version chain (`WorkingCopyStore`), committed as one ordinary version (`defineWorkingCopy`). |
| [`./proposals`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/history-and-review.md#proposals) | `defineProposals`, suggested edits over a `ProposalStore` seam: a contributor's patch against a base version, its two-tier stale / conflict classification, and accept (through the target's own update, recording `proposedBy`), reject and withdraw. |
| [`./moderation`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/history-and-review.md#moderation) | The moderation workflow: the transition rules as a before hook, the decision, the review-queue filter, threshold grading and member reports over a `ReportStore` seam. |
| **Publication** |  |
| [`./publication`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#publication) | The publication and moderation predicates, the scheduled-publication sweep window, and the cache serveability policy. |
| [`./cache`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#cache) | The reference resource cache (`makeResourceCache` over a `VersionedKv` seam): the kernel's compare-on-set `ResourceCacheSeam` with a read-through `get`, serveability checked on write and read, decode-or-evict and a TTL backstop. |
| **Structure and routing** |  |
| [`./edges`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#edges) | `defineEdgeOps`, the edge operations factory over an `EdgeStore` seam: relations between nodes, readable only when every end is, with declared cardinality limits. |
| [`./paths`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#paths) | Routable content: `routable`, a leaf's path claims tied to its chain over a `PathStore` seam, the aliases a path change leaves behind, and the gated `resolve`. |
| [`./pages`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#pages) | The page recipe: `resolveLocalised`, a routable, localised leaf's one resolution read (a path and a locale to the node in the best locale it carries, a redirect from an alias, or not-found), and its `localeFallbacks` order. |
| [`./collections`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#collections) | Ordered collections (`defineCollection` over a `CollectionStore` seam): positioned members of a parent node, with the order kept beside the chain (the default) or versioned with the parent. |
| [`./links`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#links) | Ordered link lists (`defineLinkList`): a localised list of links under a parent node (a navigation menu, say) over a `./collections` collection, with nested lists (sub-menus), read for one viewer with every entry whose target they can't follow omitted. |
| **Participation and user-generated content** |  |
| [`./budgets`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#budgets) | Write budgets: a declared ceiling on an account's writes of one kind in a rolling window, spent inside the write (`budgetHook` on a chain write; `bindBudget`'s `spend` on a proposal's `submit` or a report's `file`) over a `BudgetCounter` seam, refused as a rate-limited `WriteRejected` (the wire's 429). |
| [`./comments`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#comments) | The comments family: threaded comments on any node as versioned owned leaves (`defineComments`), behind the target's read gate and the moderation gate, with a configurable reply depth. |
| [`./reactions`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#reactions) | Reactions (`defineReactions` over a `ReactionStore` seam): one per account per node, a kind from the family's own vocabulary, behind the target's read gate, with a grouped tally for a page of nodes. |
| [`./translation`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#translation) | Translation lineage and staleness on a localised leaf (`lineageOf`, `defineTranslation`'s `pending`), the `Translator` and `TranslationCandidates` seams, the sweep that lands machine translations directly or as proposals, and `humanLineageHook`. |
| [`./discovery`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/discovery-and-search.md#discovery) | Discovery (`defineDiscovery`): the keyset-paged feed and sitemap enumeration of a leaf's anonymously readable, publicly serveable, live, routable nodes, the per-family metadata projection, and the purge-hint after hook (`purgeHintHook`). |
| [`./reference-import`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#reference-import) | External reference import (`defineReferenceImport` over an `ExternalIdStore` seam): upserting a reference leaf's nodes from a feed by `(authority, externalId)` identifiers, as ordinary chain writes made as a declared bot, with per-field merge modes (`overwrite`, `coalesce`, `curated-wins`), no-op detection, a pre-attached id and a per-batch summary. |
| [`./social`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#social) | The social graph (`defineSocial` over a `SocialStore` seam): follow, mute and block between accounts, the follower seam filled from it (`socialFollowers`), and the opt-in read filter over the authors a viewer silenced. |
| [`./audience`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#audience) | Audiences (`defineAudience` over a `MembershipStore` seam): named groups a row can be shared with (the `group` visibility), who manages and who may leave them, and the audience seam filled from them (`audienceSeam`). |
| [`./relations`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/structure.md#relations) | UGC relation patterns over `./edges` and `./collections`: reshares whose hidden target shows as a placeholder (`defineReshares`), accepted answers gated on the question (`acceptedAnswerGate`), an edge gate on one end's node (`nodeWriteGate`), and credit-only bylines. |
| [`./notifications`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/participation.md#notifications) | Notifications (`defineNotifications`): an outbox of content events written in the triggering write's own transaction (`notificationHook` on a chain write, `emitting` around any other write), the kernel kinds derived from comments, moderation, reports, proposals, follows and the new mentions in a write's documents (`mentionCreatedHook` over the application's `MentionExtractor`), a fan-out gated on each subject's read, mute, block and per-account preferences, an inbox, and a delivery seam. |
| **Media** |  |
| [`./blobs`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/media.md#blobs) | File and media leaves: the `BlobStore` seam keyed by content hash, the file field spread, the commit-ordered byte write (`defineFileWrites`, with its `bytesPending` marker) and the usage index's edge ends. |
| [`./media`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/media.md#media) | The media library: the media field spread (editorial fields and extracted metadata), the upload pipeline that records an extractor's metadata (`defineMediaUploads`, EXIF location kept unless a family strips it), gated renditions by width bucket and negotiated format (`defineRenditions`), and albums over `./collections` (`defineAlbum`). |
| **Erasure** |  |
| [`./purge`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/erasure.md#purge) | Erasure (`definePurge` over a `PurgeStore` seam): the one destructive path, which hard-deletes a node's chain and the rows kept for it, then the documents and bytes no other version references. |
| [`./erasure`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/erasure.md#erasure) | Account erasure (`defineAccountErasure` over an `AccountErasureStore` seam): a deleted member's nodes purged, reassigned to a tombstone account or anonymised per family, and every row naming them erased, in bounded, resumable batches. |
| **Discovery and search** |  |
| [`./search`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/discovery-and-search.md#search) | Hybrid search: reciprocal rank fusion (`fuseRankings`), a reranker seam, `hybridSearch` over `SearchBranch` seams that each apply the leaf's read scope, and the embedding pipeline (`enqueueEmbeddings`, `embedPending`, `sweepEmbeddings`) over `EmbeddingStore` and `Embedder` seams. |
| **Testing** |  |
| [`./testing`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md#testing) | In-memory fakes of the seams (the chain, leaf, document, edge, proposal, blob, path, report, publication, working-copy, purge, account-erasure, embedding, reaction, collection, social, membership, outbox, inbox and preference stores, the budget counter and write counts, a versioned KV, an endpoint view, a follower seam, a search branch and its scope check), for tests only. Not on the root export. |

**Discovery and search** is also `./subtype`'s searchable projection, read scope and hit hydration (see [Read model → Search](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/read-model.md#subtype)), which `./search` builds on. **Localisation** is the version chain's locale level (`./version-chain`, `./subtype`'s `getLocalised` and `./filter`'s `locale` arm), not a module of its own.

The operations are written against seams that the application fills; their expected shapes, with a SQL sketch of each, are in [docs/seams.md](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md).

## Links

- [docs/](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/README.md): the module guides each subpath above links to, and [the seams](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md), each with its expected shape and SQL sketch.
- The API reference is each export's TSDoc: its contract, its error channel and the invariant IDs it honours.
- [SECURITY.md](https://github.com/thomasfosterau/pulpit/blob/trunk/SECURITY.md): reporting a vulnerability, and the invariant IDs with their rationale.
- [CHANGELOG.md](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit/CHANGELOG.md), and the repository's [README](https://github.com/thomasfosterau/pulpit/blob/trunk/README.md) and [CONTRIBUTING.md](https://github.com/thomasfosterau/pulpit/blob/trunk/CONTRIBUTING.md).

## License

MIT
