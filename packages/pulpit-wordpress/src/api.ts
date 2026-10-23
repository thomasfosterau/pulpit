/**
 * **The `wp/v2` read API** — posts, pages and media as WordPress's REST API
 * serves them, over the leaves an application binds to those types, plus the
 * discovery index (pulpit#86, phase 1).
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
 *   `private, no-store`.
 *
 * ## What phase 1 leaves out
 *
 * No writes (`POST` / `PUT` / `PATCH` / `DELETE` are `rest_no_route`), no
 * `context=edit` (`rest_forbidden_context`, after the 404 check), no
 * revisions, no `search`, no categories or tags, no `/users` route. A
 * parameter phase 1 can't honour (`search`, `categories`, `tags`, `sticky`,
 * …) is `400 rest_invalid_param`, never silently ignored, so a client never
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
  noneOf,
  notPublished,
  or,
  published,
  type ListFilter,
} from "@thomasfosterau/pulpit/filter";
import {
  InvalidListOrder,
  type AccessPolicy,
  type ListOrder,
  type ListRequest,
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
export interface PostTypeBinding<Resource, E, R> {
  readonly ops: Pick<SubtypeOps<Resource, E, R>, "get" | "getMany" | "list">;
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
export interface BoundPostType<R> {
  readonly columns: PostColumns;
  /** The item, or none when the read gate hides it or it is missing (`SEC-AUTH-ENUM-001`). */
  readonly get: (id: string) => Effect.Effect<Option.Option<ShownItem>, unknown, R>;
  readonly getMany: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ShownItem>, unknown, R>;
  /** One page and its total; fails `InvalidListOrder` for an order the leaf doesn't sort by. */
  readonly list: (
    request: ListRequest,
  ) => Effect.Effect<
    { readonly rows: ReadonlyArray<ShownItem>; readonly total: number },
    unknown,
    R
  >;
}

/**
 * Bind an application leaf to a WordPress post type. Its `get`'s
 * `NodeNotFound` (a missing or hidden row, `SEC-AUTH-ENUM-001`) becomes
 * none; every other failure stays the store's.
 *
 * @since 0.1.0
 */
