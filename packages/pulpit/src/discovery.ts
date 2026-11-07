/**
 * **Discovery** (pulpit#203) — what a site's feeds and sitemap list: a
 * bounded, keyset-paged enumeration of a leaf's discoverable nodes, the
 * per-family metadata projection the feed item, the page head and the
 * JSON-LD builders all read, and the purge hint a write emits for the
 * application's Cache-Tag purge.
 *
 * The behavioural spec is website's `packages/database/src/discovery.ts`
 * (the JSON Feed of the latest public nodes and the sitemap, both
 * enumerated where `visibility = 'public'`) and gardeneria's
 * `apps/web/src/lib/server/discovery.ts`, with their `cache-purge.ts`.
 *
 * ## What is discoverable
 *
 * A node is listed exactly when **all** of these hold:
 *
 * - an **anonymous** reader may list it: the enumeration is the leaf's own
 *   `list` ({@link defineSubtype}) bound to `Option.none()` as the viewer,
 *   so a `private`, `followers`, draft, unapproved or tombstoned row is
 *   never listed, by the same filters every read uses (`SEC-AUTH-ENUM-001`);
 *   on a publish-gated leaf it reads the **live** version, never the head,
 *   and a node with no live version (or only a future stamp) is not listed
 *   (pulpit#46);
 * - its resource is **publicly serveable** ({@link isPubliclyServeable},
 *   `CACHE-AUTH-005`), a second guard over the same facts: whatever a feed
 *   or a sitemap lists, a public cache may hold;
 * - it has a **canonical path** (`./paths`' `PathStore.canonicalOf`).
 *
 * A guard that drops a row never shortens the cursor: a page may hold fewer
 * items than its limit, but the next page starts after the last row read,
 * so paging is stable and never skips or repeats a node.
 *
 * Serialisation is not the kernel's: JSON Feed, RSS (effect-web's
 * `effect-rss-feed`), Atom (`effect-atom-feed`) and the sitemap
 * (`effect-sitemap`) are built by the application from the items and
 * their {@link DiscoveryMetadata}.
 *
 * @copyright Thomas Foster
 * @module pulpit/discovery
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  always,
  and,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  type Comparable,
  type ListFilter,
} from "./filter.ts";
import type { PathStore } from "./paths.ts";
import { serveablePolicy } from "./publication.ts";
import {
  defineSubtype,
  MAX_PAGE_LIMIT,
  type AfterWriteHook,
  type LeafRow,
  type SubtypeDefinition,
} from "./subtype.ts";
import type { ColumnValue } from "./version-chain.ts";

// ── The metadata projection ───────────────────────────────────────────

/**
 * An image a discoverable node is shown with (a feed item's `image`, the
 * head's `og:image`, JSON-LD's `image`).
 *
 * @since 0.2.0
 */
export interface DiscoveryImage {
  readonly url: string;
  readonly alt: Option.Option<string>;
}

/**
 * One node's metadata, projected once per family and read by every
 * builder: the feed item, the page head and its JSON-LD. `schemaType` is
 * the schema.org type (`Article`, `WebPage`); `published` and `modified`
 * are the item's dates, and a sitemap's `lastmod` is `modified`, else
 * `published`.
 *
 * @since 0.2.0
 */
export interface DiscoveryMetadata {
  readonly title: string;
  readonly summary: Option.Option<string>;
  readonly image: Option.Option<DiscoveryImage>;
  readonly schemaType: string;
  readonly published: Option.Option<Date>;
  readonly modified: Option.Option<Date>;
}

/**
 * The sitemap's `lastmod` for an item: its `modified` date, else its `published` one.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Option from "effect/Option";
 * import { lastModified } from "@thomasfosterau/pulpit/discovery";
 *
 * const published = new Date("2026-01-01T00:00:00.000Z");
 * const lastmod = lastModified({ published: Option.some(published), modified: Option.none() });
 * strictEqual(Option.getOrThrow(lastmod).getTime(), published.getTime());
 * ```
 *
 * @since 0.2.0
 */
