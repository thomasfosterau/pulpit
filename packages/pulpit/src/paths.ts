/**
 * **Routable content** — a leaf's path claims, tied to its version chain,
 * the slug aliases a path change leaves behind, and the gated resolution of
 * a path to a node or a redirect.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/pages.ts`
 * and `packages/database/src/tables/pages.ts` (one live page per canonical
 * path, old slugs kept in `page_slugs` and answered with a 301). A `#NNN`
 * here names a gardeneria issue.
 *
 * ## The model (owner decision on pulpit#57)
 *
 * - **A claim lives on the root node**: one path per content item. The
 *   locale is chosen when the resolved node is read, never by the path, so a
 *   slug translation is not a claim of its own (pulpit#56's model (b)).
 * - **Claims follow the node's lifecycle.** A write that leaves the node
 *   live claims the path its new state holds in the leaf's path column; a
 *   tombstone, or a state with no path, frees the claim; a restore re-claims
 *   its path, or fails {@link PathTaken} when another node holds it now.
 * - **A path change records an alias**: the old path resolves as a redirect
 *   to the new one, for as long as no other node claims it.
 * - **Resolution is gated** (`SEC-AUTH-ENUM-001`): {@link RoutableOps.resolve}
 *   reads the node through the leaf's own `get`, so a hidden node's path,
 *   and an alias to a hidden node, is {@link PathNotFound}, never a redirect.
 *
 * Free-form redirects (patterns, a 404 log) are the site's. The path's
 * syntax is the leaf attribute's schema (effect-schema-ext's `Ids.slug`, once
 * it publishes).
 *
 * @copyright Thomas Foster
 * @module pulpit/paths
 * @since 0.1.0
 */

import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SubtypeOps } from "./subtype.ts";
import type { ChainWrite, VersionChainStore } from "./version-chain.ts";

// ── The path-store seam ───────────────────────────────────────────────

/**
 * Another node holds the path canonically: the wire's 409. It names the
 * path, never the holder, so it says only that the path is taken, as a
 * unique-key conflict does, whoever holds it.
 *
 * @since 0.1.0
 */
export class PathTaken extends Schema.TaggedError<PathTaken>()("PathTaken", {
  path: Schema.String,
}) {}

/**
 * No node the viewer can read answers to the path: the wire's 404. A path
 * nobody claims, one whose node is hidden from the viewer, and an alias to a
 * hidden node all answer this, alike (`SEC-AUTH-ENUM-001`).
 *
 * @since 0.1.0
 */
export class PathNotFound extends Schema.TaggedError<PathNotFound>()("PathNotFound", {
  path: Schema.String,
}) {}

/**
 * What a path is stored as: the node it names, and whether it is that
 * node's canonical path or an alias a path change left behind.
 *
 * @since 0.1.0
 */
export interface PathEntry {
  readonly nodeId: string;
  readonly canonical: boolean;
}

/**
 * The path table of one routable namespace (a collection): each path once,
 * canonical for one node or an alias of one. A store that persists and
 * applies no policy; it runs in the caller's transaction, so a write whose
 * claim fails rolls back with its chain append.
 *
 * @since 0.1.0
 */
export interface PathStore<E, R> {
  /** The entry for `path`, canonical or alias, or none. */
  readonly lookup: (path: string) => Effect.Effect<Option.Option<PathEntry>, E, R>;
  /** The node's canonical path, or none. */
  readonly canonicalOf: (nodeId: string) => Effect.Effect<Option.Option<string>, E, R>;
  /**
   * Make `path` the node's canonical path, in one step: fails
   * {@link PathTaken} when another node holds it canonically; otherwise
   * replaces an alias at `path` (the node's own, which a revert promotes, or
   * another node's, which the claim takes over) and turns the node's previous
   * canonical path, if any, into its alias.
   */
  readonly claim: (nodeId: string, path: string) => Effect.Effect<void, PathTaken | E, R>;
  /** Free the node's canonical path, if it has one; its aliases stay. */
  readonly release: (nodeId: string) => Effect.Effect<void, E, R>;
}

// ── The routable operations ───────────────────────────────────────────

/**
 * What a path resolves to for one viewer: the node's resource at its
 * canonical path, or a redirect from an alias to the canonical path.
 *
 * @since 0.1.0
 */
export type Resolution<Resource> =
  | { readonly kind: "node"; readonly id: string; readonly resource: Resource }
  | { readonly kind: "redirect"; readonly id: string; readonly path: string };

/**
 * A routable leaf's operations: the leaf's own, each write keeping its path
 * claim in step with the state it wrote (and failing {@link PathTaken}), plus
 * the gated {@link resolve}.
 *
 * @since 0.1.0
 */
export interface RoutableOps<Resource, E, R> extends SubtypeOps<Resource, E | PathTaken, R> {
  /**
   * Resolve a path for the viewer: its node, through the leaf's own `get`, or
   * a redirect from an alias to the node's canonical path. Fails
   * {@link PathNotFound} for an unclaimed path, a hidden node's path, and an
   * alias to a hidden node, alike, and for an alias whose node has no
   * canonical path now (`SEC-AUTH-ENUM-001`); with the store's `E` otherwise.
   */
  readonly resolve: (path: string) => Effect.Effect<Resolution<Resource>, PathNotFound | E, R>;
}

