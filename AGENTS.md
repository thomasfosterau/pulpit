# AGENTS.md

`CLAUDE.md` is a symlink to this file.

`@thomasfosterau/pulpit` is the kernel of a general-purpose headless CMS (versioned content of any shape, user-generated content, pages, media, social interactions, site structure and discovery), extracted from two applications, `thomasfosterau/website` (the foundation) and `thomasfosterau/gardeneria` (the newer, multi-tenant copy), as scoped by the epics pulpit#1 (the kernel) and pulpit#212 (the content systems the apps still build by hand) and the decisions on website#2015. Those apps, with in-the-dark and preferenceflow, are its consumers. Its toolchain (pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow) is copied from them via `thomasfosterau/effect-drizzle-ext` and `thomasfosterau/effect-jsonapi`, so the library builds against exactly what they run. It is a two-package workspace: `packages/pulpit` is the published kernel, `packages/pulpit-wordpress` (`@thomasfosterau/pulpit-wordpress`) is one optional protocol adapter over it, a WordPress-compatible read API (pulpit#86; `"private": true` until the owner sets up its publishing), and `tests/dist-consumer` is a private declaration check of both. The adapter peers on the kernel and the kernel never imports the adapter. Every later optional package (a document grammar, a UI package; see pulpit#212) follows the same layering: its own boundary, peering on the kernel, which stays `effect` + `effect-jsonapi` only.

## Common pitfalls

