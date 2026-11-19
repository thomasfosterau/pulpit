# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file holds only what is specific to Claude Code.

- **Hooks** (`.claude/settings.json`): a PostToolUse hook runs `vp fmt --write` on each edited file. The fallow audit runs in the git pre-commit hook, not here.
- **Worktrees** go under `.claude/worktrees/`, one per branch; run `vp install` in a new one. The shell's cwd resets between calls, so `cd` explicitly.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
