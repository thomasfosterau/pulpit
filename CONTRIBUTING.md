# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions, the branch model and the pre-push gate list are in [AGENTS.md](AGENTS.md).

## Setup

`pnpm install` installs dependencies, the Vite+ git hooks and, through the root `prepare` script, the Effect-patched `tsc` / `oxlint`.

## Branch model

See [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs steps 1–6 of the gates in [AGENTS.md → Verification](AGENTS.md#verification) in one job. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes each package with a new version once it merges, via npm trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. Run the gates in [AGENTS.md → Verification](AGENTS.md#verification), in order.
2. A changeset (`pnpm changeset`) for every change to a published package's behaviour, naming each package it changes.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the package's `README.md` (`packages/pulpit/` or `packages/pulpit-wordpress/`) for any exported change or new seam; its `CLAUDE.md` for a new term, invariant or boundary rule; `SECURITY.md` → Invariant IDs for a newly cited ID.

## Running individual checks

```sh
vp lint                                    # lint (Oxlint)
vp fmt                                     # format (Oxfmt)
vp run check                               # the whole type gate (includes building dist/)
vp run --filter ./packages/pulpit check    # one package's type check alone (or ./packages/pulpit-wordpress)
vp run -r test:unit                        # unit tests
vp run test:coverage                       # every suite under one coverage map (fallow audit reads it)
vp test run tests/some.test.ts             # single file (from inside the package)
vp run -r build                            # emit dist/
vp run -r docgen                           # build, then type-check and run every JSDoc @example
fallow audit --base origin/trunk           # change-set review (not a CI gate)
```
