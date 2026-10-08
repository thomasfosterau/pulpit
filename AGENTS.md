# AGENTS.md

`CLAUDE.md` is a symlink to this file.

`@thomasfosterau/pulpit` is the versioned-content (CMS) kernel extracted from two applications, `thomasfosterau/website` (the foundation) and `thomasfosterau/gardeneria` (the newer, multi-tenant copy), as scoped by the epic pulpit#1 and the decisions on website#2015. Those apps are its consumers. Its toolchain (pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow) is copied from them via `thomasfosterau/effect-drizzle-ext` and `thomasfosterau/effect-jsonapi`, so the library builds against exactly what they run. It is a single-package workspace: `packages/pulpit` is the published package and `tests/dist-consumer` is a private declaration check.

## Common pitfalls

- **The app copies are the behavioural spec and the test corpus, not code to transplant.** Target the idiomatic Effect shape (`effect/http`, `HttpApi`, `Layer`, `Schema`, `Schema.TaggedError`); port the tests, not the files. Where website and gardeneria have diverged, gardeneria is the reference unless an issue says otherwise.
- **A `#NNN` citation inside a ported comment names an issue in the app it was ported from** (gardeneria unless stated): the evidence behind a decision, not a ticket in this tracker. An ID such as `VERSION-CHAIN-006` or `CACHE-AUTH-005` is a grep handle carried over from the apps' (deleted) specs; the rule it names is stated in [SECURITY.md → Invariant IDs](SECURITY.md#invariant-ids). Grep for it to find every site that honours it, and add a row there when you cite a new one.
- **No application vocabulary.** No app tree (the registry's _flags_ are generic; its entries are the app's), no id brands beyond what an app injects, no Hyperdrive, no migrations tooling.
- **Every external version lives in `pnpm-workspace.yaml`** (`catalogMode: strict` rejects anything else in a `package.json`). After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`; a stale lockfile fails CI with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

The kernel's own invariants, terms and import boundary, including the seams-before-dependencies rule, are in [`packages/pulpit/CLAUDE.md`](packages/pulpit/CLAUDE.md); they are not restated here.

## Conventions

- **Optional fields are `?: T | undefined`, never bare `?: T`.** The workspace compiles with `exactOptionalPropertyTypes`, under which a bare `?:` rejects a caller forwarding its own `undefined`.
- **Relative imports carry their `.ts` extension** (`rewriteRelativeImportExtensions` in `tsconfig.base.json`).
- **Tests import from `vite-plus/test`**, never `vitest`. `tests/<module>.test.ts` mirrors the module it covers; `tests/*.types.ts` holds compile-time assertions, type-checked by `vp run check` and never executed.
- **Every export has a TSDoc summary** that says what it is for, before any tag; an operation's doc names its error channel and any invariant ID it honours. Every export and every module header (`src/index.ts` aside) also carries `@since <version>`, the release it first ships in: `vp run -r docgen` fails on a missing one.
- **`vp run -r docgen` executes your `@example`s.** `@effect/docgen` compiles each JSDoc `@example` under `src/` with the native `tsc` and then runs it under `tsx`, so an example is a complete program: it imports everything it uses, the package itself by its name (`@thomasfosterau/pulpit`, which docgen rewrites to `src/`) exactly as a consumer would, uses no `declare const` (nothing to run), and must not throw. `assert.…` calls get `node:assert` imported for you, which makes an assertion the cheapest way to show a result. Docgen parses `src/` with the TypeScript 5.5 bundled in its own bin (`parseCompilerOptions` in `packages/pulpit/docgen.json`) and type-checks the examples with the native `tsc` (`examplesCompilerOptions`). `src/index.ts` is excluded there, so keep its docs free of code samples.
- **Tagged errors are `Schema.TaggedError<Self>()(tag, fields)`** (see Effect below).

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and, through `prepare`, the Effect-patched `tsc` / `oxlint`. There is no pre-push hook.
- `vp check` — format + lint (Oxfmt + Oxlint). `vp run check` — the type gate: the package's `check` (which also type-checks `tests/**/*.types.ts`) plus the dist-consumer declaration check, which builds `dist/` and asserts the emitted types. They are different commands.
- `vp run -r test:unit` — unit tests (pure code; no database).
- `vp run -r build` — emit `dist/`.
- `vp run -r docgen` — build, then type-check and execute every JSDoc `@example` and generate the API docs under `packages/pulpit/docs/` (gitignored).
- `fallow audit --base origin/trunk` — the fallow gate over your change set.
- `pnpm changeset` — add a changeset (see Branches and pull requests).

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). CI installs as `pnpm install --frozen-lockfile`.

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran. None needs a credential, a database or Docker.

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `vp run -r docgen`
6. `pnpm audit --audit-level high`
7. `fallow audit --base origin/trunk`

Steps 1–6 are what CI runs (`.github/workflows/ci.yml`); step 7 is the fallow gate the PreToolUse hook also runs on commit and push. For CI parity from a clean tree, first run `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`: a warm tree hides a peer that a dependency requires but `packages/pulpit/package.json` does not declare (declare it under `peerDependencies` via `catalog:peers`).

## Branches and pull requests

- Branch off `trunk` (name it `issue-<n>-<slug>` for issue work); PR against `trunk`; squash-merge with a conventional-commit prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges, so don't use it).
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch. Start every command that targets a worktree with an explicit `cd`, and confirm with `git log -1` before committing.
- Every change to the published package's behaviour carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it (see [PUBLISHING.md](PUBLISHING.md)).
- These are standing approvals, overriding any default "don't open a PR unless asked": **open a PR** against `trunk` once a commit is pushed; **watch it to merge or close**, investigating CI failures and review comments as they arrive and rebasing promptly when it goes conflicting; **keep the PR body current** as the implementation diverges from it.
- GitHub writes go to `thomasfosterau/pulpit` only; pass `-R thomasfosterau/pulpit` whenever the cwd might be another checkout. Never write to the consuming applications' repositories, the library repositories beneath this one or any other repository without the owner's explicit approval for that action in the current session; if another repository needs something, say so in the PR body. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. pulpit#1 is the epic and its sub-issues are the slices. Adoption by each application is tracked in that application's own tracker (website#2022, gardeneria#1267), blocked on a release of this package.
- The issue is the spec: read its comments; later comments override the body. The epic's decisions (pulpit#1, website#2015) override anything older. Re-verify code claims against current `trunk`, and against the current app copies, before editing.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, or when a slice reaches the point where an unpublished dependency is needed, comment the evidence on the issue and stop.
- Scope cut mid-PR becomes a linked issue before merge.

## Effect

Consult effect-solutions before writing Effect code (`vp exec effect-solutions list`, then `vp exec effect-solutions show <topic>…`); never guess at an Effect pattern. If a guide doesn't cover it, read `node_modules/effect/dist/*.d.ts`. The pinned version is the `effect` entry in `pnpm-workspace.yaml`. It spells the tagged-error constructor `Schema.TaggedError<Self>()(tag, fields)`; `Schema.TaggedErrorClass`, which older guides show, does not exist in it. HTTP modules are `effect/http/*`; there are no `effect/unstable/*` paths.

## Agent sessions

`.claude/hooks/session-start.sh` (SessionStart) installs dependencies against the lockfile, puts `vp` and `fallow` on PATH for non-interactive shells, and repairs a broken bare `node`. It hydrates no secrets, and none are needed: every gate above runs offline. A PostToolUse hook runs `vp fmt <file> --write` after every Write / Edit, and a PreToolUse hook (`.claude/hooks/fallow-gate.sh`) runs `fallow audit --base origin/trunk` on every `git commit` / `git push` and blocks on a `fail` verdict. A worktree needs its own `pnpm install` before `vp` resolves the worktree's own vitest.

## Documentation surfaces

- `README.md` — the landing page.
- `packages/pulpit/README.md` — the API reference consumers read on npm, including the seams' expected shapes.
- `packages/pulpit/CLAUDE.md` — the kernel's boundary, invariants and terms.
- `CONTRIBUTING.md` — setup, hooks and CI for humans; the gate list is [Verification](#verification) above.
- `PUBLISHING.md` — the release pipeline and one-time owner setup. `SECURITY.md` — reporting, supply-chain posture and the invariant-ID table.
- Decisions go in issue comments. There is no `docs/` tree.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
