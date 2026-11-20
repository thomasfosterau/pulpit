# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This repo has **no `CONTEXT.md` and no `docs/adr/`**, by the owner's choice: don't create either, and don't suggest them.

## Before exploring, read these

- **[`docs/README.md`](../README.md)**: the index of module guides, and the repository's layering.
- **The module guide for the area** (`docs/<module>.md`): the cross-cutting rules, the vocabulary and the trade-offs behind each module. [`docs/seams.md`](../seams.md) gives every seam's expected shape.
- **[`docs/SECURITY.md`](../SECURITY.md#invariant-ids)**: the invariant IDs and their rationale.
- **The export's TSDoc**: each export's own contract and error channel.

## Use the docs' vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as the module guides and TSDoc use it. Don't drift to synonyms. The kernel names no application type ([CONTRIBUTING.md](../CONTRIBUTING.md#coding-guidelines)), so `page`, `post` and `album` are leaves an application binds, not kernel terms.

If the concept you need isn't named anywhere yet, either you're inventing language the project doesn't use (reconsider) or there's a real gap.

## Where terms and decisions go

When a skill (such as `/domain-modeling`, `/grill-with-docs` or `/improve-codebase-architecture`) would write a glossary entry to `CONTEXT.md` or a decision to an ADR, put it in the relevant module guide under `docs/` instead, or in the TSDoc of the export it concerns. A decision that spans modules goes in the guide that owns the rule, or `docs/README.md`.

## Flag conflicts with the docs

If your output contradicts a rule a module guide states, or an invariant in SECURITY.md, surface it explicitly rather than silently overriding:

> _Contradicts the append-only rule in docs/history-and-review.md, but worth reopening because…_
