/**
 * `@thomasfosterau/pulpit` — the versioned-content kernel.
 *
 * Every module is exported as a namespace from the package root, following
 * the convention of `effect` and `@thomasfosterau/effect-jsonapi`; each is
 * also a subpath (`@thomasfosterau/pulpit/content`, …) for a consumer that
 * wants one module without the barrel.
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
