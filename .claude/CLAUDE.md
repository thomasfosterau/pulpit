# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file holds only what is specific to Claude Code.

- **Hooks** (`.claude/settings.json`): a PreToolUse hook runs `vp exec fallow audit --base origin/trunk` from the project directory on every `git commit` / `git push` and blocks on a `fail` verdict; run `vp run test:coverage` first so it reads a current coverage map. A PostToolUse hook runs `vp fmt --write` on each edited file.
- **Plugins**: `typescript-lsp`, `code-review`, `github`, `claude-md-management`, `commit-commands`, `pr-review-toolkit`, `code-simplifier`.
- **Worktrees** go under `.claude/worktrees/`, one per branch; run `vp install` in a new one. The shell's cwd resets between calls, so `cd` explicitly.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
