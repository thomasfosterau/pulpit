/**
 * @copyright Thomas Foster
 *
 * `@thomasfosterau/pulpit` — the versioned-content kernel.
 *
 * Every module is exported as a namespace from the package root, following
 * the convention of `effect` and `@thomasfosterau/effect-jsonapi`; each is
 * also a subpath (`@thomasfosterau/pulpit/content`, …) for a consumer that
 * wants one module without the barrel.
 *
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
