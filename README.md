# pulpit

A headless content management system built on top of Effect — starting with its kernel, published as one npm package:

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/pulpit`](packages/pulpit/README.md) | The versioned-content kernel: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, and the publication, moderation and cache-serveability predicates. Peers: `effect`, `@thomasfosterau/effect-jsonapi`. |

Built against `effect@4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@0.16`.

**Disclaimer:** this repository and its package have been created using Claude Code. The API is in flux; expect churn and breaking changes.

## Documentation

[`packages/pulpit/README.md`](packages/pulpit/README.md) is the package's API reference; [AGENTS.md](AGENTS.md) carries repository conventions; [CONTRIBUTING.md](CONTRIBUTING.md) the pre-PR checklist; [PUBLISHING.md](PUBLISHING.md) and [SECURITY.md](SECURITY.md) the release pipeline.

Extracted from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications; the plan is the epic [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1).
