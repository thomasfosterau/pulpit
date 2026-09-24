# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

## Branch model

`main` plus short-lived feature branches, PR against `main`, squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/main` before opening a PR; never merge `main` into a feature branch (GitHub's "Update branch" button does a merge — avoid it).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job: `vp check` (format + lint), `vp run check` (the package's type gate — including the `tests/**/*.types.ts` type-level tests — plus the dist-consumer declaration check, which builds `dist/`), `vp run -r test:unit`, `vp run -r build`, `pnpm audit --audit-level high`. [release.yml](.github/workflows/release.yml) runs changesets/action on `main`: it opens the version PR while unreleased changesets exist and publishes the package once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)). [effect-canary.yml](.github/workflows/effect-canary.yml) floats the workspace onto `effect@rc` weekly and files an issue when the gates go red.

## Pre-PR checklist

1. `vp fmt` / `vp lint`
2. `vp run check`
3. `vp run -r test:unit`
4. `vp run -r build`
5. `fallow audit --base origin/main`
6. A changeset (`pnpm changeset`) for every change to the published package.
7. `git fetch origin main && git rebase origin/main`
8. Docs: `packages/pulpit/README.md` for any exported change; `packages/pulpit/CLAUDE.md` for a new term, invariant or seam.

## Running individual checks

```sh
vp lint                                    # oxlint
vp fmt                                     # oxlint --fix && oxfmt
vp run check                               # the whole type gate (includes building dist/)
vp run --filter ./packages/pulpit check    # the package's type check alone
vp run -r test:unit                        # unit tests
vp test run tests/some.test.ts             # single file (from inside the package)
vp run -r build                            # emit dist/
vp run fallow:audit                        # change-set review (not a CI gate)
```
