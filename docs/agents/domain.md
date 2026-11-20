# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. The layout is **single-context**: the workspace's packages share one domain, since the optional packages are adapters over the kernel's seams rather than separate bounded contexts.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/README.md`** and the module guide for the area (`docs/<module>.md`): the cross-cutting rules and trade-offs. Invariant IDs are defined in [`docs/SECURITY.md`](../SECURITY.md#invariant-ids).

If `CONTEXT.md` or `docs/adr/` don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-append-only-version-chain.md
│   │   └── 0002-seams-before-dependencies.md
│   └── <module guides>
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids. The kernel names no application type (see [CONTRIBUTING.md](../CONTRIBUTING.md#coding-guidelines)), so `page`, `post` and `album` are leaves, not kernel terms.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (append-only version chain), but worth reopening because…_
