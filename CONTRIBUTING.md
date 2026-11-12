# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. This file is the one place for setup, commands, branches, pull requests and changesets. The conventions, pitfalls and the gates to run before a PR are in [AGENTS.md](AGENTS.md), which applies to humans too; Claude Code's own session notes are in [.claude/CLAUDE.md](.claude/CLAUDE.md).

## Setup

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

`pnpm install` installs dependencies, the Vite+ git hooks and, through the root `prepare` script, the Effect-patched `tsc` / `oxlint`. CI installs as `pnpm install --frozen-lockfile`.

## Commands

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`).

- `vp check` — format + lint (Oxfmt + Oxlint: `@enfect/oxlint`'s `recommended` Effect rules, `@effect/tsgo`'s preset, and oxlint's `correctness`, `suspicious` and `perf` categories over the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins; a rule is relaxed only in `vite.config.ts`, with its reason). Lint is type-aware through oxlint-tsgolint (`typeAware` + `typeCheck`). `vp lint` and `vp fmt` run one half.
- `vp run check` — the type gate: each package's `check` (which also type-checks its `tests/**/*.types.ts`) plus the dist-consumer declaration check, which builds every package's `dist/` and asserts the emitted types. It is a different command from `vp check`. The root `check` task in `vite.config.ts` lists each package's `check` by name, so a new package must be added there. `vp run --filter ./packages/pulpit check` (or `./packages/pulpit-wordpress`, `./packages/pulpit-drizzle-pg`) runs one package's alone.
- `vp run -r test:unit` — unit tests (pure code; no database), in every package. `vp test run tests/some.test.ts` runs one file, from inside the package.
- `vp run test:coverage` — every package's unit suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores (`health.coverage` in `.fallowrc.json`). Without it fallow scores every function as uncovered, and any function with cyclomatic complexity ≥ 5 fails the gate on its own. It enforces no thresholds.
- `vp run -r test:coverage` — the coverage gate: each package's suite under its own thresholds (90 / 85 / 90 / 90 for statements / branches / functions / lines, `vite.package.ts`), plus the root's merged map above. Never lower a threshold to pass it; add the tests.
- `vp run --filter ./packages/pulpit-drizzle-pg test:integration` — pulpit-drizzle-pg's integration suite against a real PostgreSQL (not a gate; it needs a database). Point the `PG*` variables at a server (it creates its own database there), set `DATABASE_URL_TEST` to an already-migrated one, or have Docker for a Testcontainers fallback; see [packages/pulpit-drizzle-pg/AGENTS.md → Tests](packages/pulpit-drizzle-pg/AGENTS.md#tests). CI runs it in its own job.
- `vp run -r build` — emit each package's `dist/`.
- `vp run -r docgen` — build, then type-check and execute every JSDoc `@example` and generate the API docs under each package's `docs/` (gitignored).
- `vp exec fallow audit --base origin/trunk` — the fallow gate over your change set (not a CI gate; see [AGENTS.md → Fallow local gate](AGENTS.md#fallow-local-gate)).
- `pnpm changeset` — add a changeset (see below).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged`: `vp check --fix --no-lint` (format, with fixes), then `vp check --no-fmt` (lint, without fixes, so no type-aware autofix lands in a commit unverified). There is no pre-push hook.

## CI

[ci.yml](.github/workflows/ci.yml) runs steps 1–6 of the gates in [AGENTS.md → Verification](AGENTS.md#verification) in one job, plus step 7's `vp run -r test:coverage` (not `fallow audit`), which fails when any package drops below its coverage thresholds. CI holds a read-only token and no secret or OIDC (so Dependabot PRs run it safely), pins every action to a commit SHA, never persists checkout credentials outside the Release job, sets up Vite+, Node (`lts`, never `latest`, which can be a pre-release) and pnpm with `voidzero-dev/setup-vp` (pulpit#280; the Release workflow keeps its own setup), and the Release job never runs for Dependabot; `uvx zizmor --offline .github` audits the workflows (`.github/zizmor.yml`). [auto-assign.yml](.github/workflows/auto-assign.yml) assigns the owner to every pull request opened without an assignee (Dependabot's are assigned through `.github/dependabot.yml`). [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes each package with a new version once it merges, via npm trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Branches and pull requests

- Branch off `trunk` (name it `issue-<n>-<slug>` for issue work); PR against `trunk`; squash-merge with a conventional-commit prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges, so don't use it).
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`), naming each package it changes; docs-, CI- and tooling-only changes need none. The packages version independently; a private package (`pulpit-wordpress` and `pulpit-drizzle-pg`, for now) takes none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it (see [PUBLISHING.md](PUBLISHING.md)).
- The PR body follows [the template](.github/pull_request_template.md), quoting each gate's result.

## Pre-PR checklist

1. Run the gates in [AGENTS.md → Verification](AGENTS.md#verification), in order.
2. A changeset for every change to a published package's behaviour.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the package's `README.md` (`packages/pulpit/`, `packages/pulpit-wordpress/` or `packages/pulpit-drizzle-pg/`) for any exported change or new seam; its `AGENTS.md` for a new term, invariant or boundary rule; `SECURITY.md` → Invariant IDs for a newly cited ID.
