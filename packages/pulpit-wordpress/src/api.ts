/**
 * **The `wp/v2` read API** — posts, pages and media, categories and tags,
 * and their authors, as WordPress's REST API serves them, over the leaves
 * an application binds to those types and taxonomies, plus the discovery
 * index (pulpit#86, phases 1 and 2).
 *
 * The behavioural spec is WordPress core's REST API
 * (`WordPress/wordpress-develop` trunk at `9063498`:
 * `class-wp-rest-posts-controller.php`, `class-wp-rest-attachments-controller.php`,
 * `class-wp-rest-server.php`), and the response shapes are pinned to the
 * fixture core generates from it (`tests/qunit/fixtures/wp-api-generated.js`).
 * The spec and the owner's decisions on it are on pulpit#86.
 *
 * ## How the kernel's invariants hold here
 *
 * - **A hidden row is a missing one** (`SEC-AUTH-ENUM-001`). Every read goes
 *   through the bound leaf's own `get` / `getMany` / `list`, so a hidden,
 *   draft, tombstoned or unpublished item answers `404 rest_post_invalid_id`
 *   exactly as an unknown id does, and a list omits it from its page and its
 *   `X-WP-Total`. This deliberately differs from WordPress, which answers
 *   `rest_forbidden` (401 / 403) for a post that exists but can't be read. A
 *   wire id that decodes to none (unknown to the codec, or no id at all) is
 *   that same 404.
 * - **A readable item never points at a hidden one.** `featured_media` and
 *   `parent` are read through their target's own `getMany`; a target the
 *   viewer can't read is `0`, WordPress's "none", and is left out of
 *   `_links` and `_embedded`.
 * - **Batched reads** (`PERF-DB-001`). One response encodes its node ids in
 *   one `encode`, renders its fields in one `render`, reads its authors in
 *   one `getMany`, and reads each related type in one `getMany`, however many
 *   items it carries.
 * - **Bounded input** (`SEC-INPUT-003`). `per_page` is at most 100, and each
 *   id-list parameter (`include`, `exclude`, `author`, `author_exclude`,
 *   `parent`, `parent_exclude`, `slug`, `status`) at most
 *   {@link MAX_LIST_PARAMETER} values: a longer list is
 *   `400 rest_invalid_param`, answered before any id is decoded (WordPress
 *   core sets no such cap).
 * - **Caching** (`CACHE-AUTH-005`). A response is `Cache-Control: public`
 *   only when its viewer is anonymous and every item in it, embeds included,
 *   is serveable by its binding's `serveable`; anything else is
 *   `private, no-store`. A `/users` response is always `private, no-store`:
 *   which accounts it lists depends on what the viewer can read.
 * - **Assignments are read through the edge family** (`EDGE-001`). An
 *   item's `categories` / `tags`, a term's `count`, `?categories=` /
 *   `?tags=` and `post=` all count only edges whose both ends the viewer
 *   can read, so a hidden item or term is never confirmed through one.
 * - **Authors are the accounts owning a readable item** (pulpit#86,
 *   decision 5, through the kernel's `readableOwners`). Any other account,
 *   unknown or not, answers `404 rest_user_invalid_id`.
 *
 * ## What it leaves out
 *
 * No writes (`POST` / `PUT` / `PATCH` / `DELETE` are `rest_no_route`), no
 * `context=edit` (`rest_forbidden_context`, after the 404 check), no
 * revisions, no `search`. A parameter the adapter
 * can't honour (`search`, `sticky`, `orderby=term_group`, `roles`, …) is
 * `400 rest_invalid_param`, never silently ignored, so a client never
 * mistakes an unfiltered list for a filtered one.
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress/api
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Visibility } from "@thomasfosterau/pulpit/content";
import {
  always,
  and,
  anyOf,
  eq,
  gt,
  lt,
  ne,
  never,
  isNull,
  MAX_SET_VALUES,
  noneOf,
  notPublished,
  or,
  published,
  type ListFilter,
} from "@thomasfosterau/pulpit/filter";
import type { EdgeOps } from "@thomasfosterau/pulpit/edges";
import {
  InvalidListOrder,
  MAX_PAGE_LIMIT,
  readableOwners,
  type AccessPolicy,
  type ListOrder,
  type ListRequest,
  type OwnersRequest,
  type Page,
  type SubtypeOps,
  type Viewer,
} from "@thomasfosterau/pulpit/subtype";
import { NodeNotFound, type ColumnValue } from "@thomasfosterau/pulpit/version-chain";
import type { WireId, WireIds } from "./ids.ts";
import {
  authorizationStatus,
  errorBody,
  fieldTree,
  formatGmt,
  formatLocal,
  gmtOffset,
  invalidParams,
  linkValue,
  noRoute,
  parseDateTime,
  projectFields,
  readQuery,
  withQuery,
  WpRestError,
  type Query,
} from "./internal/wire.ts";

// ── The vocabulary ────────────────────────────────────────────────────

/**
 * The WordPress post types phase 1 serves, each at its own route:
 * `post` at `/posts`, `page` at `/pages`, `attachment` at `/media`.
 *
 * @since 0.1.0
 */
export type PostType = "post" | "page" | "attachment";

/**
 * A WordPress post status, as `status` derives it and the `status`
 * parameter names it.
 *
 * @since 0.1.0
 */
export type PostStatus = "publish" | "future" | "draft" | "private" | "trash" | "inherit";

/**
 * The most values one list parameter may carry (`SEC-INPUT-003`). WordPress
 * core sets no `maxItems` on `include` and its siblings; this bound is the
 * adapter's, at or below the kernel's `MAX_SET_VALUES`, so a list past it is
 * refused (`400 rest_invalid_param`) before the id codec is read, and never
 * decodes to an all-none batch that would exclude nothing (pulpit#86).
 *
 * @since 0.1.0
 */
export const MAX_LIST_PARAMETER = 100;

/* oxlint-disable effect/prefer-option-over-null -- optional fields are `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined`; an absent field is its documented default */

/**
 * The fields of one item, read off the application's own resource by its
 * binding's `fields`. Whatever WordPress has that pulpit doesn't model
 * (`comment_status`, `sticky`, `template`, `meta`, …) is a constant on the
 * wire, and `id`, `type`, `status`, `guid`, `link` and `_links` are derived.
 *
 * @since 0.1.0
 */
export interface PostFields {
  /** The node id (never on the wire: the id codec encodes it). */
  readonly id: string;
  readonly slug: string;
  /** The publication stamp; none for an item never stamped (its `date_gmt` is then `null`). */
  readonly date: Option.Option<Date>;
  readonly modified: Date;
  /** Rendered through the `render` seam. */
  readonly title: ColumnValue;
  readonly content: ColumnValue;
  readonly excerpt: ColumnValue;
  /** The author's account id, read through the author seam. */
  readonly author: Option.Option<string>;
  /** The featured attachment's node id, read through the `attachment` binding. */
  readonly featuredMedia: Option.Option<string>;
  /** The parent's node id (a page's parent page, an attachment's post), read through that type's binding. */
  readonly parent: Option.Option<string>;
  readonly menuOrder: number;
  /** The status facts: the content axes and the tombstone. */
  readonly draft: boolean;
  readonly visibility: Visibility;
  readonly deleted: boolean;
  /** An attachment's media fields (#55 brings the file leaf's own); absent for a post or page. */
  readonly media?: MediaFields | undefined;
}

/**
 * An attachment's own fields on the wire.
 *
 * @since 0.1.0
 */
export interface MediaFields {
  readonly caption: ColumnValue;
  readonly description: ColumnValue;
  readonly altText: string;
  /** `image`, `video`, `audio`, `text` or `application`: the MIME type's top level, as WordPress derives it. */
  readonly mediaType: string;
  readonly mimeType: string;
  readonly sourceUrl: string;
  readonly mediaDetails: Schema.JsonObject;
  readonly fileSize: Option.Option<number>;
}

/**
 * The view columns the list parameters filter and sort by. `slug`, `date`
 * and `modified` are required; a parameter whose column is absent
 * (`author` without `author`, `menu_order` without `menuOrder`, …) is
 * `400 rest_invalid_param`. `orderby=id` sorts by the node id unless `id`
 * names a column holding the wire integer.
 *
 * @since 0.1.0
 */
