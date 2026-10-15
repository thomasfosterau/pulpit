# packages/pulpit-wordpress — `@thomasfosterau/pulpit-wordpress`

The WordPress-compatible (`wp/v2`), read-only REST API over the kernel's chains: the second package in this repo. It is a scaffold (pulpit#115), `"private": true` until the owner sets up its publishing ([PUBLISHING.md](../../PUBLISHING.md)). The spec, and the owner's decisions on it, are on pulpit#86; read them before adding code.

## Boundary

- **Import only `effect` and `@thomasfosterau/pulpit`, both peers.** Add `@thomasfosterau/effect-jsonapi` as a peer only if the adapter imports it itself. Never import Drizzle, a framework, an HTML renderer or `node:*`. Rendering a document to HTML is an app-filled `render` seam (pulpit#86, decision 3), and integer ids are an app-filled `IdCodec` seam (pulpit#114).
- **Import the kernel by its name and through its exports only** (`@thomasfosterau/pulpit`, `@thomasfosterau/pulpit/subtype`, …), never by a relative path into `packages/pulpit`. Its `src/internal/` and `tests/` are the `.fallowrc.json` zone `pulpit-internal`, which this package's zone may not import. A relative import of a public kernel module would also escape `tsconfig.build.json`'s `rootDir`, so `build` fails on it.
- **The kernel never imports this package.** The `pulpit` zone's only allowed target is `pulpit-internal`.
- **Reuse the kernel's read gates; never re-spell them.** Reads go through `SubtypeOps.get` / `getMany` / `list` and `EdgeOps.list`, so `SEC-AUTH-ENUM-001` and `EDGE-001` hold by construction. If the adapter needs something the kernel doesn't export, that is a kernel issue (as pulpit#112 and pulpit#113 are), not a copy here.
- **No application vocabulary.** `post`, `page`, `attachment`, `category` and `tag` are WordPress's protocol vocabulary; the application binds its own leaves to them.

## In-repo wiring

- It depends on the kernel as `workspace:*` (a devDependency) and peers on it as `workspace:^`, which `pnpm publish` rewrites to `^<the kernel's version>`. Before 1.0 that range excludes the kernel's next minor, so a kernel minor release gives this package a patch release with the new range (Changesets v3 bumps a dependent whose peer range the new version leaves).
- Its tasks are the kernel's, from the root `vite.package.ts`. Its `check` is in the root `check` task, and `tests/dist-consumer/src/wordpress.ts` type-checks its emitted declarations.
- `vp run -r docgen` runs here too. An `@example` imports the package by its name, `@thomasfosterau/pulpit-wordpress` (AGENTS.md → Conventions).
