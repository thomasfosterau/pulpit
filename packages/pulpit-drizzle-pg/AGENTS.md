# packages/pulpit-drizzle-pg — `@thomasfosterau/pulpit-drizzle-pg`

The kernel's tree-bound seams over the tables and views `@thomasfosterau/effect-drizzle-ext` derives from an application's `defineTree`, on PostgreSQL through `@thomasfosterau/effect-drizzle-ext-pg`: the `VersionChain` port, leaf, publication, document, path, search, proposal, edge, embedding, external-id, collection, reaction, report, social, membership and erasure stores, and the `ListFilter` → SQL renderer. `src/internal/` holds the chain mapping, the owner table, the node-id check and the shared row source. Private until published ([docs/PUBLISHING.md](../../docs/PUBLISHING.md)).

## Boundary

- `src/` imports only `effect`, `@thomasfosterau/pulpit`, `@thomasfosterau/effect-drizzle-ext(-pg)` and `drizzle-orm` (peers); never `@effect/sql-pg`, `pg` or `node:*`. The pool is the application's. Tests may use the dev-only `@effect/sql-pg`, `@effect/platform-node` and `drizzle-kit`.
- Import the kernel by name through its exports only, as `pulpit-wordpress` does ([its AGENTS.md](../pulpit-wordpress/AGENTS.md#boundary)).
- No pulpit vocabulary in effect-drizzle-ext: the owner row, `proposedBy` and the list filter are spelled here. A capability it lacks is a change there, never a patch here.
- **Delegate the chain discipline.** Every `VersionChain` operation but `purge` is `-pg/Chain`'s own; map inputs and errors one to one and add nothing between the head read and the append. `versionChainConformance` proves it against PostgreSQL.

## Invariants

- **Errors map one to one** to the kernel's classes of the same name; `BrokenChain` stays a defect. Merging or renaming one changes the wire's 404 / 409 / 412.
- **`purge` is the only delete of version rows**: one identity-row delete scoped to the leaf's `type`, cascading through every level.
- **The SQL filter and the kernel's `evaluate` never disagree**; a node over a column the view lacks is `false`. The integration suite checks both against `makeInMemoryLeafStore`.
- **A wire id never fails a query**: a non-canonical UUID names no node (`src/internal/node-id.ts`).
- **No view key has two sources**: `makeLeafStores` refuses such a tree at module load.
- **Every leaf-shaped read goes through one row source** (`src/internal/rows.ts`); never re-spell a read per seam.
- **Locks are part of the contract**: `PathStore.claim`, `ProposalStore.lock` / `close` and `ReportStore.lock` / `close` lock `FOR UPDATE` and update only while open/pending; an edge's cardinality lock is `FOR NO KEY UPDATE` so it never blocks inserts; `addFollow` and `addBlock` share an advisory pair lock.
- **A stored document is never rewritten** (`DOC-001`): `INSERT … ON CONFLICT DO NOTHING`, hashed by the database's `digest(document::text, 'sha256')`, pinned to the kernel's `canonicalText`.
- **A search branch ranks inside its scope** (`SEC-AUTH-ENUM-001`): the scope renders into the ranking statement's `WHERE`, never filters ranked ids after.
- **A pending invitation is not a membership**: membership reads filter `status = 'active'`.
- **Erasure deletes only what it is bounded to** ([docs/drizzle-pg.md](../../docs/drizzle-pg.md) lists the statements).
- **Stores never open a transaction or a connection**: every statement yields the caller's `CurrentTransaction`.
- **A contributor is never dropped**: `proposedBy` without a column to record it dies (`ProposedByUnrecorded`).

## Tests

- `test:unit` needs no database: the conformance suite over a fake `-pg/Chain`, and construction over `tests/fixtures/tree.ts`.
- `test:integration` runs against PostgreSQL: `DATABASE_URL_TEST` (already migrated) wins; else the `PG*` server, on which it builds its own database from the fixture schema; else Testcontainers (needs Docker and `@testcontainers/postgresql`, not installed). CI runs it with a `postgres` service. Each case starts from truncated tables; the race faults are real rows and triggers.
- docgen `@example`s build the stores but never run them against a database.
