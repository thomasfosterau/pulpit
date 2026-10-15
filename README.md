# pulpit

A headless content management system built on Effect, starting with its kernel. This pnpm workspace holds two npm packages:

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/pulpit`](packages/pulpit/README.md) | The versioned-content kernel. Peers: `effect`, `@thomasfosterau/effect-jsonapi`. |
| [`@thomasfosterau/pulpit-wordpress`](packages/pulpit-wordpress/README.md) | A WordPress-compatible (`wp/v2`), read-only REST API over the kernel ([pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86)). Peers: `@thomasfosterau/pulpit`, `effect`. Not yet published: so far the `IdCodec` seam ([pulpit#114](https://github.com/thomasfosterau/pulpit/issues/114)). |

Extracted from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications; the plan is the epic [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md); agent conventions are in [AGENTS.md](AGENTS.md), and the release pipeline in [PUBLISHING.md](PUBLISHING.md).

## License

MIT
