# packages/pulpit-wordpress — `@thomasfosterau/pulpit-wordpress`

A WordPress-compatible (`wp/v2`), read-only REST API over the kernel's chains: the read API (`./Api`), its `effect/http` adapter (`./Http`), the `IdCodec` seam (`./Ids`) and its fakes (`./testing`). `src/internal/wire.ts` holds WordPress's wire vocabulary. Private until published ([docs/PUBLISHING.md](../../docs/PUBLISHING.md)).

## Boundary

- Import only `effect` and `@thomasfosterau/pulpit` (peers). Never Drizzle, a framework, an HTML renderer or `node:*`: rendering is an app-filled `render` seam, integer ids an app-filled `IdCodec`.
- Import the kernel by name through its exports only, in `tests/` as in `src/`; never by a relative path into `packages/pulpit`. The fallow rule `pulpit/adapter-imports-kernel-by-name` matches the raw specifier and misses a dynamic `import()` or a non-normalised path: don't write those. The `.fallowrc.json` zones keep the kernel's `src/internal/` and `tests/` out of reach; the kernel's fakes are `@thomasfosterau/pulpit/testing`.
- Reuse the kernel's read gates (`SubtypeOps`, `EdgeOps`); never re-spell them. Something missing is a kernel change, not a copy here.
- **Ids decode before the read gate and encode after it** (`SEC-AUTH-ENUM-001`): a wire id that decodes to nothing answers `404`, exactly as a hidden row. Encode once per response, never per item (`PERF-DB-001`).
- `./testing` mirrors the kernel's: the reference semantics of each seam in [docs/wordpress.md](../../docs/wordpress.md#seams), off the root barrel. Change a seam's contract and its fake together.
- `post`, `page`, `attachment`, `category` and `tag` are WordPress's protocol vocabulary; the application binds its own leaves to them.

## In-repo wiring

It peers on the kernel as `workspace:^`, which publishes as `^<kernel version>`: before 1.0 a kernel minor leaves that range, and Changesets gives this package a patch with the new range. Its `check` is in the root `check` task, and `tests/dist-consumer/src/wordpress.ts` type-checks its declarations.
