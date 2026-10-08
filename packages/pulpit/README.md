# @thomasfosterau/pulpit

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, the publication, moderation and cache-serveability predicates, the content-addressed document store seam, and the edge operations factory.

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
| `.` | Every module below as a namespace (`Content`, `Registry`, `VersionChain`, `Filter`, `Subtype`, `Publication`, `Documents`, `Edges`). |
| `./content` | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | The append-only node/version chain operations over a `VersionChainStore` seam. |
| `./filter` | `ListFilter`, the read-predicate tree a store renders to SQL, and its in-memory `evaluate`. |
| `./subtype` | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`, `subtypeHandlers`. |
| `./publication` | The publication and moderation predicates and the cache serveability policy. |
| `./documents` | The content-addressed `DocumentStore` seam, the `DocumentHash` it is keyed by, and the `documentRef` field spread. |
| `./edges` | `defineEdgeOps`, the edge operations factory over an `EdgeStore` seam: relations between nodes, readable only when every end is, with declared cardinality limits. |

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
    yield* chain.update({ id, patch: { title: "Hey" }, actorId, expectedVersion: 1n }); // StaleVersion unless the head is 1
    yield* chain.delete(id, actorId); // tombstone; idempotent
    yield* chain.restoreVersion(id, 0n, actorId); // appends version N+1 with version 0's state
  });
```

Every write lands at `N_max + 1`; nothing is rewritten. A plain `update` never resurrects a tombstone (`restore` and `restoreVersion` do). A create is never an upsert (`NodeAlreadyExists`). `restoreVersion` refuses a version that cannot be fully reconstructed before writing anything. `history` is bounded (`MAX_HISTORY_LIMIT`).

**Optimistic concurrency.** `update`, `restore`, `delete` and `restoreVersion` take an optional `expectedVersion` (a `Precondition`): the head version the caller last read. If the head has moved, the write fails `StaleVersion`, which carries the head it found (`current`), and nothing is written. Without one, a write extends whatever the head is, so a column that two patches both set is last-writer-wins. The check runs against the same head read the append extends, and the append lands at that head + 1. A writer that slips in between therefore takes the `(id, version)` key first, and the later append fails `VersionConflict`. The store's key is what makes the check atomic, so the seam needs nothing new. A delete over a tombstone stays idempotent whatever the precondition (the delete it asked for has happened). A missing node is still `NodeNotFound`, and a plain `update` over a tombstone is still `NodeNotFound`, whatever version it expects.

