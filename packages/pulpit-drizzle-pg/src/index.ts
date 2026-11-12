/**
 * `@thomasfosterau/pulpit-drizzle-pg` — the tree-bound seams of
 * `@thomasfosterau/pulpit` over the tables and views
 * `@thomasfosterau/effect-drizzle-ext` derives from an application's tree,
 * on PostgreSQL.
 *
 * Each module is exported here as a namespace, and as a subpath of its own,
 * following the kernel's convention: the `VersionChain` port over
 * `-pg/chain` (`VersionChain`, `./version-chain`, pulpit#247).
 *
 * @copyright Thomas Foster
 * @module pulpit-drizzle-pg
 */

/** The kernel's `VersionChain` port, one per leaf, over effect-drizzle-ext `-pg/chain`. */
export * as VersionChain from "./version-chain.ts";
