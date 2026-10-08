# @thomasfosterau/pulpit

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, the publication, moderation and cache-serveability predicates, and the content-addressed document store seam.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

`effect` (`>=4.0.0-rc.118`) and `@thomasfosterau/effect-jsonapi` (`>=0.16.0`) are required peer dependencies; the package is built against `effect@4.0.0` and `@thomasfosterau/effect-jsonapi@0.16.0`. Node.js 22 or newer is required.

## API

Every module is a namespace on the root export (`import { Content, Registry } from "@thomasfosterau/pulpit"`) and a subpath of its own.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Content`, `Registry`, `VersionChain`, `Filter`, `Subtype`, `Publication`, `Documents`). |
| `./content` | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | The append-only node/version chain operations over a `VersionChainStore` seam. |
| `./filter` | `ListFilter`, the read-predicate tree a store renders to SQL, and its in-memory `evaluate`. |
| `./subtype` | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`, `subtypeHandlers`. |
| `./publication` | The publication and moderation predicates and the cache serveability policy. |
| `./documents` | The content-addressed `DocumentStore` seam, the `DocumentHash` it is keyed by, and the `documentRef` field spread. |

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

// The account family the owner linkage points at (the application's own).
const UserResource = Resource.make("users", { attributes: { name: Schema.String } });

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
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";
import {
  parent,
  root,
  validateRegistry,
  registryWireTypes,
  type RegistryEntry,
} from "@thomasfosterau/pulpit/registry";

// In an application, the `PostResource` from the `./content` example above.
const PostResource = Resource.make("posts", { attributes: { title: Schema.String } });

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