export interface PostColumns {
  readonly slug: string;
  readonly date: string;
  readonly modified: string;
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  readonly parent?: string | undefined;
  readonly menuOrder?: string | undefined;
  readonly draft?: string | undefined;
  readonly visibility?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly mediaType?: string | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * One application leaf bound to a WordPress post type: its read operations
 * (the kernel's gated `get` / `getMany` / `list`), the view columns its
 * parameters read, the mapper from its resource to {@link PostFields}, and
 * its `CACHE-AUTH-005` serveability (typically `./publication`'s
 * `serveablePolicy` over the resource).
 *
 * @since 0.1.0
 */
export interface PostTypeBinding<Resource, E, R, Following = never> {
  readonly ops: Pick<SubtypeOps<Resource, E, R, Following>, "get" | "getMany" | "list" | "owners">;
  readonly columns: PostColumns;
  readonly fields: (resource: Resource) => PostFields;
  readonly serveable: (resource: Resource) => boolean;
}

/**
 * One item the read gate let through, as the adapter holds it.
 *
 * @since 0.1.0
 */
export interface ShownItem {
  readonly fields: PostFields;
  readonly serveable: boolean;
}

/**
 * A {@link PostTypeBinding} with its resource type closed over, as
 * {@link bind} returns it, so one config holds leaves of different resource
 * types. Its failures are the store's, which the API answers as a 500.
 *
 * @since 0.1.0
 */
export interface BoundPostType<R, Following = never> {
  readonly columns: PostColumns;
  /** The item, or none when the read gate hides it or it is missing (`SEC-AUTH-ENUM-001`). */
  readonly get: (id: string) => Effect.Effect<Option.Option<ShownItem>, unknown, R>;
  readonly getMany: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ShownItem>, unknown, R>;
  /** One page and its total; fails `InvalidListOrder` for an order the leaf doesn't sort by. */
  readonly list: (
    request: ListRequest<Following>,
  ) => Effect.Effect<
    { readonly rows: ReadonlyArray<ShownItem>; readonly total: number },
    unknown,
    R
  >;
  /** The accounts owning a row the viewer may list, as `/users` reads them (`SubtypeOps.owners`). */
  readonly owners: (request: OwnersRequest) => Effect.Effect<Page<string>, unknown, R>;
}

/**
 * Bind an application leaf to a WordPress post type. Its `get`'s
 * `NodeNotFound` (a missing or hidden row, `SEC-AUTH-ENUM-001`) becomes
 * none; every other failure stays the store's.
 *
 * @since 0.1.0
 */
export const bind = <Resource, E, R, Following = never>(
  binding: PostTypeBinding<Resource, E, R, Following>,
): BoundPostType<R, Following> => {
  const shown = (resource: Resource): ShownItem => ({
    fields: binding.fields(resource),
    serveable: binding.serveable(resource),
  });
  return {
    columns: binding.columns,
    get: (id) =>
      binding.ops.get(id).pipe(
        Effect.map((resource) => Option.some(shown(resource))),
        Effect.catchIf(Schema.is(NodeNotFound), () => Effect.succeedNone),
      ),
    getMany: (ids) => Effect.map(binding.ops.getMany(ids), HashMap.map(shown)),
    list: (request) =>
      Effect.map(binding.ops.list(request), (page) => ({
        rows: page.rows.map(shown),
        total: page.total,
      })),
    owners: binding.ops.owners,
  };
};

// ── Taxonomies ────────────────────────────────────────────────────────

/**
 * The WordPress taxonomies phase 2 serves: `category` at `/categories`
 * (hierarchical: its terms take `parent`) and `post_tag` at `/tags`.
 *
 * @since 0.1.0
 */
export type Taxonomy = "category" | "post_tag";

/**
 * The fields of one term, read off the application's own resource by its
 * binding's `fields`. `count`, `taxonomy`, `link` and `_links` are derived.
 *
 * @since 0.1.0
 */
export interface TermFields {
  /** The node id (never on the wire: the id codec encodes it). */
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  /** A `category` term's parent term, read through the same binding; ignored for `post_tag`. */
  readonly parent: Option.Option<string>;
}

/* oxlint-disable effect/prefer-option-over-null -- optional fields are `?: T | undefined` (AGENTS.md → Conventions); an absent column has its documented default */

/**
 * The term leaf's view columns the term parameters filter and sort by.
 * `orderby=id` sorts by the node id unless `id` names a column holding the
 * wire integer; `parent` without a `parent` column is `400 rest_invalid_param`.
 *
 * @since 0.1.0
 */
export interface TermColumns {
  readonly name: string;
  readonly slug: string;
  readonly id?: string | undefined;
  readonly parent?: string | undefined;
}

/**
 * One end of the assignment family: its alias (as `memberFilter` and
 * `countBy` name it) and its edge column (as an edge list's `where` reads it).
 *
 * @since 0.1.0
 */
export interface AssignmentEnd {
  readonly alias: string;
  readonly column: string;
}

/**
 * One application leaf bound to a WordPress taxonomy: the term leaf's read
 * operations, the edge family assigning its terms to items, and the mappers
 * from both resources. The terms are the edge family's `term` end and the
 * items its `post` end; `postTypes` names the post types the taxonomy
 * applies to (`["post"]` by default), whose items gain `categories` / `tags`,
 * the matching filter parameters and a `wp:term` link.
 *
 * Every assignment read goes through the edge family's own gated operations
 * (`EDGE-001`): `list` for an item's terms, `memberFilter` for
 * `?categories=`, `nonMemberFilter` for `?categories_exclude=`, `countBy`
 * for a term's `count`, so a hidden item or term
 * never shows through an assignment.
 *
 * @since 0.1.0
 */
export interface TaxonomyBinding<Term, Edge, E, R, Following = never> {
  readonly terms: Pick<SubtypeOps<Term, E, R>, "get" | "getMany" | "list">;
  readonly columns: TermColumns;
  readonly fields: (term: Term) => TermFields;
  /** A term's `CACHE-AUTH-005` serveability. */
  readonly serveable: (term: Term) => boolean;
  /** A term's public URL. */
  readonly link: (fields: TermFields) => string;
  readonly assignments: Pick<
    EdgeOps<unknown, Edge, E, R, Following>,
    "list" | "memberFilter" | "nonMemberFilter" | "countBy"
  >;
  readonly ends: { readonly post: AssignmentEnd; readonly term: AssignmentEnd };
  /** One assignment's item and term node ids. */
  readonly assignment: (edge: Edge) => { readonly post: string; readonly term: string };
  readonly postTypes?: ReadonlyArray<PostType> | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * One term the read gate let through, as the adapter holds it.
 *
 * @since 0.1.0
 */
export interface ShownTerm {
  readonly fields: TermFields;
  readonly serveable: boolean;
}

/**
 * A {@link TaxonomyBinding} with its resource types closed over, as
 * {@link bindTaxonomy} returns it. Its failures are the stores', which the
 * API answers as a 500.
 *
 * @since 0.1.0
 */
export interface BoundTaxonomy<R, Following = never> {
  readonly columns: TermColumns;
  readonly postTypes: ReadonlyArray<PostType>;
  readonly link: (fields: TermFields) => string;
  /** The term, or none when the read gate hides it or it is missing (`SEC-AUTH-ENUM-001`). */
  readonly get: (id: string) => Effect.Effect<Option.Option<ShownTerm>, unknown, R>;
  readonly getMany: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ShownTerm>, unknown, R>;
  /** One page of terms and its total; fails `InvalidListOrder` for an order the leaf doesn't sort by. */
  readonly list: (
    request: ListRequest,
  ) => Effect.Effect<
    { readonly rows: ReadonlyArray<ShownTerm>; readonly total: number },
    unknown,
    R
  >;
  /** The items holding a readable assignment to one of `termIds`, as a filter over the item leaf. */
  readonly members: (
    termIds: ReadonlyArray<string>,
  ) => Effect.Effect<ListFilter<Following>, unknown, R>;
  /** The items holding no readable assignment to any of `termIds`: the complement of `members` (pulpit#191). */
  readonly nonMembers: (
    termIds: ReadonlyArray<string>,
  ) => Effect.Effect<ListFilter<Following>, unknown, R>;
  /** The readable assignments of each of `termIds`: its `count`. */
  readonly counts: (
    termIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, number>, unknown, R>;
  /** The terms of each of `postIds` the viewer can read, in the edge family's list order. */
  readonly termsOf: (
    postIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ReadonlyArray<string>>, unknown, R>;
}

/**
 * Bind an application leaf and its assignment family to a WordPress
 * taxonomy. Its `get`'s `NodeNotFound` (a missing or hidden term,
 * `SEC-AUTH-ENUM-001`) becomes none; every other failure stays the store's.
 * `termsOf` pages through the family's `list` ({@link MAX_PAGE_LIMIT} edges
 * per read) until it has every readable assignment of the items asked for.
 *
 * @since 0.1.0
 */
export const bindTaxonomy = <Term, Edge, E, R, Following = never>(
  binding: TaxonomyBinding<Term, Edge, E, R, Following>,
): BoundTaxonomy<R, Following> => {
  const shown = (term: Term): ShownTerm => ({
    fields: binding.fields(term),
    serveable: binding.serveable(term),
  });
  const where = (postIds: ReadonlyArray<string>) => anyOf(binding.ends.post.column, postIds);
  const edgesFrom = (
    postIds: ReadonlyArray<string>,
    offset: number,
  ): Effect.Effect<ReadonlyArray<Edge>, E, R> =>
    Effect.flatMap(
      binding.assignments.list({ where: where(postIds), limit: MAX_PAGE_LIMIT, offset }),
      (page) =>
        Arr.match(page.rows, {
          onEmpty: () => Effect.succeed(page.rows),
          onNonEmpty: (rows) =>
            offset + rows.length < page.total
              ? Effect.map(edgesFrom(postIds, offset + rows.length), (rest) => [...rows, ...rest])
              : Effect.succeed(rows),
        }),
    );
  return {
    columns: binding.columns,
    postTypes: binding.postTypes ?? ["post"],
    link: binding.link,
    get: (id) =>
      binding.terms.get(id).pipe(
        Effect.map((term) => Option.some(shown(term))),
        Effect.catchIf(Schema.is(NodeNotFound), () => Effect.succeedNone),
      ),
    getMany: (ids) => Effect.map(binding.terms.getMany(ids), HashMap.map(shown)),
    list: (request) =>
      Effect.map(binding.terms.list(request), (page) => ({
        rows: page.rows.map(shown),
        total: page.total,
      })),
    members: (termIds) => binding.assignments.memberFilter(binding.ends.post.alias, termIds),
    nonMembers: (termIds) => binding.assignments.nonMemberFilter(binding.ends.post.alias, termIds),
    counts: (termIds) => binding.assignments.countBy(binding.ends.term.alias, termIds),
    termsOf: (postIds) =>
      Arr.isReadonlyArrayNonEmpty(postIds)
        ? Effect.map(edgesFrom(postIds, 0), (edges) =>
            Arr.reduce(edges, HashMap.empty<string, ReadonlyArray<string>>(), (byPost, edge) => {
              const { post, term } = binding.assignment(edge);
              const held = Option.getOrElse(HashMap.get(byPost, post), () => []);
              return Arr.contains(held, term) ? byPost : HashMap.set(byPost, post, [...held, term]);
            }),
          )
        : Effect.succeed(HashMap.empty()),
  };
};

/**
 * What the `render` seam is asked to render: one field of one item.
 *
 * @since 0.1.0
 */
export interface RenderRequest {
  readonly type: PostType;
  readonly field: "title" | "content" | "excerpt" | "caption" | "description";
  readonly value: ColumnValue;
}

/**
 * An author as `_embedded.author` shows them (`wp/v2/users` in embed
 * context).
 *
 * @since 0.1.0
 */
export interface Author {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly url: string;
  readonly avatarUrls: { readonly [size: string]: string };
}

/**
 * The author seam: an account's wire id (its own id mode, typically
 * `integerIds` over an account codec) and its public profile, both batched.
 *
 * @since 0.1.0
 */
export interface AuthorSeam<R> {
  readonly ids: WireIds<WireId, unknown, unknown, R>;
  readonly getMany: (
    accountIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, Author>, unknown, R>;
}

/**
 * The site, as the discovery index and the dates read it.
 *
 * @since 0.1.0
 */
export interface Site {
  /** The site's origin and any path, without a trailing slash (`https://example.org`). */
  readonly url: string;
  readonly name: string;
  readonly description: string;
  /** An IANA time zone: `date` is the wall-clock time here, `date_gmt` UTC. */
  readonly timezone: string;
}

/* oxlint-disable effect/prefer-option-over-null -- optional fields are `?: T | undefined` (AGENTS.md → Conventions); an absent prefix is the default, an absent type has no route */

/**
 * A `wp/v2` read API's declaration.
 *
 * @since 0.1.0
 */
export interface WordPressConfig<R, Following = never> {
  readonly site: Site;
  /** The REST prefix (`/wp-json`, the default). */
  readonly prefix?: string | undefined;
  /** The node id mode: `integerIds(codec)` or `stringIds()` from `./ids`. */
  readonly ids: WireIds<WireId, unknown, unknown, R>;
  /** The request's viewer, as the bound leaves read it. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /** The application's role axes, for the `status` parameter's scope check. */
  readonly policy: AccessPolicy;
  /** Render a response's fields to HTML in one batch, in order (pulpit#86, decision 3). */
  readonly render: (
    requests: ReadonlyArray<RenderRequest>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, R>;
  /** An item's public URL. */
  readonly link: (type: PostType, fields: PostFields) => string;
  /** The leaves bound to each post type; an unbound type has no route. */
  readonly types: { readonly [Type in PostType]?: BoundPostType<R, Following> | undefined };
  /** The leaves bound to each taxonomy (phase 2); an unbound taxonomy has no route. */
  readonly taxonomies?:
    | { readonly [Tax in Taxonomy]?: BoundTaxonomy<R, Following> | undefined }
    | undefined;
  readonly authors: AuthorSeam<R>;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * One request, as the adapter reads it: the method, the path from the site
 * root (`/wp-json/wp/v2/posts`) and the query string's pairs in order.
 *
 * @since 0.1.0
 */
export interface WordPressRequest {
  readonly method: string;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}

/**
 * One response: the status, the headers and the JSON body (none for `HEAD`).
 *
 * @since 0.1.0
 */
export interface WordPressResponse {
  readonly status: number;
  readonly headers: { readonly [name: string]: string };
  readonly body: Option.Option<Schema.Json>;
}

/**
 * A `wp/v2` read API: one handler for every request under its prefix.
 *
 * @since 0.1.0
 */
export interface WordPressApi<R> {
  /**
   * Answer one request. Never fails: a WordPress error is its envelope and
   * status, and a store, codec or render failure is
   * `500 internal_server_error`.
   */
  readonly handle: (request: WordPressRequest) => Effect.Effect<WordPressResponse, never, R>;
}

// ── Routes and errors ─────────────────────────────────────────────────

const ROUTES: ReadonlyArray<readonly [base: string, type: PostType]> = [
  ["posts", "post"],
  ["pages", "page"],
  ["media", "attachment"],
];

const baseOf = (type: PostType): string =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(ROUTES, ([, routed]) => routed === type),
      ([base]) => base,
    ),
    () => "posts",
  );

const typeOf = (base: string): Option.Option<PostType> =>
  Option.map(
    Arr.findFirst(ROUTES, ([routed]) => routed === base),
    ([, type]) => type,
  );

/** The type a page's or an attachment's `parent` names: a page's parent page, an attachment's post. */
const parentTypeOf = (type: PostType): PostType => (type === "page" ? "page" : "post");

const invalidId = () =>
  new WpRestError({ code: "rest_post_invalid_id", message: "Invalid post ID.", status: 404 });

const internalError = () =>
  new WpRestError({
    code: "internal_server_error",
    message: "There has been a critical error on this website.",
    status: 500,
  });

/** A seam's failure (a store, the codec, the renderer) as the 500 it answers. */
const internal = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, WpRestError, R> =>
  Effect.mapError(effect, () => internalError());

/** The parameters the adapter refuses rather than silently ignores. */
const UNSUPPORTED = [
  "search",
  "search_columns",
  "search_semantics",
  "sticky",
  "ignore_sticky",
  "format",
] as const;

// ── Parameters ────────────────────────────────────────────────────────

interface CollectionParams {
  readonly context: "view" | "embed";
  readonly page: number;
  readonly perPage: number;
  readonly offset: Option.Option<number>;
  readonly order: "asc" | "desc";
  readonly orderby: string;
  readonly include: Option.Option<ReadonlyArray<string>>;
  readonly exclude: ReadonlyArray<string>;
  readonly slug: Option.Option<ReadonlyArray<string>>;
  readonly statuses: ReadonlyArray<string>;
  readonly author: Option.Option<ReadonlyArray<string>>;
  readonly authorExclude: ReadonlyArray<string>;
  readonly parent: Option.Option<ReadonlyArray<string>>;
  readonly parentExclude: ReadonlyArray<string>;
  readonly menuOrder: Option.Option<number>;
  readonly mimeType: Option.Option<string>;
  readonly mediaType: Option.Option<ReadonlyArray<string>>;
  readonly after: Option.Option<Date>;
  readonly before: Option.Option<Date>;
  readonly modifiedAfter: Option.Option<Date>;
  readonly modifiedBefore: Option.Option<Date>;
  /**
   * Each taxonomy's term lists as given: `categories` / `tags` include,
   * `categories_exclude` / `tags_exclude` exclude (pulpit#215).
   */
  readonly terms: ReadonlyArray<readonly [Taxonomy, "include" | "exclude", ReadonlyArray<string>]>;
  readonly taxRelation: "AND" | "OR";
}

/** Each taxonomy's route base, which is also its item filter parameter. */
const TAXONOMIES: ReadonlyArray<readonly [base: string, taxonomy: Taxonomy]> = [
  ["categories", "category"],
  ["tags", "post_tag"],
];

/** A taxonomy's route base: `categories` or `tags`. */
const taxonomyBase = (taxonomy: Taxonomy): string =>
  taxonomy === "category" ? "categories" : "tags";

const integerSyntax = /^-?\d+$/;

const STATUSES = [
  "publish",
  "future",
  "draft",
  "pending",
  "private",
  "trash",
  "inherit",
  "any",
] as const;
const MEDIA_TYPES = ["image", "video", "text", "application", "audio"] as const;

/** A binding's optional column, by its key. */
const columnOf = (columns: PostColumns, key: keyof PostColumns): Option.Option<string> =>
  Option.fromNullishOr(columns[key]);

/** The parameters each post type takes beyond the shared ones, and the column each needs. */
const typedParameters = (
  type: PostType,
): ReadonlyArray<readonly [name: string, column: keyof PostColumns]> => [
  ["author", "author"],
  ["author_exclude", "author"],
  ...(type === "post"
    ? []
    : ([
        ["parent", "parent"],
        ["parent_exclude", "parent"],
      ] as const)),
  ...(type === "page" ? ([["menu_order", "menuOrder"]] as const) : []),
  ...(type === "attachment"
    ? ([
        ["mime_type", "mimeType"],
        ["media_type", "mediaType"],
      ] as const)
    : []),
];

/** Every type-specific parameter, for refusing one a post type doesn't take. */
const TYPED = ["parent", "parent_exclude", "menu_order", "mime_type", "media_type"] as const;

/**
 * The parameter readers every collection shares: each records a bad value
 * in `bad` (one `rest_invalid_param` collects them all, as WordPress's
 * argument validation does) and answers its fallback.
 */
const readerOf = (query: Query, timeZone: string) => {
  const bad: Array<readonly [string, string]> = [];
  const refuse = (name: string, message: string) => {
    bad.push([name, message]);
  };
  const present = (name: string) => Arr.contains(query.names, name);
  const integer = (name: string, min: number, max: number, fallback: number): number =>
    Option.match(query.scalar(name), {
      onNone: () => fallback,
      onSome: (raw) => {
        const value = integerSyntax.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isSafeInteger(value)) {
          refuse(name, `${name} is not of type integer.`);
          return fallback;
        }
        if (value < min || value > max) {
          refuse(
            name,
            max === Number.MAX_SAFE_INTEGER
              ? `${name} must be greater than or equal to ${min}`
              : `${name} must be between ${min} (inclusive) and ${max} (inclusive)`,
          );
          return fallback;
        }
        return value;
      },
    });
  const oneOf = <A extends string>(name: string, allowed: ReadonlyArray<A>, fallback: A): A =>
    Option.match(query.scalar(name), {
      onNone: () => fallback,
      onSome: (raw) => {
        const found = Arr.findFirst(allowed, (value) => value === raw);
        if (Option.isNone(found)) refuse(name, `${name} is not one of ${allowed.join(", ")}.`);
        return Option.getOrElse(found, () => fallback);
      },
    });
  const list = (name: string): Option.Option<ReadonlyArray<string>> =>
    Option.map(query.list(name), (values) => {
      if (values.length > MAX_LIST_PARAMETER) {
        refuse(name, `${name} must contain at most ${MAX_LIST_PARAMETER} items.`);
        return [];
      }
      return values;
    });
  const date = (name: string): Option.Option<Date> =>
    Option.flatMap(query.scalar(name), (raw) => {
      const parsed = parseDateTime(raw, timeZone);
      if (Option.isNone(parsed)) refuse(name, "Invalid date.");
      return parsed;
    });
  const boolean = (name: string, fallback: boolean): boolean =>
    Option.match(query.scalar(name), {
      onNone: () => fallback,
      onSome: (raw) => {
        // rest_sanitize_boolean: "1", "true" and "0", "false", "" (any case).
        const value = raw.toLowerCase();
        if (value === "1" || value === "true") return true;
        if (value === "0" || value === "false" || value === "") return false;
        refuse(name, `${name} is not of type boolean.`);
        return fallback;
      },
    });
  /** The paging, order and id-list parameters every collection takes. */
  const paging = (defaultOrder: "asc" | "desc") => ({
    page: integer("page", 1, Number.MAX_SAFE_INTEGER, 1),
    perPage: integer("per_page", 1, 100, 10),
    offset: Option.map(query.scalar("offset"), () =>
      integer("offset", 0, Number.MAX_SAFE_INTEGER, 0),
    ),
    order: oneOf("order", ["asc", "desc"] as const, defaultOrder),
    include: list("include"),
    exclude: Option.getOrElse(list("exclude"), () => []),
    slug: list("slug"),
  });
  /** `context`, as `/terms` and `/users` read it (`edit` is refused by the handler). */
  const context = (): "view" | "embed" =>
    oneOf("context", ["view", "embed", "edit"] as const, "view") === "embed" ? "embed" : "view";
  return { bad, refuse, present, integer, oneOf, list, date, boolean, paging, context };
};

/**
 * A collection's parsed parameters, or the one `rest_invalid_param` naming
 * every bad one, or core's error for `orderby=include` without `include`.
 */
const checked = <P extends { readonly orderby: string; readonly include: Option.Option<unknown> }>(
  bad: ReadonlyArray<readonly [string, string]>,
  params: P,
): Effect.Effect<P, WpRestError> => {
  if (Arr.isReadonlyArrayNonEmpty(bad)) return Effect.fail(invalidParams(Record.fromEntries(bad)));
  if (params.orderby === "include" && Option.isNone(params.include)) {
    return Effect.fail(
      new WpRestError({
        code: "rest_orderby_include_missing_include",
        message: "You need to define an include parameter to order by include.",
        status: 400,
      }),
    );
  }
  return Effect.succeed(params);
};

/**
 * Parse and check a collection's parameters, collecting every bad one into
 * one `rest_invalid_param`, as WordPress's argument validation does.
 */
const collectionParams = (
  type: PostType,
  query: Query,
  columns: PostColumns,
  timeZone: string,
  taxonomies: ReadonlyArray<Taxonomy>,
): Effect.Effect<CollectionParams, WpRestError> =>
  Effect.suspend(() => {
    const { bad, refuse, present, integer, oneOf, list, date, paging } = readerOf(query, timeZone);

    Arr.filter(UNSUPPORTED, present).forEach((name) =>
      refuse(name, `${name} is not supported by this API.`),
    );
    const typed = typedParameters(type);
    Arr.filter(
      TYPED,
      (name) => present(name) && !Arr.some(typed, ([taken]) => taken === name),
    ).forEach((name) => refuse(name, `${name} is not supported for this post type.`));
    Arr.filter(
      typed,
      ([name, column]) => present(name) && Option.isNone(columnOf(columns, column)),
    ).forEach(([name]) => refuse(name, `${name} is not supported for this post type.`));

    Arr.filter(TAXONOMIES, ([, taxonomy]) => !Arr.contains(taxonomies, taxonomy)).forEach(
      ([base]) =>
        [base, `${base}_exclude`]
          .filter(present)
          .forEach((name) => refuse(name, `${name} is not supported for this post type.`)),
    );
    const terms = Arr.getSomes(
      Arr.flatMap(taxonomies, (taxonomy) =>
        (["include", "exclude"] as const).map((mode) =>
          Option.map(
            list(mode === "include" ? taxonomyBase(taxonomy) : `${taxonomyBase(taxonomy)}_exclude`),
            (values) => [taxonomy, mode, values] as const,
          ),
        ),
      ),
    );

    const orderbys = [
      "author",
      "date",
      "id",
      "include",
      "modified",
      "slug",
      "title",
      ...(type === "post" ? [] : ["parent"]),
      ...(type === "page" ? ["menu_order"] : []),
    ];
    const context = Option.match(query.scalar("context"), {
      onNone: () => "view" as const,
      onSome: (raw) => {
        if (raw === "view" || raw === "embed") return raw;
        if (raw !== "edit") refuse("context", "context is not one of view, embed, edit.");
        return "view" as const;
      },
    });
    const statuses = Option.getOrElse(list("status"), () => [
      type === "attachment" ? "inherit" : "publish",
    ]);
    Arr.filter(statuses, (status) => !Arr.contains(STATUSES, status)).forEach((status) =>
      refuse("status", `status[${status}] is not one of ${STATUSES.join(", ")}.`),
    );
    const mediaType = list("media_type");
    Arr.filter(
      Option.getOrElse(mediaType, () => []),
      (value) => !Arr.contains(MEDIA_TYPES, value),
    ).forEach((value) =>
      refuse("media_type", `media_type[${value}] is not one of ${MEDIA_TYPES.join(", ")}.`),
    );
    const params: CollectionParams = {
      context,
      ...paging("desc"),
      orderby: oneOf("orderby", orderbys, "date"),
      statuses,
      author: list("author"),
      authorExclude: Option.getOrElse(list("author_exclude"), () => []),
      parent: list("parent"),
      parentExclude: Option.getOrElse(list("parent_exclude"), () => []),
      menuOrder: Option.map(query.scalar("menu_order"), () =>
        integer("menu_order", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0),
      ),
      mimeType: query.scalar("mime_type"),
      mediaType,
      after: date("after"),
      before: date("before"),
      modifiedAfter: date("modified_after"),
      modifiedBefore: date("modified_before"),
      terms,
      taxRelation: oneOf("tax_relation", ["AND", "OR"] as const, "AND"),
    };
    return checked(bad, params);
  });

interface TermParams {
  readonly context: "view" | "embed";
  readonly page: number;
  readonly perPage: number;
  readonly offset: Option.Option<number>;
  readonly order: "asc" | "desc";
  readonly orderby: "id" | "include" | "name" | "slug" | "count";
  readonly include: Option.Option<ReadonlyArray<string>>;
  readonly exclude: ReadonlyArray<string>;
  readonly slug: Option.Option<ReadonlyArray<string>>;
  readonly hideEmpty: boolean;
  readonly parent: Option.Option<number>;
  readonly post: Option.Option<number>;
}

/** The term orders the adapter serves. */
const TERM_ORDERS = ["id", "include", "name", "slug", "count"] as const;
/** The term orders core takes that the adapter has no column for (`400 rest_invalid_param`). */
const UNSUPPORTED_TERM_ORDERS = ["include_slugs", "term_group", "description"] as const;

/**
 * Parse and check a taxonomy's collection parameters, as core's terms
 * controller registers them: `parent` only on a hierarchical taxonomy, and
 * `search` refused (no search yet, pulpit#54).
 */
const termParams = (
  taxonomy: Taxonomy,
  query: Query,
  columns: TermColumns,
  timeZone: string,
): Effect.Effect<TermParams, WpRestError> =>
  Effect.suspend(() => {
    const { bad, refuse, present, integer, oneOf, boolean, paging, context } = readerOf(
      query,
      timeZone,
    );
    if (present("search")) refuse("search", "search is not supported by this API.");
    if (present("parent") && (taxonomy !== "category" || columns.parent === undefined)) {
      refuse("parent", "parent is not supported for this taxonomy.");
    }
    const requested = oneOf("orderby", [...TERM_ORDERS, ...UNSUPPORTED_TERM_ORDERS], "name");
    const orderby = Option.getOrElse(
      Arr.findFirst(TERM_ORDERS, (order) => order === requested),
      () => {
        refuse("orderby", `orderby ${requested} is not supported for this taxonomy.`);
        return "name" as const;
      },
    );
    const params: TermParams = {
      context: context(),
      ...paging("asc"),
      orderby,
      hideEmpty: boolean("hide_empty", false),
      parent: Option.map(query.scalar("parent"), () =>
        integer("parent", 0, Number.MAX_SAFE_INTEGER, 0),
      ),
      post: Option.map(query.scalar("post"), () => integer("post", 0, Number.MAX_SAFE_INTEGER, 0)),
    };
    return checked(bad, params);
  });

interface UserParams {
  readonly context: "view" | "embed";
  readonly page: number;
  readonly perPage: number;
  readonly offset: Option.Option<number>;
  readonly order: "asc" | "desc";
  readonly orderby: (typeof USER_ORDERS)[number];
  /** An order core reserves for `list_users` (`rest_forbidden_orderby`, 401 / 403). */
  readonly forbiddenOrderby: Option.Option<string>;
  readonly include: Option.Option<ReadonlyArray<string>>;
  readonly exclude: ReadonlyArray<string>;
  readonly slug: Option.Option<ReadonlyArray<string>>;
}

/** The user orders the adapter serves, the ones core reserves, and the ones it has no field for. */
const USER_ORDERS = ["id", "include", "name", "slug"] as const;
const FORBIDDEN_USER_ORDERS = ["registered_date", "email"] as const;
const UNSUPPORTED_USER_ORDERS = ["include_slugs", "url"] as const;
/** The user parameters the adapter refuses: no search yet, and no roles or capabilities to filter by. */
const UNSUPPORTED_USER_PARAMS = [
  "search",
  "search_columns",
  "roles",
  "capabilities",
  "has_published_posts",
] as const;

/**
 * Parse and check `/users`' parameters, as core's users controller registers
 * them. `who` takes only `authors`, which every listed account already is.
 */
const userParams = (query: Query, timeZone: string): Effect.Effect<UserParams, WpRestError> =>
  Effect.suspend(() => {
    const { bad, refuse, present, oneOf, paging, context } = readerOf(query, timeZone);
    Arr.filter(UNSUPPORTED_USER_PARAMS, present).forEach((name) =>
      refuse(name, `${name} is not supported by this API.`),
    );
    oneOf("who", ["authors"] as const, "authors");
    const requested = oneOf(
      "orderby",
      [...USER_ORDERS, ...FORBIDDEN_USER_ORDERS, ...UNSUPPORTED_USER_ORDERS],
      "name",
    );
    if (Arr.contains<string>(UNSUPPORTED_USER_ORDERS, requested)) {
      refuse("orderby", `orderby ${requested} is not supported by this API.`);
    }
    const params: UserParams = {
      context: context(),
      ...paging("asc"),
      orderby: Option.getOrElse(
        Arr.findFirst(USER_ORDERS, (order) => order === requested),
        () => "name" as const,
      ),
      forbiddenOrderby: Option.liftPredicate(requested, (order) =>
        Arr.contains<string>(FORBIDDEN_USER_ORDERS, order),
      ),
    };
    return checked(bad, params);
  });

// ── Status ────────────────────────────────────────────────────────────

/** An item's derived status: a tombstone, a draft, a non-public row, an unarrived stamp, in that order. */
const statusOf = (type: PostType, fields: PostFields, now: Date): PostStatus => {
  if (fields.deleted) return "trash";
  if (fields.draft) return "draft";
  if (fields.visibility !== "public") return "private";
  if (type === "attachment") return "inherit";
  return Option.exists(fields.date, (date) => date.getTime() > now.getTime())
    ? "future"
    : "publish";
};

/** The filter one `status` value selects: the same facts {@link statusOf} reads. */
const statusFilter = (type: PostType, columns: PostColumns, status: string): ListFilter<never> => {
  const live = ne("action", "delete");
  const draftColumn = columnOf(columns, "draft");
  const visibilityColumn = columnOf(columns, "visibility");
  const isPublic = Option.match(visibilityColumn, {
    onNone: () => always,
    onSome: (column) => eq(column, "public"),
  });
  const notDraft = Option.match(draftColumn, {
    onNone: () => always,
    onSome: (column) => eq(column, false),
  });
  const shown = and<never>(live, isPublic, notDraft);
  const attachment = type === "attachment";
  return Match.value(status).pipe(
    Match.when("publish", () => (attachment ? never : and<never>(shown, published(columns.date)))),
    Match.when("future", () =>
      attachment ? never : and<never>(shown, notPublished(columns.date)),
    ),
    Match.when("inherit", () => (attachment ? shown : never)),
    Match.when("draft", () =>
      Option.match(draftColumn, {
        onNone: () => never,
        onSome: (column) => and<never>(live, eq(column, true)),
      }),
    ),
    Match.when("private", () =>
      Option.match(visibilityColumn, {
        onNone: () => never,
        onSome: (column) => and<never>(live, notDraft, anyOf(column, ["private", "followers"])),
      }),
    ),
    Match.when("trash", () => eq("action", "delete")),
    Match.when("any", () =>
      or<never>(
        ...["publish", "future", "inherit", "draft", "private"].map((value) =>
          statusFilter(type, columns, value),
        ),
      ),
    ),
    // `pending` (no such state in the kernel) matches nothing.
    Match.orElse(() => never),
  );
};

/**
 * The `status` parameter's scope check (pulpit#86, decision 4): a status
 * other than the default asks for rows only a signed-in viewer may see, so an
 * anonymous caller gets `rest_forbidden_status` (401); `trash` needs the
 * view-deleted rung (403 for a signed-in caller below it). It names no row.
 */
const checkStatuses = (
  type: PostType,
  statuses: ReadonlyArray<string>,
  viewer: Viewer,
  policy: AccessPolicy,
): Effect.Effect<void, WpRestError> => {
  const fallback = type === "attachment" ? "inherit" : "publish";
  const beyond = Option.match(viewer, {
    onNone: () => Arr.some(statuses, (status) => status !== fallback),
    onSome: (account) => Arr.contains(statuses, "trash") && !policy.canViewDeleted(account),
  });
  return beyond
    ? Effect.fail(
        new WpRestError({
          code: "rest_forbidden_status",
          message: "Status is forbidden.",
          status: authorizationStatus(Option.isSome(viewer)),
        }),
      )
    : Effect.void;
};

// ── Related nodes ─────────────────────────────────────────────────────

/** Everything a response's items point at, each kind read once. */
interface Related {
  /** Readable featured media and parents, by node id. */
  readonly media: HashMap.HashMap<string, ShownItem>;
  readonly parents: HashMap.HashMap<string, ShownItem>;
  /** The wire ids of the nodes the response names, every one read-gated. */
  readonly wire: HashMap.HashMap<string, WireId>;
  readonly authorWire: HashMap.HashMap<string, WireId>;
  readonly profiles: HashMap.HashMap<string, Author>;
  readonly rendered: HashMap.HashMap<string, string>;
  readonly now: Date;
  /** Each taxonomy applying to the response's type: its readable terms by item (`EDGE-001`). */
  readonly terms: ReadonlyArray<
    readonly [Taxonomy, HashMap.HashMap<string, ReadonlyArray<string>>]
  >;
  /** The terms `_embed=wp:term` shows, read through their own binding's `getMany`. */
  readonly termItems: HashMap.HashMap<string, ShownTerm>;
}

const renderKey = (id: string, field: string) => `${id}\u0000${field}`;

const renderRequests = (type: PostType, item: ShownItem): ReadonlyArray<RenderRequest> => {
  const { fields } = item;
  const text: ReadonlyArray<RenderRequest> =
    type === "attachment"
      ? []
      : [
          { type, field: "content", value: fields.content },
          { type, field: "excerpt", value: fields.excerpt },
        ];
  const media: ReadonlyArray<RenderRequest> =
    fields.media === undefined
      ? []
      : [
          { type, field: "caption", value: fields.media.caption },
          { type, field: "description", value: fields.media.description },
        ];
  return [{ type, field: "title", value: fields.title }, ...text, ...media];
};

/** Which `_embed` rels a request asks for: none without `_embed`, every one for a bare `_embed`. */
const embedsOf = (query: Query): ((rel: string) => boolean) =>
  Option.match(query.list("_embed"), {
    onNone: () => () => false,
    onSome: (rels) => {
      const named = Arr.filter(rels, (rel) => rel !== "1" && rel !== "true");
      return Arr.isReadonlyArrayNonEmpty(named)
        ? (rel: string) => Arr.contains(named, rel)
        : () => true;
    },
  });

/** The `_fields` filter a request asks for, or every field. */
const fieldsFilterOf = (query: Query): ((body: Schema.JsonObject) => Schema.Json) =>
  Option.match(query.list("_fields"), {
    onNone: () => (body) => body,
    onSome: (requested) => {
      const tree = fieldTree(requested);
      return (body) => projectFields(body, tree);
    },
  });

/** A list of one rel's link objects, or none. */
type LinkEntry = readonly [rel: string, links: Schema.Json];

// ── The API ───────────────────────────────────────────────────────────

/**
 * Declare a `wp/v2` read API over the leaves an application binds to
 * WordPress's post types. Its `handle` answers every request under the
 * prefix: `GET` (and `HEAD`) on `/`, `/wp/v2`, and each bound type's
 * collection and item routes; any other method or path is
 * `404 rest_no_route`. Every failure is a response (see
 * {@link WordPressApi.handle}); the invariants it honours are listed in this
 * module's header (`SEC-AUTH-ENUM-001`, `PERF-DB-001`, `SEC-INPUT-003`,
 * `CACHE-AUTH-005`).
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import { defineWordPress } from "@thomasfosterau/pulpit-wordpress/api";
 * import { stringIds } from "@thomasfosterau/pulpit-wordpress/ids";
 *
 * const api = defineWordPress({
 *   site: { url: "https://example.org", name: "Example", description: "", timezone: "UTC" },
 *   ids: stringIds(),
 *   viewer: Effect.succeed(Option.none()),
 *   policy: {
 *     canViewPrivate: () => false,
 *     canViewDeleted: () => false,
 *     canModerate: () => false,
 *     canWriteCorpus: () => false,
 *   },
 *   render: (requests) => Effect.succeed(requests.map(({ value }) => String(value))),
 *   link: (_, fields) => `https://example.org/${fields.slug}`,
 *   types: {},
 *   authors: { ids: stringIds(), getMany: () => Effect.succeed(HashMap.empty()) },
 * });
 * const index = Effect.runSync(api.handle({ method: "GET", path: "/wp-json/", query: [] }));
 * strictEqual(index.status, 200);
 * const unbound = Effect.runSync(
 *   api.handle({ method: "GET", path: "/wp-json/wp/v2/posts", query: [] }),
 * );
 * strictEqual(unbound.status, 404); // no leaf is bound to `post`
 * ```
 *
 * @since 0.1.0
 */
export const defineWordPress = <R, Following = never>(
  config: WordPressConfig<R, Following>,
): WordPressApi<R> => {
  const prefix = (config.prefix ?? "/wp-json").replace(/\/+$/, "");
  const { site, ids, authors, policy } = config;
  const root = `${site.url}${prefix}`;
  const apiLink = linkValue(`${root}/`, "https://api.w.org/");
  const restUrl = (route: string) => `${root}${route}`;
  const idPattern = ids.mode === "integer" ? "(?P<id>[\\d]+)" : "(?P<id>[^/]+)";

  const bound = (type: PostType): Option.Option<BoundPostType<R, Following>> =>
    Option.fromNullishOr(config.types[type]);

  /** The bound taxonomies applying to `type`, in route order. */
  const taxonomiesOf = (
    type: PostType,
  ): ReadonlyArray<readonly [Taxonomy, BoundTaxonomy<R, Following>]> =>
    Arr.getSomes(
      TAXONOMIES.map(([, taxonomy]) =>
        Option.filter(
          Option.map(
            Option.fromNullishOr(config.taxonomies?.[taxonomy]),
            (binding) => [taxonomy, binding] as const,
          ),
          ([, binding]) => Arr.contains(binding.postTypes, type),
        ),
      ),
    );

  /**
   * The `categories` / `tags` filter: each taxonomy's readable members
   * (`EDGE-001`, through `memberFilter`), and for `categories_exclude` /
   * `tags_exclude` its non-members (`nonMemberFilter`, pulpit#191), every
   * clause joined by `tax_relation` as core's `tax_query` joins them. An
   * include list whose ids all decode to none fails closed, as
   * `memberFilter` does; an exclude list excludes nothing, as
   * `nonMemberFilter` does, so an unknown or hidden term never narrows the
   * list differently from an absent one.
   */
  const termMembership = (
    params: CollectionParams,
    decoded: ReadonlyArray<ReadonlyArray<string>>,
  ): Effect.Effect<ListFilter<Following>, WpRestError, R> =>
    Effect.gen(function* () {
      if (!Arr.isReadonlyArrayNonEmpty(params.terms)) return always;
      const filters = yield* Effect.forEach(
        Arr.zip(params.terms, decoded),
        ([[taxonomy, mode], termIds]) =>
          Option.match(Option.fromNullishOr(config.taxonomies?.[taxonomy]), {
            onNone: () =>
              Effect.succeed<ListFilter<Following>>(mode === "include" ? never : always),
            onSome: (binding) =>
              internal(mode === "include" ? binding.members(termIds) : binding.nonMembers(termIds)),
          }),
        { concurrency: 1 },
      );
      return params.taxRelation === "OR" ? or(...filters) : and(...filters);
    });

  /** The bound type's `getMany`, skipped for no ids. */
  const readable = (type: PostType, nodeIds: ReadonlyArray<string>) =>
    Option.match(bound(type), {
      onNone: () => Effect.succeed(HashMap.empty<string, ShownItem>()),
      onSome: (binding) =>
        Arr.isReadonlyArrayNonEmpty(nodeIds)
          ? internal(binding.getMany(nodeIds))
          : Effect.succeed(HashMap.empty<string, ShownItem>()),
    });

  const routesBody = (): Schema.JsonObject => {
    const userPattern = authors.ids.mode === "integer" ? "(?P<id>[\\d]+)" : "(?P<id>[^/]+)";
    const routed: ReadonlyArray<readonly [base: string, pattern: string]> = [
      ...Arr.filter(ROUTES, ([, type]) => Option.isSome(bound(type))).map(
        ([base]) => [base, idPattern] as const,
      ),
      ...Arr.filter(TAXONOMIES, ([, taxonomy]) => config.taxonomies?.[taxonomy] !== undefined).map(
        ([base]) => [base, idPattern] as const,
      ),
      ...(servesUsers() ? [["users", userPattern] as const] : []),
    ];
    return Record.fromEntries(
      Arr.flatMap(routed, ([base, pattern]) =>
        [`/wp/v2/${base}`, `/wp/v2/${base}/${pattern}`].map(
          (route) =>
            [
              route,
              {
                namespace: "wp/v2",
                methods: ["GET"],
                endpoints: [{ methods: ["GET"], args: {} }],
              },
            ] as const,
        ),
      ),
    );
  };

  /** The terms of each taxonomy's items, through that taxonomy's `getMany` (one read each). */
  const readTerms = (
    terms: ReadonlyArray<readonly [Taxonomy, HashMap.HashMap<string, ReadonlyArray<string>>]>,
  ) =>
    Effect.map(
      Effect.forEach(
        terms,
        ([taxonomy, byItem]) => {
          const termIds = Arr.dedupe(Arr.flatten(HashMap.toValues(byItem)));
          return Option.match(Option.fromNullishOr(config.taxonomies?.[taxonomy]), {
            onNone: () => Effect.succeed(HashMap.empty<string, ShownTerm>()),
            onSome: (binding) =>
              Arr.isReadonlyArrayNonEmpty(termIds)
                ? internal(binding.getMany(termIds))
                : Effect.succeed(HashMap.empty<string, ShownTerm>()),
          });
        },
        { concurrency: 1 },
      ),
      (maps) =>
        Arr.reduce(maps, HashMap.empty<string, ShownTerm>(), (all, map) => HashMap.union(all, map)),
    );

  /** Read everything a set of items points at, each kind in one batch. */
  const relate = (
    type: PostType,
    items: ReadonlyArray<ShownItem>,
    embed: (rel: string) => boolean,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const parentType = parentTypeOf(type);
      const media = yield* readable(
        "attachment",
        Arr.dedupe(Arr.getSomes(items.map(({ fields }) => fields.featuredMedia))),
      );
      const parents = yield* readable(
        parentType,
        Arr.dedupe(Arr.getSomes(items.map(({ fields }) => fields.parent))),
      );
      const terms = yield* Effect.forEach(
        taxonomiesOf(type),
        ([taxonomy, binding]) =>
          Effect.map(
            internal(binding.termsOf(items.map(({ fields }) => fields.id))),
            (byItem) => [taxonomy, byItem] as const,
          ),
        { concurrency: 1 },
      );
      const termIds = Arr.dedupe(
        Arr.flatMap(terms, ([, byItem]) => Arr.flatten(HashMap.toValues(byItem))),
      );
      const termItems = embed("wp:term")
        ? yield* readTerms(terms.map(([taxonomy, byItem]) => [taxonomy, byItem] as const))
        : HashMap.empty<string, ShownTerm>();
      const embeddedMedia = embed("wp:featuredmedia") ? HashMap.toValues(media) : [];
      const embeddedParents = embed("up") ? HashMap.toValues(parents) : [];
      const nodeIds = Arr.dedupe([
        ...items.map(({ fields }) => fields.id),
        ...HashMap.keys(media),
        ...HashMap.keys(parents),
        ...termIds,
      ]);
      const encoded = Arr.isReadonlyArrayNonEmpty(nodeIds)
        ? yield* internal(ids.encode(nodeIds))
        : [];
      const authorIds = Arr.dedupe(
        Arr.getSomes(
          [...items, ...embeddedMedia, ...embeddedParents].map(({ fields }) => fields.author),
        ),
      );
      const authorEncoded = Arr.isReadonlyArrayNonEmpty(authorIds)
        ? yield* internal(authors.ids.encode(authorIds))
        : [];
      const profiles =
        embed("author") && Arr.isReadonlyArrayNonEmpty(authorIds)
          ? yield* internal(authors.getMany(authorIds))
          : HashMap.empty<string, Author>();
      const toRender: ReadonlyArray<readonly [PostType, ShownItem]> = [
        ...items.map((item): readonly [PostType, ShownItem] => [type, item]),
        ...embeddedMedia.map((item): readonly [PostType, ShownItem] => ["attachment", item]),
        ...embeddedParents.map((item): readonly [PostType, ShownItem] => [parentType, item]),
      ];
      const requests = Arr.flatMap(toRender, ([itemType, item]) =>
        renderRequests(itemType, item).map((request) => [item.fields.id, request] as const),
      );
      const html = Arr.isReadonlyArrayNonEmpty(requests)
        ? yield* internal(config.render(requests.map(([, request]) => request)))
        : [];
      return {
        media,
        parents,
        wire: HashMap.fromIterable(Arr.zip(nodeIds, encoded)),
        authorWire: HashMap.fromIterable(Arr.zip(authorIds, authorEncoded)),
        profiles,
        rendered: HashMap.fromIterable(
          Arr.zip(
            requests.map(([id, request]) => renderKey(id, request.field)),
            html,
          ),
        ),
        now,
        terms,
        termItems,
      } satisfies Related;
    });

  /** A node's wire id, or `0` (WordPress's "none") for no node or one the response may not name. */
  const wireOf = (related: Related, id: Option.Option<string>): WireId =>
    Option.getOrElse(
      Option.flatMap(id, (node) => HashMap.get(related.wire, node)),
      () => 0,
    );

  /** An item's terms in one taxonomy, as wire ids (none when the taxonomy doesn't apply). */
  const termIdsOf = (related: Related, taxonomy: Taxonomy, itemId: string) =>
    Option.getOrElse(
      Option.flatMap(
        Arr.findFirst(related.terms, ([held]) => held === taxonomy),
        ([, byItem]) => HashMap.get(byItem, itemId),
      ),
      () => [],
    );
  const termWires = (related: Related, taxonomy: Taxonomy, itemId: string) =>
    Arr.getSomes(termIdsOf(related, taxonomy, itemId).map((id) => HashMap.get(related.wire, id)));

  const rendered = (related: Related, id: string, field: string): string =>
    Option.getOrElse(HashMap.get(related.rendered, renderKey(id, field)), () => "");

  const linksOf = (type: PostType, item: ShownItem, related: Related): Schema.JsonObject => {
    const { fields } = item;
    const wireId = wireOf(related, Option.some(fields.id));
    const author = Option.flatMap(fields.author, (account) =>
      HashMap.get(related.authorWire, account),
    );
    const featured = Option.filter(fields.featuredMedia, (id) => HashMap.has(related.media, id));
    const parent = Option.filter(fields.parent, (id) => HashMap.has(related.parents, id));
    const embeddable = (href: string): Schema.Json => [{ embeddable: true, href }];
    const entries: ReadonlyArray<LinkEntry> = [
      [
        "self",
        [{ href: restUrl(`/wp/v2/${baseOf(type)}/${wireId}`), targetHints: { allow: ["GET"] } }],
      ],
      ["collection", [{ href: restUrl(`/wp/v2/${baseOf(type)}`) }]],
      ["about", [{ href: restUrl(`/wp/v2/types/${type}`) }]],
      ...Option.toArray(
        Option.map(author, (id): LinkEntry => [
          "author",
          embeddable(restUrl(`/wp/v2/users/${id}`)),
        ]),
      ),
      ...Option.toArray(
        Option.map(featured, (id): LinkEntry => [
          "wp:featuredmedia",
          embeddable(restUrl(`/wp/v2/media/${wireOf(related, Option.some(id))}`)),
        ]),
      ),
      ...Option.toArray(
        Option.map(parent, (id): LinkEntry => [
          "up",
          embeddable(
            restUrl(`/wp/v2/${baseOf(parentTypeOf(type))}/${wireOf(related, Option.some(id))}`),
          ),
        ]),
      ),
      ...(type !== "attachment" && Option.isSome(bound("attachment"))
        ? [
            [
              "wp:attachment",
              [
                {
                  href: withQuery(
                    restUrl("/wp/v2/media"),
                    [["parent", String(wireId)]],
                    Option.none(),
                  ),
                },
              ],
            ] as const,
          ]
        : []),
      ...termLinks(type, wireId),
      ["curies", [{ name: "wp", href: "https://api.w.org/{rel}", templated: true }]],
    ];
    return Record.fromEntries(entries);
  };

  /** An item's `wp:term` link: one entry per taxonomy applying to its type. */
  const termLinks = (type: PostType, wireId: WireId): ReadonlyArray<LinkEntry> => {
    const taxonomies = taxonomiesOf(type);
    return Arr.isReadonlyArrayNonEmpty(taxonomies)
      ? [
          [
            "wp:term",
            taxonomies.map(([taxonomy]) => ({
              taxonomy,
              embeddable: true,
              href: withQuery(
                restUrl(`/wp/v2/${taxonomyBase(taxonomy)}`),
                [["post", String(wireId)]],
                Option.none(),
              ),
            })),
          ],
        ]
      : [];
  };

  /** One item on the wire, in `view` or `embed` context. */
  const itemBody = (
    type: PostType,
    item: ShownItem,
    related: Related,
    context: "view" | "embed",
  ): Schema.JsonObject => {
    const { fields } = item;
    const id = wireOf(related, Option.some(fields.id));
    const status = statusOf(type, fields, related.now);
    const link = config.link(type, fields);
    const date = formatLocal(
      Option.getOrElse(fields.date, () => fields.modified),
      site.timezone,
    );
    const author = Option.getOrElse(
      Option.flatMap(fields.author, (account) => HashMap.get(related.authorWire, account)),
      () => 0,
    );
    const featured = wireOf(
      related,
      Option.filter(fields.featuredMedia, (media) => HashMap.has(related.media, media)),
    );
    const parent = wireOf(
      related,
      Option.filter(fields.parent, (node) => HashMap.has(related.parents, node)),
    );
    const title = { rendered: rendered(related, fields.id, "title") };
    const excerpt = { rendered: rendered(related, fields.id, "excerpt"), protected: false };
    const content = { rendered: rendered(related, fields.id, "content"), protected: false };
    const caption = { rendered: rendered(related, fields.id, "caption") };
    const media = Option.fromNullishOr(fields.media);
    const mediaFields = (mediaOf: MediaFields) => ({
      alt_text: mediaOf.altText,
      media_type: mediaOf.mediaType,
      mime_type: mediaOf.mimeType,
      media_details: mediaOf.mediaDetails,
    });
    const _links = linksOf(type, item, related);
    /** The term fields of a page or attachment a taxonomy is bound to (a post always has both). */
    const termFields: Schema.JsonObject = Record.fromEntries(
      related.terms.map(([taxonomy]) => [
        taxonomyBase(taxonomy),
        termWires(related, taxonomy, fields.id),
      ]),
    );
    if (context === "embed") {
      return type === "attachment"
        ? {
            id,
            date,
            slug: fields.slug,
            type,
            link,
            title,
            author,
            caption,
            ...Option.match(media, {
              onNone: () => ({}),
              onSome: (mediaOf) => ({ ...mediaFields(mediaOf), source_url: mediaOf.sourceUrl }),
            }),
            _links,
          }
        : {
            id,
            date,
            slug: fields.slug,
            type,
            link,
            title,
            author,
            featured_media: featured,
            excerpt,
            _links,
          };
    }
    const common = {
      id,
      date,
      date_gmt: Option.getOrNull(Option.map(fields.date, formatGmt)),
      guid: {
        rendered: `${site.url}/?${Match.value(type).pipe(
          Match.when("post", () => "p"),
          Match.when("page", () => "page_id"),
          Match.when("attachment", () => "attachment_id"),
          Match.exhaustive,
        )}=${id}`,
      },
      modified: formatLocal(fields.modified, site.timezone),
      modified_gmt: formatGmt(fields.modified),
      slug: fields.slug,
      status,
      type,
      link,
      title,
    };
    const classList = [
      `post-${id}`,
      type,
      `type-${type}`,
      `status-${status}`,
      ...(type === "post" ? ["format-standard"] : []),
      "hentry",
    ];
    return Match.value(type).pipe(
      Match.when("post", (): Schema.JsonObject => ({
        ...common,
        content,
        excerpt,
        author,
        featured_media: featured,
        comment_status: "closed",
        ping_status: "closed",
        sticky: false,
        template: "",
        format: "standard",
        meta: [],
        categories: termWires(related, "category", fields.id),
        tags: termWires(related, "post_tag", fields.id),
        class_list: classList,
        _links,
      })),
      Match.when("page", (): Schema.JsonObject => ({
        ...common,
        content,
        excerpt,
        author,
        featured_media: featured,
        parent,
        menu_order: fields.menuOrder,
        comment_status: "closed",
        ping_status: "closed",
        template: "",
        meta: [],
        ...termFields,
        class_list: classList,
        _links,
      })),
      Match.when("attachment", (): Schema.JsonObject => ({
        ...common,
        author,
        featured_media: featured,
        comment_status: "closed",
        ping_status: "closed",
        template: "",
        meta: [],
        class_list: classList,
        description: { rendered: rendered(related, fields.id, "description") },
        caption,
        ...Option.match(media, { onNone: () => ({}), onSome: mediaFields }),
        post: parent === 0 ? null : parent,
        source_url: Option.match(media, { onNone: () => "", onSome: (m) => m.sourceUrl }),
        filename: Option.getOrElse(
          Option.flatMap(media, (m) => Arr.last(m.sourceUrl.split("/"))),
          () => "",
        ),
        filesize: Option.getOrNull(Option.flatMap(media, (m) => m.fileSize)),
        ...termFields,
        _links,
      })),
      Match.exhaustive,
    );
  };

  const authorBody = (wireId: WireId, profile: Author): Schema.JsonObject => ({
    id: wireId,
    name: profile.name,
    url: profile.url,
    description: profile.description,
    link: `${site.url}/?author=${wireId}`,
    slug: profile.slug,
    avatar_urls: profile.avatarUrls,
    _links: {
      self: [{ href: restUrl(`/wp/v2/users/${wireId}`), targetHints: { allow: ["GET"] } }],
      collection: [{ href: restUrl("/wp/v2/users") }],
    },
  });

  /**
   * One term on the wire, in `view` or `embed` context. `parent` is the
   * readable parent's wire id, or `0` (none, or one the viewer can't read).
   */
  const termBody = (
    taxonomy: Taxonomy,
    term: ShownTerm,
    wireId: WireId,
    context: "view" | "embed",
    count: number,
    parent: WireId,
  ): Schema.JsonObject => {
    const { fields } = term;
    const base = taxonomyBase(taxonomy);
    const binding = Option.fromNullishOr(config.taxonomies?.[taxonomy]);
    const link = Option.match(binding, { onNone: () => "", onSome: (b) => b.link(fields) });
    const postTypes = Option.match(binding, { onNone: () => [], onSome: (b) => b.postTypes });
    const entries: ReadonlyArray<LinkEntry> = [
      ["self", [{ href: restUrl(`/wp/v2/${base}/${wireId}`), targetHints: { allow: ["GET"] } }]],
      ["collection", [{ href: restUrl(`/wp/v2/${base}`) }]],
      ["about", [{ href: restUrl(`/wp/v2/taxonomies/${taxonomy}`) }]],
      ...(taxonomy === "category" && parent !== 0
        ? [["up", [{ embeddable: true, href: restUrl(`/wp/v2/${base}/${parent}`) }]] as const]
        : []),
      [
        "wp:post_type",
        Arr.filter(postTypes, (type) => Option.isSome(bound(type))).map((type) => ({
          href: withQuery(
            restUrl(`/wp/v2/${baseOf(type)}`),
            [[base, String(wireId)]],
            Option.none(),
          ),
        })),
      ],
      ["curies", [{ name: "wp", href: "https://api.w.org/{rel}", templated: true }]],
    ];
    const _links = Record.fromEntries(entries);
    if (context === "embed") {
      return { id: wireId, link, name: fields.name, slug: fields.slug, taxonomy, _links };
    }
    const shown = {
      id: wireId,
      count,
      description: fields.description,
      link,
      name: fields.name,
      slug: fields.slug,
      taxonomy,
    };
    // Only a hierarchical taxonomy's terms carry `parent`, as core's do.
    return taxonomy === "category"
      ? { ...shown, parent, meta: [], _links }
      : { ...shown, meta: [], _links };
  };

  /** A user in `view` context: the embed form plus `meta`. */
  const userBody = (wireId: WireId, profile: Author): Schema.JsonObject => {
    const { _links, ...shown } = authorBody(wireId, profile);
    return { ...shown, meta: [], _links };
  };

  /** An item's `_embedded`, only the rels asked for and only targets the viewer may read. */
  const embeddedOf = (
    type: PostType,
    item: ShownItem,
    related: Related,
    embed: (rel: string) => boolean,
  ): ReadonlyArray<LinkEntry> => {
    const { fields } = item;
    const members: ReadonlyArray<LinkEntry> = [
      ...(embed("author")
        ? Option.toArray(
            Option.flatMap(fields.author, (account) =>
              Option.map(
                Option.all([
                  HashMap.get(related.authorWire, account),
                  HashMap.get(related.profiles, account),
                ]),
                ([wireId, profile]): LinkEntry => ["author", [authorBody(wireId, profile)]],
              ),
            ),
          )
        : []),
      ...(embed("wp:featuredmedia")
        ? Option.toArray(
            Option.map(
              Option.flatMap(fields.featuredMedia, (id) => HashMap.get(related.media, id)),
              (media): LinkEntry => [
                "wp:featuredmedia",
                [itemBody("attachment", media, related, "embed")],
              ],
            ),
          )
        : []),
      ...(embed("up")
        ? Option.toArray(
            Option.map(
              Option.flatMap(fields.parent, (id) => HashMap.get(related.parents, id)),
              (up): LinkEntry => ["up", [itemBody(parentTypeOf(type), up, related, "embed")]],
            ),
          )
        : []),
      ...(embed("wp:term") && Arr.isReadonlyArrayNonEmpty(related.terms)
        ? [
            [
              "wp:term",
              related.terms.map(([taxonomy]) =>
                Arr.getSomes(
                  termIdsOf(related, taxonomy, fields.id).map((id) =>
                    Option.map(
                      Option.all([
                        HashMap.get(related.termItems, id),
                        HashMap.get(related.wire, id),
                      ]),
                      ([term, wireId]) => termBody(taxonomy, term, wireId, "embed", 0, 0),
                    ),
                  ),
                ),
              ),
            ] as const,
          ]
        : []),
    ];
    return Arr.isReadonlyArrayNonEmpty(members) ? [["_embedded", Record.fromEntries(members)]] : [];
  };

  /** The item with its `_embedded`, filtered to the `_fields` asked for. */
  const itemResponse = (
    type: PostType,
    item: ShownItem,
    related: Related,
    context: "view" | "embed",
    query: Query,
  ): Schema.Json =>
    fieldsFilterOf(query)(
      Record.fromEntries([
        ...Record.toEntries(itemBody(type, item, related, context)),
        ...embeddedOf(type, item, related, embedsOf(query)),
      ]),
    );

  /** Whether everything a response carries may be served from a public cache (`CACHE-AUTH-005`). */
  const publicly = (
    viewer: Viewer,
    items: ReadonlyArray<ShownItem>,
    related: Related,
    embed: (rel: string) => boolean,
  ) =>
    Option.isNone(viewer) &&
    Arr.every(items, (item) => item.serveable) &&
    (!embed("wp:featuredmedia") ||
      Arr.every(HashMap.toValues(related.media), (item) => item.serveable)) &&
    (!embed("up") || Arr.every(HashMap.toValues(related.parents), (item) => item.serveable)) &&
    (!embed("wp:term") || Arr.every(HashMap.toValues(related.termItems), (term) => term.serveable));

  const respond = (
    status: number,
    body: Schema.Json,
    headers: ReadonlyArray<readonly [string, string]> = [],
  ): WordPressResponse => {
    const links = Arr.filter(headers, ([name]) => name === "link").map(([, value]) => value);
    return {
      status,
      headers: Record.fromEntries([
        ["content-type", "application/json; charset=UTF-8"],
        ...Arr.filter(headers, ([name]) => name !== "link"),
        ["link", [apiLink, ...links].join(", ")],
      ]),
      body: Option.some(body),
    };
  };

  const cacheControl = (isPublic: boolean): readonly [string, string] => [
    "cache-control",
    isPublic ? "public" : "private, no-store",
  ];

  const editRefused = (viewer: Viewer, message: string) =>
    new WpRestError({
      code: "rest_forbidden_context",
      message,
      status: authorizationStatus(Option.isSome(viewer)),
    });

  // ── Handlers ────────────────────────────────────────────────────────

  /** One path id decoded, or `missing` (unknown to the codec, or no id at all: `SEC-AUTH-ENUM-001`). */
  const decodeOne = (
    wireIds: WireIds<WireId, unknown, unknown, R>,
    rawId: string,
    missing: () => WpRestError,
  ) =>
    Effect.flatMap(internal(wireIds.decode([rawId])), (decoded) =>
      Effect.fromOption(Option.flatten(Arr.head(decoded))).pipe(Effect.mapError(missing)),
    );

  /** The row the read gate lets through, or `missing` exactly as for an unknown id. */
  const shownOr = <A>(
    read: Effect.Effect<Option.Option<A>, unknown, R>,
    missing: () => WpRestError,
  ) =>
    Effect.flatMap(internal(read), (shown) =>
      Effect.fromOption(shown).pipe(Effect.mapError(missing)),
    );

  const getItem = (
    type: PostType,
    binding: BoundPostType<R, Following>,
    rawId: string,
    query: Query,
  ) =>
    Effect.gen(function* () {
      const id = yield* decodeOne(ids, rawId, invalidId);
      const item = yield* shownOr(binding.get(id), invalidId);
      const viewer = yield* config.viewer;
      // The 404 comes first, so a refused context never confirms the row.
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(viewer, "Sorry, you are not allowed to edit this post.");
      }
      const context = Option.contains(query.scalar("context"), "embed") ? "embed" : "view";
      const embed = embedsOf(query);
      const related = yield* relate(type, [item], embed);
      return respond(200, itemResponse(type, item, related, context, query), [
        cacheControl(publicly(viewer, [item], related, embed)),
      ]);
    });

  /** The decoded node ids of each id list, in one `decode`. */
  const decodeLists = (
    wireIds: WireIds<WireId, unknown, unknown, R>,
    lists: ReadonlyArray<ReadonlyArray<string>>,
  ) =>
    Effect.gen(function* () {
      const flat = Arr.flatten(lists);
      const decodedIds = Arr.isReadonlyArrayNonEmpty(flat)
        ? yield* internal(wireIds.decode(flat))
        : [];
      const starts = Arr.scan(lists, 0, (at, list) => at + list.length);
      return lists.map((list, index) =>
        Arr.getSomes(decodedIds.slice(starts[index] ?? 0, (starts[index] ?? 0) + list.length)),
      );
    });

  const listItems = (type: PostType, binding: BoundPostType<R, Following>, query: Query) =>
    Effect.gen(function* () {
      const { columns } = binding;
      const taxonomies = taxonomiesOf(type);
      const params = yield* collectionParams(
        type,
        query,
        columns,
        site.timezone,
        taxonomies.map(([taxonomy]) => taxonomy),
      );
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(
          viewer,
          "Sorry, you are not allowed to edit posts in this post type.",
        );
      }
      yield* checkStatuses(type, params.statuses, viewer, policy);

      // Every node id parameter decodes in one batch, every author id in another.
      const [include = [], exclude = [], parent = [], parentExclude = [], ...termIds] =
        yield* decodeLists(ids, [
          Option.getOrElse(params.include, () => []),
          params.exclude,
          Option.getOrElse(params.parent, () => []),
          params.parentExclude,
          ...params.terms.map(([, , values]) => values),
        ]);
      const membership = yield* termMembership(params, termIds);
      const [author = [], authorExclude = []] = yield* decodeLists(authors.ids, [
        Option.getOrElse(params.author, () => []),
        params.authorExclude,
      ]);

      /** A filter over a bound column; collectionParams refused a parameter whose column is absent. */
      const onColumn = (
        key: keyof PostColumns,
        filter: (column: string) => ListFilter<never>,
      ): ListFilter<never> =>
        Option.match(columnOf(columns, key), { onNone: () => never, onSome: filter });
      const when = <A>(value: Option.Option<A>, filter: (value: A) => ListFilter<never>) =>
        Option.match(value, { onNone: () => always, onSome: filter });
      /**
       * `column NOT IN values` as WordPress reads it: an unset column is core's
       * `0` (a top-level page's `post_parent`), which no exclusion names, so the
       * row stays; a bare `noneOf` drops it, as SQL's `NULL <> ALL(…)` does (pulpit#170).
       */
      const excluding = (column: string, values: ReadonlyArray<string>) =>
        or<never>(isNull(column), noneOf(column, values));
      const unless = (values: ReadonlyArray<string>, filter: () => ListFilter<never>) =>
        Arr.isReadonlyArrayNonEmpty(values) ? filter() : always;
      const where = and<Following>(
        or<never>(...params.statuses.map((status) => statusFilter(type, columns, status))),
        when(params.include, () => anyOf("id", include)),
        unless(exclude, () => noneOf("id", exclude)),
        when(params.slug, (slugs) => anyOf(columns.slug, slugs)),
        when(params.author, () => onColumn("author", (column) => anyOf(column, author))),
        unless(authorExclude, () =>
          onColumn("author", (column) => excluding(column, authorExclude)),
        ),
        when(params.parent, () => onColumn("parent", (column) => anyOf(column, parent))),
        unless(parentExclude, () =>
          onColumn("parent", (column) => excluding(column, parentExclude)),
        ),
        when(params.menuOrder, (value) => onColumn("menuOrder", (column) => eq(column, value))),
        when(params.mimeType, (value) => onColumn("mimeType", (column) => eq(column, value))),
        when(params.mediaType, (types) => onColumn("mediaType", (column) => anyOf(column, types))),
        when(params.after, (at) => gt(columns.date, at)),
        when(params.before, (at) => lt(columns.date, at)),
        when(params.modifiedAfter, (at) => gt(columns.modified, at)),
        when(params.modifiedBefore, (at) => lt(columns.modified, at)),
        membership,
      );
      const sortBy = Match.value(params.orderby).pipe(
        Match.when("author", () => columnOf(columns, "author")),
        Match.when("id", () => Option.some(columns.id ?? "id")),
        Match.when("modified", () => Option.some(columns.modified)),
        Match.when("slug", () => Option.some(columns.slug)),
        Match.when("title", () => columnOf(columns, "title")),
        Match.when("parent", () => columnOf(columns, "parent")),
        Match.when("menu_order", () => columnOf(columns, "menuOrder")),
        // `date`, and `include`'s reading before its own reorder.
        Match.orElse(() => Option.some(columns.date)),
      );
      const column = yield* Effect.fromOption(sortBy).pipe(
        Effect.mapError(() =>
          invalidParams({
            orderby: `orderby ${params.orderby} is not supported for this post type.`,
          }),
        ),
      );
      const orderBy: ReadonlyArray<ListOrder> = [{ column, direction: params.order }];
      const offset = Option.getOrElse(params.offset, () => (params.page - 1) * params.perPage);
      // `orderby=include` orders by the include list, at most MAX_LIST_PARAMETER long: read it whole, then page it here.
      const byInclude = params.orderby === "include";
      const page = yield* binding
        .list({
          where,
          orderBy,
          includeDeleted: Arr.contains(params.statuses, "trash"),
          limit: byInclude ? MAX_LIST_PARAMETER : params.perPage,
          offset: byInclude ? 0 : offset,
        })
        .pipe(
          Effect.catchIf(Schema.is(InvalidListOrder), () =>
            Effect.fail(
              invalidParams({
                orderby: `orderby ${params.orderby} is not sortable for this post type.`,
              }),
            ),
          ),
          Effect.mapError((error) => (Schema.is(WpRestError)(error) ? error : internalError())),
        );
      const rows = byInclude
        ? Arr.sort(
            page.rows,
            Order.mapInput(Order.Number, (item: ShownItem) => include.indexOf(item.fields.id)),
          ).slice(offset, offset + params.perPage)
        : page.rows;
      const { total } = page;
      const maxPages = Math.ceil(total / params.perPage);
      if (params.page > maxPages && total > 0) {
        return yield* new WpRestError({
          code: "rest_post_invalid_page_number",
          message: "The page number requested is larger than the number of pages available.",
          status: 400,
        });
      }
      const embed = embedsOf(query);
      const related = yield* relate(type, rows, embed);
      const collection = restUrl(`/wp/v2/${baseOf(type)}`);
      const pageLink = (to: number, rel: string): readonly [string, string] => [
        "link",
        linkValue(withQuery(collection, query.pairs, Option.some(to)), rel),
      ];
      return respond(
        200,
        rows.map((item) => itemResponse(type, item, related, params.context, query)),
        [
          ["x-wp-total", String(total)],
          ["x-wp-totalpages", String(maxPages)],
          cacheControl(publicly(viewer, rows, related, embed)),
          ...(params.page > 1 ? [pageLink(Math.min(params.page - 1, maxPages), "prev")] : []),
          ...(maxPages > params.page ? [pageLink(params.page + 1, "next")] : []),
        ],
      );
    });

  // ── Terms ───────────────────────────────────────────────────────────

  const invalidTerm = () =>
    new WpRestError({ code: "rest_term_invalid", message: "Term does not exist.", status: 404 });

  /** The readable parents of `terms` (one `getMany`), so a hidden parent is `0`. */
  const readableParents = (
    binding: BoundTaxonomy<R, Following>,
    terms: ReadonlyArray<ShownTerm>,
  ) => {
    const parentIds = Arr.dedupe(Arr.getSomes(terms.map(({ fields }) => fields.parent)));
    return Arr.isReadonlyArrayNonEmpty(parentIds)
      ? internal(binding.getMany(parentIds))
      : Effect.succeed(HashMap.empty<string, ShownTerm>());
  };

  /** Terms on the wire: their ids and readable parents encoded in one batch. */
  const termBodies = (
    taxonomy: Taxonomy,
    binding: BoundTaxonomy<R, Following>,
    terms: ReadonlyArray<ShownTerm>,
    counts: HashMap.HashMap<string, number>,
    context: "view" | "embed",
  ) =>
    Effect.gen(function* () {
      const parents = yield* readableParents(binding, terms);
      const nodeIds = Arr.dedupe([
        ...terms.map(({ fields }) => fields.id),
        ...HashMap.keys(parents),
      ]);
      const encoded = Arr.isReadonlyArrayNonEmpty(nodeIds)
        ? yield* internal(ids.encode(nodeIds))
        : [];
      const wire = HashMap.fromIterable(Arr.zip(nodeIds, encoded));
      const wireOfNode = (id: Option.Option<string>): WireId =>
        Option.getOrElse(
          Option.flatMap(id, (node) => HashMap.get(wire, node)),
          () => 0,
        );
      return terms.map((term) =>
        termBody(
          taxonomy,
          term,
          wireOfNode(Option.some(term.fields.id)),
          context,
          Option.getOrElse(HashMap.get(counts, term.fields.id), () => 0),
          wireOfNode(Option.filter(term.fields.parent, (parent) => HashMap.has(parents, parent))),
        ),
      );
    });

  const getTerm = (
    taxonomy: Taxonomy,
    binding: BoundTaxonomy<R, Following>,
    rawId: string,
    query: Query,
  ) =>
    Effect.gen(function* () {
      const id = yield* decodeOne(ids, rawId, invalidTerm);
      const term = yield* shownOr(binding.get(id), invalidTerm);
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(viewer, "Sorry, you are not allowed to edit this term.");
      }
      const context = Option.contains(query.scalar("context"), "embed") ? "embed" : "view";
      const counts = yield* internal(binding.counts([id]));
      const [body = {}] = yield* termBodies(taxonomy, binding, [term], counts, context);
      return respond(200, fieldsFilterOf(query)(body), [
        cacheControl(Option.isNone(viewer) && term.serveable),
      ]);
    });

  /** The item `post=` names, read through the post types the taxonomy applies to; a hidden one is unknown. */
  const termsOfPost = (binding: BoundTaxonomy<R, Following>, postId: string) =>
    Effect.gen(function* () {
      const found = yield* Effect.forEach(
        Arr.getSomes(binding.postTypes.map(bound)),
        (postBinding) => internal(postBinding.get(postId)),
        { concurrency: 1 },
      );
      if (!Arr.some(found, Option.isSome)) {
        return yield* new WpRestError({
          code: "rest_post_invalid_id",
          message: "Invalid post ID.",
          status: 400,
        });
      }
      const byPost = yield* internal(binding.termsOf([postId]));
      return Option.getOrElse(HashMap.get(byPost, postId), () => []);
    });

  /**
   * Every matching term at once (at most `MAX_SET_VALUES`), with its count:
   * what `hide_empty` and `orderby=count` read, since neither is a column.
   * A larger match is `400 rest_invalid_param` rather than a short answer.
   */
  const everyTerm = (
    binding: BoundTaxonomy<R, Following>,
    params: TermParams,
    request: ListRequest,
  ) =>
    Effect.gen(function* () {
      const all = yield* termPage(binding, { ...request, limit: MAX_SET_VALUES, offset: 0 });
      if (all.total > all.rows.length) {
        const name = params.hideEmpty ? "hide_empty" : "orderby";
        return yield* invalidParams({
          [name]: `${name} is not supported for more than ${MAX_SET_VALUES} matching terms.`,
        });
      }
      const counts = yield* internal(binding.counts(all.rows.map(({ fields }) => fields.id)));
      const countOf = (term: ShownTerm) =>
        Option.getOrElse(HashMap.get(counts, term.fields.id), () => 0);
      const kept = params.hideEmpty ? Arr.filter(all.rows, (term) => countOf(term) > 0) : all.rows;
      const byCount = Order.mapInput(Order.Number, countOf);
      const sorted =
        params.orderby === "count"
          ? Arr.sort(kept, params.order === "desc" ? Order.flip(byCount) : byCount)
          : kept;
      return { rows: sorted, total: sorted.length, counts };
    });

  /** One page of terms, an undeclared order answering `400 rest_invalid_param`. */
  const termPage = (binding: BoundTaxonomy<R, Following>, request: ListRequest) =>
    binding.list(request).pipe(
      Effect.catchIf(Schema.is(InvalidListOrder), () =>
        Effect.fail(invalidParams({ orderby: "orderby is not sortable for this taxonomy." })),
      ),
      Effect.mapError((error) => (Schema.is(WpRestError)(error) ? error : internalError())),
    );

  /** The paging headers WordPress sets on a collection, with no past-the-end error (as core's terms and users). */
  const pagingHeaders = (
    route: string,
    query: Query,
    total: number,
    page: number,
    perPage: number,
  ): ReadonlyArray<readonly [string, string]> => {
    const maxPages = Math.ceil(total / perPage);
    const pageLink = (to: number, rel: string): readonly [string, string] => [
      "link",
      linkValue(withQuery(restUrl(route), query.pairs, Option.some(to)), rel),
    ];
    return [
      ["x-wp-total", String(total)],
      ["x-wp-totalpages", String(maxPages)],
      ...(page > 1 ? [pageLink(Math.min(page - 1, maxPages), "prev")] : []),
      ...(maxPages > page ? [pageLink(page + 1, "next")] : []),
    ];
  };

  const listTerms = (taxonomy: Taxonomy, binding: BoundTaxonomy<R, Following>, query: Query) =>
    Effect.gen(function* () {
      const { columns } = binding;
      const params = yield* termParams(taxonomy, query, columns, site.timezone);
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(
          viewer,
          "Sorry, you are not allowed to edit terms in this taxonomy.",
        );
      }
      const parentWire = Option.filter(params.parent, (parent) => parent > 0);
      const postWire = Option.filter(params.post, (post) => post > 0);
      const [include = [], exclude = [], parent = [], post = []] = yield* decodeLists(ids, [
        Option.getOrElse(params.include, () => []),
        params.exclude,
        Option.toArray(Option.map(parentWire, String)),
        Option.toArray(Option.map(postWire, String)),
      ]);
      const ofPost = Option.isSome(postWire)
        ? Option.some(
            yield* Option.match(Arr.head(post), {
              onNone: () =>
                Effect.fail(
                  new WpRestError({
                    code: "rest_post_invalid_id",
                    message: "Invalid post ID.",
                    status: 400,
                  }),
                ),
              onSome: (postId) => termsOfPost(binding, postId),
            }),
          )
        : Option.none<ReadonlyArray<string>>();
      const when = <A>(value: Option.Option<A>, filter: (value: A) => ListFilter<never>) =>
        Option.match(value, { onNone: () => always, onSome: filter });
      const where = and<never>(
        when(params.include, () => anyOf("id", include)),
        Arr.isReadonlyArrayNonEmpty(exclude) ? noneOf("id", exclude) : always,
        when(params.slug, (slugs) => anyOf(columns.slug, slugs)),
        when(params.parent, (wire) =>
          Option.match(Option.fromNullishOr(columns.parent), {
            onNone: () => never,
            onSome: (column) => (wire === 0 ? isNull(column) : anyOf(column, parent)),
          }),
        ),
        when(ofPost, (termIds) => anyOf("id", termIds)),
      );
      const column = Match.value(params.orderby).pipe(
        Match.when("id", () => columns.id ?? "id"),
        Match.when("slug", () => columns.slug),
        Match.orElse(() => columns.name),
      );
      const request: ListRequest = {
        where,
        orderBy: [{ column, direction: params.orderby === "count" ? "asc" : params.order }],
        includeDeleted: false,
        limit: params.perPage,
        offset: Option.getOrElse(params.offset, () => (params.page - 1) * params.perPage),
      };
      const inMemory =
        params.hideEmpty || params.orderby === "count" || params.orderby === "include";
      const { rows, total, counts } = inMemory
        ? yield* Effect.map(everyTerm(binding, params, request), (all) => {
            const ordered =
              params.orderby === "include"
                ? Arr.sort(
                    all.rows,
                    Order.mapInput(Order.Number, (term: ShownTerm) =>
                      include.indexOf(term.fields.id),
                    ),
                  )
                : all.rows;
            return {
              rows: ordered.slice(request.offset, request.offset + request.limit),
              total: all.total,
              counts: all.counts,
            };
          })
        : yield* Effect.flatMap(termPage(binding, request), (page) =>
            Effect.map(
              internal(binding.counts(page.rows.map(({ fields }) => fields.id))),
              (counts) => ({ ...page, counts }),
            ),
          );
      const bodies = yield* termBodies(taxonomy, binding, rows, counts, params.context);
      return respond(200, bodies.map(fieldsFilterOf(query)), [
        ...pagingHeaders(
          `/wp/v2/${taxonomyBase(taxonomy)}`,
          query,
          total,
          params.page,
          params.perPage,
        ),
        cacheControl(Option.isNone(viewer) && Arr.every(rows, (term) => term.serveable)),
      ]);
    });

