# @thomasfosterau/pulpit

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, and the publication, moderation and cache-serveability predicates.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

`effect` (`>=4.0.0-rc.118`) and `@thomasfosterau/effect-jsonapi` (`>=0.16.0`) are required peer dependencies; the package is built against `effect@4.0.0-rc.118` and `@thomasfosterau/effect-jsonapi@0.16.0`. Node.js 22 or newer is required.

## API

Every module is a namespace on the root export (`import { Content, Registry } from "@thomasfosterau/pulpit"`) and a subpath of its own.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Content`, `Registry`, `VersionChain`, `Filter`, `Subtype`, `Publication`). |
| `./content` | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | The append-only node/version chain operations over a `VersionChainStore` seam. |
| `./filter` | `ListFilter`, the read-predicate tree a store renders to SQL, and its in-memory `evaluate`. |
| `./subtype` | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`, `subtypeHandlers`. |
| `./publication` | The publication and moderation predicates and the cache serveability policy. |

The operations are written against seams that the application fills; their expected shapes are in [Seams](#seams).

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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineVersionChain, type VersionChainStore } from "@thomasfosterau/pulpit/version-chain";

const program = <E, R>(store: VersionChainStore<E, R>) =>
  Effect.gen(function* () {
    const chain = defineVersionChain("posts", store);
    const actorId = Option.none<string>();
    const { id } = yield* chain.create({ id: Option.none(), state: { title: "Hello" }, actorId });
    yield* chain.update({ id, patch: { title: "Hi", summary: null }, actorId }); // null clears; an absent key carries forward
    yield* chain.delete(id, actorId); // tombstone; idempotent
    yield* chain.restoreVersion(id, 0n, actorId); // appends version N+1 with version 0's state
  });
```

Every write lands at `N_max + 1`; nothing is rewritten. A plain `update` never resurrects a tombstone (`restore` and `restoreVersion` do). A create is never an upsert (`NodeAlreadyExists`). `restoreVersion` refuses a version that cannot be fully reconstructed before writing anything. `history` is bounded (`MAX_HISTORY_LIMIT`).

| Export | What it is |
| --- | --- |
| `defineVersionChain(type, store)` | The operations (`create`, `update`, `restore`, `delete`, `getVersion`, `restoreVersion`, `history`) for one leaf type. |
| `VersionChainStore<E, R>` | The persistence seam (see [Seams](#seams)). |
| `ChainState`, `ChainPatch`, `applyPatch` | A leaf's state at one version, the tri-state patch over it (a value sets, `null` clears, `undefined` carries forward), and the merge. |
| `NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `VersionConflict` | The tagged failures: the wire's 404 / 404 / 409, and a concurrent writer's `(id, version)` collision, which is never retried. |

## `./filter`

The kernel's read predicates as data: a store renders a `ListFilter` to SQL, and `evaluate` runs it against an in-memory row, so a list filter and its row predicate can be proven to agree.

| Export | What it is |
| --- | --- |
| `ListFilter<Following>` | The predicate tree. `Following` is whatever the follower seam hands the `in` node: a subquery for SQL, a set in memory. |
| `always`, `never` | No predicate; a predicate no row satisfies (fail closed). |
| `eq`, `ne`, `isIn` | `col = v`, `col <> v`, `col IN (following)`. |
| `published`, `notPublished` | Stamped and arrived; its exact complement (unstamped, or stamped in the future). |
| `and`, `or` | Combinators that drop identity parts, short-circuit on the absorbing part, and return a single part bare. |
| `evaluate(filter, row, context)` | The in-memory reading, against `context.now` and `context.contains`. |

A SQL renderer must honour this contract:

