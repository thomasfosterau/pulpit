/**
 * `@thomasfosterau/pulpit-wordpress` — a WordPress-compatible (`wp/v2`),
 * read-only REST API over the chains of `@thomasfosterau/pulpit`.
 *
 * Each module is exported here as a namespace, and as a subpath of its own,
 * following the kernel's convention. So far that is the `IdCodec` seam
 * (`Ids`, `./ids`, pulpit#114); the endpoints and the mapping seam land with
 * pulpit#86 phase 1. The in-memory fakes are the `./testing` subpath only,
 * never this barrel.
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress
 */

/**
 * The `IdCodec` seam an application fills, and the integer and string id
 * modes the adapter reads ids through.
 */
export * as Ids from "./ids.ts";
