# @thomasfosterau/pulpit-drizzle-pg

The tree-bound seams of [`@thomasfosterau/pulpit`](../pulpit/README.md) over the tables and views [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext) derives from an application's tree, on PostgreSQL through `@thomasfosterau/effect-drizzle-ext-pg`. An application declares its versioned ontology once with `defineTree`, derives its tables with `makeTreeTables`, and gets the kernel's ports for every leaf from this package.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published.** The package is `"private": true` until the owner sets up its publishing ([PUBLISHING.md](../../PUBLISHING.md)). The spec is [pulpit#247](https://github.com/thomasfosterau/pulpit/issues/247), and it lands in slices:

- **Landed:** the `VersionChain` port over `-pg/chain` ([`./version-chain`](#version-chain)), passing the kernel's `versionChainConformance` against PostgreSQL; the `LeafStore` over the tree's leaf views and the owner table ([`./leaf-store`](#leaf-store)), with the `ListFilter` → SQL renderer and the list order ([`./filter`](#filter)), checked row by row against the kernel's in-memory store on PostgreSQL.
- **Landed:** the live pointer, `PublicationStore` / `LiveView` and the gated store, over the tree's pointer level ([`./publication`](#publication)), checked against the kernel's in-memory publication on PostgreSQL.
- **Landed:** the content-addressed `DocumentStore` ([`./documents`](#documents)), its hashes checked against the kernel's `canonicalText` on PostgreSQL.
- **Landed:** the localised `LeafStore` over a tree's keyed views ([`./leaf-store`](#localised-leaves)), checked against the kernel's localised in-memory store on PostgreSQL.
- **Next:** the `PathStore` (#334) and `SearchBranch` (#336).

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-drizzle-pg @thomasfosterau/pulpit \
  @thomasfosterau/effect-drizzle-ext @thomasfosterau/effect-drizzle-ext-pg \
  drizzle-orm @effect/sql-pg effect
```

`@thomasfosterau/pulpit`, `@thomasfosterau/effect-drizzle-ext` (`>=0.2.0`), `@thomasfosterau/effect-drizzle-ext-pg` (`>=0.2.0`), `drizzle-orm` (`>=1.0.0-rc.5`) and `effect` are required peer dependencies, and so are their own peers (`@effect/sql-pg` for `-pg`; the kernel's). Node.js 22.18 or newer is required (effect-drizzle-ext's floor).

## API

Every module is a namespace on the root export (`import { VersionChain } from "@thomasfosterau/pulpit-drizzle-pg"`) and a subpath of its own.

| Subpath | Contents |
| --- | --- |
| `./version-chain` | `makeVersionChains`: the kernel's `VersionChain` port for every leaf of a tree. |
| `./leaf-store` | `makeLeafStores`: the kernel's `LeafStore` for every leaf view of a tree; `makeNodeOwnerTable`, the owner table. |
| `./publication` | `makePublications`: the live pointer (`PublicationStore`, `LiveView`, the gated store) for every leaf of a pointer. |
| `./documents` | `makeDocumentTable` / `makeDocumentStore`: the kernel's content-addressed `DocumentStore`, one table per family. |
| `./filter` | `renderListFilter` / `renderListOrder`: the kernel's `ListFilter` and list order as Drizzle SQL. |

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
- **`purge(id)`** deletes the node's identity row, scoped to the leaf's `type`, which cascades through every level of its chain (effect-drizzle-ext#145): [`./purge`](../pulpit/README.md#purge)'s erasure. A no-op for an unknown id or another leaf's node.

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

A leaf with a keyed level (`defineTree`'s `keyed: { … }`, the kernel's locale level, pulpit#56) gets a keyed view from `makeTreeViews` (`views.keyed[leaf]`), and `makeLeafStores` reads it with nothing more to pass: `views` carries it. Its store is the kernel's localised `LeafStore` (README → Seams → `LeafStore` → "A localised leaf's view"):

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
  owners: nodeOwner,
  CurrentTransaction,
});

// defineSubtype({ type: "post", chain: chains.post, store: gated.post.leaves,
//   publication: { live: gated.post.live, facts: gated.post.facts }, … })
```

- **`facts`**, the `PublicationStore` over the append-only `live_pointer` log: `record` appends a fact (`version` `NULL` for an unpublish; `at` in the future schedules it); `effective(id)` is the latest by `seq` whose `at <= now()`; `facts(id, limit)` is the node's facts in record order; `scheduled(ids)` (#325, pulpit#220) is, per node and in one read, the latest-recorded fact naming a version whose `at` is still ahead and that no later record overtakes (`DISTINCT ON (id) … NOT EXISTS (a later fact with at <= this at)`), the kernel's own SQL sketch.
- **`live`**, the `LiveView`: `get` / `getMany` read the row at the effective fact's version, with that version as its `version`, the head's `action` (a tombstone hides it too), `draft = false` and the fact's `at` as `publishedAt`; `list` / `distinct` read the `UNION ALL` of the head rows matching `headFor` (the viewer's own) and the live rows of every other node, under the same filter, order and page as `./leaf-store`. `publishedAt <= now()` is the gate the kernel's `isPubliclyServeable` reads (`CACHE-AUTH-005`).
- **`leaves`**, the gated current-version store: the head rows with `draft` computed as `NOT EXISTS (a live row)`, a stored draft column ignored, as README → Seams asks.

`listLocalised` reads none on both for now; the localised live view over the pointer's keyed view is #343. An id that is no canonical UUID names no node and has no facts.

| Export | What it is |
| --- | --- |
| `makePublications(config)`, `Publications<Leaf, E, I>`, `PublishGated<E, I>` | One `{ facts, live, leaves }` per leaf of the pointer. |

## `./documents`

The kernel's content-addressed `DocumentStore` (README → Seams → `DocumentStore`, `DOC-001`): one table per document family, built by `makeDocumentTable({ schema, name })`, with the hash the database generates to the kernel's contract:

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

## `./filter`

The kernel's read predicates as Drizzle SQL, to the contract table under the kernel's [`./filter`](../pulpit/README.md#filter), so the SQL store and the kernel's `evaluate` agree row for row (the integration suite checks every node, and every row × viewer through the kernel's own read scope, against the in-memory store):

- `renderListFilter(filter, columns)` is the `WHERE`, or `undefined` for `always`. A node over a column `columns` lacks is `false` (fail closed). `in` / `notIn` embed the seam's subquery. A string comparison and sort is by code point (`col::text COLLATE "C"`); a `uuid` column compares as text, so a value that is no UUID compares unequal instead of failing the query. A `NaN` or invalid-`Date` comparand, an empty `anyOf` and a set past `MAX_SET_VALUES` are `false`; an empty `noneOf` is `true`; `±Infinity` is bound as a `float8` literal. `anyOf` / `noneOf` render as `IN (…)` / `NOT IN (…)` lists of bound values, with the same `NULL` semantics as `= ANY` / `<> ALL`.
- `renderListOrder(orderBy, columns, id)` is `<key> ASC|DESC NULLS LAST, …, id ASC`.
- `distinctKey(column)` is a string column's code-point form, the key `distinct` reads.

## License

MIT
