# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; they apply to agents too. This file holds only what is agent-specific. Each package's `AGENTS.md` states its boundary and invariants: read it before changing that package.

## Process

- You may open PRs in this repository (draft first, ready once the gates pass) and keep the body current. Never merge, version or publish.
- Out-of-scope work you spot: file an issue here and move on.
- Use the GitHub MCP tools or `gh` (with `-R thomasfosterau/pulpit` when the cwd may be another checkout). Write only to this repository.
- The issue is the spec; re-verify its claims against current `trunk` before editing.

## Pitfalls

- Use Effect idioms and Effect's own modules over hand-rolled code; the exceptions are in docs/CONTRIBUTING.md.
- The website and gardeneria applications' copies are the behavioural spec and test corpus, not code to transplant: port the tests, target the idiomatic Effect shape.
- An invariant ID in a comment (`VERSION-CHAIN-006`, `CACHE-AUTH-005`) is defined in [docs/SECURITY.md](docs/SECURITY.md#invariant-ids); grep for it to find every site that honours it, and add a row when you cite a new one.
- `vp run -r docgen` executes every `@example`; a missing `@since` fails it.
- There is no root `CLAUDE.md`; `.claude/CLAUDE.md` imports this file.

## Fallow

Before committing, run `vp run test:coverage` (the audit reads its map), then `vp exec fallow audit --base origin/trunk`, and fix findings your change introduces. In Claude Code a PreToolUse hook runs the same audit on `git commit` / `git push` and blocks on `fail`.
