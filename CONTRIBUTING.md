# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions, the branch model and the pre-push gate list are in [AGENTS.md](AGENTS.md).

## Setup

`pnpm install` installs dependencies, the Vite+ git hooks and, through the root `prepare` script, the Effect-patched `tsc` / `oxlint`.

## Branch model

See [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs steps 1–5 of the gates in [AGENTS.md → Verification](AGENTS.md#verification) in one job. [release.yml](.github/workflows/release.yml) runs changesets/action on `main`: it opens the version PR while unreleased changesets exist and publishes the package once it merges, via npm trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. Run the gates in [AGENTS.md → Verification](AGENTS.md#verification), in order.
2. A changeset (`pnpm changeset`) for every change to the published package's behaviour.
3. `git fetch origin main && git rebase origin/main`
4. Docs: `packages/pulpit/README.md` for any exported change or new seam; `packages/pulpit/CLAUDE.md` for a new term or invariant; `SECURITY.md` → Invariant IDs for a newly cited ID.

## Running individual checks

```sh
vp lint                                    # lint (Oxlint)
vp fmt                                     # format (Oxfmt)
vp run check                               # the whole type gate (includes building dist/)
vp run --filter ./packages/pulpit check    # the package's type check alone
vp run -r test:unit                        # unit tests
vp test run tests/some.test.ts             # single file (from inside the package)
vp run -r build                            # emit dist/
vp run fallow:audit                        # change-set review (not a CI gate)
```
