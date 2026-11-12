# @thomasfosterau/pulpit-drizzle-pg

The tree-bound seams of [`@thomasfosterau/pulpit`](../pulpit/README.md) over the tables and views [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext) derives from an application's tree, on PostgreSQL through `@thomasfosterau/effect-drizzle-ext-pg`. An application declares its versioned ontology once with `defineTree`, derives its tables with `makeTreeTables`, and gets the kernel's ports for every leaf from this package.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published.** The package is `"private": true` until the owner sets up its publishing ([PUBLISHING.md](../../PUBLISHING.md)). The spec is [pulpit#247](https://github.com/thomasfosterau/pulpit/issues/247), and it lands in slices:

- **Landed:** the `VersionChain` port over `-pg/chain` ([`./version-chain`](#version-chain)), passing the kernel's `versionChainConformance` against PostgreSQL.
- **Next:** `LeafStore` (the `ListFilter` → SQL renderer, the list-order contract, `distinct`, `ownerOf` / `stampOwner`), then `PublicationStore` / `LiveView`, the localised `LeafStore` and `SearchBranch`.

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

## License

MIT