export const bind = <Resource, E, R>(
  binding: PostTypeBinding<Resource, E, R>,
): BoundPostType<R> => {
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
export interface WordPressConfig<R> {
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
  readonly types: { readonly [Type in PostType]?: BoundPostType<R> | undefined };
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

/** The parameters phase 1 refuses rather than silently ignores. */
const UNSUPPORTED = [
  "search",
  "search_columns",
  "search_semantics",
  "categories",
  "categories_exclude",
  "tags",
  "tags_exclude",
  "tax_relation",
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
}

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
 * Parse and check a collection's parameters, collecting every bad one into
 * one `rest_invalid_param`, as WordPress's argument validation does.
 */
const collectionParams = (
  type: PostType,
  query: Query,
  columns: PostColumns,
  timeZone: string,
): Effect.Effect<CollectionParams, WpRestError> =>
  Effect.suspend(() => {
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
      page: integer("page", 1, Number.MAX_SAFE_INTEGER, 1),
      perPage: integer("per_page", 1, 100, 10),
      offset: Option.map(query.scalar("offset"), () =>
        integer("offset", 0, Number.MAX_SAFE_INTEGER, 0),
      ),
      order: oneOf("order", ["asc", "desc"] as const, "desc"),
      orderby: oneOf("orderby", orderbys, "date"),
      include: list("include"),
      exclude: Option.getOrElse(list("exclude"), () => []),
      slug: list("slug"),
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
    };
    if (Arr.isReadonlyArrayNonEmpty(bad))
      return Effect.fail(invalidParams(Record.fromEntries(bad)));
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
export const defineWordPress = <R>(config: WordPressConfig<R>): WordPressApi<R> => {
  const prefix = (config.prefix ?? "/wp-json").replace(/\/+$/, "");
  const { site, ids, authors, policy } = config;
  const root = `${site.url}${prefix}`;
  const apiLink = linkValue(`${root}/`, "https://api.w.org/");
  const restUrl = (route: string) => `${root}${route}`;
  const idPattern = ids.mode === "integer" ? "(?P<id>[\\d]+)" : "(?P<id>[^/]+)";

  const bound = (type: PostType): Option.Option<BoundPostType<R>> =>
    Option.fromNullishOr(config.types[type]);

  /** The bound type's `getMany`, skipped for no ids. */
  const readable = (type: PostType, nodeIds: ReadonlyArray<string>) =>
    Option.match(bound(type), {
      onNone: () => Effect.succeed(HashMap.empty<string, ShownItem>()),
      onSome: (binding) =>
        Arr.isReadonlyArrayNonEmpty(nodeIds)
          ? internal(binding.getMany(nodeIds))
          : Effect.succeed(HashMap.empty<string, ShownItem>()),
    });

  const routesBody = (): Schema.JsonObject =>
    Record.fromEntries(
      Arr.flatMap(ROUTES, ([base, type]) =>
        Option.isSome(bound(type))
          ? [`/wp/v2/${base}`, `/wp/v2/${base}/${idPattern}`].map(
              (route) =>
                [
                  route,
                  {
                    namespace: "wp/v2",
                    methods: ["GET"],
                    endpoints: [{ methods: ["GET"], args: {} }],
                  },
                ] as const,
            )
          : [],
      ),
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
      const embeddedMedia = embed("wp:featuredmedia") ? HashMap.toValues(media) : [];
      const embeddedParents = embed("up") ? HashMap.toValues(parents) : [];
      const nodeIds = Arr.dedupe([
        ...items.map(({ fields }) => fields.id),
        ...HashMap.keys(media),
        ...HashMap.keys(parents),
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
      } satisfies Related;
    });

  /** A node's wire id, or `0` (WordPress's "none") for no node or one the response may not name. */
  const wireOf = (related: Related, id: Option.Option<string>): WireId =>
    Option.getOrElse(
      Option.flatMap(id, (node) => HashMap.get(related.wire, node)),
      () => 0,
    );

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
      ["curies", [{ name: "wp", href: "https://api.w.org/{rel}", templated: true }]],
    ];
    return Record.fromEntries(entries);
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
        categories: [],
        tags: [],
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
    (!embed("up") || Arr.every(HashMap.toValues(related.parents), (item) => item.serveable));

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

  const getItem = (type: PostType, binding: BoundPostType<R>, rawId: string, query: Query) =>
    Effect.gen(function* () {
      const decodedIds = yield* internal(ids.decode([rawId]));
      const id = yield* Effect.fromOption(Option.flatten(Arr.head(decodedIds))).pipe(
        Effect.mapError(invalidId),
      );
      const item = yield* Effect.fromOption(yield* internal(binding.get(id))).pipe(
        Effect.mapError(invalidId),
      );
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

  const listItems = (type: PostType, binding: BoundPostType<R>, query: Query) =>
    Effect.gen(function* () {
      const { columns } = binding;
      const params = yield* collectionParams(type, query, columns, site.timezone);
      const viewer = yield* config.viewer;
      if (Option.contains(query.scalar("context"), "edit")) {
        return yield* editRefused(
          viewer,
          "Sorry, you are not allowed to edit posts in this post type.",
        );
      }
      yield* checkStatuses(type, params.statuses, viewer, policy);

      // Every node id parameter decodes in one batch, every author id in another.
      const [include = [], exclude = [], parent = [], parentExclude = []] = yield* decodeLists(
        ids,
        [
          Option.getOrElse(params.include, () => []),
          params.exclude,
          Option.getOrElse(params.parent, () => []),
          params.parentExclude,
        ],
      );
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
      const where = and<never>(
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
