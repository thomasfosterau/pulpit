# pulpit docs

The cross-cutting prose behind the packages: each module's guide (how its exports fit together, the rules that span them, the trade-offs), every seam's expected shape and SQL sketch, and the adapters' wiring. Each export's own contract, error channel and the invariant IDs it honours are in its TSDoc, which `vp run -r docgen` renders under each package's `docs/` (gitignored); the package READMEs hold only what a package is, its install, one example and its entry points. The invariant IDs cited throughout are defined, with their rationale, in [SECURITY.md → Invariant IDs](SECURITY.md#invariant-ids).

## The kernel, `@thomasfosterau/pulpit`

| Page | Modules | What it covers |
| --- | --- | --- |
| [Content model](content-model.md) | `./Content`, `./Registry`, `./Documents`, `./Filter` | The Content-axis field spreads, the registry flags and checks, content-addressed documents, and `ListFilter` with the contract a SQL renderer must honour. |
| [Read model](read-model.md) | `./Subtype`, `./Publication`, `./Cache` | The read gates and who sees what, list order and `sortable`, the gated version history, the head version on the wire, search scope and hydration, the live pointer, localisation, lifecycle hooks, serveability and the resource cache. |
| [History and review](history-and-review.md) | `./VersionChain`, `./WorkingCopy`, `./Proposals`, `./Moderation` | The append-only chain, optimistic concurrency and compare, autosave, suggested edits and moderation. |
| [Structure and routing](structure.md) | `./Edges`, `./Paths`, `./Pages`, `./Collections`, `./Links`, `./Relations` | Edges and what a write discloses, taxonomies, paths and aliases, the page recipe, collections, link lists and the UGC relation patterns. |
| [Participation](participation.md) | `./Comments`, `./Reactions`, `./Budgets`, `./Social`, `./Audience`, `./Notifications`, `./Translation`, `./ReferenceImport` | Comments, reactions, write budgets, the social graph, audiences, notifications, translation lineage and reference import. |
| [Media](media.md) | `./Blobs`, `./Media` | File leaves over the byte store, the upload pipeline, renditions and albums. |
| [Discovery and search](discovery-and-search.md) | `./Search`, `./Discovery` | Hybrid search, the embedding pipeline, the discovery feed and sitemaps. |
| [Erasure](erasure.md) | `./Purge`, `./Erasure` | Purging a node's history, and account erasure. |
| [Seams](seams.md) | every seam, and `./testing` | The shape each seam's real implementation must have (with its SQL sketch) and which package fills it, and the in-memory fakes that are each seam's reference semantics. |

## The optional packages

| Page | Package | What it covers |
| --- | --- | --- |
| [WordPress adapter](wordpress.md) | `@thomasfosterau/pulpit-wordpress` | Status, the id modes, the `wp/v2` read API, the `effect/http` handler, its fakes and the `IdCodec` seam. |
| [Drizzle / PostgreSQL seams](drizzle-pg.md) | `@thomasfosterau/pulpit-drizzle-pg` | Status, an end-to-end wiring, and each tree-bound seam's tables, statements and guarantees. |

## The repository

A pnpm workspace with three packages: `packages/pulpit` (the published kernel), `packages/pulpit-wordpress` (the WordPress adapter) and `packages/pulpit-drizzle-pg` (the Drizzle / PostgreSQL seams), the last two `"private": true` until the owner sets up their publishing, plus `tests/dist-consumer`, a private check of every package's emitted declarations. Each optional package peers on the kernel and the kernel never imports one; every later optional package follows the same layering.

The kernel is extracted from two applications, `thomasfosterau/website` (the foundation) and `thomasfosterau/gardeneria` (the newer, multi-tenant copy). Those applications, with in-the-dark and preferenceflow, are its consumers. Its toolchain (pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow) is copied from them via `thomasfosterau/effect-drizzle-ext` and `thomasfosterau/effect-jsonapi`, so the library builds against exactly what they run.
