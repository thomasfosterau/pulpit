/**
 * `@thomasfosterau/pulpit-wordpress` — a WordPress-compatible (`wp/v2`),
 * read-only REST API over the chains of `@thomasfosterau/pulpit`.
 *
 * Each module is exported here as a namespace, and as a subpath of its own,
 * following the kernel's convention: the `wp/v2` read API and its mapping
 * seam (`Api`, `./api`, pulpit#86 phase 1), its `effect/http` adapter
 * (`Http`, `./http`) and the `IdCodec` seam (`Ids`, `./ids`, pulpit#114).
 * The in-memory fakes are the `./testing` subpath only, never this barrel.
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress
 */

/**
 * The `IdCodec` seam an application fills, and the integer and string id
 * modes the adapter reads ids through.
 */
export * as Ids from "./ids.ts";

/**
 * The `wp/v2` read API: posts, pages and media over the leaves an
 * application binds to them, and the discovery index.
 */
export * as Api from "./api.ts";

/** The read API as an `effect/http` request handler. */
export * as Http from "./http.ts";