  // ── Users ───────────────────────────────────────────────────────────

  const invalidUser = () =>
    new WpRestError({ code: "rest_user_invalid_id", message: "Invalid user ID.", status: 404 });

  /**
   * The accounts owning a row the viewer may list, across every bound post
   * type (`readableOwners`, `SEC-AUTH-ENUM-001`), narrowed to `among`.
   */
  const readableAuthors = (among: Option.Option<ReadonlyArray<string>>) =>
    Effect.gen(function* () {
      const leaves = Arr.getSomes(
        ROUTES.map(([, type]) =>
          Option.map(bound(type), (binding) => ({ type, owners: binding.owners })),
        ),
      );
      const page = yield* internal(
        readableOwners(leaves, {
          limit: MAX_PAGE_LIMIT,
          offset: 0,
          includeDeleted: false,
          among: Option.getOrUndefined(among),
        }),
      );
      // The union of several leaves can pass one page; answering a short list would hide authors.
      if (page.total > page.rows.length) return yield* internalError();
      return page.rows;
    });

  const getUser = (rawId: string, query: Query) =>
    Effect.gen(function* () {
      const id = yield* decodeOne(authors.ids, rawId, invalidUser);
      const owners = yield* readableAuthors(Option.some([id]));
      if (!Arr.contains(owners, id)) return yield* invalidUser();
      const profile = yield* Effect.fromOption(
        HashMap.get(yield* internal(authors.getMany([id])), id),
      ).pipe(Effect.mapError(invalidUser));
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(viewer, "Sorry, you are not allowed to edit this user.");
      }
      const [wireId = 0] = yield* internal(authors.ids.encode([id]));
      const body = Option.contains(query.scalar("context"), "embed")
        ? authorBody(wireId, profile)
        : userBody(wireId, profile);
      return respond(200, fieldsFilterOf(query)(body), [cacheControl(false)]);
    });

  const listUsers = (query: Query) =>
    Effect.gen(function* () {
      const params = yield* userParams(query, site.timezone);
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(viewer, "Sorry, you are not allowed to list users.");
      }
      if (Option.isSome(params.forbiddenOrderby)) {
        return yield* new WpRestError({
          code: "rest_forbidden_orderby",
          message: "Sorry, you are not allowed to order users by this parameter.",
          status: authorizationStatus(Option.isSome(viewer)),
        });
      }
      const [include = [], exclude = []] = yield* decodeLists(authors.ids, [
        Option.getOrElse(params.include, () => []),
        params.exclude,
      ]);
      const owners = Arr.filter(
        yield* readableAuthors(Option.map(params.include, () => include)),
        (owner) => !Arr.contains(exclude, owner),
      );
      const profiles = Arr.isReadonlyArrayNonEmpty(owners)
        ? yield* internal(authors.getMany(owners))
        : HashMap.empty<string, Author>();
      const shown = Arr.filter(
        Arr.getSomes(
          owners.map((owner) =>
            Option.map(HashMap.get(profiles, owner), (profile) => [owner, profile] as const),
          ),
        ),
        ([, profile]) =>
          Option.match(params.slug, {
            onNone: () => true,
            onSome: (slugs) => Arr.contains(slugs, profile.slug),
          }),
      );
      const encoded = Arr.isReadonlyArrayNonEmpty(shown)
        ? yield* internal(authors.ids.encode(shown.map(([owner]) => owner)))
        : [];
      const users = Arr.zip(shown, encoded).map(([[owner, profile], wireId]) => ({
        owner,
        profile,
        wireId,
      }));
      type User = (typeof users)[number];
      // An integer id sorts by value (zero-padded past any safe integer), a string id by code point.
      const byWireId = Order.mapInput(Order.String, (user: User) =>
        Predicate.isNumber(user.wireId) ? String(user.wireId).padStart(20, "0") : user.wireId,
      );
      const ascending = Match.value(params.orderby).pipe(
        Match.when("id", () => byWireId),
        Match.when("slug", () => Order.mapInput(Order.String, (user: User) => user.profile.slug)),
        Match.when("include", () =>
          Order.mapInput(Order.Number, (user: User) => include.indexOf(user.owner)),
        ),
        Match.orElse(() => Order.mapInput(Order.String, (user: User) => user.profile.name)),
      );
      const sorted = Arr.sort(
        users,
        params.order === "desc" && params.orderby !== "include" ? Order.flip(ascending) : ascending,
      );
      const offset = Option.getOrElse(params.offset, () => (params.page - 1) * params.perPage);
      const rows = sorted.slice(offset, offset + params.perPage);
      return respond(
        200,
        rows.map(({ wireId, profile }) =>
          fieldsFilterOf(query)(
            params.context === "embed" ? authorBody(wireId, profile) : userBody(wireId, profile),
          ),
        ),
        [
          ...pagingHeaders("/wp/v2/users", query, sorted.length, params.page, params.perPage),
          cacheControl(false),
        ],
      );
    });

  const indexBody = () =>
    Effect.map(DateTime.now, (now): Schema.JsonObject => ({
      name: site.name,
      description: site.description,
      url: site.url,
      home: site.url,
      gmt_offset: gmtOffset(DateTime.toDateUtc(now), site.timezone),
      timezone_string: site.timezone,
      namespaces: ["wp/v2"],
      authentication: [],
      routes: routesBody(),
    }));

  /** A taxonomy or `/users` route, or none for a post type's. */
  const routeOther = (
    base: Option.Option<string>,
    id: Option.Option<string>,
    query: Query,
  ): Effect.Effect<Option.Option<WordPressResponse>, WpRestError, R> => {
    const taxonomy = Option.flatMap(
      Arr.findFirst(TAXONOMIES, ([routed]) => Option.contains(base, routed)),
      ([, found]) =>
        Option.map(
          Option.fromNullishOr(config.taxonomies?.[found]),
          (binding) => [found, binding] as const,
        ),
    );
    if (Option.isSome(taxonomy)) {
      const [found, binding] = taxonomy.value;
      return Option.match(id, {
        onNone: () => Effect.map(listTerms(found, binding, query), Option.some),
        onSome: (rawId) =>
          ids.mode === "integer" && !/^\d+$/.test(rawId)
            ? Effect.fail(noRoute())
            : Effect.map(getTerm(found, binding, decodeURIComponent(rawId), query), Option.some),
      });
    }
    if (Option.contains(base, "users") && servesUsers()) {
      return Option.match(id, {
        onNone: () => Effect.map(listUsers(query), Option.some),
        onSome: (rawId) =>
          authors.ids.mode === "integer" && !/^\d+$/.test(rawId)
            ? Effect.fail(noRoute())
            : Effect.map(getUser(decodeURIComponent(rawId), query), Option.some),
      });
    }
    return Effect.succeed(Option.none());
  };

  /** `/users` is routed when any post type is bound: its authors are the only accounts it lists. */
  const servesUsers = () => Arr.some(ROUTES, ([, type]) => Option.isSome(bound(type)));

  const route = (request: WordPressRequest) =>
    Effect.gen(function* () {
      if (request.method !== "GET" && request.method !== "HEAD") return yield* noRoute();
      if (!request.path.startsWith(prefix)) return yield* noRoute();
      const rest = request.path.slice(prefix.length).replace(/\/+$/, "");
      const query = readQuery(request.query);
      if (rest === "") return respond(200, yield* indexBody(), [cacheControl(true)]);
      if (rest === "/wp/v2") {
        return respond(200, { namespace: "wp/v2", routes: routesBody() }, [cacheControl(true)]);
      }
      const [, base, rawId] = /^\/wp\/v2\/([a-z]+)(?:\/([^/]+))?$/.exec(rest) ?? [];
      const routed = yield* routeOther(
        Option.fromNullishOr(base),
        Option.fromNullishOr(rawId),
        query,
      );
      if (Option.isSome(routed)) return routed.value;
      const type = yield* Effect.fromOption(
        Option.flatMap(Option.fromNullishOr(base), typeOf),
      ).pipe(Effect.mapError(noRoute));
      const binding = yield* Effect.fromOption(bound(type)).pipe(Effect.mapError(noRoute));
      if (rawId === undefined) return yield* listItems(type, binding, query);
      // An integer route matches digits only, as core's `(?P<id>[\d]+)` does.
      if (ids.mode === "integer" && !/^\d+$/.test(rawId)) return yield* noRoute();
      return yield* getItem(type, binding, decodeURIComponent(rawId), query);
    });

  return {
    handle: (request) =>
      route(request).pipe(
        Effect.catchTag("WpRestError", (error) =>
          Effect.succeed(respond(error.status, errorBody(error))),
        ),
        Effect.map((response) =>
          request.method === "HEAD" ? { ...response, body: Option.none() } : response,
        ),
      ),
  };
};
