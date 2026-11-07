/**
 * **The page recipe** (pulpit#201) — a routable, localised leaf answered by
 * one resolution read: a path and a requested locale resolve to the node in
 * the best locale it carries, to a redirect from an alias, or to not-found.
 *
 * A page family is assembled from the existing modules; this one adds only
 * the read that joins them (see the package README → Pages):
 *
 * - **the leaf** — `./subtype`'s `defineSubtype`, usually a reference leaf
 *   (corpus material written at the corpus-write rung), with a locale level
 *   (`defineLocaleLevel`) and, for scheduled and drafted pages, the
 *   publication pointer (`./publication`, pulpit#46);
 * - **the path** — `./paths`' `routable` over a shared (untranslated) path
 *   column. A page collection is a root claim in `./paths` (owner decision
 *   on pulpit#201): one `PathStore` per collection, so a path is claimed
 *   once per collection and a slug translation is never a claim of its own;
 * - **the read** — {@link resolveLocalised}, here.
 *
 * Every read rule is the leaf's own: the path goes through `routable`'s
 * gated `resolve`, and the locale through `getLocalised`, which gates the
 * node exactly as `get` does. So a hidden, unpublished, scheduled or
 * tombstoned page resolves as {@link PathNotFound}, exactly as a path
 * nobody claims (`SEC-AUTH-ENUM-001`), and never as forbidden. Navigation
 * menus and page builders are not part of the recipe.
 *
 * @copyright Thomas Foster
 * @module pulpit/pages
 * @since 0.2.0
 */

import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { PathNotFound, type Resolution } from "./paths.ts";
import type { LocalisedResource } from "./subtype.ts";
import type { NodeNotFound } from "./version-chain.ts";

/**
 * The locales a page read tries, in order: the requested tag, each shorter
 * prefix of it (its base language: `pt-BR` → `pt`, `zh-Hant-TW` →
 * `zh-Hant` → `zh`), then the family's default. Empty tags are dropped and
 * each tag is tried once. Tags are compared exactly as given: normalise
 * their case before they reach a store (BCP 47 is case-insensitive; the
 * locale rows are not).
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { localeFallbacks } from "@thomasfosterau/pulpit/pages";
 *
 * deepStrictEqual(localeFallbacks("pt-BR", "en"), ["pt-BR", "pt", "en"]);
 * deepStrictEqual(localeFallbacks("en", "en"), ["en"]);
 * ```
 *
 * @since 0.2.0
 */
export const localeFallbacks = (
  requested: string,
  defaultLocale: string,
): ReadonlyArray<string> => {
  const subtags = Array.filter(Str.split(requested, "-"), Str.isNonEmpty);
  const prefixes = Array.map(Array.reverse(Array.range(1, Math.max(1, subtags.length))), (count) =>
    Array.join(Array.take(subtags, count), "-"),
  );
  return Array.dedupe(Array.filter([...prefixes, defaultLocale], Str.isNonEmpty));
};

/**
 * What a localised path resolves to for one viewer: the node in the locale
 * the fallback chose, or a redirect from an alias to the node's canonical
 * path (the wire's 301).
 *
 * @since 0.2.0
 */
export type LocalisedResolution<Resource> =
  | {
      readonly kind: "node";
      readonly id: string;
      /** The locale the read fell back to: the first of {@link localeFallbacks} the node carries. */
      readonly locale: string;
      readonly resource: Resource;
    }
  | { readonly kind: "redirect"; readonly id: string; readonly path: string };

/**
 * The two reads {@link resolveLocalised} joins: a routable leaf's gated
 * `resolve` (`./paths`' `RoutableOps`) and its locale-fallback `getLocalised`
 * (`./subtype`'s `SubtypeOps`). A `routable(defineSubtype(…), …)` fits as it
 * stands.
 *
 * @since 0.2.0
 */
