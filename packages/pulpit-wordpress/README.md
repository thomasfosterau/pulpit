# @thomasfosterau/pulpit-wordpress

A WordPress-compatible (`wp/v2`), read-only REST API over the chains of [`@thomasfosterau/pulpit`](../pulpit/README.md), so a headless WordPress frontend (one written against the WordPress REST API, such as `@wordpress/api-fetch` or a hand-rolled `fetch('/wp-json/wp/v2/posts?slug=…')`) can read posts, pages, media, terms and authors from a pulpit application unchanged.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published, and empty.** This is the package's scaffold ([pulpit#115](https://github.com/thomasfosterau/pulpit/issues/115)): it is `"private": true` and exports nothing. The API is specified on [pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86) (the spec draft and the owner's decisions of 2026-10-15) and lands in phases:

- **Phase 1:** posts, pages and media (list and get), the discovery index, `_links`, `_embed`, `_fields`, the headers and the errors. It waits for the kernel's list ordering ([pulpit#112](https://github.com/thomasfosterau/pulpit/issues/112)) and filter arms ([pulpit#113](https://github.com/thomasfosterau/pulpit/issues/113)), and for the `IdCodec` seam ([pulpit#114](https://github.com/thomasfosterau/pulpit/issues/114)), which lives in this package.
- **Phase 2:** categories, tags and `/users`.
- **Phase 3:** each later kernel slice as it lands.

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-wordpress @thomasfosterau/pulpit effect
```

`@thomasfosterau/pulpit` and `effect` are required peer dependencies, and so are the kernel's own peers. Node.js 22 or newer is required.

## License

MIT
