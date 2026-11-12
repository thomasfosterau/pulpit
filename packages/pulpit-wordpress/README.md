# @thomasfosterau/pulpit-wordpress

A WordPress-compatible (`wp/v2`), read-only REST API over the chains of [`@thomasfosterau/pulpit`](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit/README.md), so a headless WordPress frontend (one written against the WordPress REST API, such as `@wordpress/api-fetch` or a hand-rolled `fetch('/wp-json/wp/v2/posts?slug=…')`) can read posts, pages, media, terms and authors from a pulpit application unchanged.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

**Not published.** The package is `"private": true` ([pulpit#115](https://github.com/thomasfosterau/pulpit/issues/115)). The API is specified on [pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86) and lands in phases; what has landed is in [docs/wordpress.md → Status](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#status).

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-wordpress @thomasfosterau/pulpit effect
```

`@thomasfosterau/pulpit` and `effect` are required peer dependencies, and so are the kernel's own peers. Node.js 22 or newer is required.

## Example

Bind the application's leaves to WordPress's post types and mount the API on `effect/http`. The operations, mappers and seams named here are the application's; [`./api`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#api) walks through each, taxonomies and authors included.

```ts
import { bind, defineWordPress } from "@thomasfosterau/pulpit-wordpress/api";
import { wordPressHttp } from "@thomasfosterau/pulpit-wordpress/http";
import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";

const wp = defineWordPress({
  site: {
    url: "https://example.org",
    name: "Example",
    description: "",
    timezone: "Australia/Sydney",
  },
  ids: integerIds(nodeCodec), // the application's IdCodec
  viewer, // the request's viewer, as the leaves read it
  policy, // the application's role axes
  render: (requests) => renderHtml(requests), // one batch per response, in order
  link: (type, fields) => `https://example.org/${fields.slug}`,
  types: {
    post: bind({
      ops: postOps, // the leaf's defineSubtype operations, so the kernel's read gates hold
      columns: { slug: "slug", date: "publishedAt", modified: "updatedAt" },
      fields: postFields,
      serveable,
    }),
  },
});

export const handler = wordPressHttp(wp); // GET /wp-json/wp/v2/posts?slug=…
```

## Entry points

Every module is a namespace on the root export (`import { Ids } from "@thomasfosterau/pulpit-wordpress"`) and a subpath of its own, except `./testing`, which is a subpath only, as in the kernel.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Ids`, `Api`, `Http`). |
| [`./api`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#api) | The `wp/v2` read API: `defineWordPress`, the post-type and taxonomy bindings (`bind`, `bindTaxonomy`) and the seams it reads (`render`, the author seam, the site). |
| [`./http`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#http) | `wordPressHttp(api)`, the read API as an `effect/http` request handler. |
| [`./ids`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#ids) | The `IdCodec` seam an application fills, the integer-id mode over it (`integerIds`) and the opt-in string-id mode (`stringIds`). |
| [`./testing`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#testing) | In-memory fakes of the adapter's seams (`makeInMemoryIdCodec`), for tests only. Not on the root export. |

## Links

- [docs/wordpress.md](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md): the module guide (the id modes, routes, parameters, `_embed`, `_fields`, headers and errors) and the [seams](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#seams) an application fills, with the `IdCodec`'s suggested storage.
- The API reference is each export's TSDoc.
- The kernel: [`@thomasfosterau/pulpit`](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit/README.md), and its [seams](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md).
- The spec and the owner's decisions: [pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86).

## License

MIT
