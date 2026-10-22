# pulpit

A headless content management system built on [Effect](https://effect.website), starting with its kernel: versioned content nodes with an append-only history, a resource registry, owned and reference-data access rules, publication and cache-serveability predicates, content-addressed documents and edges between nodes. Persistence is behind seams the application fills; the kernel holds the policy.

Extracted from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications; the plan is the epic [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1). The API is in flux: expect breaking changes before 1.0.

## Packages

| Package | What it is | Peers |
| --- | --- | --- |
| [`@thomasfosterau/pulpit`](packages/pulpit/README.md) | The versioned-content kernel: the Content model fields, the registry, the version chain, the subtype and edge operation factories, the publication predicates and the in-memory fakes of every seam (`./testing`). | `effect`, `@thomasfosterau/effect-jsonapi` |
| [`@thomasfosterau/pulpit-wordpress`](packages/pulpit-wordpress/README.md) | A WordPress-compatible (`wp/v2`), read-only REST API over the kernel ([pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86)). Not yet published: so far the `IdCodec` seam ([pulpit#114](https://github.com/thomasfosterau/pulpit/issues/114)). | `@thomasfosterau/pulpit`, `effect` |

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

Node.js 22 or newer. Each module is also a subpath (`@thomasfosterau/pulpit/version-chain`, `…/subtype`, `…/edges`, …); the [package README](packages/pulpit/README.md) is the API reference.

## Example

A version chain over the in-memory store from `./testing`; an application binds the same operations to its own `VersionChainStore`.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
import { makeInMemoryChainStore } from "@thomasfosterau/pulpit/testing";

const chain = defineVersionChain("posts", makeInMemoryChainStore());
const actorId = Option.none<string>();

const program = Effect.gen(function* () {
  const { id } = yield* chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
  yield* chain.update({ id, patch: { title: "Hi" }, actorId }); // appends version 1
  yield* chain.delete(id, actorId); // a tombstone, version 2
  yield* chain.restoreVersion(id, 0n, actorId); // version 3, with version 0's state
  return yield* chain.compare(id, 0n, 1n); // changes: { title: "Hello" → "Hi" }
});

Effect.runPromise(program).then(({ changes }) => console.log(changes));
```

## Links

- [Contributing](CONTRIBUTING.md): setup, hooks and the individual checks. Agent conventions are in [AGENTS.md](AGENTS.md).
- [Publishing](PUBLISHING.md): the changesets release pipeline.
- [Security](SECURITY.md): reporting a vulnerability, the supply-chain posture and the invariant IDs.

## License

MIT
