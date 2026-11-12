# AGENTS.md

Guidance for any coding agent working in this repository. Claude Code reads it through [`.claude/CLAUDE.md`](.claude/CLAUDE.md), which imports it with [CONTRIBUTING.md](CONTRIBUTING.md) and [README.md](README.md) and adds what is specific to Claude Code sessions (the hooks, the plugins, worktrees). What the repository is, its packages and its toolchain are in [README.md](README.md); setup, commands, branches, pull requests and changesets are in [CONTRIBUTING.md](CONTRIBUTING.md). Neither is restated here.

## Common pitfalls

- **The app copies are the behavioural spec and the test corpus, not code to transplant.** Target the idiomatic Effect shape (`effect/http`, `HttpApi`, `Layer`, `Schema`, `Schema.TaggedError`); port the tests, not the files. Where website and gardeneria have diverged, gardeneria is the reference unless an issue says otherwise.
- **A `#NNN` citation inside a ported comment names an issue in the app it was ported from** (gardeneria unless stated): the evidence behind a decision, not a ticket in this tracker. An ID such as `VERSION-CHAIN-006` or `CACHE-AUTH-005` is a grep handle carried over from the apps' (deleted) specs; the rule it names is stated in [SECURITY.md → Invariant IDs](SECURITY.md#invariant-ids). Grep for it to find every site that honours it, and add a row there when you cite a new one.
- **No application vocabulary.** A general CMS needs this more, not less: `page`, `post`, `album` and `menu` are leaves an application binds, and the kernel ships capabilities and recipes, never those types. No app tree (the registry's _flags_ are generic; its entries are the app's), no id brands beyond what an app injects, no Hyperdrive, no migrations tooling.
- **Every external version lives in `pnpm-workspace.yaml`** (`catalogMode: strict` rejects anything else in a `package.json`). After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`; a stale lockfile fails CI with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
- **Lockstep sets move together.** `.github/dependabot.yml` groups only them (the toolchain: vite-plus / vitest / oxlint / `@effect/tsgo` / the TypeScript 6/7 pair; `effect` + `@effect/*`, `@effect/docgen` included); everything else, the Effect lint plugin `@enfect/oxlint`, `tsx` and `fallow` included, gets its own PR, and a `fallow` bump is checked against the hand-maintained gate below. A toolchain PR that fails `pnpm install` needs the `@effect/tsgo` whose components table covers the new oxlint / tsgolint / TypeScript, chosen by hand on that branch. The npm-alias catalog entries (`vite`, always the `vite-plus` version; `typescript` and `@typescript/native`) are by-hand moves on that branch, since Dependabot cannot bump an alias. The security floors under `overrides` in `pnpm-workspace.yaml` are by-hand too: Dependabot does not bump them, and each comes out once its parents' ranges carry the fix.
- **Node and pnpm only.** No bun, deno, npm or yarn: no other lockfile, no `npx` / `npm run` / `yarn` / `bun` in scripts, workflows, hooks or docs (`pnpm audit` and `pnpm publish` are pnpm's own).

The kernel's own invariants, terms and import boundary, including the seams-before-dependencies rule, are in [`packages/pulpit/AGENTS.md`](packages/pulpit/AGENTS.md), and the adapter's boundary in [`packages/pulpit-wordpress/AGENTS.md`](packages/pulpit-wordpress/AGENTS.md); they are not restated here.

## Conventions

- **An optional property is `readonly x?: Option.Option<T>`, and a `T | null` is `Option.Option<T>`** (pulpit#238). An absent property means `Option.none()`, and every reader reads it so (`x ?? Option.none()`); a caller forwards its own absence as `Option.none()` (`Option.fromNullishOr` from a nullable value), never as `undefined`. No `| undefined` beside the `Option`: `effect/prefer-option-over-null` (at `error`) reports every union with `undefined` or `null`, and under `exactOptionalPropertyTypes` the bare `?:` already refuses an explicit `undefined`. A flag that is literal `true` or absent is `?: true`. The only exceptions are genuine can't-applies, each a scoped override in `vite.config.ts` with its reason beside it: driver or Drizzle config that reads `undefined`, and a documented wire contract (`pulpit-wordpress`'s WordPress shapes, a JSON:API attribute's tri-state input, where `null` clears). Surfaces #238 has not converted yet still spell `?: T | undefined` behind a disable comment: convert them, never copy them.
- **Effect modules are namespace imports under `@enfect/oxlint`'s canonical aliases** (`effect/prefer-namespace-imports`, at the preset's `error`; owner decision 2026-11-11, family-wide): `import * as Arr from "effect/Array"`, `P` for `effect/Predicate`, `R` for `effect/Record`, `Str` for `effect/String`, `Eq` for `effect/Equal`, `Bool` for `effect/Boolean`; every other module keeps its own name (`import * as Option from "effect/Option"`, `Schema`, `Effect`, …). Never a named import from those modules or from `effect`'s barrel. The rule has no autofix. `R` shares its name with the requirements type parameter most signatures carry, so inside such a generic use the built-in `Record<K, V>` / `Readonly<…>` in type positions rather than `R.ReadonlyRecord`.
- **Relative imports carry their `.ts` extension** (`rewriteRelativeImportExtensions` in `tsconfig.base.json`).
- **Tests import from `vite-plus/test`**, never `vitest`. `tests/<module>.test.ts` mirrors the module it covers; `tests/*.types.ts` holds compile-time assertions, type-checked by `vp run check` and never executed.
- **Every export has a TSDoc summary** that says what it is for, before any tag; an operation's doc names its error channel and any invariant ID it honours. Every export and every module header (`src/index.ts` aside) also carries `@since <version>`, the release it first ships in: `vp run -r docgen` fails on a missing one.
- **`vp run -r docgen` executes your `@example`s.** `@effect/docgen` (4.x) compiles each JSDoc `@example` under `src/` with the native `tsc` (`examplesCompilerOptions`) and, because each package's `docgen.json` sets `"runExamples": true` (4.x only type-checks without it), then runs it under `tsx`. So an example is a complete program: it imports everything it uses, the package itself by its name (`@thomasfosterau/pulpit`, or `@thomasfosterau/pulpit-wordpress`) exactly as a consumer would, uses no `declare const` (nothing to run), and must not throw. Docgen rewrites no imports: the examples are written under the package's `docs/examples/`, inside the package, so the name resolves through the package's own `exports`, which point at `src/`. Docgen injects nothing either: an assertion is the cheapest way to show a result, and you import the function by name (`import { strictEqual } from "node:assert";`). Docgen parses `src/` with `ts-morph` (`parseCompilerOptions` in `docgen.json`). `src/index.ts` is excluded there, so keep its docs free of code samples.
- **Tagged errors are `Schema.TaggedError<Self>()(tag, fields)`** (see Effect below).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran. None needs a credential, a database or Docker.

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `vp run -r docgen`
6. `pnpm audit --audit-level high`
7. `vp run -r test:coverage`, then `vp exec fallow audit --base origin/trunk`

Steps 1–6 are what CI runs, and CI runs step 7's `vp run -r test:coverage` too, after the unit tests, so each package's coverage thresholds are enforced (pulpit#119, pulpit#166); CI's posture is in [CONTRIBUTING.md → CI](CONTRIBUTING.md#ci). Step 7's `fallow audit` reads the merged coverage map on disk (`coverage/coverage-final.json`) and never refreshes it, so run `vp run -r test:coverage` (or `vp run test:coverage`, the map alone) first. Each command is described in [CONTRIBUTING.md → Commands](CONTRIBUTING.md#commands). For CI parity from a clean tree, first run `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`: a warm tree hides a peer that a dependency requires but a package's `package.json` does not declare (declare it under `peerDependencies` via `catalog:peers`, or `workspace:^` for the kernel).

## Pull requests (agents)

Branches, rebasing, squash-merging and changesets are in [CONTRIBUTING.md → Branches and pull requests](CONTRIBUTING.md#branches-and-pull-requests). For an agent, additionally:

- These are standing approvals, overriding any default "don't open a PR unless asked": **open a PR** against `trunk` once a commit is pushed; **watch it to merge or close**, investigating CI failures and review comments as they arrive and rebasing promptly when it goes conflicting; **keep the PR body current** as the implementation diverges from it. Never merge it yourself, and never publish or version by hand.
- GitHub writes go to `thomasfosterau/pulpit` only. Never write to the consuming applications' repositories, the library repositories beneath this one or any other repository without the owner's explicit approval for that action in the current session; if another repository needs something, say so in the PR body.

## Work tracker

- Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. pulpit#1 is the epic and its sub-issues are the slices. Adoption by each application is tracked in that application's own tracker (website#2022, gardeneria#1267), blocked on a release of this package.
- The issue is the spec: read its comments; later comments override the body. The epic's decisions (pulpit#1, website#2015) override anything older. Re-verify code claims against current `trunk`, and against the current app copies, before editing.
- Record decisions and findings as issue comments.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, or when a slice reaches the point where an unpublished dependency is needed, comment the evidence on the issue and stop.
- Scope cut mid-PR becomes a linked issue before merge.

## Effect

Never guess at an Effect API: read the installed package. `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` are the pinned release's own guides, `node_modules/effect/dist/*.d.ts` its signatures and `node_modules/effect/src` its source. The pinned version is the `effect` entry in `pnpm-workspace.yaml`. The published `effect` peer (`catalogs.peers`) is `^4.0.0`; raise it only when a dependency requires a newer one, naming the dependency in the catalog comment, and prove a floor by running the gates with the pin set to it. The pin spells the tagged-error constructor `Schema.TaggedError<Self>()(tag, fields)`; `Schema.TaggedErrorClass`, which older guides show, does not exist in it. HTTP modules are `effect/http/*`; there are no `effect/unstable/*` paths.

## Documentation surfaces

- `README.md` — the landing page: what the repository is, its packages and its toolchain.
- `packages/pulpit/README.md` — the API reference consumers read on npm, including the seams' expected shapes.
- `packages/pulpit/AGENTS.md` — the kernel's boundary, invariants and terms (its `CLAUDE.md` imports it).
- `packages/pulpit-wordpress/README.md` and `AGENTS.md` — the same two for the WordPress adapter.
- `CONTRIBUTING.md` — setup, commands, git hooks, CI, branches, pull requests and changesets; the gate list is [Verification](#verification) above.
- `AGENTS.md` (this file) — agent conventions, pitfalls, the gates and the work tracker. `.claude/CLAUDE.md` — Claude Code's memory: its hooks, plugins and session notes, importing this file, `CONTRIBUTING.md` and `README.md`.
- `PUBLISHING.md` — the release pipeline and one-time owner setup. `SECURITY.md` — reporting, supply-chain posture and the invariant-ID table.
- Decisions go in issue comments. There is no `docs/` tree.

---

## Fallow local gate

This block, the task map below and `.claude/hooks/fallow-gate.sh` are hand-maintained: do not regenerate them with `fallow setup-hooks`, `fallow hooks install --target agent` or `fallow agent install`. Checked against fallow 3.31.0: every form of these that targets Claude Code (the default auto-detection here, `--agent claude` or `--harness claude`) rewrites `.claude/hooks/fallow-gate.sh` without `--force`, dropping `--base origin/trunk` from its audit and this hook's header note; only the Codex-only forms (`--agent codex`, `--harness codex`) leave the hook alone. This block carries no `<!-- fallow:… -->` markers, so every form except `--agent claude` also appends a second, marked block to this file instead of replacing this one, and that block's commands omit `--base`. `fallow agent install` with Claude Code also appends `@AGENTS.md` to a root `CLAUDE.md`, creating one. There is deliberately no root `CLAUDE.md`: Claude Code's memory is `.claude/CLAUDE.md`, which already imports this file, so a root one would load AGENTS.md twice. Delete it if a tool creates it.

Before any `git commit` or `git push`, run `vp run test:coverage` (the audit reads `coverage/coverage-final.json`), then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk`. In Claude Code sessions a PreToolUse hook (`.claude/hooks/fallow-gate.sh`, see `.claude/CLAUDE.md`) runs this same audit on every `git commit` / `git push` and blocks the command on a `fail` verdict, so running it first just surfaces the findings sooner. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base origin/trunk` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