export const lastModified = (
  metadata: Pick<DiscoveryMetadata, "published" | "modified">,
): Option.Option<Date> => Option.orElse(metadata.modified, () => metadata.published);

// ── The enumeration ───────────────────────────────────────────────────

/**
 * A discovery declaration the rules refuse, thrown by
 * {@link defineDiscovery} when the family is declared (never an Effect
 * failure), as `./subtype`'s `SubtypeDeclarationError` is: a localised
 * leaf, whose list reads one row per locale (pulpit#265 tracks its
 * per-locale enumeration).
 *
 * @since 0.2.0
 */
export class DiscoveryDeclarationError extends Schema.TaggedError<
  DiscoveryDeclarationError,
  { readonly brand: unique symbol }
>()("DiscoveryDeclarationError", { message: Schema.String }) {}

/**
 * Where a page starts: after the node `id` whose order key was `key` (the
 * feed column's value; none for a `NULL`, and always none in the sitemap,
 * which orders by `id` alone). The application encodes it into its own
 * page parameter.
 *
 * @since 0.2.0
 */
export interface DiscoveryCursor {
  readonly id: string;
  readonly key: Option.Option<Comparable>;
}

/**
 * A page request: at most `limit` items (clamped to `[1, MAX_PAGE_LIMIT]`,
 * `SEC-INPUT-003`), after `after` when given.
 *
 * @since 0.2.0
 */
export interface DiscoveryRequest {
  readonly limit: number;
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the first page
  readonly after?: DiscoveryCursor | undefined;
}

/**
 * One discoverable node: its id, its canonical path, its resource as an
 * anonymous reader gets it (the live version on a publish-gated leaf) and
 * its projected metadata.
 *
 * @since 0.2.0
 */
export interface DiscoveryItem<Resource> {
  readonly type: string;
  readonly id: string;
  readonly path: string;
  readonly resource: Resource;
  readonly metadata: DiscoveryMetadata;
}

/**
 * One page of items and the cursor of the next page, none on the last.
 *
 * @since 0.2.0
 */
export interface DiscoveryPage<Resource> {
  readonly items: ReadonlyArray<DiscoveryItem<Resource>>;
  readonly next: Option.Option<DiscoveryCursor>;
}

/**
 * A discoverable family's declaration.
 *
 * @since 0.2.0
 */