/**
 * What {@link routable} needs besides the leaf's operations.
 *
 * @since 0.1.0
 */
export interface RoutableConfig<E, R> {
  /** The leaf's path column: a string holds the node's path; any other value, or none, claims nothing. */
  readonly column: string;
  /** The routable namespace's path table. */
  readonly paths: PathStore<E, R>;
  /** The leaf's chain store, read (ungated) for the state a write landed at. */
  readonly chain: VersionChainStore<E, R>;
}

/**
 * Make a leaf routable (pulpit#57): its writes keep the node's path claim in
 * step with its chain, and {@link RoutableOps.resolve} answers a path through
 * the leaf's own read gate. After each write's append, in the same
 * transaction, the claim follows the state the write landed at: a live state
 * with a path claims it (a change leaves the old path as an alias; another
 * node's claim fails {@link PathTaken}), and a tombstone or a state with no
 * path frees it. A restore into a path another node took meanwhile therefore
 * fails `PathTaken`, and its append rolls back with it. Wrap the result with
 * `./subtype`'s `subtypeHandlers` as the leaf's own operations, so its
 * `transact` covers the claims.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { routable } from "@thomasfosterau/pulpit/paths";
 * import { defineSubtype, nobodyFollows } from "@thomasfosterau/pulpit/subtype";
 * import {
 *   makeInMemoryChainStore,
 *   makeInMemoryLeafStore,
 *   makeInMemoryPathStore,
 * } from "@thomasfosterau/pulpit/testing";
 * import * as HashSet from "effect/HashSet";
 *
 * const chain = makeInMemoryChainStore();
 * const pages = routable(
 *   defineSubtype({
 *     type: "pages",
 *     access: { kind: "reference" },
 *     chain,
 *     leaves: makeInMemoryLeafStore(chain, { columns: ["slug"] }),
 *     viewer: Effect.succeed(Option.some({ id: "editor", role: "admin" })),
 *     policy: {
 *       canViewPrivate: () => true,
 *       canViewDeleted: () => true,
 *       canModerate: () => true,
 *       canWriteCorpus: () => true,
 *     },
 *     followers: nobodyFollows(HashSet.empty<string>()),
 *     toResource: (row) => ({ id: row.id, slug: row["slug"] }),
 *   }),
 *   { column: "slug", paths: makeInMemoryPathStore(), chain },
 * );
 * const program = Effect.gen(function* () {
 *   const { id } = yield* pages.create({ id: Option.none(), state: { slug: "about" } });
 *   yield* pages.update({ id, patch: { slug: "about-us" } });
 *   return yield* pages.resolve("about");
 * });
 * const resolved = Effect.runSync(program);
 * strictEqual(resolved.kind === "redirect" && resolved.path, "about-us");
 * ```
 *
 * @since 0.1.0
 */
export const routable = <Resource, E, R>(
  ops: SubtypeOps<Resource, E, R>,
  config: RoutableConfig<E, R>,
): RoutableOps<Resource, E, R> => {
  const { column, paths, chain } = config;

  // The claim the written state calls for: its path while it is live, none
  // for a tombstone or a state whose path column holds no string.
  const follow = ({ id, version }: ChainWrite) =>
    Effect.gen(function* () {
      const written = yield* chain.snapshot(id, version);
      const path = Option.flatMap(written, (snapshot) =>
        snapshot.action === "delete"
          ? Option.none()
          : Option.liftPredicate(snapshot.state[column], Predicate.isString),
      );
      const held = yield* paths.canonicalOf(id);
      if (Option.makeEquivalence(Equivalence.String)(path, held)) return;
      yield* Option.match(path, {
        onNone: () => paths.release(id),
        onSome: (claimed) => paths.claim(id, claimed),
      });
    });
  const claiming = <A extends ChainWrite, E2, R2>(write: Effect.Effect<A, E2, R2>) =>
    Effect.tap(write, follow);

  const resolve = Effect.fn(`${ops.type}.resolve`)(function* (path: string) {
    const notFound = new PathNotFound({ path });
    const entry = yield* paths.lookup(path);
    if (Option.isNone(entry)) return yield* notFound;
    const { nodeId, canonical } = entry.value;
    // The leaf's own gate: a hidden node answers exactly as no node.
    const resource = yield* ops
      .get(nodeId)
      .pipe(Effect.catchTag("NodeNotFound", () => Effect.fail(notFound)));
    if (canonical) return { kind: "node", id: nodeId, resource } satisfies Resolution<Resource>;
    const target = yield* paths.canonicalOf(nodeId);
    return yield* Option.match(target, {
      onNone: () => Effect.fail(notFound),
      onSome: (to) =>
        Effect.succeed({ kind: "redirect", id: nodeId, path: to } satisfies Resolution<Resource>),
    });
  });

  return {
    ...ops,
    create: (input) => claiming(ops.create(input)),
    update: (input) => claiming(ops.update(input)),
    restore: (input) => claiming(ops.restore(input)),
    // A delete over a tombstone wrote nothing, and its claim is already free.
    delete: (id, precondition) =>
      Effect.tap(ops.delete(id, precondition), (written) =>
        written.alreadyDeleted ? Effect.void : paths.release(id),
      ),
    restoreVersion: (id, version, precondition) =>
      claiming(ops.restoreVersion(id, version, precondition)),
    resolve,
  };
};
