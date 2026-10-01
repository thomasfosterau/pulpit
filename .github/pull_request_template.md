## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `main`.

## Verification

Run the gates in [AGENTS.md → Verification](https://github.com/thomasfosterau/pulpit/blob/main/AGENTS.md#verification), in order, and list each command with its final pass/fail. If a gate couldn't run, say which and why.

## Changeset

- [ ] A changeset under `.changeset/` for every change to the published package's behaviour (or: none needed, because …)

## Notes

Anything reviewers should pay special attention to: exported signatures, declaration-emit shape, peer ranges, behaviour ported from an application that must stay byte-compatible.
