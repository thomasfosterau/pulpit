# @thomasfosterau/pulpit-drizzle-pg

The tree-bound seams of [`@thomasfosterau/pulpit`](../pulpit/README.md) over the tables and views [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext) derives from an application's tree, on PostgreSQL through `@thomasfosterau/effect-drizzle-ext-pg`. An application declares its versioned ontology once with `defineTree`, derives its tables with `makeTreeTables`, and gets the kernel's ports for every leaf from this package.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published.** The package is `"private": true` until the owner sets up its publishing ([PUBLISHING.md](../../PUBLISHING.md)). The spec is [pulpit#247](https://github.com/thomasfosterau/pulpit/issues/247), and it lands in slices:

- **Landed:** the `VersionChain` port over `-pg/chain` ([`./version-chain`](#version-chain)), passing the kernel's `versionChainConformance` against PostgreSQL; the `LeafStore` over the tree's leaf views and the owner table ([`./leaf-store`](#leaf-store)), with the `ListFilter` → SQL renderer and the list order ([`./filter`](#filter)), checked row by row against the kernel's in-memory store on PostgreSQL.
- **Landed:** the `PathStore` over a path table per routable namespace ([`./paths`](#paths)), checked step by step against the kernel's in-memory store on PostgreSQL.
- **Next:** `PublicationStore` / `LiveView` (#338), the `DocumentStore` (#339), the localised `LeafStore` (#335) and `SearchBranch` (#336).

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
| `./paths` | `makePathTable` / `makePathStore`: the kernel's `PathStore`, one table per routable namespace. |
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
- **`listLocalised`** reads none over a leaf view, which has no locale level; the localised store over the keyed view is a later slice.
- **`ownerOf` / `stampOwner`** read and insert the owner row.
- **Every read and write runs in the caller's `CurrentTransaction`**: no store opens a connection or a transaction, so a handler's `transact` covers the chain write, the owner stamp and the read back.

**The view-merge trap is refused at module load.** A tree view merges its sources by key (`{ ...identityExtras, ...levels, timestamp, createdAt }`), so a key two sources share keeps the later silently: an identity `slug` shadowed by a level's `slug`, or a level column named `createdAt` shadowed by the birth timestamp. `makeLeafStores` throws a `DerivationError` naming both sources instead, for any key an identity extra, a level on the leaf's path and the view's own projection (`id`, `version`, `action`, `timestamp`, `createdAt`, `ownerId`) share.

| Export | What it is |
| --- | --- |
| `makeLeafStores(config)` | One `LeafStore` per leaf view. |
| `LeafStores<Leaf, E, I>` | Its result. |
| `makeNodeOwnerTable({ schema, identity, name? })`, `NodeOwnerTable` | The owner table (`node_owner` by default): `node_id` primary key, cascading from the identity row, and `owner_id`, indexed. |
| `OWNER_COLUMN` | `"ownerId"`, the key the owner joins in under. |
| `StoreQueryError<Relations>` | The driver's query error. |

## `./paths`

The kernel's `PathStore` (README → Seams → `PathStore`, pulpit#57) for `routable`: one path table per routable namespace, `makePathTable({ schema, name, identity })`, `(path PRIMARY KEY, node_id → node.id ON DELETE CASCADE, canonical)` with a partial unique index (`node_id WHERE canonical`) holding at most one canonical row per node. `makePathStore({ table, CurrentTransaction })` binds it:

- `lookup(path)` is the row by key, `canonicalOf(id)` the node's canonical row, `release(id)` deletes it and keeps the aliases.
- `claim(id, path)` is the uniqueness pre-check, then the claim. It reads the row at `path` `FOR UPDATE` and fails `PathTaken` when another node holds it canonically, **before writing anything**; it then turns the node's previous canonical row into an alias and upserts `path` as its canonical row, over an alias at `path` (the node's own, which a revert promotes, or another node's, which the claim takes over). The upsert is guarded by the key: `ON CONFLICT (path) DO UPDATE … WHERE NOT canonical OR node_id = $id`, so a concurrent claim that took the path after the check makes this one `PathTaken` instead of overwriting it (the integration suite races two). The caller's transaction then rolls back the alias it made, as `routable` rolls back the append.
- `PathTaken` names the path, never the holder. An id that is no canonical UUID holds no path. Every call runs in the caller's `CurrentTransaction`.

A node-level slug on the identity table (`identityColumns: { slug }`) is a different thing: `makeLeafStores` refuses one that shares a key with a level column (the view-merge trap).

| Export                                                   | What it is                  |
| -------------------------------------------------------- | --------------------------- |
| `makePathTable({ schema, name, identity })`, `PathTable` | One namespace's path table. |
| `makePathStore(config)`                                  | The `PathStore` over it.    |

## `./filter`

The kernel's read predicates as Drizzle SQL, to the contract table under the kernel's [`./filter`](../pulpit/README.md#filter), so the SQL store and the kernel's `evaluate` agree row for row (the integration suite checks every node, and every row × viewer through the kernel's own read scope, against the in-memory store):

- `renderListFilter(filter, columns)` is the `WHERE`, or `undefined` for `always`. A node over a column `columns` lacks is `false` (fail closed). `in` / `notIn` embed the seam's subquery. A string comparison and sort is by code point (`col::text COLLATE "C"`); a `uuid` column compares as text, so a value that is no UUID compares unequal instead of failing the query. A `NaN` or invalid-`Date` comparand, an empty `anyOf` and a set past `MAX_SET_VALUES` are `false`; an empty `noneOf` is `true`; `±Infinity` is bound as a `float8` literal. `anyOf` / `noneOf` render as `IN (…)` / `NOT IN (…)` lists of bound values, with the same `NULL` semantics as `= ANY` / `<> ALL`.
- `renderListOrder(orderBy, columns, id)` is `<key> ASC|DESC NULLS LAST, …, id ASC`.
- `distinctKey(column)` is a string column's code-point form, the key `distinct` reads.

## License

MIT
