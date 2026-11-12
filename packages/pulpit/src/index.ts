/**
 * `@thomasfosterau/pulpit` — the versioned-content kernel.
 *
 * Every module is exported as a namespace from the package root, following
 * the convention of `effect` and `@thomasfosterau/effect-jsonapi`; each is
 * also a subpath (`@thomasfosterau/pulpit/content`, …) for a consumer that
 * wants one module without the barrel. The in-memory fakes are the one
 * exception: they are the subpath `@thomasfosterau/pulpit/testing` only, so
 * that production code never pulls them in through the barrel.
 *
 * @copyright Thomas Foster
 * @module pulpit
 */

/**
 * The Content model fields: `Visibility`, the visibility / draft / timestamp /
 * tombstone spreads, `ownerRef`, the base `content` resource.
 */
export * as Content from "./content.ts";

/**
 * The registry flag vocabulary, `validateRegistry`, and the derived families /
 * branches.
 */
export * as Registry from "./registry.ts";

/**
 * The append-only node / version chain: create, update, restore, delete,
 * getVersion, compare (with the pure `diffStates`), restoreVersion, history —
 * over a store seam.
 */
export * as VersionChain from "./version-chain.ts";

/** The list-filter vocabulary the read predicates render into, and its in-memory evaluator. */
export * as Filter from "./filter.ts";

/**
 * The subtype operation factory: `LeafAccess`, the read scope and viewer
 * predicates, the write gates, `defineSubtype` and its handlers seam.
 */
export * as Subtype from "./subtype.ts";

/**
 * The publication axis, the moderation state, and the cache serveability
 * policy (`isPubliclyServeable`, the `serveable` hook).
 */
export * as Publication from "./publication.ts";

/**
 * The content-addressed document store seam (`DocumentStore`), the
 * `DocumentHash` it is keyed by, and the `documentRef` field spread a version
 * row carries the reference in.
 */
export * as Documents from "./documents.ts";

/**
 * The edge operations factory: a relation between nodes as its own family
 * (`defineEdgeOps` over an `EdgeStore` seam), readable only when every end
 * is, with declared cardinality limits.
 */
export * as Edges from "./edges.ts";

/**
 * Suggested edits: a contributor's patch against a node's version, accepted
 * through the target's own update or rejected (`defineProposals` over a
 * `ProposalStore` seam), with its two-tier stale / conflict classification.
 */
export * as Proposals from "./proposals.ts";

/**
 * File and media leaves: the blob-store seam (`BlobStore`) keyed by the
 * content hash, the file field spread, the commit-ordered byte write
 * (`defineFileWrites`) and the usage index's edge ends.
 */
export * as Blobs from "./blobs.ts";

/**
 * Routable content: a leaf's path claims tied to its version chain
 * (`routable` over a `PathStore` seam), the aliases a path change leaves
 * behind, and the gated resolution of a path.
 */
export * as Paths from "./paths.ts";

/**
 * The page recipe: a routable, localised leaf's one resolution read
 * (`resolveLocalised`, a path and a locale to a node in the best locale it
 * carries, a redirect, or not-found) and its `localeFallbacks` order.
 */
export * as Pages from "./pages.ts";

/**
 * The moderation workflow: the transition rules as a before hook
 * (`moderationHook`), the decision (`defineModeration`), the review-queue
 * filter, threshold grading (`gradeScores`) and member reports
 * (`defineReports` over a `ReportStore` seam).
 */
export * as Moderation from "./moderation.ts";

/**
 * The working copy: an editor's autosave buffer outside the version chain
 * (`WorkingCopyStore`), committed as one ordinary version
 * (`defineWorkingCopy`).
 */
export * as WorkingCopy from "./working-copy.ts";

/**
 * The comments family: threaded comments on any node as versioned owned
 * leaves (`defineComments`), behind the target's read gate and the
 * moderation gate.
 */
export * as Comments from "./comments.ts";

/**
 * Purge: erasure, the one destructive path through a node's history. It
 * hard-deletes a node's chain and the rows kept for it, then the documents
 * and bytes nothing else references (`definePurge` over a `PurgeStore`).
 */
export * as Purge from "./purge.ts";

/**
 * Account erasure: when a member's account is deleted, its nodes are
 * purged, reassigned to a tombstone account or anonymised per family, and
 * every relationship row naming it goes, in bounded, resumable batches
 * (`defineAccountErasure` over an `AccountErasureStore`).
 */
export * as Erasure from "./erasure.ts";

/**
 * Hybrid search: reciprocal rank fusion over ranked branches, the reranker
 * and branch seams every branch's scope runs through, and the embedding
 * pipeline as seams (`fuseRankings`, `hybridSearch`, `embedPending`).
 */
export * as Search from "./search.ts";

/**
 * Write budgets: a declared ceiling on an account's writes in a rolling
 * window, spent inside the write as a before hook or by a plain-row family,
 * over a `BudgetCounter` seam (`bindBudget`, `budgetHook`).
 */
export * as Budgets from "./budgets.ts";

/**
 * Reactions: one reaction per account per node, a kind from the family's
 * vocabulary, behind the target's read gate, with a grouped tally
 * (`defineReactions` over a `ReactionStore`).
 */
export * as Reactions from "./reactions.ts";

/**
 * The reference resource cache: `./subtype`'s `ResourceCacheSeam`, with a
 * read-through `get`, over a minimal versioned key-value seam
 * (`makeResourceCache` over a `VersionedKv`).
 */
export * as Cache from "./cache.ts";

/**
 * Ordered collections: positioned members of a parent node, the order kept
 * beside the chain or versioned with the parent (`defineCollection` over a
 * `CollectionStore`).
 */
export * as Collections from "./collections.ts";

/**
 * Ordered link lists: a flat, localised list of links under a parent node,
 * read for one viewer with every entry whose target they can't follow
 * omitted (`defineLinkList` over a `./collections` collection).
 */
export * as Links from "./links.ts";

/**
 * The social graph: follow, mute and block between accounts, the follower
 * seam filled from it, and the opt-in read filter over silenced authors
 * (`defineSocial` over a `SocialStore`).
 */
export * as Social from "./social.ts";

/**
 * Audiences: named groups a row can be shared with (the `group` visibility
 * state), their membership gates, and the audience seam filled from them
 * (`defineAudience` over a `MembershipStore`).
 */
export * as Audience from "./audience.ts";

/**
 * Discovery: the keyset-paged enumeration of what a leaf's feeds and
 * sitemap list (anonymously readable, publicly serveable, live, routable),
 * the per-family metadata projection, and the purge-hint after hook
 * (`defineDiscovery`, `purgeHintHook`).
 */
export * as Discovery from "./discovery.ts";

/**
 * UGC relation patterns: reshares with a placeholder for a hidden target,
 * accepted answers gated on the question, and the write gates their edge
 * families take (`defineReshares`, `acceptedAnswerGate`, `nodeWriteGate`).
 */
export * as Relations from "./relations.ts";

/**
 * Translation: lineage and staleness on a localised leaf's locales, the
 * translator seam, and the sweep that lands machine translations directly
 * or as proposals (`defineTranslation`, `humanLineageHook`).
 */
export * as Translation from "./translation.ts";