- **The app copies are the behavioural spec and the test corpus, not code to transplant.** Target the idiomatic Effect shape (`effect/http`, `HttpApi`, `Layer`, `Schema`, `Schema.TaggedError`); port the tests, not the files. Where website and gardeneria have diverged, gardeneria is the reference unless an issue says otherwise.
- **A `#NNN` citation inside a ported comment names an issue in the app it was ported from** (gardeneria unless stated): the evidence behind a decision, not a ticket in this tracker. An ID such as `VERSION-CHAIN-006` or `CACHE-AUTH-005` is a grep handle carried over from the apps' (deleted) specs; the rule it names is stated in [SECURITY.md → Invariant IDs](SECURITY.md#invariant-ids). Grep for it to find every site that honours it, and add a row there when you cite a new one.
- **No application vocabulary.** A general CMS needs this more, not less: `page`, `post`, `album` and `menu` are leaves an application binds, and the kernel ships capabilities and recipes, never those types. No app tree (the registry's _flags_ are generic; its entries are the app's), no id brands beyond what an app injects, no Hyperdrive, no migrations tooling.
- **Every external version lives in `pnpm-workspace.yaml`** (`catalogMode: strict` rejects anything else in a `package.json`). After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`; a stale lockfile fails CI with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
- **Lockstep sets move together.** `.github/dependabot.yml` groups them (the toolchain: vite-plus / vitest / oxlint / `@effect/tsgo` / the TypeScript 6/7 pair / the Effect lint plugin; `effect` + `@effect/*`; docgen + `tsx`; `@changesets/*`; `fallow` alone, checked against the hand-maintained gate below). A toolchain PR that fails `pnpm install` needs the `@effect/tsgo` whose components table covers the new oxlint / tsgolint / TypeScript, chosen by hand on that branch. The security floors under `overrides` in `pnpm-workspace.yaml` are by-hand too: Dependabot does not bump them, and each comes out once its parents' ranges carry the fix.
- **Node and pnpm only.** No bun, deno, npm or yarn: no other lockfile, no `npx` / `npm run` / `yarn` / `bun` in scripts, workflows, hooks or docs (`pnpm audit` and `pnpm publish` are pnpm's own).

The kernel's own invariants, terms and import boundary, including the seams-before-dependencies rule, are in [`packages/pulpit/CLAUDE.md`](packages/pulpit/CLAUDE.md), and the adapter's boundary in [`packages/pulpit-wordpress/CLAUDE.md`](packages/pulpit-wordpress/CLAUDE.md); they are not restated here.

## Conventions

- **Optional fields are `?: T | undefined`, never bare `?: T`.** The workspace compiles with `exactOptionalPropertyTypes`, under which a bare `?:` rejects a caller forwarding its own `undefined`.
- **Relative imports carry their `.ts` extension** (`rewriteRelativeImportExtensions` in `tsconfig.base.json`).
- **Tests import from `vite-plus/test`**, never `vitest`. `tests/<module>.test.ts` mirrors the module it covers; `tests/*.types.ts` holds compile-time assertions, type-checked by `vp run check` and never executed.
- **Every export has a TSDoc summary** that says what it is for, before any tag; an operation's doc names its error channel and any invariant ID it honours. Every export and every module header (`src/index.ts` aside) also carries `@since <version>`, the release it first ships in: `vp run -r docgen` fails on a missing one.
- **`vp run -r docgen` executes your `@example`s.** `@effect/docgen` (4.x) compiles each JSDoc `@example` under `src/` with the native `tsc` (`examplesCompilerOptions`) and, because each package's `docgen.json` sets `"runExamples": true` (4.x only type-checks without it), then runs it under `tsx`. So an example is a complete program: it imports everything it uses, the package itself by its name (`@thomasfosterau/pulpit`, or `@thomasfosterau/pulpit-wordpress`) exactly as a consumer would, uses no `declare const` (nothing to run), and must not throw. Docgen rewrites no imports: the examples are written under the package's `docs/examples/`, inside the package, so the name resolves through the package's own `exports`, which point at `src/`. Docgen injects nothing either: an assertion is the cheapest way to show a result, and you import the function by name (`import { strictEqual } from "node:assert";`). Docgen parses `src/` with `ts-morph` (`parseCompilerOptions` in `docgen.json`). `src/index.ts` is excluded there, so keep its docs free of code samples.
- **Tagged errors are `Schema.TaggedError<Self>()(tag, fields)`** (see Effect below).

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and, through `prepare`, the Effect-patched `tsc` / `oxlint`. There is no pre-push hook.
- `vp check` — format + lint (Oxfmt + Oxlint). `vp run check` — the type gate: each package's `check` (which also type-checks its `tests/**/*.types.ts`) plus the dist-consumer declaration check, which builds both packages' `dist/` and asserts the emitted types. They are different commands. The root `check` task in `vite.config.ts` lists each package's `check` by name, so a new package must be added there.
- `vp run -r test:unit` — unit tests (pure code; no database), in every package.
- `vp run test:coverage` — every package's unit suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores (`health.coverage` in `.fallowrc.json`). Without it fallow scores every function as uncovered, and any function with cyclomatic complexity ≥ 5 fails the gate on its own. It enforces no thresholds.
- `vp run -r test:coverage` — the coverage gate: each package's suite under its own thresholds (90 / 85 / 90 / 90 for statements / branches / functions / lines, `vite.package.ts`), plus the root's merged map above. Never lower a threshold to pass it; add the tests.
- `vp run -r build` — emit each package's `dist/`.
- `vp run -r docgen` — build, then type-check and execute every JSDoc `@example` and generate the API docs under each package's `docs/` (gitignored).
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
7. `vp run -r test:coverage`, then `fallow audit --base origin/trunk`

Steps 1–6 are what CI runs (`.github/workflows/ci.yml`), and CI runs step 7's `vp run -r test:coverage` too, after the unit tests, so each package's coverage thresholds are enforced (pulpit#119, pulpit#166); step 7's `fallow audit` is the fallow gate the PreToolUse hook also runs on commit and push. The hook reads the merged coverage map on disk and never refreshes it, so run `vp run -r test:coverage` (or `vp run test:coverage`, the map alone) first. For CI parity from a clean tree, first run `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`: a warm tree hides a peer that a dependency requires but a package's `package.json` does not declare (declare it under `peerDependencies` via `catalog:peers`, or `workspace:^` for the kernel).

## Branches and pull requests

- Branch off `trunk` (name it `issue-<n>-<slug>` for issue work); PR against `trunk`; squash-merge with a conventional-commit prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges, so don't use it).
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch. Start every command that targets a worktree with an explicit `cd`, and confirm with `git log -1` before committing.
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`); docs-, CI- and tooling-only changes need none. The packages version independently; a private package (`pulpit-wordpress`, for now) takes none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it (see [PUBLISHING.md](PUBLISHING.md)).
- These are standing approvals, overriding any default "don't open a PR unless asked": **open a PR** against `trunk` once a commit is pushed; **watch it to merge or close**, investigating CI failures and review comments as they arrive and rebasing promptly when it goes conflicting; **keep the PR body current** as the implementation diverges from it.
- GitHub writes go to `thomasfosterau/pulpit` only; pass `-R thomasfosterau/pulpit` whenever the cwd might be another checkout. Never write to the consuming applications' repositories, the library repositories beneath this one or any other repository without the owner's explicit approval for that action in the current session; if another repository needs something, say so in the PR body. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. pulpit#1 is the epic and its sub-issues are the slices. Adoption by each application is tracked in that application's own tracker (website#2022, gardeneria#1267), blocked on a release of this package.
- The issue is the spec: read its comments; later comments override the body. The epic's decisions (pulpit#1, website#2015) override anything older. Re-verify code claims against current `trunk`, and against the current app copies, before editing.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, or when a slice reaches the point where an unpublished dependency is needed, comment the evidence on the issue and stop.
- Scope cut mid-PR becomes a linked issue before merge.

