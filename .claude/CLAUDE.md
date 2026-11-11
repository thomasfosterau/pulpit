# Claude Code

Claude Code loads this file as the project's memory. It holds only what is specific to Claude Code sessions; the project's general guidance is imported at the end, from [AGENTS.md](../AGENTS.md) (agent conventions, pitfalls, the Verification gates, the work tracker), [CONTRIBUTING.md](../CONTRIBUTING.md) (setup, commands, branches, pull requests and changesets) and [README.md](../README.md) (what the repository is). Each package's own `CLAUDE.md` imports that package's `AGENTS.md` (its boundary, invariants and terms), which Claude Code loads when it reads a file there. There is no root `CLAUDE.md`: keep it that way, or the imports below load twice.

## Hooks (`.claude/settings.json`)

- **SessionStart** (`startup` / `resume`): `.claude/hooks/session-start.sh` installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), installs dependencies with `vp install --frozen-lockfile` (pnpm through corepack only when the global CLI is absent), and repairs a broken bare `node`. The global `vp` delegates to each checkout's own `vite-plus` (worktrees included); everything else goes through it: `vp exec fallow …` for fallow, `vpx <file>.ts` for scripts. Nothing else is put on PATH, and the hook removes the `fallow` / `tsx` links and the walking `vp` shim earlier versions made. `tsx` is installed only because `@effect/docgen` requires it as a peer and runs it itself; never invoke it directly. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets, and none are needed: the gates need no credential (the installer and `pnpm audit` need the network).
- **PreToolUse** (`Bash`): `.claude/hooks/fallow-gate.sh` runs `fallow audit --base origin/trunk` through `vp exec fallow` on every `git commit` / `git push` and blocks the command on a `fail` verdict (AGENTS.md → Fallow local gate). It reads the merged coverage map on disk and never refreshes it, so run `vp run -r test:coverage` (or `vp run test:coverage`, the map alone) first. It runs only in this checkout and its `.claude/worktrees/*`; anywhere else it runs none of that tree's tooling and skips the audit with a notice. CI doesn't run fallow, so this hook is the only place a fallow rule (the adapter's `pulpit/adapter-imports-kernel-by-name` included) is enforced.
- **PostToolUse** (`Write` / `Edit` / `MultiEdit`): `vp fmt <file> --write` on every edited `.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs` / `.css` / `.json` / `.md` file, so a file you just wrote may come back reformatted. Formatting a fenced `ts` block in Markdown can respace a `yield*` outside a generator to `yield * …`: write such snippets inside an `Effect.gen` body.

## Plugins

`.claude/settings.json` enables `typescript-lsp`, `code-review`, `github`, `claude-md-management`, `commit-commands`, `pr-review-toolkit` and `code-simplifier` (all `@claude-plugins-official`).

## Sessions

- **Worktrees.** Agent work uses git worktrees under `.claude/worktrees/`, one per branch. Start every command that targets a worktree with an explicit `cd`, and confirm with `git log -1` before committing. A worktree needs its own `vp install` before `vp` resolves the worktree's own vitest.
- **GitHub.** Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available, and pass `-R thomasfosterau/pulpit` whenever the cwd might be another checkout. In a cloud session GitHub's GraphQL API may be blocked: use `gh api` against the REST endpoints (`repos/thomasfosterau/pulpit/pulls`, `…/issues/<n>/comments`).
- **Every gate runs in a session.** None needs a credential, a database or Docker; if one can't run here, say which and why in the PR body (AGENTS.md → Verification).

## Imported guidance

@../AGENTS.md

@../CONTRIBUTING.md

@../README.md
