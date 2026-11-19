# pulpit

A headless content management system on [Effect](https://effect.website): versioned content of any shape, its review and publication, structure, participation, search, media, localisation and erasure. Persistence, transports and models sit behind seams the application fills; the kernel holds the policy and names no application type.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change in any release.

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi @thomasfosterau/effect-auth
```

Node.js 22 or newer.

## Example

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
import { makeInMemoryVersionChain } from "@thomasfosterau/pulpit/testing";

const chain = defineVersionChain("posts", makeInMemoryVersionChain("posts"));
const actorId = Option.none<string>();

const program = Effect.gen(function* () {
  const { id } = yield* chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
  yield* chain.update({ id, patch: { title: "Hi" }, actorId }); // appends version 1
  return yield* chain.compare(id, 0n, 1n); // changes: { title: "Hello" → "Hi" }
});
```

## Packages

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/pulpit`](packages/pulpit/README.md) | The kernel: one subpath module per capability, with in-memory fakes of every seam (`./testing`). |
| [`@thomasfosterau/pulpit-drizzle-pg`](packages/pulpit-drizzle-pg/README.md) | The kernel's tree-bound seams on PostgreSQL, over `@thomasfosterau/effect-drizzle-ext`. Not yet published. |
| [`@thomasfosterau/pulpit-wordpress`](packages/pulpit-wordpress/README.md) | A read-only, WordPress-compatible (`wp/v2`) REST API over the kernel's leaves. Not yet published. |

## Documentation

- [docs/](docs/README.md): the module guides and every seam's expected shape. Each export's TSDoc is its reference.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): workflow, toolchain, coding guidelines, gates.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) and [docs/SECURITY.md](docs/SECURITY.md): releases, vulnerability reports, invariant IDs.

## License

[MIT](LICENSE.md)