export interface LocalisedRoutes<Resource, E, R> {
  readonly resolve: (path: string) => Effect.Effect<Resolution<Resource>, PathNotFound | E, R>;
  readonly getLocalised: (
    id: string,
    locales: ReadonlyArray<string>,
  ) => Effect.Effect<LocalisedResource<Resource>, NodeNotFound | E, R>;
}

/**
 * What {@link resolveLocalised} needs besides the leaf.
 *
 * @since 0.2.0
 */
export interface LocalisedRoutesConfig {
  /** The family's default locale: the last fallback every read tries. */
  readonly defaultLocale: string;
}

/**
 * The page resolution read: resolve `path` through the leaf's gated
 * `resolve`, then read the node in the first of
 * {@link localeFallbacks}`(locale, defaultLocale)` it carries. An alias
 * answers its redirect without reading a locale (the canonical path is the
 * node's, shared by every locale). Fails {@link PathNotFound} for a path
 * nobody claims, a node hidden from the viewer (private, unpublished,
 * scheduled, tombstoned), an alias to one, and a node that carries none of
 * the fallback locales, alike (`SEC-AUTH-ENUM-001`); with the leaf's `E`
 * otherwise.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashSet from "effect/HashSet";
 * import * as Option from "effect/Option";
 * import { resolveLocalised } from "@thomasfosterau/pulpit/pages";
 * import { routable } from "@thomasfosterau/pulpit/paths";
 * import { defineLocaleLevel, defineSubtype, nobodyFollows } from "@thomasfosterau/pulpit/subtype";
 * import {
 *   makeInMemoryChainStore,
 *   makeInMemoryLeafStore,
 *   makeInMemoryPathStore,
 * } from "@thomasfosterau/pulpit/testing";
 *
 * const chain = makeInMemoryChainStore();
 * const pages = routable(
 *   defineSubtype({
 *     type: "pages",
 *     access: { kind: "reference" },
 *     chain,
 *     leaves: makeInMemoryLeafStore(chain, { columns: ["slug", "title"], localised: true }),
 *     viewer: Effect.succeed(Option.some({ id: "editor", role: "admin" })),
 *     policy: {
 *       canViewPrivate: () => true,
 *       canViewDeleted: () => true,
 *       canModerate: () => true,
 *       canWriteCorpus: () => true,
 *     },
 *     followers: nobodyFollows(HashSet.empty<string>()),
 *     toResource: (row) => ({ id: row.id, title: row["title"] }),
 *     locales: defineLocaleLevel({ columns: ["title"] }),
 *   }),
 *   { column: "slug", paths: makeInMemoryPathStore(), chain },
 * );
 * const resolve = resolveLocalised(pages, { defaultLocale: "en" });
 * const program = Effect.gen(function* () {
 *   yield* pages.create({
 *     id: Option.none(),
 *     state: { slug: "about" },
 *     locales: { en: { title: "About" }, pt: { title: "Sobre" } },
 *   });
 *   return yield* resolve("about", "pt-BR");
 * });
 * const resolved = Effect.runSync(program);
 * strictEqual(resolved.kind === "node" && resolved.locale, "pt");
 * ```
 *
 * @since 0.2.0
 */
export const resolveLocalised =
  <Resource, E, R>(ops: LocalisedRoutes<Resource, E, R>, config: LocalisedRoutesConfig) =>
  (
    path: string,
    locale: string,
  ): Effect.Effect<LocalisedResolution<Resource>, PathNotFound | E, R> =>
    Effect.filterOrElse(
      ops.resolve(path),
      (resolved): resolved is Extract<Resolution<Resource>, { readonly kind: "redirect" }> =>
        resolved.kind === "redirect",
      (resolved) =>
        ops.getLocalised(resolved.id, localeFallbacks(locale, config.defaultLocale)).pipe(
          Effect.map((found): LocalisedResolution<Resource> => ({
            kind: "node",
            id: resolved.id,
            locale: found.locale,
            resource: found.resource,
          })),
          // The node's own gate answered: hidden, or in none of the locales.
          Effect.catchTag("NodeNotFound", () => Effect.fail(new PathNotFound({ path }))),
        ),
    );