## Effect

Never guess at an Effect API: read the installed package. `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` are the pinned release's own guides, `node_modules/effect/dist/*.d.ts` its signatures and `node_modules/effect/src` its source. The pinned version is the `effect` entry in `pnpm-workspace.yaml`. It spells the tagged-error constructor `Schema.TaggedError<Self>()(tag, fields)`; `Schema.TaggedErrorClass`, which older guides show, does not exist in it. HTTP modules are `effect/http/*`; there are no `effect/unstable/*` paths.

## Agent sessions

`.claude/hooks/session-start.sh` (SessionStart) installs dependencies against the lockfile with pnpm (through corepack when available), puts `vp` (a re-exec shim), `fallow` and `tsx` (docgen's example runner) on PATH for non-interactive shells, and repairs a broken bare `node`. It hydrates no secrets, and none are needed: every gate above runs offline. A PostToolUse hook runs `vp fmt <file> --write` after every Write / Edit, and a PreToolUse hook (`.claude/hooks/fallow-gate.sh`) runs `fallow audit --base origin/trunk` on every `git commit` / `git push` and blocks on a `fail` verdict. A worktree needs its own `pnpm install` before `vp` resolves the worktree's own vitest.

## Documentation surfaces

- `README.md` — the landing page.
- `packages/pulpit/README.md` — the API reference consumers read on npm, including the seams' expected shapes.
- `packages/pulpit/CLAUDE.md` — the kernel's boundary, invariants and terms.
- `packages/pulpit-wordpress/README.md` and `CLAUDE.md` — the same two for the WordPress adapter.
- `CONTRIBUTING.md` — setup, hooks and CI for humans; the gate list is [Verification](#verification) above.
- `PUBLISHING.md` — the release pipeline and one-time owner setup. `SECURITY.md` — reporting, supply-chain posture and the invariant-ID table.
- Decisions go in issue comments. There is no `docs/` tree.

---

## Fallow local gate

This block, the task map below and `.claude/hooks/fallow-gate.sh` are hand-maintained: do not regenerate them with `fallow setup-hooks`, `fallow hooks install --target agent` or `fallow agent install`. Checked against fallow 3.31.0: every form of these that targets Claude Code (the default auto-detection here, `--agent claude` or `--harness claude`) rewrites `.claude/hooks/fallow-gate.sh` without `--force`, dropping `--base origin/trunk` from its audit and this hook's header note; only the Codex-only forms (`--agent codex`, `--harness codex`) leave the hook alone. This block carries no `<!-- fallow:… -->` markers, so every form except `--agent claude` also appends a second, marked block to this file instead of replacing this one, and that block's commands omit `--base`. `fallow agent install` with Claude Code also appends `@AGENTS.md` to `CLAUDE.md`, which is a symlink to this file, so AGENTS.md would import itself.

Before any `git commit` or `git push`, run `vp run test:coverage` (the audit reads `coverage/coverage-final.json`), then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk`. The PreToolUse hook `.claude/hooks/fallow-gate.sh` runs this same audit on every `git commit` / `git push` and blocks the command on a `fail` verdict, so running it first just surfaces the findings sooner. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base origin/trunk` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
