# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; they apply to agents too. This file holds only what is agent-specific. Each package's `AGENTS.md` states its boundary and invariants: read it before changing that package.

## Process

- You may open PRs in this repository and keep the body current. Never merge, version or publish.
- Out-of-scope work you spot: file an issue here and move on.
- Use the GitHub MCP tools or `gh` (with `-R thomasfosterau/pulpit` when the cwd may be another checkout). Write only to this repository.
- The issue is the spec; re-verify its claims against current `trunk` before editing.

## Pitfalls

- Use Effect idioms and Effect's own modules over hand-rolled code; the exceptions are in docs/CONTRIBUTING.md.
- The website and gardeneria applications' copies are the behavioural spec and test corpus, not code to transplant: port the tests, target the idiomatic Effect shape.
- An invariant ID in a comment (`VERSION-CHAIN-006`, `CACHE-AUTH-005`) is defined in [docs/SECURITY.md](docs/SECURITY.md#invariant-ids); grep for it to find every site that honours it, and add a row when you cite a new one.
- `vp run -r docgen` executes every `@example`; a missing `@since` fails it.
- There is no root `CLAUDE.md`; `.claude/CLAUDE.md` imports this file.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

No `CONTEXT.md` or `docs/adr/`: the module guides in `docs/`, SECURITY.md's invariant IDs and each export's TSDoc are the domain docs. See `docs/agents/domain.md`.

## Pull requests

- **Write the PR body with the `pr` skill** from Matt Pocock's skills (`mattpocock-skills:pr`), filling in the repository's pull request template where there is one.
- **Resolve merge conflicts before you hand a PR over.** Rebase onto `origin/trunk` and push; a PR that conflicts with `trunk` isn't finished.
- **Mark the PR ready for review as soon as the initial draft is finished.** Don't wait for CI to run, for reviews, or for the owner to do it. Keep fixing CI failures and review findings on the ready PR.

## Fallow

The pre-commit hook runs `vp run fallow:audit` and blocks on findings your change introduces; fix them rather than skipping the hook.

`vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved under `permissions` in `pnpm-workspace.yaml`); drizzle-kit's `drizzle` skill is linked the same way.
