## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `main`.

## Validation

Tick what you ran. Pre-commit covers format + lint; there is no pre-push hook.

- [ ] `vp fmt --check` / `vp lint`
- [ ] `vp run check` (packages + the dist-consumer declaration check)
- [ ] `vp run -r test:unit`
- [ ] `vp run test:integration` (needs a local PostgreSQL server or a Docker daemon)
- [ ] `vp run -r build`
- [ ] `fallow audit --base origin/main`
- [ ] A changeset under `.changeset/` for every published-package change

## Notes

Anything reviewers should pay special attention to: exported signatures, declaration-emit shape, peer ranges, behaviour ported from an application that must stay byte-compatible.
