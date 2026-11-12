# @thomasfosterau/pulpit-drizzle-pg

The tree-bound seams of [`@thomasfosterau/pulpit`](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit/README.md) over the tables and views [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext) derives from an application's tree, on PostgreSQL through `@thomasfosterau/effect-drizzle-ext-pg`. An application declares its versioned ontology once with `defineTree`, derives its tables with `makeTreeTables`, and gets the kernel's ports for every leaf from this package.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

**Not published.** The package is `"private": true`, at version `0.0.0`, until the owner sets up its publishing ([PUBLISHING.md → Adding `pulpit-drizzle-pg`](https://github.com/thomasfosterau/pulpit/blob/trunk/PUBLISHING.md#adding-pulpit-drizzle-pg-to-the-release-flow)). The spec is [pulpit#247](https://github.com/thomasfosterau/pulpit/issues/247); what has landed, and what is next, is in [docs/drizzle-pg.md → Status](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#status).

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-drizzle-pg @thomasfosterau/pulpit \
  @thomasfosterau/effect-drizzle-ext @thomasfosterau/effect-drizzle-ext-pg \
  drizzle-orm @effect/sql-pg effect
```

`@thomasfosterau/pulpit`, `@thomasfosterau/effect-drizzle-ext` (`>=0.2.0`), `@thomasfosterau/effect-drizzle-ext-pg` (`>=0.2.0`), `drizzle-orm` (`>=1.0.0-rc.5`) and `effect` are required peer dependencies, and so are their own peers (`@effect/sql-pg` for `-pg`; the kernel's). Node.js 22.18 or newer is required (effect-drizzle-ext's floor).

## Example

One tree, its ports, and the kernel's leaf operations over them. `makePublications`' `@example` is the complete, runnable program (docgen type-checks and runs it); [docs/drizzle-pg.md → End to end](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#end-to-end) covers the ungated and localised variants.

```ts
const tables = makeTreeTables(tree, { schema: core, builders, root: { pointers: ["live"] } });
const views = makeTreeViews(tree, tables, { schema: core, pointers: { live: ["post"] } });
const owners = makeNodeOwnerTable({ schema: core, identity: tables.root.identity });

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const gated = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  owners,
  CurrentTransaction,
});

const posts = defineSubtype({
  type: "post",
  access: ownedAccess({ draft: true }),
  chain: chains.post,
  leaves: gated.post.leaves,
  publication: { live: gated.post.live, facts: gated.post.facts },
  viewer,
  policy,
  followers,
  toResource,
});
// Every operation needs `CurrentTransaction`: run it inside the application's `transact`.
```

## Entry points

Every module is a namespace on the root export (`import { VersionChain } from "@thomasfosterau/pulpit-drizzle-pg"`) and a subpath of its own.

| Subpath | Contents |
| --- | --- |
| [`./version-chain`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#version-chain) | `makeVersionChains`: the kernel's `VersionChain` port for every leaf of a tree. |
| [`./leaf-store`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#leaf-store) | `makeLeafStores`: the kernel's `LeafStore` for every leaf view of a tree; `makeNodeOwnerTable`, the owner table. |
| [`./publication`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#publication) | `makePublications`: the live pointer (`PublicationStore`, `LiveView`, the gated store) for every leaf of a pointer. |
| [`./documents`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#documents) | `makeDocumentTable` / `makeDocumentStore`: the kernel's content-addressed `DocumentStore`, one table per family. |
| [`./paths`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#paths) | `makePathTable` / `makePathStore`: the kernel's `PathStore`, one table per routable namespace. |
| [`./proposals`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#proposals) | `makeProposalTable` / `makeProposalStore`: the kernel's `ProposalStore` (suggested edits) over one proposal table. |
| [`./embeddings`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#embeddings) | `makeEmbeddingTables` / `makeEmbeddingStore`: the kernel's `EmbeddingStore`, a queue and a vector table per document family. |
| [`./search`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#search) | `makeSearchBranch` / `fullTextRank`: the kernel's `SearchBranch`, one ranked and scoped statement over a view. |
| [`./edges`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#edges) | `makeEdgeTable` / `makeEdgeStore`: the kernel's `EdgeStore`, one table per edge family, its ends joined to the tree's views. |
| [`./collections`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#collections) | `makeCollectionTable` / `makeCollectionStore`: the kernel's `CollectionStore`, one membership table per ordered family. |
| [`./external-ids`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#external-ids) | `makeExternalIdTable` / `makeExternalIdStore`: the kernel's `ExternalIdStore`, an authority's identifiers linked to nodes. |
| [`./social`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#social) | `makeRelationshipTable` / `makeSocialStore`: the kernel's `SocialStore`, follows, mutes and blocks over one relationship table. |
| [`./filter`](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md#filter) | `renderListFilter` / `renderListOrder`: the kernel's `ListFilter` and list order as Drizzle SQL. |

## Links

- [docs/drizzle-pg.md](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/drizzle-pg.md): the module guide, each module's tables, statements and guarantees.
- The API reference is each export's TSDoc.
- The kernel: [`@thomasfosterau/pulpit`](https://github.com/thomasfosterau/pulpit/blob/trunk/packages/pulpit/README.md), and the [seams](https://github.com/thomasfosterau/pulpit/blob/trunk/docs/seams.md) this package fills.
- [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext), which derives the tables and views.

## License

MIT