| Export | What it is |
| --- | --- |
| `defineVersionChain(type, store)` | The operations (`create`, `update`, `restore`, `delete`, `getVersion`, `restoreVersion`, `history`) for one leaf type. |
| `VersionChainStore<E, R>` | The persistence seam (see [Seams](#seams)). |
| `ChainState`, `ChainPatch`, `applyPatch` | A leaf's state at one version, the tri-state patch over it (a value sets, `null` clears, `undefined` carries forward), and the merge. |
| `Precondition` | The optional `expectedVersion` every write to an existing node takes. |
| `NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `StaleVersion`, `VersionConflict` | The tagged failures: the wire's 404 / 404 / 409, a failed expected-version precondition (412 for an `If-Match`, or 409; it carries the head), and a concurrent writer's `(id, version)` collision, which is never retried. |

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

`update`, `restore`, `delete` and `restoreVersion` (and the handlers' `update`, `delete` and `restoreVersion`) take the chain's optional `expectedVersion` and fail `StaleVersion` when it is not the head. The write gate runs first, so only a caller who may write learns the head version.

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

## `./edges`

`defineEdgeOps` binds the operations of an edge family: a relation between nodes, stored as a row of its own (an id, a `createdAt`, one column per end holding that end's node id, and the family's own qualifier columns) outside both nodes' tables. It is ported from gardeneria's `defineEdgeOpsE`:

- `list`: one page under the family's own `where`, at most `MAX_PAGE_LIMIT` (1000) rows, ordered by `createdAt` then `id`, with the unpaged total.
- `get`: one edge by id.
- `create`: asserts the edge. On a collision with a stored edge on the family's unique key, `onConflict: "ignore"` returns the stored edge's id with `created: false` (a re-assertion is idempotent, and never rewrites the stored qualifiers); `"fail"`, the default, fails `EdgeConflict`.
- `delete`: a hard `DELETE`. There is no update: correcting an edge is deleting it and asserting the right one.

Writes gate on the declaration's `writeGate`. The default, `corpusWriteGate`, is the corpus-write rung, right for an edge between two reference leaves. `rungGate((policy) => policy.canModerate)` puts a family on another rung. An owned-child edge (gardeneria's observation → disorder) passes a gate that reads its owned end's owner, typically `requireWriter` from `./subtype`.

On top of the port, pulpit enforces three rules:

- **Endpoint visibility** (`EDGE-001`). Each end declares its endpoint leaf's `access` and its current-version view (`nodes`; the leaf's own `LeafStore` fits). An edge is readable only if the viewer can read the node at every end, by the rule that leaf's own `list` applies (pulpit#73 tracks two cases where the subtype's `get` is looser). `get` fails `EdgeNotFound` for a hidden edge, and `list` omits it, never `Forbidden` (`SEC-AUTH-ENUM-001`). A related list (the edges at one node) is `list` filtered on that end's column, so it omits every edge whose other end is hidden, and the related list of a hidden node is empty. The list filter (`endpointFilter`) and the per-endpoint predicate (`canViewEndpoint`) read the same facts, so they never disagree. A create naming a node the viewer can't read fails `NodeNotFound`, before the write gate runs, so a 403 never confirms that the node exists.
- **Endpoint lifecycle.** A tombstoned end hides its edges from every viewer, the view-deleted rung included, and a create can't name it. Nothing is deleted, so restoring the node (`restore`) brings its edges back as they were.
- **Cardinality.** An end's `maxEdges` bounds how many edges one node at that end may hold; a create past it fails `EdgeCardinalityExceeded` (with the end, the node and the limit). It must be a positive safe integer: `defineEdgeOps` throws `EdgeDeclarationError` when the family is declared otherwise, and likewise for an end alias containing a `.`. Every stored edge at the node counts, including hidden ones, because a hidden edge reappears when its other end does. A re-assertion of a stored edge resolves before the count, so it stays idempotent at a full node. Counting hidden edges has two consequences:
  - **The count is disclosed** to a writer; see [What a write discloses](#what-a-write-discloses).
  - **Known limitation: a tombstoned partner holds its slot** ([#77](https://github.com/thomasfosterau/pulpit/issues/77), an open owner decision). An edge whose other end is tombstoned is hidden from everyone, the view-deleted rung included, so nobody can delete it, and it still counts. With `maxEdges: 1`, tombstoning the partner freezes the node: `delete` fails `EdgeNotFound` for every writer, a new create fails `EdgeCardinalityExceeded`, and no list shows the edge. The remedy is to restore the partner, delete the edge, and tombstone the partner again.

### What a write discloses

The read operations never reveal a hidden edge (`SEC-AUTH-ENUM-001`). A write discloses more, but only to a caller the write gate admits, because `create` runs in this order: ends, then the write gate, then the unique-key collision, then the cardinality count. pulpit#24 asks the same question of `./subtype`'s writes. Two cases are disclosed:

- **Hidden edges are counted.** Suppose a node N is readable, its limit is `k`, and the writer can see `v` of its edges. An `EdgeCardinalityExceeded` tells the writer that N holds at least `k − v` edges it can't read. A writer can create `s` edges at N until one is refused, then delete them. That gives the exact hidden count `h = k − v − s`, and repeating the probe shows the count changing over time: a side channel.
- **A hidden edge's unique key.** Some families' unique key leaves out an end (gardeneria's page slugs key on the path, not the page). In such a family, an `EdgeConflict` tells the writer that an edge it can't read holds the key. Where the key covers every end, a colliding edge joins the same nodes the create just showed to be readable, so it is visible and nothing is disclosed.

**An edge isn't a node.** It has no version chain, so the chain's append-only rules (`VERSION-CHAIN-001/002`) don't govern it, and its hard delete rewrites no version row. Tombstoning a node leaves its edges stored.

### Taxonomies

pulpit ships no category or tag vocabulary: a taxonomy is a reference-data leaf plus an edge family.

- **The terms** are a `reference` leaf (`defineSubtype` with `access: { kind: "reference" }`), written at the corpus rung, versioned like any other node. A hierarchy is a parent column on that leaf, or a second edge family between terms.
- **An assignment** is an edge family whose ends are the term leaf and the classified leaf. `maxEdges` on the classified end says how many terms one node may hold (1 for a single-choice taxonomy); on the term end, how many nodes one term may classify. `onConflict: "ignore"` makes re-assigning a term idempotent.
- **Who may assign** is the write gate: the corpus rung for curated assignments, or a gate on the classified node's owner when members classify their own rows.
- **A node's terms, and a term's nodes,** are `list` filtered on one end. Either list hides what the viewer can't read at the other end, and a tombstoned term drops out of every list until it is restored.
- **Retiring a term with a bounded classified end** runs into the known limitation under Cardinality ([#77](https://github.com/thomasfosterau/pulpit/issues/77)). A tombstoned term still holds its slot on every node it classified. Under `maxEdges: 1`, those nodes can't be reassigned until the term is restored. To retire a term in a single-choice taxonomy, delete its assignments first, then tombstone it.

```ts
import type * as Effect from "effect/Effect";
import { defineEdgeOps, type EdgeRow, type EdgeStore } from "@thomasfosterau/pulpit/edges";
import { eq } from "@thomasfosterau/pulpit/filter";
import {
  ownedAccess,
  requireWriter,
  type AccessPolicy,
  type FollowerSeam,
  type LeafRow,
  type LeafStore,
  type Viewer,
} from "@thomasfosterau/pulpit/subtype";

const assignments = <Following, E, R>(seams: {
  readonly terms: LeafStore<LeafRow, Following, E, R>;
  readonly notes: LeafStore<LeafRow, Following, E, R>;
  readonly edges: EdgeStore<EdgeRow, Following, E, R>;
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
  readonly followers: FollowerSeam<Following, R>;
}) =>
  defineEdgeOps({
    type: "note-terms",
    ends: {
      term: { column: "termId", type: "terms", access: { kind: "reference" }, nodes: seams.terms },
      note: {
        column: "noteId",
        type: "notes",
        access: ownedAccess({ draft: true }),
        nodes: seams.notes,
        maxEdges: 10, // at most ten terms on one note
      },
    },
    edges: seams.edges,
    viewer: seams.viewer,
    policy: seams.policy,
    followers: seams.followers,
    values: (input: { readonly termId: string; readonly noteId: string }) => ({ ...input }),
    toResource: (row) => ({ id: row.id, termId: row["termId"], noteId: row["noteId"] }),
    onConflict: "ignore",
    // A member classifies their own notes; a moderator anyone's.
    writeGate: ({ viewer, policy, edge }) => {
      const noteId = String(edge["noteId"]);
      return requireWriter(
        ownedAccess(),
        viewer,
        policy,
        { type: "notes", id: noteId },
        seams.notes.ownerOf(noteId),
      );
    },
  });

// A note's terms: the edges at one end, without any the viewer can't read.
const termsOf = <Following, E, R>(
  ops: ReturnType<typeof assignments<Following, E, R>>,
  noteId: string,
) => ops.list({ limit: 50, offset: 0, where: eq("noteId", noteId) });
```

| Export | What it is |
| --- | --- |
| `defineEdgeOps(definition)`, `EdgeDefinition`, `EdgeOps` | The factory, its declaration (type, ends, store, viewer seams, create mapping, conflict policy, write gate, row → resource mapper) and the operations it produces. |
| `EdgeEnd`, `EdgeEnds`, `EndpointView` | One end (its edge column, endpoint type and access, the endpoint view, `maxEdges`), the ends by alias, and the endpoint view a `LeafStore` satisfies. |
| `canViewEndpoint`, `endpointFilter`, `endpointColumn(alias, column)` | The per-endpoint read predicate, the same facts as a list filter over every end, and the filter column naming an end's node column. |
| `EdgeWriteGate`, `EdgeWriteRequest`, `corpusWriteGate`, `rungGate(rung)` | The write gate, what it is asked about, the default corpus-rung gate, and a gate on any rung. |
| `EdgeStore`, `EdgeRow`, `EdgeValues`, `EdgeListRequest`, `EdgeWrite` | The edge-table seam, its row and column values, the list request, and a create's outcome. |
| `EdgeNotFound`, `EdgeConflict`, `EdgeCardinalityExceeded` | A missing or hidden edge (404), an unresolved unique-key collision (409, never naming the stored edge), and a create past a declared limit (409). |
| `EdgeDeclarationError` | A malformed family (an end alias with a `.`, or a `maxEdges` that isn't a positive safe integer), thrown by `defineEdgeOps` when the family is declared, never as an Effect failure. |

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

`update`, `delete` and `restoreVersion` take an optional `expectedVersion`. Mapping a request's `If-Match` onto it, and a `StaleVersion` failure onto `412 Precondition Failed`, is the HTTP layer's job, and so effect-jsonapi's: 0.16.3 has no such mapping. A resource doesn't yet carry its head version (`meta.version` or an ETag) for a client to send back; pulpit#65 tracks that.

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

### `EdgeStore<Row, Following, E, R>`: the edge table

Filled by the application over each edge family's own table (pulpit#52); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `created_at` (`timestamptz NOT NULL DEFAULT now()`), one column per end holding the node id (a foreign key to the node identity table, `core.node`) with an index each, the family's qualifier columns, and, for a family that resolves re-assertions, a unique index on its natural key (`NULLS NOT DISTINCT` when a key column is nullable).

Method contract:

- `get` is `id = $id LIMIT 1`.
- `list` INNER JOINs each end's current-version view on `view.id = edge.<end column>`, under the end's alias, so an edge whose end has no view row is never listed. It renders `where` with the `ListFilter` renderer: a column `alias.name` resolves to that alias's view column, and a bare column to the edge table's. It orders by `created_at, id` and applies `LIMIT` / `OFFSET`. It returns the unpaged total as a window column (`count(*) OVER ()`), so the total is exact whenever the page has a row. An empty page reports `0`, including a page past the end of a non-empty list. That is gardeneria's documented rule, and the in-memory fake follows it.
- `countAt(column, nodeId)` is `count(*)` over the edge table where `column = $nodeId`, with no join. The create calls it inside its transaction for the cardinality check, once for each bounded end. The store locks the node first, so two creates at one node serialise and can't both take the last place. Three rules make that lock work:
  - **Lock with `FOR NO KEY UPDATE`:** `SELECT 1 FROM core.node WHERE id = $nodeId FOR NO KEY UPDATE`. Don't use `FOR UPDATE`. Every insert that references the node by foreign key (an edge in any family, or any other row keyed to `core.node`) takes `FOR KEY SHARE` on it, and `FOR UPDATE` would block those inserts for the rest of the transaction. `FOR NO KEY UPDATE` still conflicts with itself, so the creates still serialise.
  - **Run under READ COMMITTED** (PostgreSQL's default). There, the count after the lock wait sees the edge that the previous lock holder committed. Under REPEATABLE READ, the count reads the snapshot taken before the wait, so two creates can both see room and the node can overshoot its limit.
  - **Lock in ascending node id.** `create` calls `countAt` in ascending `nodeId` order, not declaration order. A self-referential family with two bounded ends (`a → b` and `b → a`) therefore locks its pair in one order, and two such creates can't deadlock. A store that locks anything else in `countAt` must keep to that order.
- `existing(values)` is the id of the stored edge whose unique-key columns match `values` (`IS NOT DISTINCT FROM`), `LIMIT 1`; always none for a family without a unique key.
- `insert(values)` is `INSERT … ON CONFLICT DO NOTHING RETURNING id`: the new id, or none when the key was taken (a racing writer, which the create then resolves through `existing`).
- `delete(id)` is `DELETE … WHERE id = $id RETURNING id`: whether a row went.

`E` and `R` are as for the chain store, and the store never opens a transaction itself. Each end's `EndpointView` is the endpoint leaf's own `LeafStore` (its `columns` and `get`).

### `ResourceCacheSeam` and the `serveable` hook: the resource cache

Filled by the application: a KV read-through resource cache it owns (pulpit#5, pulpit#6). No library is expected to provide one; effect-web dropped its Cloudflare package, and with it the planned cache (effect-web#33). The cache's write side is `set(id, resource)` / `delete(id)`, both never failing (the cache swallows a KV fault). Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as the cache's `serveable` option; the cache applies it on both its read and write paths and evicts on a non-serveable write.

## License

MIT
