# `@thomasfosterau/pulpit`

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, and the publication, moderation and cache-serveability predicates.

[![CI](https://github.com/thomasfosterau/pulpit/actions/workflows/ci.yml/badge.svg)](https://github.com/thomasfosterau/pulpit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@thomasfosterau/pulpit.svg)](https://www.npmjs.com/package/@thomasfosterau/pulpit) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Installation

```bash
npm install @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

`effect` (`>=4.0.0-rc.112`) and `@thomasfosterau/effect-jsonapi` (`>=0.14.0`) are peer dependencies, built against `effect@4.0.0-rc.115` and `@thomasfosterau/effect-jsonapi@0.14.0`. Node.js 22 or newer is required.

## Overview

The package is being extracted slice by slice from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications (the plan is [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1)). Every module is a namespace on the root export (`import { Content, Registry } from "@thomasfosterau/pulpit"`) and a subpath of its own. The subpaths marked _planned_ arrive with their slices.

| Subpath | Slice | Contents |
| --- | --- | --- |
| `./content` | pulpit#3 | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | pulpit#3 | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | pulpit#4 — _planned_ | The append-only node/version chain operations over a store seam. |
| `./subtype` | pulpit#5 — _planned_ | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`. |
| `./publication` | pulpit#6 — _planned_ | The publication and moderation predicates and the cache serveability policy. |

## `./content`

The Content-axis field spreads a Content subtype opens its `Resource.make` attributes with. One declaration drives the resource object, its documents and the create / update projections.

```ts
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";
import {
  contentVisibilityResourceFields,
  ownedContentLeafResourceFields,
  ownerRef,
} from "@thomasfosterau/pulpit/content";

export const PostResource = Resource.make("posts", {
  attributes: {
    ...ownedContentLeafResourceFields, // createdAt, updatedAt, deletedAt?, visibility
    ...contentVisibilityResourceFields, // visibility, draft
    title: Schema.NonEmptyString,
  },
  relationships: { ...ownerRef(() => UserResource) },
});
```

| Export | What it is |
| --- | --- |
| `Visibility` | `"public" \| "followers" \| "private"` — the access axis. Only `public` is ever cache-serveable. |
| `contentVisibilityResourceFields` | `visibility` + `draft`: required on the resource, optional at create and update, never cleared. |
| `contentVisibilityCreateFields` | The same pair as `Schema.optional` keys, for a hand-written create struct. |
| `ownedVisibilityResourceFields` | `visibility` alone, for owned Entity / File leaves (no `draft`). |
| `nodeTimestampResourceFields` | `createdAt` / `updatedAt`, read-only. |
| `tombstoneResourceFields` | `deletedAt`, an optional key on the resource and in no write projection. |
| `referenceLeafResourceFields` | Timestamps + tombstone: every reference-data leaf. |
| `ownedContentLeafResourceFields` | Timestamps + tombstone + `visibility`: every owned Content leaf. |
| `ownerRef(() => Owner)` | The `owner` to-one linkage every owned leaf carries. The operation layer stamps it from the viewer. |
| `ContentResource`, `ContentRef`, `makeContentResource(id)` | The base `content` resource, with the auto-derived id or the application's own brand. |

## `./registry`

The flag vocabulary an application's resource registry is declared in, and the construction-time checks that keep it honest. The tree is the application's; the vocabulary and the checks are the kernel's.

```ts
import {
  parent,
  root,
  validateRegistry,
  registryWireTypes,
  type RegistryEntry,
} from "@thomasfosterau/pulpit/registry";

const REGISTRY = [
  { key: "node", parent: root },
  { key: "content", parent: parent("node") },
  {
    key: "posts",
    parent: parent("content"),
    resource: PostResource,
    id: PostResource.Id,
    owned: true,
    pageable: true,
  },
] as const satisfies readonly RegistryEntry[];

validateRegistry(REGISTRY); // throws RegistryDeclarationError at import on a malformed tree
registryWireTypes(REGISTRY, ["content"]).owned; // ["posts"]
```

| Export | What it is |
| --- | --- |
| `RegistryEntry`, `RESOURCE_FLAGS` | The entry shape and its flags: `pageable`, `agent`, `owned`, `referenceData`, `searchable`. `owned` and `referenceData` are mutually exclusive. |
| `parent(key)`, `root` | Declare an entry's parent with its key literal preserved (`Option.some` widens it to `string`, which empties every typed derivation). |
| `validateRegistry(entries, checks?)` | Unique keys, parents resolve, a flag implies a resource, the trust axis, id / wire-type lockstep; then the application's own `RegistryCheck`s. |
| `branchOf(entry, byKey, roots)` | The branch root an entry sits under, walking marker levels. |
| `flaggedMembers(entries, flag)`, `branchMembers(entries, root, roots, parents?)` | The resources themselves, typed as the precise member tuple, ready for `Schema.Union`. |
| `identifiersOf(members)` | The members' `identifier` schemas, for a linkage-ref union. |
| `registryWireTypes(entries, roots)` | The wire types of every flag family and branch — what a wire-identity test pins and a subtype factory checks its `access` against. |

## `./version-chain`

The append-only chain discipline, bound to a `VersionChainStore` the application supplies.

```ts
import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";

const chain = defineVersionChain("posts", store);
yield * chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
yield * chain.update({ id, patch: { title: "Hi", summary: null }, actorId }); // null clears, absent carries forward
yield * chain.delete(id, actorId); // tombstone; idempotent
yield * chain.restoreVersion(id, 0n, actorId); // appends version N+1 with version 0's state
```

Every write lands at `N_max + 1`; nothing is rewritten. A plain `update` never resurrects a tombstone (`restore` and `restoreVersion` do). A create is never an upsert (`NodeAlreadyExists`). `restoreVersion` refuses a version that cannot be fully reconstructed before writing anything. `history` is bounded.

## `./subtype`

`defineSubtype` binds a leaf's CRUD, version history and list over the chain store, a current-version `LeafStore`, and the viewer seam (`viewer`, `AccessPolicy`, `FollowerSeam`), gated by `LeafAccess`:

- `reference` — writes at the corpus-write rung; reads public apart from soft-delete and `private`.
- `owned` — creates at any account (stamping the owner); other writes at owner-or-moderator; reads through `canViewOwned` (three-state visibility plus `draft`), lists through `ownedListFilter`, the same facts as a `ListFilter`.

A hidden row is always `NodeNotFound`, never `Forbidden`. `subtypeHandlers(ops, { transact, cache })` wraps the operations as the handler record effect-jsonapi#172's `resourceHandlers` is expected to accept, writing every mutation through the resource cache.

## `./publication`

| Export | What it is |
| --- | --- |
| `isPublishedAt(stamp, now)` / `isNotPublishedAt` | Stamped AND arrived, and its exact complement (a future stamp is scheduled, not out). |
| `publishedFilter(column, wanted)` | The axis as a list-filter arm; none in, no predicate out. |
| `ModerationState` | `pending \| approved \| rejected`. |
| `isPubliclyServeable(resource, { owned?, publishGated?, now? })` | The KV cache's security gate (`CACHE-AUTH-005`): only what every viewer may read is serveable. |
| `serveablePolicy(options)` | The same gate as effect-web#4's `serveable` hook. |
