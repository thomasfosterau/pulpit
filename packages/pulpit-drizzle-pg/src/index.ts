/**
 * `@thomasfosterau/pulpit-drizzle-pg` — the tree-bound seams of
 * `@thomasfosterau/pulpit` over the tables and views
 * `@thomasfosterau/effect-drizzle-ext` derives from an application's tree,
 * on PostgreSQL.
 *
 * Each module is exported here as a namespace, and as a subpath of its own,
 * following the kernel's convention: the `VersionChain` port over
 * `-pg/chain` (`VersionChain`, `./version-chain`, pulpit#247), the
 * `LeafStore` over the tree's leaf views (`LeafStore`, `./leaf-store`) and
 * the `ListFilter` → SQL renderer it reads through (`Filter`, `./filter`),
 * the live pointer, `PublicationStore` / `LiveView` over the tree's
 * pointer level (`Publication`, `./publication`), the `PathStore` over a
 * path table (`Paths`, `./paths`), the content-addressed `DocumentStore`
 * (`Documents`, `./documents`), and the `SearchBranch` over a tree's views
 * (`Search`, `./search`), and the `ProposalStore` over a proposal table
 * (`Proposals`, `./proposals`).
 *
 * @copyright Thomas Foster
 * @module pulpit-drizzle-pg
 */

/** The kernel's `VersionChain` port, one per leaf, over effect-drizzle-ext `-pg/chain`. */
export * as VersionChain from "./version-chain.ts";

/** The kernel's `LeafStore`, one per leaf, over the tree's current-version views, and the owner table. */
export * as LeafStore from "./leaf-store.ts";

/** The kernel's `ListFilter` and list order, rendered to Drizzle SQL. */
export * as Filter from "./filter.ts";

/** The kernel's live pointer: `PublicationStore`, `LiveView` and the gated store, over a tree's pointer level. */
export * as Publication from "./publication.ts";

/** The kernel's `PathStore`, one table per routable namespace. */
export * as Paths from "./paths.ts";
/** The kernel's content-addressed `DocumentStore`, one table per document family. */
export * as Documents from "./documents.ts";

/** The kernel's `ProposalStore`: suggested edits against a tree's nodes. */
export * as Proposals from "./proposals.ts";

/** The kernel's `SearchBranch`: one ranked, scoped statement over a tree's view. */
export * as Search from "./search.ts";