export interface DiscoveryDefinition<Row extends LeafRow, Resource, Following, E, R> {
  /**
   * The leaf, exactly as its own operations declare it. Its `viewer` is
   * ignored: the enumeration always reads as the anonymous do. A
   * localised leaf is refused ({@link DiscoveryDeclarationError}).
   */
  readonly leaf: SubtypeDefinition<Row, Resource, Following, E, R>;
  /** The family's path table, for each item's canonical path. */
  readonly paths: Pick<PathStore<E, R>, "canonicalOf">;
  /**
   * The feed's order: newest first by this view column (a timestamp, such
   * as a live pointer's `publishedAt`), `NULL`s last, then `id` ascending.
   * It must be a sortable column of the leaf (on a publish-gated leaf,
   * one of `LeafStore.columns` that the live view projects); any other is
   * a defect, since it is a mistake in the declaration, and so is a value
   * in it that is not a timestamp, text or number.
   */
  readonly feedColumn: string;
  /** The family's metadata, from the resource an anonymous reader gets. */
  readonly project: (resource: Resource) => DiscoveryMetadata;
  /**
   * The second guard, the public cache's own gate. Omitted, it is
   * `./publication`'s {@link serveablePolicy} at the leaf's posture: `owned`
   * for an owned leaf, `publishGated` for a leaf with a live pointer (so its
   * resource must carry `publishedAt`). It reads a JSON:API resource's
   * `attributes`; a resource without them is never listed.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the leaf's own posture
  readonly serveable?: ((resource: Resource) => boolean) | undefined;
}

/**
 * A family's discovery reads. Both fail only with the stores' `E`.
 *
 * @since 0.2.0
 */
export interface DiscoveryOps<Resource, E, R> {
  readonly type: string;
  /** The feed: newest first by the family's `feedColumn`, keyset-paged. */
  readonly feed: (request: DiscoveryRequest) => Effect.Effect<DiscoveryPage<Resource>, E, R>;
  /** The sitemap: by `id`, a stable order, keyset-paged; `lastmod` is {@link lastModified}. */
  readonly sitemap: (request: DiscoveryRequest) => Effect.Effect<DiscoveryPage<Resource>, E, R>;
}

/** A row read with the resource it maps to, so the cursor can read the row's own key. */
interface Read<Row, Resource> {
  readonly row: Row;
  readonly resource: Resource;
}

/** A view value as an order key; a `NULL` (or absent) key is none. Anything else is a defect. */
const keyOf = (
  type: string,
  column: string,
  cell: Option.Option<ColumnValue>,
): Effect.Effect<Option.Option<Comparable>> => {
  if (Option.isNone(cell) || cell.value === null) return Effect.succeedNone;
  const value = cell.value;
  return value instanceof Date || Predicate.isString(value) || Predicate.isNumber(value)
    ? Effect.succeedSome(value)
    : Effect.die(
        new DiscoveryDeclarationError({
          message: `${type}: the feed column ${column} holds a value that does not order (a timestamp, text or number)`,
        }),
      );
};

/**
 * The rows after `cursor` in the feed's order (`column` descending,
 * `NULL`s last, then `id` ascending).
 */
const afterInFeed = <Following>(column: string, cursor: DiscoveryCursor): ListFilter<Following> =>
  Option.match(cursor.key, {
    onNone: () => and<Following>(isNull(column), gt("id", cursor.id)),
    onSome: (key) =>
      or<Following>(
        lt(column, key),
        and<Following>(gte(column, key), lte(column, key), gt("id", cursor.id)),
        isNull(column),
      ),
  });

const clampLimit = (limit: number) => Math.max(1, Math.min(Math.trunc(limit), MAX_PAGE_LIMIT));

/**
 * Bind a family's discovery reads. Throws {@link DiscoveryDeclarationError}
 * for a localised leaf, and whatever {@link defineSubtype} throws for the
 * leaf itself.
 *
 * @since 0.2.0
 */
export const defineDiscovery = <Row extends LeafRow, Resource, Following, E, R>(
  definition: DiscoveryDefinition<Row, Resource, Following, E, R>,
): DiscoveryOps<Resource, E, R> => {
  const { leaf, paths, feedColumn, project } = definition;
  const type = leaf.type;
  if (leaf.locales !== undefined) {
    throw new DiscoveryDeclarationError({
      message: `${type}: a localised leaf's discovery is not supported yet (pulpit#265)`,
    });
  }
  const serveable =
    definition.serveable ??
    serveablePolicy({
      owned: leaf.access.kind === "owned",
      publishGated: leaf.publication !== undefined,
    });
  // The leaf's own reads, as the anonymous get them, each with the row it maps.
  const anonymous = defineSubtype<Row, Read<Row, Resource>, Following, E, R>({
    ...leaf,
    viewer: Effect.succeedNone,
    toResource: (row) => ({ row, resource: leaf.toResource(row) }),
    hooks: undefined,
  });

  const itemOf = (read: Read<Row, Resource>) =>
    serveable(read.resource)
      ? Effect.map(paths.canonicalOf(read.row.id), (path) =>
          Option.map(path, (canonical): DiscoveryItem<Resource> => ({
            type,
            id: read.row.id,
            path: canonical,
            resource: read.resource,
            metadata: project(read.resource),
          })),
        )
      : Effect.succeedNone;

  const enumerate = (
    request: DiscoveryRequest,
    where: ListFilter<Following>,
    orderBy: ReadonlyArray<{ readonly column: string; readonly direction: "asc" | "desc" }>,
    cursorOf: (row: Row) => Effect.Effect<DiscoveryCursor>,
  ): Effect.Effect<DiscoveryPage<Resource>, E, R> =>
    Effect.gen(function* () {
      const limit = clampLimit(request.limit);
      const page = yield* anonymous
        .list({ limit, offset: 0, includeDeleted: false, where, orderBy })
        .pipe(Effect.catchTag("InvalidListOrder", (error) => Effect.die(error)));
      const items = Arr.getSomes(yield* Effect.forEach(page.rows, itemOf, { concurrency: 1 }));
      const next =
        page.total > page.rows.length
          ? yield* Effect.transposeOption(
              Option.map(Arr.last(page.rows), ({ row }) => cursorOf(row)),
            )
          : Option.none<DiscoveryCursor>();
      return { items, next };
    });

  return {
    type,
    feed: (request) =>
      enumerate(
        request,
        request.after === undefined ? always : afterInFeed(feedColumn, request.after),
        [{ column: feedColumn, direction: "desc" }],
        (row) =>
          Effect.map(keyOf(type, feedColumn, Option.fromUndefinedOr(row[feedColumn])), (key) => ({
            id: row.id,
            key,
          })),
      ),
    sitemap: (request) =>
      enumerate(
        request,
        request.after === undefined ? always : gt("id", request.after.id),
        [],
        (row) => Effect.succeed({ id: row.id, key: Option.none() }),
      ),
  };
};

// ── Purge hints ───────────────────────────────────────────────────────

/**
 * What a write invalidates, for the application's Cache-Tag purge: the
 * node and its family's feed and sitemap. `tags` are the conventional tag
 * names (`discovery:<type>`, `node:<type>:<id>`); an application with its
 * own scheme maps `type` and `id` itself.
 *
 * @since 0.2.0
 */
export interface PurgeHint {
  readonly type: string;
  readonly id: string;
  readonly tags: ReadonlyArray<string>;
}

/**
 * An after hook ({@link AfterWriteHook}, run once the write has committed)
 * that emits a {@link PurgeHint} for every write that can change what the
 * family's feed and sitemap list:
 *
 * - on a publish-gated leaf, `publish`, `unpublish`, `delete`, `restore`
 *   and `restoreVersion`; a `create` or `update` changes only the head,
 *   which discovery never reads, so it emits nothing;
 * - on any other leaf, every write: an update may have made a public row
 *   private, so it purges whether or not the row is still listed.
 *
 * A scheduled publication whose stamp arrives later writes nothing and
 * fires no hook; drive that purge from the sweep over `./publication`'s
 * `duePublications`. A failing `emit` is the hooks' `afterFailure` policy's
 * concern, never the write's.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { purgeHintHook, type PurgeHint } from "@thomasfosterau/pulpit/discovery";
 *
 * const emitted: Array<PurgeHint> = [];
 * const hook = purgeHintHook<unknown>({
 *   publishGated: true,
 *   emit: (hint) => Effect.sync(() => void emitted.push(hint)),
 * });
 * const event = (action: "update" | "publish") => ({
 *   type: "post",
 *   action,
 *   write: { id: "p-1", version: 1n },
 *   resource: Option.none(),
 *   publication: Option.none(),
 * });
 * Effect.runSync(hook.run(event("update")));
 * Effect.runSync(hook.run(event("publish")));
 * deepStrictEqual(emitted, [
 *   { type: "post", id: "p-1", tags: ["discovery:post", "node:post:p-1"] },
 * ]);
 * ```
 *
 * @since 0.2.0
 */
export const purgeHintHook = <Resource, E = never, R = never>(options: {
  /** Whether the family's leaf declares the live pointer (`SubtypeDefinition.publication`). */
  readonly publishGated: boolean;
  readonly emit: (hint: PurgeHint) => Effect.Effect<void, E, R>;
}): AfterWriteHook<Resource, E, R> => ({
  name: "discovery.purgeHint",
  run: (event) =>
    options.publishGated && (event.action === "create" || event.action === "update")
      ? Effect.void
      : options.emit({
          type: event.type,
          id: event.write.id,
          tags: [`discovery:${event.type}`, `node:${event.type}:${event.write.id}`],
        }),
});
