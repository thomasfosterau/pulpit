# Contributing

A pnpm workspace: the kernel (`packages/pulpit`), its optional packages (`packages/pulpit-drizzle-pg`, `packages/pulpit-wordpress`, private until published) and `tests/dist-consumer`, which type-checks consumer fixtures against every package's emitted declarations. Each package's `AGENTS.md` states its boundary and invariants.

## Workflow

- Branch off `trunk` and open a pull request into `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Never commit to `trunk` directly.
- Open a draft PR as soon as you start, so others can see the work.
- Keep a change in one PR, however large.
- Rebase onto `origin/trunk` rather than merging it in.
- Found something out of scope? File an issue and move on. Keep issue bodies evergreen: edit the body with context, findings and the chosen fix rather than appending comments.
- Dependabot updates dependencies. Update one by hand only when your change needs it, or for the steps Dependabot can't do ([below](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node, pnpm and the tools; use it rather than `npx` or bare `pnpm`. `vp install` installs dependencies and the git hooks (pre-commit runs `vp staged`, then `vp run fallow:audit`), and its `prepare` step patches the native `tsc` and oxlint with `@effect/tsgo`.

| Command | What it does |
| --- | --- |
| `vp check` | Format and lint (type-aware). `--fix` applies fixes. |
| `vp run check` | The type gate: every package's `tsc` (including `tests/**/*.types.ts`) and the dist-consumer check against built `dist/`. A new package's `check` must be added to the root task in `vite.config.ts`. |
| `vp run -r test:unit` | Every package's unit tests. `vp test run tests/x.test.ts` from inside a package runs one file. |
| `vp run -r test:coverage` | The suites under each package's coverage thresholds (`vite.package.ts`); never lower one to pass. |
| `vp run -r build` | Every package's `dist/`. |
| `vp run -r docgen` | Type-checks and runs every JSDoc `@example`; output under each package's gitignored `docs/`. |
| `vp run --filter ./packages/pulpit-drizzle-pg test:integration` | The PostgreSQL suite: set the `PG*` variables (it builds its own database) or `DATABASE_URL_TEST`. |
| `vp run fallow:audit` | Fallow's change-set audit, after `test:coverage` writes the map it reads. |
| `vp run ci` | Everything CI runs, in order, stopping at the first failure (needs the PostgreSQL above). |

[Fallow](https://docs.fallow.tools) checks dead code, duplication, complexity and the package boundaries (`.fallowrc.json`, `fallow-rules.json`). `vp run fallow:audit` (which runs `test:coverage` first, for the CRAP scores) audits your change against `origin/trunk`; the pre-commit hook runs it and blocks on a failing verdict. Its findings are guidance, not dogma, and CI doesn't run it.

## Coding guidelines

- **Effect.** Use Effect v4 idioms throughout. Strongly prefer Effect's own modules (`Array`, `Option`, `Schema`, `Match`, `Clock`, …) over hand-rolled equivalents, and convert existing code where practical. Exceptions: non-Effect third-party APIs (adapt them at the edge) and measured hot paths. Read the installed `effect` (`node_modules/effect/dist/*.d.ts`, its `AGENTS.md` and `ai-docs/`) rather than guessing at an API. HTTP is `effect/http/*`; tagged errors are `Schema.TaggedError<Self>()(tag, fields)`.
- **Absence.** A field or return that may be absent is `Option.Option<T>`, never `T | null`. An options-bag member is `readonly x?: T`; an optional parameter is `x?: T`; neither takes `| undefined`. Keep `x?: Option.Option<T>` only where `none` is itself a value callers forward. Wire contracts (WordPress shapes, JSON:API tri-state input) keep their native forms.
- **Imports.** Effect modules as namespaces under the canonical aliases (`Arr`, `P`, `R`, `Str`, `Eq`, `Bool`; the rest by module name). Relative imports carry `.ts`.
- **Exports.** Effect v4's layout: `index.ts` exports each module as a PascalCase namespace (`export * as VersionChain from "./version-chain.ts"`), and each module is also importable on its own subpath, which follows the same PascalCase name (`./VersionChain`). The kernel's subpaths are still lowercase capability names; new modules follow the existing pattern until they move.
- **No application vocabulary.** `page`, `post` and `album` are leaves an application binds; the kernel ships capabilities and recipes. Seams come before dependencies: persistence, transports and models are behind ports the application fills.
- **Lints.** Fix findings in code. A rule is relaxed only in `vite.config.ts`, scoped to the files it can't apply to, with the reason.
- **Comments.** A file comment only for non-obvious context, under 50 words. TSDoc where it helps a consumer in their editor: what an export is for, its error channel and the invariant IDs it honours ([SECURITY.md](SECURITY.md#invariant-ids)); don't restate the signature. Every export and module header carries `@since <version>`, and every `@example` is a complete program that docgen runs (import the package by name, no `declare const`, must not throw). Inline comments only for what the code can't say. Never cite issues, PRs or CI runs; stable external documentation links are fine.
- **Tests** live in each package's `tests/`, mirroring the module they cover, and import from `vite-plus/test`. `tests/*.types.ts` hold compile-time assertions. Test logic that can break; don't test what the type system or a lint already checks.

## Before pushing

Run `vp run ci` (CI runs exactly that, on Node LTS and latest, with a PostgreSQL service), then the fallow audit (the pre-commit hook does). If a gate can't run where you are, say which and why in the PR body. `uvx zizmor --offline .github` audits the workflows; actions are pinned by exact tag and locked to commits by `.github/workflows/actions.lock` (run `gh actions-lock` after changing a `uses:`).

## Dependencies

Every external version lives in the `pnpm-workspace.yaml` catalog (`catalogMode: strict`); after editing it, run `vp install` and commit `pnpm-lock.yaml`. Dependabot groups the sets that must move together. By hand, on the matching PR:

- The npm aliases `vite` (equal to `vite-plus`), `typescript` and `@typescript/native`, and the devcontainer image tag (equal to `vite-plus`).
- An `@effect/tsgo` whose `components` table covers the new oxlint and `@typescript/native`; `@vitest/coverage-istanbul` equal to vite-plus's `vitest`.
- `catalogs.peers`. The published `effect` peer is `^4.0.0` unless a dependency needs more (today effect-auth needs `^4.1.0`); name the reason in the catalog comment.

## Changesets

Every change to a published package's behaviour, or to a doc comment that reaches its `.d.ts`, needs a changeset (`pnpm changeset`) naming each package it changes. Docs-, CI- and tooling-only changes need none, and private packages take none. Never version or publish by hand: the Release workflow opens the `chore: version packages` PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
