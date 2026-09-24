# AGENTS.md

Project conventions live here; personal style preferences live in user memory. `CLAUDE.md` is a symlink to this file.

`@thomasfosterau/pulpit` is the versioned-content (CMS) kernel extracted from two applications — `thomasfosterau/website` (the foundation) and `thomasfosterau/gardeneria` (the newer, multi-tenant copy) — as scoped by the epic pulpit#1 and the decisions on website#2015. Those apps are the consumers, and their toolchain — pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow — is copied here (via `thomasfosterau/effect-drizzle-ext` and `thomasfosterau/effect-jsonapi`, the library template) so the library builds against exactly what they run.

## Standing invariants

- **The app copies are the behavioural spec and the test corpus, not code to transplant.** Target the idiomatic Effect shape (`effect/unstable/http`, `HttpApi`, `Layer`, `Schema`, `Schema.TaggedError`); port the tests, not the files. Where website and gardeneria have diverged, gardeneria is the reference unless an issue says otherwise.
- **A `#NNN` citation inside a ported comment names an issue in the app it was ported from** (gardeneria unless stated) — the evidence behind a decision, not a ticket in this tracker. An ID such as `PUB-009`, `VERSION-CHAIN-006`, `SEC-AUTH-ENUM-001` or `CACHE-AUTH-005` is the stable handle for an invariant written up in that app; grep for it here to find every site that honours it.
- **The version chain is append-only.** Every write lands at `N_max + 1`; no existing version row is ever rewritten, deleted or reordered (`VERSION-CHAIN-001/002`). A restore is a new version whose content came from history.
- **Nothing owned-private is ever served from the KV read-through cache** (`CACHE-AUTH-005`). The serveability policy in `./publication` is the one place that rule is spelled; every axis it checks is one the operation layer gates on.
- **A hidden row is `NotFound`, never `Forbidden`** (`SEC-AUTH-ENUM-001`): a 403 would confirm the row exists.
- **Update inputs are tri-state**: a value sets, `null` clears a nullable column, `undefined` carries forward. Declare it on the `Resource.make` descriptor; never spell `input.x ?? null`.
- **Seams before dependencies.** Slices 3–5 are written against explicit seam interfaces (the version-chain store, the read scope, the handlers config, the `serveable` hook) because the packages that will fill them — effect-drizzle-ext, effect-jsonapi#172's server skeleton, effect-auth#221's read scope, effect-web#4's cache — are not published. Never vendor code from an unpublished package; document the seam's expected shape in `packages/pulpit/CLAUDE.md` and stop where a real dependency is needed.
- **No application vocabulary.** No app tree (the registry's _flags_ are generic; its entries are the app's), no id brands beyond what an app injects, no Hyperdrive, no migrations tooling.

Everything else that must be visible when touching the package is in `packages/pulpit/CLAUDE.md`, which carries its terms, invariants, seams and import boundary.

## Work tracker

- **Active work** lives in GitHub Issues for `thomasfosterau/pulpit`; pulpit#1 is the epic and its sub-issues are the slices. Longer-running tech debt is an issue too; there is no in-repo backlog file and a code comment is not a tracker.
- **Decisions and findings** are recorded as comments on the issue they were found working; later comments override the body.
- **Adoption** by each application is tracked in that application's own tracker (website#2022, gardeneria#1267), blocked on a release of this package.

## Commands

- `vp install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files). No pre-push hook: run the tests yourself.
- `vp check` — the built-in format + lint pass (`vp fmt --check` + `vp lint`).
- `vp run check` — the type gate: the package's `check` (which also type-checks the `tests/**/*.types.ts` type-level slot) plus the dist-consumer declaration check (which builds `dist/` and asserts the emitted types). Distinct from `vp check`.
- `vp run -r test:unit` — unit tests (pure code; no database).
- `vp run -r build` — emit `dist/`.
- `pnpm changeset` — add a changeset; every change to the published package needs one. Releases are cut by the `Release` workflow (changesets/action) on `main`; the owner merges the "Version Packages" PR. Never run the release yourself.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). CI installs as `pnpm install --frozen-lockfile`.

## Branch model

`main` plus short-lived feature branches, PR against `main`, squash-merge. Rebase onto `origin/main` before opening a PR; never merge `main` into a feature branch. Agent work uses git worktrees under `.claude/worktrees/`, one per branch; start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing.

## Working a dispatched issue

- The issue is the spec: read all of it, including comments. The epic's decisions (pulpit#1, website#2015) override anything older.
- Re-verify the code claims against current `main` — and against the current app copies — before editing.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, or when a slice reaches the point where an unpublished dependency is needed, comment the evidence on the issue and stop.
- No silent deferrals: scope cut mid-PR becomes a linked issue before merge.

## PR management

These are standing instructions and approvals; they override any default "don't open a PR unless asked" behaviour.

- **Always open a PR** for branch work, against `main`, once a commit is pushed.
- **Always watch the PR to merge or close**: investigate CI failures and review comments as they arrive; rebase promptly when the PR goes conflicting.
- **Always keep the PR body current** as the implementation diverges from it.
- **GitHub writes are scoped to `thomasfosterau/pulpit` only.** Never write to the consuming applications' repositories, the library repositories beneath this one, or any other repository without the owner's explicit approval for that action in the current session. If another repository needs something, say so in the PR body. Pass `-R thomasfosterau/pulpit` explicitly whenever the cwd might not be this checkout.

## Verification

- Claims of verification name the command and its final status. If a gate cannot run, say so in the PR body rather than implying it ran.
- The pre-push parity run is: `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`, then `vp check`, `vp run check`, `vp run -r test:unit`, `vp run -r build`.
- Peers are declared explicitly: a required peer of a dependency must be a declared dependency or CI fails on a fresh runner while a warm local tree passes.

## Effect best practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code: `vp exec effect-solutions list`, then `vp exec effect-solutions show <topic>...` (data-modeling, services-and-layers, error-handling, testing, basics). Never guess at Effect patterns. Note that the installed `effect` prerelease spells the tagged-error constructor `Schema.TaggedError<Self>()(tag, fields)` (the guide's `Schema.TaggedErrorClass` is the newer name); check `node_modules/effect/dist/Schema.d.ts` before assuming either.

## Documentation surfaces

`README.md` at the root is the landing page; `packages/pulpit/README.md` is the API reference consumers read on npm; `packages/pulpit/CLAUDE.md` carries its terms, invariants, seams and boundary; `CONTRIBUTING.md` carries the pre-PR checklist; `PUBLISHING.md` and `SECURITY.md` carry the release pipeline and its posture. No `docs/` tree; decisions go in issue comments.

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