| Node | SQL |
| --- | --- |
| `always` | no predicate (`undefined` to Drizzle's `.where`) |
| `never` | a predicate no row satisfies |
| `eq` / `ne` | `col = $v` / `col <> $v` |
| `in` | `col IN (<following subquery>)`: a subquery, never a materialised array |
| `published` | `(col IS NOT NULL AND col <= now())`: the database's clock, one per query |
| `notPublished` | `(col IS NULL OR col > now())`, parenthesised so it cannot bind to a surrounding `AND` |
| `and` / `or` | `AND` / `OR` over the parts |

## `./subtype`

`defineSubtype` binds a leaf's CRUD, version history and list over the chain store, a current-version `LeafStore`, and the viewer seam (`viewer`, `AccessPolicy`, `FollowerSeam`), gated by `LeafAccess`:

- `reference` — writes at the corpus-write rung; reads public apart from soft-delete and `private`.
- `owned` — creates at any account (stamping the owner); other writes at owner-or-moderator; reads through `canViewOwned` (three-state visibility plus `draft`), lists through `ownedListFilter`, the same facts as a `ListFilter`.

A hidden row is always `NodeNotFound`, never `Forbidden`. `subtypeHandlers(ops, { transact, cache })` wraps the operations as the handler record effect-jsonapi#172's `resourceHandlers` is expected to accept, writing every mutation through the resource cache.

| Export | What it is |
| --- | --- |
| `defineSubtype(definition)`, `SubtypeDefinition`, `SubtypeOps` | The factory, its declaration (type, access, stores, viewer seams, row → resource mapper) and the operations it produces. |
| `subtypeHandlers(ops, config)`, `SubtypeHandlers`, `SubtypeHandlersConfig`, `ResourceCacheSeam` | The handler record with cache write-through, its `transact` boundary and the cache's write side. |
| `LeafAccess`, `ownedAccess(options?)` | The gate selector (`reference` / `owned` with its view columns), and the owned declaration with the conventional column names. |
| `Viewer`, `ViewerAccount`, `AccessPolicy` | The viewer seam and the four role axes (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`). |
| `FollowerSeam`, `nobodyFollows(nobody)` | The follower seam and its fail-closed default. |
| `ReadScope`, `readScopeFor(viewer, policy, followers)` | A viewer's owned-material read scope (`all` / `public` / `member`). |
| `canViewOwned`, `OwnedFacts` | The owned-row read predicate and the facts it reads. |
| `ownedListFilter`, `softDeleteFilter`, `referencePrivacyFilter` | The list arms: owned visibility, the soft-delete axis, and the reference privacy axis. |
| `requireCreator`, `requireWriter` | The write gates for a create and for a write to an existing row. |
| `Unauthorized`, `Forbidden` | The gates' failures: no signed-in viewer (401); a viewer below the rung (403, never used to hide a row). |
| `LeafStore`, `LeafRow`, `Page`, `ListRequest`, `MAX_PAGE_LIMIT` | The current-version view seam, its row and page shapes, the list request, and the page cap (1000). |

## `./publication`

| Export | What it is |
| --- | --- |
| `isPublishedAt(stamp, now)` / `isNotPublishedAt` | Stamped AND arrived, and its exact complement (a future stamp is scheduled, not out). |
| `publishedFilter(column, wanted)` | The axis as a list-filter arm; none in, no predicate out. |
| `ModerationState` | `pending \| approved \| rejected`. |
| `isPubliclyServeable(resource, { owned?, publishGated?, now? })` | The KV cache's security gate (`CACHE-AUTH-005`): only what every viewer may read is serveable. |
| `serveablePolicy(options)` | The same gate as effect-web#4's `serveable` hook. |

## Seams

The kernel is written against explicit interfaces, because the packages that will fill them are not published yet. Each seam below states the shape its real implementation must have.

### `VersionChainStore<E, R>` — filled by effect-drizzle-ext's `./versioned-chain` (pulpit#4)

The Drizzle store is built over `makeSubtypeTables` / `makeCurrentVersionView` and the application's root tables. Expected schema:

- a root version table (the apps' `core.node_version`) keyed `(id, version bigint)`, carrying `action` (`create | update | delete`, the single home of currency and tombstone state), `timestamp` and `user_id`; plus the identity row (`core.node`: `id`, `type`) inserted at version 0;
- one version table per chain level keyed `(id, version)` with the `(id, version)` → parent-version FK, carrying that level's domain columns (6NF fact tables for a fact-scoped level).

Method contract: `head` is `SELECT … ORDER BY version DESC LIMIT 1` on the root table; `snapshot` reads every level at `(id, version)` and returns none when ANY level is missing (no partial state); `append` inserts the root row and every level's row at the given version (at version 0 the identity row too) and maps a primary-key violation on `(id, version)` to `VersionConflict`; `entries` is `ORDER BY version ASC LIMIT $limit`; `mintId` is a UUID. `E` is `EffectDrizzleQueryError`; `R` is `CurrentTransaction` — the store never opens a transaction.

### `LeafStore<Row, Following, E, R>` — filled by a Drizzle store over the current-version view (pulpit#5)

`columns` is the view's column-name set (`getColumns(view)`); `get` / `getMany` are `id = $id` / `id = ANY($ids)` reads with `LIMIT`; `list` renders its `ListFilter` (below), orders totally (the caller's order closed by `id`), and returns the page plus the unpaged total as a window column; `ownerOf` / `stampOwner` read and insert `core.node_owner`.

### `ListFilter<Following>` → SQL — filled by effect-drizzle-ext's query helpers / effect-auth-drizzle (pulpit#5, #6)

The rendering contract is the table under [`./filter`](#filter). `Following` is the follower seam's subquery (`SQLWrapper`), rendered as `col IN (<subquery>)`, never a materialised array (gardeneria #1107). `published` / `notPublished` use the database's `now()` and are parenthesised.

### The viewer, the role axes and the follower seam — filled by effect-auth#221 (pulpit#5)

The lettered items below are the inputs listed in [effect-auth#221](https://github.com/thomasfosterau/effect-auth/issues/221).

- `Viewer = Option<{ id, role }>` — effect-auth's session context, item (b).
- `AccessPolicy` — four predicates over a signed-in account (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`), each an application-named rung compared by the role-ladder factory's `hasRoleAtLeast`, item (a). Must fail closed on an unknown role.
- `FollowerSeam<Following, R>` — `isFollower(followerId, ownerId)` and `following(followerId)`, item (c); `nobodyFollows(nobody)` is the fail-closed default when a runtime provides none.
- `ReadScope` and `canViewOwned` live here until effect-auth ships item (c); when it does, pulpit consumes its read scope and keeps only the rendering into `ListFilter`.
- `Unauthorized` / `Forbidden` are defined here until effect-auth's item (a) owns them.

### `SubtypeHandlers` — the record effect-jsonapi#172's `resourceHandlers` is expected to accept (pulpit#5)

One entry per endpoint (`list`, `get`, `create`, `update`, `delete`) returning the resource the document assembler wraps, plus `restoreVersion`, which has no JSON:API endpoint and runs SSR-direct. Each write runs inside the handler seam's `transact` (always-open, website #1883), re-reads the row outside it, and writes it through the cache. When #172 lands, `subtypeHandlers` maps onto its real handler signatures (the request context, the query decode, the document assembly) and its error catalogue replaces the tags here.

### `ResourceCacheSeam` and the `serveable` hook — filled by effect-web#4 (pulpit#5, #6)

The cache's write side is `set(id, resource)` / `delete(id)`, both never failing (a KV fault is swallowed by the cache). Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as `makeResourceCache`'s `serveable` option; the cache applies it on both paths and evicts on a non-serveable write.

## License

MIT
