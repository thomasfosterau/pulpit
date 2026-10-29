# @thomasfosterau/pulpit-wordpress

A WordPress-compatible (`wp/v2`), read-only REST API over the chains of [`@thomasfosterau/pulpit`](../pulpit/README.md), so a headless WordPress frontend (one written against the WordPress REST API, such as `@wordpress/api-fetch` or a hand-rolled `fetch('/wp-json/wp/v2/posts?slug=…')`) can read posts, pages, media, terms and authors from a pulpit application unchanged.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published.** The package is `"private": true` ([pulpit#115](https://github.com/thomasfosterau/pulpit/issues/115)). The API is specified on [pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86) (the spec draft and the owner's decisions of 2026-10-15) and lands in phases:

- **Landed:** the `IdCodec` seam and the id modes ([`./ids`](#ids), [pulpit#114](https://github.com/thomasfosterau/pulpit/issues/114)), with an in-memory codec in [`./testing`](#testing).
- **Phase 1 (landed):** posts, pages and media (list and get), the discovery index, `_links`, `_embed`, `_fields`, the headers and the errors ([`./api`](#api), [`./http`](#http)).
- **Phase 2:** categories, tags and `/users` ([`./api`](#api)), with `categories_exclude` / `tags_exclude` over the kernel's `nonMemberFilter` ([pulpit#215](https://github.com/thomasfosterau/pulpit/issues/215)).
- **Phase 3:** each later kernel slice as it lands.

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-wordpress @thomasfosterau/pulpit effect
```

`@thomasfosterau/pulpit` and `effect` are required peer dependencies, and so are the kernel's own peers. Node.js 22 or newer is required.

## API

Every module is a namespace on the root export (`import { Ids } from "@thomasfosterau/pulpit-wordpress"`) and a subpath of its own, except `./testing`, which is a subpath only, as in the kernel.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Ids`, `Api`, `Http`). |
| `./api` | The `wp/v2` read API: `defineWordPress`, the post-type and taxonomy bindings (`bind`, `bindTaxonomy`) and the seams it reads (`render`, the author seam, the site). |
| `./http` | `wordPressHttp(api)`, the read API as an `effect/http` request handler. |
| `./ids` | The `IdCodec` seam an application fills, the integer-id mode over it (`integerIds`) and the opt-in string-id mode (`stringIds`). |
| `./testing` | In-memory fakes of the adapter's seams (`makeInMemoryIdCodec`), for tests only. Not on the root export. |

## `./ids`

WordPress clients expect positive integer ids (the core route pattern is `(?P<id>[\d]+)`), and pulpit node ids are opaque strings. The adapter reads and writes ids through one of two modes:

- **`integerIds(codec)`**, the default: an application-filled [`IdCodec`](#idcodece-r-node-ids-to-wordpress-integers) maps node ids to integers and back.
- **`stringIds(options?)`**, opt-in, for clients that tolerate string ids: node ids pass through unchanged and no codec is read. `isNodeId` rejects a string that can't be a node id (a non-UUID, for a `uuid` column), so it decodes to none and never reaches a store as a malformed value. A throwing `isNodeId` is a defect of the effect, never a synchronous throw.

Both answer per input, in input order, duplicates included:

- `encode(nodeIds)` answers each node id's wire id. In integer mode it reads the codec once for the whole batch, deduplicated, and fails `UnencodableNodeId` if the codec has no integer for a node (`unmapped`), answers one that isn't a positive safe integer (`invalid-integer`), or answers one integer for two distinct node ids in the batch (`duplicate-integer`), each an application defect: the adapter encodes only nodes the read gate has let through.
- `decode(wireIds)` answers the node id each wire id names, or `Option.none()`. In integer mode a wire id that isn't a positive safe integer (`0`, a negative, a fraction, an exponent, a non-numeric string, one above `Number.MAX_SAFE_INTEGER`) is none without reaching the codec; a string must be decimal digits, and leading zeros read as decimal, as WordPress's `absint` reads them (`007` is 7). An integer the codec doesn't know is none too. `decode` fails only with the codec's own error (its error type is the codec's `E` alone), never on a malformed input.
- **A `decode` batch is capped at the kernel's `MAX_SET_VALUES`** (1000, duplicates counted; `SEC-INPUT-003`), the cap on the `= ANY($values)` set the decoded ids feed. Past it, every wire id decodes to none and the codec isn't read, failing closed as the kernel's `anyOf` does. That is closed for an `include` list or a path id, but not for `exclude`, where excluding nothing is open: the adapter caps `include`, `exclude` and every other list parameter itself, at `MAX_LIST_PARAMETER` (100), before `decode` ([`./api`](#api)).

**Unknown, malformed and hidden ids answer alike (`SEC-AUTH-ENUM-001`).** Every none is answered exactly as a hidden or missing row is (`404 rest_post_invalid_id`), never as a `400` or a `500`, and a decoded id still goes through the kernel's read gate. Integer ids are guessable where UUIDs aren't, so this is what keeps them from confirming that a hidden node exists. The answer is the same; the timing is not: a malformed id skips the codec, an unknown one costs one codec read, and a hidden one a codec read and a store read. That is the same timing residue the kernel accepts between a missing and a hidden row.

```ts
import { deepStrictEqual } from "node:assert";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";
import { makeInMemoryIdCodec } from "@thomasfosterau/pulpit-wordpress/testing";

const ids = integerIds(makeInMemoryIdCodec(["node-a", "node-b"]));

deepStrictEqual(Effect.runSync(ids.encode(["node-b", "node-a", "node-b"])), [2, 1, 2]);
deepStrictEqual(Effect.runSync(ids.decode(["1", "7", "0", "1.5"])), [
  Option.some("node-a"),
  Option.none(), // unknown
  Option.none(), // not a WordPress id
  Option.none(),
]);
```

## `./api`

`defineWordPress(config)` declares a `wp/v2` read API over the leaves an application binds to WordPress's post types, and returns `{ handle }`, which answers one request (its method, its path from the site root, and its query pairs in order) with a status, headers and a JSON body. `handle` never fails: a WordPress error is its envelope (`{ code, message, data: { status } }`), and a failure of a store, the codec or the renderer is `500 internal_server_error`. It is framework-free; [`./http`](#http) mounts it on `effect/http`.

```ts
import { bind, bindTaxonomy, defineWordPress } from "@thomasfosterau/pulpit-wordpress/api";
import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";

const wp = defineWordPress({
  site: {
    url: "https://example.org",
    name: "Example",
    description: "",
    timezone: "Australia/Sydney",
  },
  ids: integerIds(nodeCodec),
  viewer, // the request's viewer, as the leaves read it
  policy, // the application's role axes
  render: (requests) => renderHtml(requests), // one batch per response, in order
  link: (type, fields) => `https://example.org/${fields.slug}`,
  types: {
    post: bind({
      ops: postOps,
      columns: { slug: "slug", date: "publishedAt", modified: "updatedAt" },
      fields: postFields,
      serveable,
    }),
    page: bind({ ops: pageOps, columns, fields: pageFields, serveable }),
    attachment: bind({ ops: imageOps, columns, fields: imageFields, serveable }),
  },
  taxonomies: {
    category: bindTaxonomy({
      terms: categoryOps, // a reference leaf's defineSubtype operations
      columns: { name: "name", slug: "slug", parent: "parentId" },
      fields: categoryFields,
      serveable: () => true,
      link: (fields) => `https://example.org/category/${fields.slug}`,
      assignments: postCategoryOps, // the post_category edge family's defineEdgeOps operations
      ends: {
        post: { alias: "post", column: "postId" },
        term: { alias: "term", column: "termId" },
      },
      assignment: (edge) => ({ post: edge.postId, term: edge.termId }),
    }),
    post_tag: bindTaxonomy({/* … */}),
  },
  authors: { ids: integerIds(accountCodec), getMany: readProfiles },
});
```

**Routes.** Under the prefix (`/wp-json`, by default): the discovery index `/` (`namespaces`, `routes`, `gmt_offset`, `timezone_string`), the namespace `/wp/v2`, for each bound type its collection and item routes (`/posts`, `/pages`, `/media`, each with `/{id}`), for each bound taxonomy its own (`/categories`, `/tags`), and `/users` and `/users/{id}` once any type is bound. `GET` and `HEAD` only; any other method, an unbound type, and any other route answer `404 rest_no_route`. Every response carries `Link: <…/wp-json/>; rel="https://api.w.org/"`.

**Collections** take `context` (`view` | `embed`), `page`, `per_page` (1–100, default 10), `offset`, `order`, `orderby` (`date` by default; `author`, `id`, `include`, `modified`, `slug`, `title`, plus `parent` and `menu_order` where they apply), `include`, `exclude`, `slug`, `status`, `author`, `author_exclude`, `after`, `before`, `modified_after`, `modified_before`, `_fields` and `_embed`; pages and media add `parent` / `parent_exclude`, pages `menu_order`, media `mime_type` / `media_type`. A list is a bare JSON array with `X-WP-Total`, `X-WP-TotalPages` and the `Link` `prev` / `next` WordPress builds; a page past the end of a non-empty list is `400 rest_post_invalid_page_number`. Bad parameters are one `400 rest_invalid_param` naming each in `data.params`. A post type a taxonomy applies to also takes `categories` / `tags` (lists of term ids; the items holding a readable assignment to one of them, through the edge family's `memberFilter`) `categories_exclude` / `tags_exclude` (the items holding no readable assignment to any of them, through `nonMemberFilter`: a hidden assignment or an unknown term excludes nothing), and `tax_relation` (`AND`, the default, or `OR`), which joins every term clause, the exclusions included, as core's `tax_query` does. A parameter the adapter can't honour (`search`, `sticky`, `format`, …), or one whose column the binding doesn't declare, is `rest_invalid_param` too, never silently ignored.

**Items** carry WordPress's fields in core's wire form (pinned to the fixture core generates from its REST API): `title` / `content` / `excerpt` as `{ rendered }` through `render`, `date` in the site's time zone and `date_gmt` in UTC (`null` for an item never stamped), `status` derived from the binding's facts (`trash` for a tombstone, `draft`, `private` for any visibility but `public`, `future` for an unarrived stamp, else `publish`; media are `inherit`), `_links` (`self`, `collection`, `about`, `author`, `wp:featuredmedia`, `up`, `wp:attachment`, `curies`), and, with `_embed` (all, or a list of rels), `_embedded.author`, `wp:featuredmedia` and `up`. Fields pulpit doesn't model are constants: `comment_status` and `ping_status` `"closed"`, `sticky: false`, `format: "standard"`, `template: ""` and `meta: []`. An item of a type a taxonomy applies to carries its readable terms (`categories`, `tags`; a post always has both, empty when unbound), a `wp:term` link per taxonomy (`/categories?post={id}`), and, with `_embed=wp:term`, `_embedded["wp:term"]`: one array of terms per taxonomy, in link order, each read through its taxonomy's own `getMany`.

**Terms** (`/categories`, `/tags`, each with `/{id}`) carry core's term form: `id`, `count`, `description`, `link`, `name`, `slug`, `taxonomy`, `parent` (categories only), `meta: []` and `_links` (`self`, `collection`, `about`, `up` for a readable parent, `wp:post_type`, `curies`). A collection takes `context`, `page`, `per_page`, `offset`, `order` (`asc` by default), `orderby` (`name` by default; `id`, `include`, `slug`, `count`), `include`, `exclude`, `slug`, `hide_empty`, `parent` (categories; `0` for the top level) and `post`. As in core, a page past the end is an empty list, not an error.

- **`count`** is the number of assignments the viewer can read (the edge family's `countBy`, one grouped read per page), so it differs by viewer, where WordPress's is a stored total over published posts.
- **`hide_empty` and `orderby=count`** need every matching term's count, so they read the matching terms at once, at most `MAX_SET_VALUES` (1000), and page in memory; a larger match is `400 rest_invalid_param` rather than a short answer.
- **`post=`** names an item through the post types the taxonomy applies to; one the viewer can't read answers `400 rest_post_invalid_id`, exactly as an unknown one. WordPress answers `rest_forbidden_context` for a post it can't show terms for.
- **An unknown or hidden term** is `404 rest_term_invalid`. `orderby` `include_slugs`, `term_group` and `description`, and `search`, are `400 rest_invalid_param`.

**Authors** (`/users`, `/users/{id}`) are the accounts owning at least one item the viewer can read, across every bound post type (the kernel's `readableOwners`), with core's user form (`id`, `name`, `url`, `description`, `link`, `slug`, `avatar_urls`, `meta: []`, `_links`). Any other account answers `404 rest_user_invalid_id`, exactly as an unknown one, where WordPress answers `rest_user_cannot_view` (401) for an account it won't list. A collection takes `context`, `page`, `per_page`, `offset`, `order`, `orderby` (`name` by default; `id`, `include`, `slug`), `include`, `exclude`, `slug` and `who=authors`; it reads every readable author with their profile and pages in memory. A bound post type with more than `MAX_PAGE_LIMIT` (1000) readable authors, or a union of them past one page, is `500 internal_server_error` rather than a short list (the kernel's `OwnerSetTooLarge`). `orderby` `email` or `registered_date` is `rest_forbidden_orderby` (401 / 403), as core answers a caller without `list_users`; `search`, `roles`, `capabilities` and `has_published_posts` are `400 rest_invalid_param`. Every `/users` response is `Cache-Control: private, no-store`.

**The read rule, and where it differs from WordPress.**

- **A hidden item is a missing one** (`SEC-AUTH-ENUM-001`). Reads go through each bound leaf's own `get` / `getMany` / `list`, so a hidden, draft, tombstoned or unpublished item answers `404 rest_post_invalid_id` exactly as an unknown id does, and a list omits it from its page and its `X-WP-Total`. WordPress answers `rest_forbidden` (401 / 403) for a post that exists but can't be read; this adapter never does.
- **A file whose bytes are pending is missing** ([pulpit#221](https://github.com/thomasfosterau/pulpit/issues/221)). An attachment over a `./blobs` file leaf whose `MediaFields.bytesPending` is `true` answers `404 rest_post_invalid_id`, to its owner too, and is never a `featured_media` or `_embed` target, until its bytes are confirmed. Declare the leaf's `bytesPending` column in `PostColumns` so a `/media` list (and its `X-WP-Total`) reads only confirmed files. `fileMediaFields(file, blobs, { caption, description, altText, mediaDetails? })` maps a file version onto `MediaFields`: `mime_type` from its `mediaType`, `media_type` from that type's top level, `filesize` from `byteSize`, `source_url` from `fileUrl` (empty while pending), and `bytesPending`.
- **A routable leaf's paths** ([pulpit#222](https://github.com/thomasfosterau/pulpit/issues/222)). Bind a `./paths` `routable` leaf with its path column as `PostColumns.slug`: the column holds the canonical path, so `?slug=` finds a renamed item by its new path only, never by an alias (WordPress's REST API doesn't follow old slugs either), and a hidden item answers to neither. Build `link` from that slug, so it is the canonical URL. Redirecting an alias is the site's router's job, through `resolve`, which hides a hidden node's alias too.
- **A readable item never points at a hidden one.** `featured_media` and `parent` are read through the target type's own `getMany`; a target the viewer can't read is `0`, and is left out of `_links` and `_embedded`.
- **`status`.** The default is `publish` (`inherit` for media). Any other status from an anonymous caller is `401 rest_forbidden_status`, and `trash` without the view-deleted rung is `403` (pulpit#86, decision 4); the answer names no row. A signed-in caller's `draft` or `private` list is whatever the leaf's gates show them (their own drafts, say). A `followers` item reads as `private` to a viewer who may see it (decision 7).
- **`context=edit`** is `rest_forbidden_context` (401 / 403), checked after the 404, so it never confirms a hidden item (decision 6). Revisions are not routed.
- **List parameters are capped** at `MAX_LIST_PARAMETER` (100) values each, `400 rest_invalid_param` past it, before any id is decoded (`SEC-INPUT-003`). WordPress core sets no such cap; the cap keeps an over-long `exclude` from decoding to an all-none batch that would exclude nothing.
- **Caching** (`CACHE-AUTH-005`). `Cache-Control: public` only for an anonymous viewer when every item, embeds included, is its binding's `serveable`; otherwise `private, no-store`.
- **Batched reads** (`PERF-DB-001`). One response is one node `encode`, one author `encode` (plus one profile read with `_embed`), one `render`, and one `getMany` per related type, however many items it carries. `orderby=include` reads the whole `include` list (at most 100 items) and orders it in memory.

| Export | What it is |
| --- | --- |
| `defineWordPress(config)`, `WordPressConfig`, `WordPressApi`, `WordPressRequest`, `WordPressResponse` | The API, its declaration, and one request and response. |
| `bind(binding)`, `PostTypeBinding`, `BoundPostType`, `ShownItem` | One leaf bound to a post type: its gated operations (`get`, `getMany`, `list`, `owners`), view columns, field mapper and serveability. |
| `bindTaxonomy(binding)`, `TaxonomyBinding`, `BoundTaxonomy`, `ShownTerm`, `TermFields`, `TermColumns`, `AssignmentEnd`, `Taxonomy` | One term leaf and its assignment edge family bound to a taxonomy (`category`, `post_tag`): the leaf's gated operations, the family's `list` / `memberFilter` / `countBy`, its two ends, and the mappers. |
| `PostFields`, `MediaFields`, `PostColumns` | What a binding reads off its resource, and the view columns its parameters filter and sort by. |
| `fileMediaFields(file, blobs, described)` | An attachment's `MediaFields` from a `./blobs` file version ([pulpit#221](https://github.com/thomasfosterau/pulpit/issues/221)). |
| `RenderRequest`, `Author`, `AuthorSeam`, `Site` | The render seam's request, the author seam and its profile, and the site. |
| `PostType`, `PostStatus`, `MAX_LIST_PARAMETER` | The served post types, the statuses, and the list-parameter cap (100). |

## `./http`

`wordPressHttp(api)` is the API as an `effect/http` handler, `Effect<HttpServerResponse, never, HttpServerRequest | R>`: it reads the method, path and query pairs from the request URL and answers a JSON response (an empty one for `HEAD`) with the API's status and headers. Mount it on the application's router under the prefix.

## `./testing`

In-memory fakes of the adapter's seams, for tests, mirroring the kernel's [`@thomasfosterau/pulpit/testing`](../pulpit/README.md#testing). Each implements its seam's contract under [Seams](#seams) and records its calls, so a test can pin how many reads a request made. **Not for production**; the subpath isn't on the root export.

| Export | Fakes | Test hooks |
| --- | --- | --- |
| `makeInMemoryIdCodec(nodeIds?)`, `InMemoryIdCodec` | [`IdCodec`](#idcodece-r-node-ids-to-wordpress-integers), minting 1, 2, … in assignment order, as a `bigserial` does. | `assign(nodeId)` (mint or look up), `encodeCalls()` / `decodeCalls()` (every batch, in call order). |

## Seams

The adapter is written against interfaces the application fills. Besides the codec below: each **post-type binding** is a kernel leaf's `defineSubtype` operations (`get`, `getMany`, `list`, so the kernel's gates hold), the view columns its parameters read (`slug`, `date`, `modified`, and optionally `id`, `title`, `author`, `parent`, `menuOrder`, `draft`, `visibility`, `mimeType`, `mediaType`), a `fields` mapper from its resource to `PostFields`, and a `serveable` predicate (typically the kernel's `serveablePolicy`); each **taxonomy binding** is a term leaf's `defineSubtype` operations (`get`, `getMany`, `list`), its view columns (`name`, `slug`, optionally `id` and `parent`), the assignment family's `defineEdgeOps` operations (`list`, `memberFilter`, `nonMemberFilter`, `countBy`, so `EDGE-001` holds), the family's `post` and `term` ends (each an alias and an edge column), and mappers from the term to `TermFields` and from an edge to its item and term ids; **`render`** turns a response's `title` / `content` / `excerpt` / `caption` / `description` values into HTML in one batch, in order (resolving a `documentRef` hash through the kernel's `DocumentStore.getMany`, say); the **author seam** is an account id mode (`integerIds` over an account codec, typically) and a batched profile read. Each states the shape its implementation must have; [`./testing`](#testing) has an in-memory fake of each, which implements the contract stated here.

### `IdCodec<E, R>`: node ids to WordPress integers

Filled by the application; pulpit never mints or stores the integer, and no library is expected to provide one.

```ts
interface IdCodec<E, R> {
  readonly encode: (
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, number>, E, R>;
  readonly decode: (
    integers: ReadonlyArray<number>,
  ) => Effect.Effect<HashMap.HashMap<number, string>, E, R>;
}
```

- **Suggested storage (the application's concern).** A `bigserial` column beside the node identity table (`core.node.wp_id bigserial UNIQUE`, or a table of its own keyed by node id), so each node gets an integer once, at insert. `encode` is one `id = ANY($nodeIds)` read and `decode` one `wp_id = ANY($integers)` read, each returning the rows found as a `HashMap` keyed by its input. A driver that reads `int8` / `bigint` as a string (node-postgres and postgres.js do by default) must convert it with `Number` before keying the `decode` map, and in the `encode` map's values: a `HashMap` keyed by `"42"` has no entry for `42`, so every id silently decodes to none and every request 404s. A `bigint` above `Number.MAX_SAFE_INTEGER` can't be served; `encode` fails `UnencodableNodeId` for it.
- **Method contract.** Each method is one read for the whole batch. An id the codec doesn't know is absent from the map, never a failure; `E` is the codec's own failure (its query error) and `R` its requirements. It applies no policy: the adapter encodes only nodes the read gate has let through, and passes every decoded id through the gate. `integerIds` hands it only non-empty, deduplicated batches, and `decode` only positive safe integers.
- **Stability.** A node's integer never changes and is never reused, and it is unique across every node type the adapter serves (WordPress clients cache by id, and `/posts/{id}` and `/pages/{id}` share one id space).
- **What it discloses.** A sequence reveals creation order and roughly how many nodes exist, to anyone holding two readable ids. An application for which that matters can fill the codec from a non-sequential integer instead, or serve `stringIds`.

## License

MIT
