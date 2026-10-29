# pulpit

A general-purpose headless content management system built on [Effect](https://effect.website): versioned content of any shape (an application's articles, pages, media, member posts, reference records), the people who write and react to it, the structure that ties it together, and the rules for who may read it. Persistence, transports and models sit behind seams the application fills; the kernel holds the policy.

What the kernel covers, by capability:

- **Content model:** the Content axes (visibility, draft, tombstone), a resource registry with owned and reference-data access rules, content-addressed documents, and the subtype factory that serves any leaf an application declares.
- **History and review:** an append-only version chain with field-level compare and restore, autosaved working copies, suggested edits (proposals) and moderation.
- **Publication:** publish, unpublish and scheduling with a live-version pointer, and the cache-serveability policy.
- **Structure and routing:** edges between nodes (taxonomies, relations) and routable paths with aliases.
- **Participation and user-generated content:** threaded comments, member reports and the moderation queue.
- **Discovery and search:** a searchable projection, the read scope a search runs under, and gated hydration of its hits.
- **Media:** file leaves over a content-addressed byte store.
- **Localisation:** a locale level in the version chain, with fallback reads.
- **Erasure:** purging a node's whole history.

The kernel names no application type: a `page`, a `post` or an `album` is a leaf the application binds, with the capabilities it opts into. Extracted from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications; the plans are the epics [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1) (the kernel) and [pulpit#212](https://github.com/thomasfosterau/pulpit/issues/212) (the content systems the applications still build by hand: social interactions, pages and menus, media, discovery). The API is in flux: expect breaking changes before 1.0.

## Packages

The kernel depends on `effect` and `@thomasfosterau/effect-jsonapi` alone. Anything tied to a protocol, an editor or a framework is an optional package with its own boundary, which peers on the kernel and which the kernel never imports.

| Package | What it is | Peers |
| --- | --- | --- |
| [`@thomasfosterau/pulpit`](packages/pulpit/README.md) | The kernel: every capability above, as one subpath module each, behind seams, with the in-memory fakes of every seam (`./testing`). | `effect`, `@thomasfosterau/effect-jsonapi` |
| [`@thomasfosterau/pulpit-wordpress`](packages/pulpit-wordpress/README.md) | An optional protocol adapter: a WordPress-compatible (`wp/v2`), read-only REST API over the kernel's leaves, so a headless WordPress frontend reads a pulpit application unchanged ([pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86)). Not yet published ([pulpit#115](https://github.com/thomasfosterau/pulpit/issues/115)). | `@thomasfosterau/pulpit`, `effect` |

Further optional packages are proposed under [pulpit#212](https://github.com/thomasfosterau/pulpit/issues/212): a document-grammar package (allow-lists, serialisers and reference extractors for ProseKit documents, [pulpit#202](https://github.com/thomasfosterau/pulpit/issues/202)) and a UI package for the editorial surfaces ([pulpit#211](https://github.com/thomasfosterau/pulpit/issues/211)). Each is an owner decision still open on its issue.

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