`get`, `getMany` and `list` treat a row the viewer may not see as missing (`NodeNotFound`, never `Forbidden`). The write and history operations don't: their gate answers `Forbidden` for an existing owned row the caller doesn't own. `subtypeHandlers(ops, { transact, cache })` wraps the operations as the handler record a JSON:API server is expected to accept (see [Seams](#seams)), writing every mutation through the resource cache.

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

The publication axis (stamped AND arrived), the moderation state, and the KV cache's serveability policy.

| Export | What it is |
| --- | --- |
| `isPublishedAt(stamp, now)` / `isNotPublishedAt` | Stamped AND arrived, and its exact complement (a future stamp is scheduled, not out). |
| `publishedFilter(column, wanted)` | The axis as a list-filter arm; none in, no predicate out. |
| `ModerationState` | `pending \| approved \| rejected`. |
| `isPubliclyServeable(resource, { owned?, publishGated?, now? })` | The KV cache's security gate (`CACHE-AUTH-005`): only what every viewer may read is serveable. |
| `serveablePolicy(options)` | The same gate as a resource cache's `serveable` hook (see [Seams](#seams)). |

## `./documents`

The content-addressed document store. A version row carries a document's hash rather than another copy of the document, so a long document edited many times is stored once per distinct content, and history (which is never pruned) stays small. A stored document is never rewritten and a changed document is a new hash (`DOC-001`), so `restoreVersion` restores the reference, and the old hash still reads back the old document.

```ts
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { documentRef, type DocumentStore } from "@thomasfosterau/pulpit/documents";
import { defineVersionChain, type VersionChainStore } from "@thomasfosterau/pulpit/version-chain";

export const NoteResource = Resource.make("notes", {
  attributes: { ...documentRef("title"), ...documentRef("body") }, // each a DocumentHash
});

const program = <Document, E, R>(
  documents: DocumentStore<Document, E, R>,
  store: VersionChainStore<E, R>,
  title: Document,
  body: Document,
) =>
  Effect.gen(function* () {
    const chain = defineVersionChain("notes", store);
    const state = { title: yield* documents.put(title), body: yield* documents.put(body) };
    const { id } = yield* chain.create({ id: Option.none(), state, actorId: Option.none() });
    return { id, body: yield* documents.get(state.body) }; // put is idempotent: the same document, the same hash
  });
```

The document type is a parameter: its schema and validation are the application's, and pulpit never imports them. The hash is the store's to derive; the algorithm and the bytes it is taken over are in [Seams](#seams).

| Export | What it is |
| --- | --- |
| `DocumentStore<Document, E, R>` | The store seam: `put` (idempotent, returns the hash), `get`, `getMany` (see [Seams](#seams)). |
| `DocumentHash` | A SHA-256 document hash as 64 lowercase hex characters. |
| `documentRef(key)` | The attribute spread for a version row's document reference: the hash, required on the resource and at create, carried forward at update, never cleared. |

## Seams

The kernel is written against explicit interfaces, so that it doesn't depend on the packages that fill them before they publish. Each seam below states the shape its real implementation must have, and which package (if any) is expected to fill it; the issue numbers in parentheses are for maintainers and aren't needed to follow the contract.

### `VersionChainStore<E, R>`: the version-chain persistence

Expected to be a Drizzle store built over the application's version tables (effect-drizzle-ext's `./versioned-chain`, once it publishes; pulpit#4). Expected schema:

- a root version table (the apps' `core.node_version`) keyed `(id, version bigint)`, carrying `action` (`create | update | delete`, the single home of currency and tombstone state), `timestamp` and `user_id`; plus the identity row (`core.node`: `id`, `type`) inserted at version 0;
- one version table per chain level keyed `(id, version)` with the `(id, version)` → parent-version FK, carrying that level's domain columns (6NF fact tables for a fact-scoped level).

Method contract: `head` is `SELECT … ORDER BY version DESC LIMIT 1` on the root table; `snapshot` reads every level at `(id, version)` and returns none when ANY level is missing (no partial state); `append` inserts the root row and every level's row at the given version (at version 0 the identity row too) and maps a primary-key violation on `(id, version)` to `VersionConflict`; `entries` is `ORDER BY version ASC LIMIT $limit`; `mintId` is a UUID. `E` is the store's query error and `R` the ambient transaction (`EffectDrizzleQueryError` and `CurrentTransaction` for the Drizzle store). The store never opens a transaction itself.

### `LeafStore<Row, Following, E, R>`: the current-version view

Expected to be a Drizzle store over the leaf's current-version view (pulpit#5). `columns` is the view's column-name set (`getColumns(view)`); `get` / `getMany` are `id = $id` / `id = ANY($ids)` reads with `LIMIT`; `list` renders its `ListFilter` (below), orders totally (the caller's order closed by `id`), and returns the page plus the unpaged total as a window column; `ownerOf` / `stampOwner` read and insert the node's owner row (`core.node_owner`).

### `ListFilter<Following>` → SQL: the filter renderer

The rendering contract is the table under [`./filter`](#filter). `Following` is the follower seam's subquery (Drizzle's `SQLWrapper`), rendered as `col IN (<subquery>)`, never a materialised array. `published` / `notPublished` use the database's `now()` and are parenthesised.

### The viewer, the role axes and the follower seam

Expected to come from effect-auth once it publishes (pulpit#5). Its default branch already has them, unpublished (release PR effect-auth#177): `OwnedAccess` (`canView`, `readScope`, the `IsFollower` service, read fail-closed, `serveableAxes`), `Guard` (`Unauthorized`, `Forbidden`, and the kit `Guard.make` returns: `requireRoleAtLeast`, `requireOwnerOrRole`), `Ladder` and `Cacheability.publiclyServeable`, plus `ownedListFilter` in `@thomasfosterau/effect-auth-drizzle`. Until it publishes, the application supplies:

- `Viewer = Option<{ id, role }>`: the request's signed-in account, or none for an anonymous request (effect-auth's session context).
- `AccessPolicy`: four predicates over a signed-in account (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`). Each compares the account's role against an application-named rung on its role ladder (effect-auth's `Ladder.make`, checked through the `Guard.make` kit's `hasRoleAtLeast` / `requireRoleAtLeast`). Each must fail closed on an unknown role.
- `FollowerSeam<Following, R>`: `isFollower(followerId, ownerId)` answers one row's question, and `following(followerId)` returns the list filter's `in` set (effect-auth's `IsFollower`). `nobodyFollows(nobody)` is the fail-closed default when a runtime provides none (effect-auth's `isFollowerNever`).
- `ReadScope` and `canViewOwned` (effect-auth's `OwnedReadScope` / `OwnedAccess.readScope` and `OwnedAccess.canView`) live here until effect-auth publishes its own; then pulpit consumes its read scope and keeps only the rendering into `ListFilter`.
- `Unauthorized` / `Forbidden` (effect-auth's `Guard` errors) are defined here until effect-auth publishes them.

### `SubtypeHandlers`: the handler record

The record a JSON:API server's resource handlers are expected to accept. effect-jsonapi's server skeleton has shipped as its `ResourceHandlers` namespace (`make`, `readOnly`, `related`; exported since 0.15.0, and pulpit's peer is `>=0.16.0`), but `subtypeHandlers` isn't wired to it yet (pulpit#5). One entry per endpoint (`list`, `get`, `create`, `update`, `delete`) returns the resource the document assembler wraps, plus `restoreVersion`, which has no JSON:API endpoint and is called directly. Each write runs inside the config's `transact` (always-open: a nested call opens a savepoint), re-reads the row outside it, and writes it through the cache. When it is wired, `subtypeHandlers` maps onto `ResourceHandlers`' real handler signatures (the request context, the query decode, the document assembly), and its error catalogue replaces the tags here.

### `DocumentStore<Document, E, R>`: the content-addressed document store

Filled by the application, over its own document tables (the apps' `inline_documents` / `block_documents`; pulpit#53). No library is expected to provide one. Expected schema: a table per document family holding the document as `jsonb`, keyed by its hash, which the database generates:

```sql
hash_id bytea PRIMARY KEY GENERATED ALWAYS AS (digest(document_jsonb::text, 'sha256')) STORED,
document_jsonb jsonb NOT NULL
```

**The hash contract.** The hash is SHA-256 (pgcrypto's `digest(…, 'sha256')`) over the UTF-8 bytes of the document's canonical text. The canonical text is PostgreSQL's `jsonb` text output (`document_jsonb::text`, in a `UTF8` database):

- object keys are deduplicated (the last wins) and ordered shorter-first by UTF-8 byte length, then bytewise;
- `": "` follows each key and `", "` separates members and elements, with no other whitespace;
- a string escapes `"`, `\` and the control characters below U+0020 (as `\b`, `\f`, `\n`, `\r`, `\t`, otherwise `\u00xx` in lowercase hex), and nothing else;
- a number is written as `numeric` prints it, never with an exponent (`1e21` is `1000000000000000000000`, `1e-7` is `0.0000001`), and it keeps the scale it was written with: `{"n":1.0}` is `{"n": 1.0}` and `{"n":1}` is `{"n": 1}`, two different hashes although `jsonb` `=` calls the documents equal.

So structurally equal documents share a hash whatever their member order, provided their numbers are spelled alike; that holds for documents serialised as `JSON.stringify` does (shortest round-trip digits, so `1.0` is written `1`). The hash is exchanged as a `DocumentHash`, the 32 bytes as 64 lowercase hex characters (`encode(hash_id, 'hex')`). A store that does not run on Postgres must reproduce these bytes exactly; the in-memory fake under `tests/` is a reference implementation, pinned to hashes taken from Postgres.

Method contract: `put` is `INSERT … ON CONFLICT DO NOTHING RETURNING hash_id`, and when the insert returns no row it reads the row that conflicted, `hash_id = digest($document::jsonb::text, 'sha256')`; it never updates a stored row (`DOC-001`). `get` is `hash_id = $hash`; `getMany` is one `hash_id = ANY($hashes)` read, returning the documents found keyed by hash. `E` and `R` are as for the chain store, and the store never opens a transaction itself. A first insert's side effects (both apps enqueue an embedding job) stay outside this seam until the lifecycle-events seam lands (pulpit#45).

**The apps' column differs.** Both apps generate the hash as `digest(document_jsonb::text::bytea, 'sha256')`. The `::bytea` cast parses the text as `bytea` escape-format input, so it agrees with the contract only on a document whose canonical text has no backslash. A document with a `"`, a newline, a tab or another escaped character in a string or key fails to insert (`invalid input syntax for type bytea`), and one with a literal backslash hashes different bytes (pulpit#71 tracks the apps' fix). Gardeneria's no-row lookup, `document_jsonb = $document`, also differs from the contract's: `jsonb` `=` ignores a number's scale, so it can match a row stored at another hash. The contract's spelling, `digest(document_jsonb::text, 'sha256')`, uses pgcrypto's `text` overload, which is immutable and therefore valid in a generated column; `convert_to(…, 'UTF8')` gives the same bytes but is only stable, so a generated column can't use it.

### `ResourceCacheSeam` and the `serveable` hook: the resource cache

Filled by the application: a KV read-through resource cache it owns (pulpit#5, pulpit#6). No library is expected to provide one; effect-web dropped its Cloudflare package, and with it the planned cache (effect-web#33). The cache's write side is `set(id, resource)` / `delete(id)`, both never failing (the cache swallows a KV fault). Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as the cache's `serveable` option; the cache applies it on both its read and write paths and evicts on a non-serveable write.

## License

MIT
