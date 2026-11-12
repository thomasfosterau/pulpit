# Drizzle / PostgreSQL seams

The module guide for [`@thomasfosterau/pulpit-drizzle-pg`](../packages/pulpit-drizzle-pg/README.md): its status, an end-to-end wiring, and each module's tables, statements and guarantees. The kernel-side contract each module fills is in [Seams](seams.md); each export's own contract is in its TSDoc.

## Status

**Not published.** The package is `"private": true`, at version `0.0.0`, until the owner sets up its publishing ([PUBLISHING.md → Adding `pulpit-drizzle-pg`](../PUBLISHING.md#adding-pulpit-drizzle-pg-to-the-release-flow)). The spec is [pulpit#247](https://github.com/thomasfosterau/pulpit/issues/247), and it lands in slices:

- **Landed:** the `VersionChain` port over `-pg/chain` ([`./version-chain`](#version-chain)), passing the kernel's `versionChainConformance` against PostgreSQL; the `LeafStore` over the tree's leaf views and the owner table ([`./leaf-store`](#leaf-store)), with the `ListFilter` → SQL renderer and the list order ([`./filter`](#filter)), checked row by row against the kernel's in-memory store on PostgreSQL.
- **Landed:** the live pointer, `PublicationStore` / `LiveView` and the gated store, over the tree's pointer level ([`./publication`](#publication)), checked against the kernel's in-memory publication on PostgreSQL.
- **Landed:** the content-addressed `DocumentStore` ([`./documents`](#documents)), its hashes checked against the kernel's `canonicalText` on PostgreSQL.
- **Landed:** the localised `LeafStore` over a tree's keyed views ([`./leaf-store`](#localised-leaves)), checked against the kernel's localised in-memory store on PostgreSQL.
- **Landed:** the `PathStore` over a path table per routable namespace ([`./paths`](#paths)), checked step by step against the kernel's in-memory store on PostgreSQL.
- **Landed:** `SearchBranch` over a tree's leaf and branch views and over a gated leaf's live rows ([`./search`](#search)), checked against the kernel's in-memory branch under every viewer's read scope on PostgreSQL.
- **Landed:** the localised live view and gated store of a publish-gated keyed leaf ([`./publication`](#publication), pulpit#343), checked against the kernel's in-memory publication over a localised store on PostgreSQL.
- **Next:** the stores that aren't tree-bound (edges, proposals, reports, budgets, working copies, erasure, embeddings, social and notification tables), tracked in [pulpit#353](https://github.com/thomasfosterau/pulpit/issues/353); dropping the local guards once effect-drizzle-ext ships them ([pulpit#342](https://github.com/thomasfosterau/pulpit/issues/342)).

## End to end

One tree, its ports, and the kernel's leaf operations over them. `makePublications`' `@example` is the complete, runnable program (docgen type-checks and runs it):

```ts
const tables = makeTreeTables(tree, { schema: core, builders, root: { pointers: ["live"] } });
const views = makeTreeViews(tree, tables, { schema: core, pointers: { live: ["post"] } });
const owners = makeNodeOwnerTable({ schema: core, identity: tables.root.identity });

const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const gated = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  owners,
  CurrentTransaction,
});

const posts = defineSubtype({
  type: "post",
  access: ownedAccess({ draft: true }),
  chain: chains.post,
  leaves: gated.post.leaves,
  publication: { live: gated.post.live, facts: gated.post.facts },
  viewer,
  policy,
  followers,
  toResource,
});
// Every operation needs `CurrentTransaction`: run it inside the application's `transact`.
```

An ungated leaf takes `makeLeafStores({ tree, tables, views, owners, CurrentTransaction })[leaf]` as its `leaves` instead, and a localised one also passes `keyed` (see [`./publication`](#publication)).

## `./version-chain`

`makeVersionChains({ tree, tables, CurrentTransaction })` takes exactly what effect-drizzle-ext `-pg/chain`'s `makeVersionChain` takes and returns one kernel `VersionChain<EffectDrizzleQueryError, CurrentTransaction>` per leaf, keyed by leaf name, ready for the kernel's `defineVersionChain` and `defineSubtype`'s `chain`.

```ts
import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makePgDatabase, pgClientFromPool } from "@thomasfosterau/effect-drizzle-ext-pg";
import { makeVersionChains } from "@thomasfosterau/pulpit-drizzle-pg/version-chain";
import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
import { pgSchema, text } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const nullableText = (column: string) =>
  dbColumn(Schema.NullOr(Schema.String), { column, pg: "text", notNull: false });

// The models package: the ontology, with no Drizzle import.
const tree = defineTree({
  work: { columns: { title: nullableText("title") } },
  post: {
    parent: "work",
    leaf: { body: nullableText("body") },
    keyed: { name: "locale", columns: { heading: nullableText("heading") } },
  },
});

// The database package: the tables (migrations come from these through drizzle-kit).
const tables = makeTreeTables(tree, {
  schema: pgSchema("core"),
  builders: { text: (column: string) => text(column) },
  root: { versionColumns: { proposedBy: text("proposed_by") } },
});
const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;

// The kernel's ports, one per leaf.
const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const posts = defineVersionChain("post", chains.post);

const program = transact(
  Effect.gen(function* () {
    const actorId = Option.some("u-author");
    const { id } = yield* posts.create({
      id: Option.none(),
      state: { title: "Hello", body: "…" },
      locales: { en: { heading: "Hello" } },
      actorId,
    });
    yield* posts.update({ id, patch: { title: "Hi" }, actorId, expectedVersion: 0n });
    return yield* posts.compare(id, 0n, 1n); // changes: { title: "Hello" → "Hi" }
  }),
);

const DatabaseLive = database.layer.pipe(
  Layer.provide(pgClientFromPool({ connectionString: Redacted.make(process.env.DATABASE_URL!) })),
);
Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)));
```

What each port does, over the leaf's tables:

- **`create` / `update` / `restore` / `delete` / `restoreVersion` / `getVersion` / `history` / `head`** are `-pg/chain`'s own, so the kernel's invariants (append-only at `N_max + 1`, never an upsert, no resurrection by a plain `update`, no partial restore, bounded history, the expected-version precondition checked against the head the append extends) are the chain's. Its errors map one to one onto the kernel's: `NodeAlreadyExists`, `NodeNotFound`, `VersionNotFound`, `StaleVersion`, `VersionConflict`; `BrokenChain` stays a defect.
- **State** is keyed by Drizzle field key across the leaf's whole path (a work's `title` and a post's `body` alike). A key that names no column of the path is not stored, and a column the state omits is `NULL` at create. Timestamps are the transaction's `now()` (the root version table's column default).
- **`actorId`** is the root version row's actor. **`locales`** is the leaf's keyed level (`keyed: { name: "locale", columns }` in the tree); `getVersion` returns it as `locales`, and omits the key for a version that carries none. A translated column is never a shared one: the tree rejects a key both levels of one path declare.
- **`proposedBy`** (the contributor whose accepted proposal a version applies, `./proposals`) is the root version row's `proposedBy` extra: declare `root.versionColumns: { proposedBy }` in `makeTreeTables` to accept proposals. An update carrying one over a tree without that column dies (`ProposedByUnrecorded`) rather than drop the contributor.
- **`purge(id)`** deletes the node's identity row, scoped to the leaf's `type`, which cascades through every level of its chain (effect-drizzle-ext#145): [`./purge`](erasure.md#purge)'s erasure. A no-op for an unknown id or another leaf's node.

No operation opens a transaction: each requires the application's `CurrentTransaction`, the kernel's `R`, so the caller's `transact` is the boundary (and rolls back a `VersionConflict`'s aborted transaction).

| Export | What it is |
| --- | --- |
| `makeVersionChains(config)` | One kernel `VersionChain` per leaf of `config.tree`, over `config.tables`. Throws effect-drizzle-ext's `DerivationError` at module load for tables not built from the tree. |
| `VersionChains<Leaf, E, I>` | Its result: `{ readonly [K in Leaf]: VersionChain<E, I> }`. |
| `VersionChainTables` | The tables it reads: `makeTreeTables`' output, with the identity table's `id` and `type`. |
| `ChainQueryError<C>` | A `-pg/chain` leaf chain's query error (drizzle's `EffectDrizzleQueryError`). |

## `./leaf-store`

`makeLeafStores({ tree, tables, views, owners, CurrentTransaction })` returns one kernel `LeafStore<LeafRow, SQLWrapper, EffectDrizzleQueryError, CurrentTransaction>` per leaf view, ready for `defineSubtype`'s `store`. `views` is `makeTreeViews(tree, tables, { schema })`, and `owners` the owner table:

```ts
import { makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makeLeafStores, makeNodeOwnerTable } from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
import { sql } from "drizzle-orm";

const views = makeTreeViews(tree, tables, { schema: core });
// core.node_owner: node_id → node.id (cascading), owner_id. Export it with the schema, so migrations create it.
export const nodeOwner = makeNodeOwnerTable({ schema: core, identity: tables.root.identity });

const stores = makeLeafStores({ tree, tables, views, owners: nodeOwner, CurrentTransaction });

// The follower seam hands the list filter SQL subqueries, never arrays.
const followers = {
  isFollower: (follower: string, owner: string) => /* a one-row read */ Effect.succeed(false),
  following: (follower: string) =>
    sql`select owner_id from core.follows where follower_id = ${follower}`,
};

// defineSubtype({ type: "post", chain: chains.post, store: stores.post, access: ownedAccess({ draft: true }), followers, … })
```

What each store does, over the leaf's view:

- **Rows** are the view's (`id`, the head's `version` and `action`, the identity extras, every level's columns from the branch root down, `timestamp`, `createdAt`) with the node's owner LEFT JOINed in as `ownerId`, the column `ownedAccess` reads. `columns` is that key set. A node with no owner row has a `NULL` owner, which the kernel reads as none.
- **`get` / `getMany`** are `id = $id` / `id IN (…)` reads with a `LIMIT`. An id that is no canonical UUID (the identity table's type) names no node: none, or omitted, never a query error. The `VersionChain` ports answer one the same way (`NodeNotFound` / `VersionNotFound`).
- **`list`** renders its `ListFilter` with [`renderListFilter`](#filter), orders by [`renderListOrder`](#filter), pages by `LIMIT` / `OFFSET` and reads the unpaged total off `count(*) OVER ()`, so a page past the end reports `total: 0`.
- **`distinct`** reads one column's distinct non-`NULL` values, by code point, over the same rows, with the distinct count. A column that decodes to no string has none.
- **`listLocalised`** reads none over a leaf with no keyed view; a keyed leaf's is [below](#localised-leaves).
- **`ownerOf` / `stampOwner`** read and insert the owner row.
- **Every read and write runs in the caller's `CurrentTransaction`**: no store opens a connection or a transaction, so a handler's `transact` covers the chain write, the owner stamp and the read back.

### Localised leaves

A leaf with a keyed level (`defineTree`'s `keyed: { … }`, the kernel's locale level, pulpit#56) gets a keyed view from `makeTreeViews` (`views.keyed[leaf]`), and `makeLeafStores` reads it with nothing more to pass: `views` carries it. Its store is the kernel's localised `LeafStore` ([Seams → `LeafStore`](seams.md#leafstorerow-following-e-r-the-current-version-view), "A localised leaf's view"):

- **`columns`, `list` and `distinct`** read the keyed rows, one per `(id, locale)` and one `NULL`-locale row for a node with no locale, so the filter's `locale([…])` arm renders over the `locale` column and a translated column (an aliased expression in the view) filters, orders and reads distinct values like any other. A node with two locales is two rows, and counts twice in `total`.
- **`get` / `getMany`** read the shared row, one per node, as for an unkeyed leaf.
- **`listLocalised({ locales, … })`** (pulpit#272) reads, per node, the row of its most preferred carried locale (`DISTINCT ON (id) … WHERE locale = ANY($locales) ORDER BY id, array_position($locales, locale)`), then the filter, order and page over those rows. Tags match exactly (`en` is not `en-AU`; the kernel's `localeChain` widens a request before it reaches here); a node carrying none of them is absent, and an empty `locales` reads none.

The integration suite runs every read here against the kernel's `makeInMemoryLeafStore(chain, { localised: true })` over the same writes, a dropped locale included.

**The view-merge trap is refused at module load.** A tree view merges its sources by key (`{ ...identityExtras, ...levels, timestamp, createdAt }`), so a key two sources share keeps the later silently: an identity `slug` shadowed by a level's `slug`, or a level column named `createdAt` shadowed by the birth timestamp. `makeLeafStores` throws a `DerivationError` naming both sources instead, for any key an identity extra, a level on the leaf's path and the view's own projection (`id`, `version`, `action`, `timestamp`, `createdAt`, `ownerId`) share.

| Export | What it is |
| --- | --- |
| `makeLeafStores(config)` | One `LeafStore` per leaf view. |
| `LeafStores<Leaf, E, I>` | Its result. |
| `makeNodeOwnerTable({ schema, identity, name? })`, `NodeOwnerTable` | The owner table (`node_owner` by default): `node_id` primary key, cascading from the identity row, and `owner_id`, indexed. |
| `OWNER_COLUMN` | `"ownerId"`, the key the owner joins in under. |
| `StoreQueryError<Relations>` | The driver's query error. |

## `./publication`

A publish-gated leaf (the kernel's `publication: { live, facts }`, pulpit#46) over effect-drizzle-ext's pointer level: declare the pointer in `makeTreeTables` (`root: { pointers: ["live"] }`) and its leaves in `makeTreeViews` (`pointers: { live: ["post"] }`), then

```ts
import { makePublications } from "@thomasfosterau/pulpit-drizzle-pg/publication";

const gated = makePublications({
  views,
  pointer: "live",
  log: tables.pointers.live,
  live: views.pointers.live.leaves,
  // A publish-gated leaf with a locale level (optional): its keyed head and pointer views.
  keyed: { views: views.keyed, live: views.pointers.live.keyed },
  owners: nodeOwner,
  CurrentTransaction,
});

// defineSubtype({ type: "post", chain: chains.post, store: gated.post.leaves,
//   publication: { live: gated.post.live, facts: gated.post.facts }, … })
```

- **`facts`**, the `PublicationStore` over the append-only `live_pointer` log: `record` appends a fact (`version` `NULL` for an unpublish; `at` in the future schedules it); `effective(id)` is the latest by `seq` whose `at <= now()`; `facts(id, limit)` is the node's facts in record order; `scheduled(ids)` (#325, pulpit#220) is, per node and in one read, the latest-recorded fact naming a version whose `at` is still ahead and that no later record overtakes (`DISTINCT ON (id) … NOT EXISTS (a later fact with at <= this at)`), the kernel's own SQL sketch.
- **`live`**, the `LiveView`: `get` / `getMany` read the row at the effective fact's version, with that version as its `version`, the head's `action` (a tombstone hides it too), `draft = false` and the fact's `at` as `publishedAt`; `list` / `distinct` read the `UNION ALL` of the head rows matching `headFor` (the viewer's own) and the live rows of every other node, under the same filter, order and page as `./leaf-store`. `publishedAt <= now()` is the gate the kernel's `isPubliclyServeable` reads (`CACHE-AUTH-005`).
- **`leaves`**, the gated current-version store: the head rows with `draft` computed as `NOT EXISTS (a live row)`, a stored draft column ignored, as [Seams → the live pointer](seams.md#publicationstoree-r-and-liveviewrow-following-e-r-the-live-pointer) asks.
- **`searchBranch(options)`**, the leaf's [`SearchBranch`](#search), one value for every viewer: each request ranks the rows `live.list` reads for its `headFor` (per node, its head when it matches `headFor`, else its live row). Pass the kernel's `searchHeadFor(leaf, viewer)` as `headFor` (pulpit#346), the choice the leaf's `list` makes: every head on a head-reading rung, the viewer's own on an owned leaf, none for a reader. So a reader's search never scores a head's unpublished text, and an owner's finds their own.

**A localised gated leaf** (pulpit#343): a leaf with a keyed level, listed under the pointer in `makeTreeViews` (`pointers: { live: ["post"] }` derives `views.pointers.live.keyed.post` beside its leaf view), reads one row per locale once `keyed` names both its keyed head view (`views.keyed`) and the pointer's keyed view; a leaf named on one side only is a `DerivationError` at module load.

- `live.list` / `distinct` read, per node, the locale rows of its head when its **shared** head matches `headFor` (as the kernel's `LiveView` reads it), else those of its live version: the `UNION ALL` of the keyed head rows of the matching nodes and the keyed live rows of every other.
- `live.listLocalised` picks each node's most preferred carried locale over those same rows, then the filter, order and page, as [`./leaf-store`'s](#localised-leaves) does. A reader sees the live version's locales, an owner their head's.
- `live.get` / `getMany` read the shared live row, one per node.
- `leaves` is the localised store over the keyed head rows, `draft` computed as "no live row".
- `searchBranch` still ranks the shared rows, one hit per node, since a search hit is a node.

An unkeyed gated leaf's `listLocalised` reads none on both. An id that is no canonical UUID names no node and has no facts.

| Export | What it is |
| --- | --- |
| `makePublications(config)`, `Publications<Leaf, E, I>`, `PublishGated<E, I>` | One `{ facts, live, leaves }` per leaf of the pointer. |

## `./documents`

The kernel's content-addressed `DocumentStore` ([Seams → `DocumentStore`](seams.md#documentstoredocument-e-r-the-content-addressed-document-store), `DOC-001`): one table per document family, built by `makeDocumentTable({ schema, name })`, with the hash the database generates to the kernel's contract:

```sql
hash bytea PRIMARY KEY GENERATED ALWAYS AS (digest(document::text, 'sha256')) STORED,
document jsonb NOT NULL
```

`digest` is pgcrypto's (its immutable `text` overload): a migration must `CREATE EXTENSION pgcrypto` before the table. `makeDocumentStore({ table, document, CurrentTransaction })` binds the store, `document` the family's schema (a document read back that fails it is a defect):

- **`put`** is `INSERT … ON CONFLICT DO NOTHING RETURNING encode(hash, 'hex')`: `{ hash, inserted: true }` for a first insert; for a document already stored, or equal to one under the canonical text (a reordering), nothing is written and the hash is Postgres's own, `encode(digest($document::jsonb::text, 'sha256'), 'hex')`, `inserted: false`. A stored row is never rewritten. The document is bound as its JSON text cast to `jsonb`, so a JSON `null` document is stored as `'null'`, never SQL `NULL`.
- **`get` / `getMany`** read by `hash` (`getMany` one `IN (…)` read); a string that is no `DocumentHash` names no document.
- **The first-insert hook** (website's embedding enqueue) is the kernel's `onDocumentInsert(store, hook)` over this store, with `EmbeddingStore.enqueue` in the same transaction; this package adds no hook of its own.

The integration suite puts the same documents through this store and the kernel's `makeInMemoryDocumentStore` (whose hash is `canonicalText`'s) and checks every hash agrees, escapes, key order and exponent-free numbers included.

| Export                                                 | What it is                   |
| ------------------------------------------------------ | ---------------------------- |
| `makeDocumentTable({ schema, name })`, `DocumentTable` | One family's table.          |
| `makeDocumentStore(config)`                            | The `DocumentStore` over it. |

## `./paths`

The kernel's `PathStore` ([Seams → `PathStore`](seams.md#pathstoree-r-the-path-table), pulpit#57) for `routable`: one path table per routable namespace, `makePathTable({ schema, name, identity })`, `(path PRIMARY KEY, node_id → node.id ON DELETE CASCADE, canonical)` with a partial unique index (`node_id WHERE canonical`) holding at most one canonical row per node. `makePathStore({ table, CurrentTransaction })` binds it:

- `lookup(path)` is the row by key, `canonicalOf(id)` the node's canonical row, `release(id)` deletes it and keeps the aliases.
- `claim(id, path)` is the uniqueness pre-check, then the claim. It reads the row at `path` `FOR UPDATE` and fails `PathTaken` when another node holds it canonically, **before writing anything**; it then turns the node's previous canonical row into an alias and upserts `path` as its canonical row, over an alias at `path` (the node's own, which a revert promotes, or another node's, which the claim takes over). The upsert is guarded by the key: `ON CONFLICT (path) DO UPDATE … WHERE NOT canonical OR node_id = $id`, so a concurrent claim that took the path after the check makes this one `PathTaken` instead of overwriting it (the integration suite races two). The caller's transaction then rolls back the alias it made, as `routable` rolls back the append.
- `PathTaken` names the path, never the holder. An id that is no canonical UUID holds no path. Every call runs in the caller's `CurrentTransaction`.

A node-level slug on the identity table (`identityColumns: { slug }`) is a different thing: `makeLeafStores` refuses one that shares a key with a level column (the view-merge trap).

| Export                                                   | What it is                  |
| -------------------------------------------------------- | --------------------------- |
| `makePathTable({ schema, name, identity })`, `PathTable` | One namespace's path table. |
| `makePathStore(config)`                                  | The `PathStore` over it.    |

## `./search`

The kernel's `SearchBranch` ([Seams → `SearchBranch`](seams.md#searchbranchfollowing-e-r-and-embeddingstoree-r-search-and-embeddings), pulpit#204): one ranked query over a view, with the leaf's read scope rendered into the same statement, so a row outside the scope is never ranked and never shifts another hit's rank (`SEC-AUTH-ENUM-001`).

```ts
import { fullTextRank, makeSearchBranch } from "@thomasfosterau/pulpit-drizzle-pg/search";
import { searchHeadFor, searchScopeFilter } from "@thomasfosterau/pulpit/subtype";
import { hybridSearch } from "@thomasfosterau/pulpit/search";
import { sql } from "drizzle-orm";

// makeTreeViews(tree, tables, { schema, branches: { work: { project: (leaf, c) =>
//   ({ search: sql`setweight(to_tsvector('english', coalesce(${c.title}, '')), 'A')`.as("search") }) } } })
const text = makeSearchBranch({
  view: views.leaves.book, // or views.branches.work, the search union over the marker's leaves
  owners: nodeOwner,
  name: "text",
  rank: fullTextRank({
    vector: (columns) => sql`to_tsvector('english', coalesce(${columns["title"]}, ''))`,
    config: "english",
  }),
  CurrentTransaction,
});

const search = hybridSearch({ branches: [text /* , trigram, vector … */] });
// search({ query, scope: searchScopeFilter(leaf, viewer, { includeDeleted, where }),
//   headFor: searchHeadFor(leaf, viewer), limit })
```

- **`search({ query, scope, headFor, limit })`** is `SELECT id … WHERE rank.matches AND scope ORDER BY (rank.score)::float8 DESC NULLS LAST, id LIMIT limit`, over the view's rows with the owner joined in as `ownerId`. `scope` renders through [`renderListFilter`](#filter) over the same columns `./leaf-store`'s `list` renders it over. It is never rank, then filter. `limit` is clamped to `[0, MAX_PAGE_LIMIT]`, and a zero limit reads nothing.
- **The rank is the application's** (`SearchRank`: the source's columns and the query to `{ matches, score }`, or none to read nothing): full text, trigram `similarity`, a vector's `embedding <=> $query`, or a literal-id match. `fullTextRank({ vector, config? })` is the full-text one: `vector @@ websearch_to_tsquery(config, query)`, scored by `ts_rank_cd`, `'simple'` by default; a blank query matches nothing.
- **A branch view** (`views.branches[marker]`, a `UNION ALL` over the marker's leaves with the `type` column and its `project` columns) ranks every leaf of the union. `eq("type", leaf)` narrows it to one leaf. A scope node over a column the union lacks is `false`, so a leaf's owned scope over a branch view without that leaf's access columns ranks none of it: it fails closed. Give the projection the columns the scope reads, or search the leaf view.
- **A publish-gated leaf** searches through [`./publication`](#publication)'s `searchBranch(options)`, which ranks the rows `LiveView.list` reads for the request's `headFor` (`BranchRequest.headFor`, pulpit#346). `makeSearchBranch` ignores `headFor`: a leaf or branch view has no live pointer.
- **The hits are ids** for `hydrateSearchHits`, which re-reads each one through the leaf's gated `getMany`. The branch applies no other policy, never opens a transaction, and fails only with the driver's query error.

The integration suite checks both branch kinds against the kernel's `makeInMemorySearchBranch` on PostgreSQL. A leaf view's branch runs under every viewer × `includeDeleted` through `searchScopeFilter`; a gated leaf's runs for each `headFor`. `fullTextRank` runs over a branch view, including the type narrowing and the fail-closed scope.

| Export | What it is |
| --- | --- |
| `makeSearchBranch(config)` | A `SearchBranch<SQLWrapper, EffectDrizzleQueryError, CurrentTransaction>` over one view. |
| `SearchBranchOptions`, `SearchRank` | Its name, weight and rank; the rank's shape. |
| `fullTextRank({ vector, config? })` | The full-text `SearchRank` (`ts_rank_cd` over a `tsvector`). |

## `./filter`

The kernel's read predicates as Drizzle SQL, to the contract table under the kernel's [`./filter`](content-model.md#filter), so the SQL store and the kernel's `evaluate` agree row for row (the integration suite checks every node, and every row × viewer through the kernel's own read scope, against the in-memory store):

- `renderListFilter(filter, columns)` is the `WHERE`, or `undefined` for `always`. A node over a column `columns` lacks is `false` (fail closed). `in` / `notIn` embed the seam's subquery. A string comparison and sort is by code point (`col::text COLLATE "C"`); a `uuid` column compares as text, so a value that is no UUID compares unequal instead of failing the query. A `NaN` or invalid-`Date` comparand, an empty `anyOf` and a set past `MAX_SET_VALUES` are `false`; an empty `noneOf` is `true`; `±Infinity` is bound as a `float8` literal. `anyOf` / `noneOf` render as `IN (…)` / `NOT IN (…)` lists of bound values, with the same `NULL` semantics as `= ANY` / `<> ALL`.
- `renderListOrder(orderBy, columns, id)` is `<key> ASC|DESC NULLS LAST, …, id ASC`.
- `distinctKey(column)` is a string column's code-point form, the key `distinct` reads.
