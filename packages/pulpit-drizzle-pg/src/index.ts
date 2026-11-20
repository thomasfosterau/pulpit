/**
 * `@thomasfosterau/pulpit-drizzle-pg` — the tree-bound seams of
 * `@thomasfosterau/pulpit` over the tables and views
 * `@thomasfosterau/effect-drizzle-ext` derives from an application's tree,
 * on PostgreSQL.
 *
 * Each module is exported here as a namespace, and as a subpath of its own,
 * following the kernel's convention: the `VersionChain` port over
 * `-pg/chain` (`VersionChain`, `./VersionChain`), the
 * `LeafStore` over the tree's leaf views (`LeafStore`, `./LeafStore`) and
 * the `ListFilter` → SQL renderer it reads through (`Filter`, `./Filter`),
 * the live pointer, `PublicationStore` / `LiveView` over the tree's
 * pointer level (`Publication`, `./Publication`), the `PathStore` over a
 * path table (`Paths`, `./Paths`), the content-addressed `DocumentStore`
 * (`Documents`, `./Documents`), and the `SearchBranch` over a tree's views
 * (`Search`, `./Search`), the `ProposalStore` over a proposal table
 * (`Proposals`, `./Proposals`), the `EdgeStore` over one table per edge
 * family (`Edges`, `./Edges`), the `EmbeddingStore` over a document
 * family's queue and vectors (`Embeddings`, `./Embeddings`), the
 * `ExternalIdStore` over an external-identifier table (`ExternalIds`,
 * `./ExternalIds`), the `CollectionStore` over one membership table per
 * ordered family (`Collections`, `./Collections`), the `ReactionStore`
 * over a reaction table (`Reactions`, `./Reactions`), the `ReportStore`
 * over a member report table (`Reports`, `./Reports`), the
 * `SocialStore` over a relationship table (`Social`, `./Social`), the
 * `MembershipStore` and `GroupOwnerStore` over a group membership table and
 * the application's group table (`Memberships`, `./Memberships`), and the
 * erasure seams, `PurgeStore` and `AccountErasureStore` (`Erasure`,
 * `./Erasure`).
 *
 * @copyright Thomas Foster
 * @module pulpit-drizzle-pg
 */

/** The kernel's `VersionChain` port, one per leaf, over effect-drizzle-ext `-pg/chain`. */
export * as VersionChain from "./VersionChain.ts";

/** The kernel's `LeafStore`, one per leaf, over the tree's current-version views, and the owner table. */
export * as LeafStore from "./LeafStore.ts";

/** The kernel's `ListFilter` and list order, rendered to Drizzle SQL. */
export * as Filter from "./Filter.ts";

/** The kernel's live pointer: `PublicationStore`, `LiveView` and the gated store, over a tree's pointer level. */
export * as Publication from "./Publication.ts";

/** The kernel's `PathStore`, one table per routable namespace. */
export * as Paths from "./Paths.ts";
/** The kernel's content-addressed `DocumentStore`, one table per document family. */
export * as Documents from "./Documents.ts";

/** The kernel's `ProposalStore`: suggested edits against a tree's nodes. */
export * as Proposals from "./Proposals.ts";

/** The kernel's `CollectionStore`: one membership table per ordered family. */
export * as Collections from "./Collections.ts";

/** The kernel's `ReactionStore`: one account's reaction to one node per row. */
export * as Reactions from "./Reactions.ts";

/** The kernel's `ReportStore`: member reports against a tree's nodes, the moderation queue. */
export * as Reports from "./Reports.ts";

/** The kernel's `SocialStore`: follows, mutes and blocks between accounts. */
export * as Social from "./Social.ts";

/** The kernel's `MembershipStore` and `GroupOwnerStore`: a group's members, invitations and owner. */
export * as Memberships from "./Memberships.ts";

/** The kernel's erasure seams: `PurgeStore` and `AccountErasureStore`. */
export * as Erasure from "./Erasure.ts";

/** The kernel's `EdgeStore`: one table per edge family, its ends joined to the tree's views. */
export * as Edges from "./Edges.ts";
/** The kernel's `EmbeddingStore`: a document family's embedding queue and vectors. */
export * as Embeddings from "./Embeddings.ts";
/** The kernel's `ExternalIdStore`: an authority's identifiers linked to a tree's nodes. */
export * as ExternalIds from "./ExternalIds.ts";

/** The kernel's `SearchBranch`: one ranked, scoped statement over a tree's view. */
export * as Search from "./Search.ts";
