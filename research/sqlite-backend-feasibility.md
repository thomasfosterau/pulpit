# What would a SQLite backend need for each tree-bound seam?

Research for thomasfosterau/pulpit#416. Checked 2026-11-20 against the repo checkout (`docs/seams.md`, `docs/drizzle-pg.md`, `packages/pulpit-drizzle-pg/src`), the published tarballs of `@thomasfosterau/effect-drizzle-ext{,-pg}@0.5.0`, `drizzle-orm@1.0.0-rc.5` (the version the workspace catalog pins) and `@effect/sql-{d1,libsql,sqlite-node,sqlite-do}@4.1.5`, and the sqlite.org, Cloudflare and Turso docs. Each claim's source is listed under [Sources](#sources).

## Summary

- **Plain SQLite (`node:sqlite` / better-sqlite3 / Bun / wasm), libSQL/Turso and Durable Object SQLite can fill every tree-bound seam.** None of them needs anything PostgreSQL-only that has no rewrite. The SQL changes are mechanical, apart from full-text and vector search, which need a different design. SQLite gives serializable isolation with a single writer [S-iso]. Writes that open with `BEGIN IMMEDIATE` therefore serialise more strongly than every `FOR UPDATE`, `FOR NO KEY UPDATE` and `pg_advisory_xact_lock` the PostgreSQL stores take. `@effect/sql-sqlite-node` [E-node] and libSQL's `"write"` mode [T-tx] both begin with `BEGIN IMMEDIATE`.
- **Blocker 1, Cloudflare D1: no interactive transactions.** `@effect/sql-d1`'s `transactionAcquirer` is `Effect.die("transactions are not supported in D1")` [E-d1]. Drizzle's `effect-d1` session routes `transaction()` through it [D-d1]. D1's only atomic unit is `batch()` [CF-batch]. Every kernel write runs inside the caller's `transact` (`R` is the ambient transaction) and reads before it writes: the chain's head, then the append; `countAt`, then the insert; `lock`, then `close`. A batch can't hold that read-then-write shape, so D1 can't fill the seams without changing the kernel's transaction model. D1 also caps a query at 100 bound parameters, against the kernel's `MAX_SET_VALUES` of 1000 [CF-limits].
- **Blocker 2, library: effect-drizzle-ext 0.5.0 has no SQLite chain and its core is PostgreSQL-bound.** No `effect-drizzle-ext-sqlite` (or `-d1`, or `-libsql`) package exists on npm. The "driver-agnostic" core imports `drizzle-orm/pg-core` in `versioned-chain`, `columns`, `constraints`, `derive`, `references` and `sort`. Its `ReadSurface` requires `selectDistinctOn`, which SQLite's Effect database lacks. `transact` is typed on `PgTransactionConfig`. `./errors` classifies PostgreSQL SQLSTATEs only (`23505`). Drizzle's side, by contrast, is ready: rc.5 ships `effect-sqlite-node`, `-bun`, `-wasm` and `-do`, plus `effect-libsql` and `effect-d1` [D-pkg].
- **Blocker 3, search (`./Search`, the vector branch over `./Embeddings`): no in-core equivalent.** FTS5 is an index you maintain, not an expression you rank in a view [S-fts5]. Vectors need libSQL's native type [T-vec], a pre-v1 extension (sqlite-vec [VEC]) that D1 and Durable Objects can't load, or Vectorize outside SQL. Vectorize can't put the scope filter into the statement that ranks, which the `SearchBranch` contract requires.

## effect-drizzle-ext and Drizzle status

| Layer | PostgreSQL today | SQLite status | What's missing |
| --- | --- | --- | --- |
| Drizzle dialect | `drizzle-orm/pg-core` | `drizzle-orm/sqlite-core`, with an Effect database in `sqlite-core/effect` (rc.5) | Not in sqlite-core: `selectDistinctOn` (0 occurrences in `sqlite-core/effect/db.d.ts`, against 5 in pg), `.for()` row locks (only `pg-core` `select.d.ts` declares `for(strength)`), schemas (`pgSchema` → none) and `nullsNotDistinct`. Bigints use `blob({ mode: "bigint" })` or `numeric({ mode: "bigint" })`. |
| Drizzle Effect drivers | `effect-postgres` over `@effect/sql-pg` | `effect-sqlite-node`, `effect-sqlite-bun`, `effect-sqlite-wasm`, `effect-sqlite-do`, `effect-libsql`, `effect-d1` over the matching `@effect/sql-*` peers [D-pkg] | Nothing on Drizzle's side. Transactions: node uses `BEGIN IMMEDIATE` with savepoints [E-node]; libSQL uses `sdk.transaction("write")` with savepoints [E-libsql]; DO uses `ctx.storage.transaction` [E-do]; D1 dies [E-d1]. |
| effect-drizzle-ext core (`./database`) | `makeDatabaseServices` | Shape is generic (`Database`, `CurrentTransaction`, `transact`). | `ReadSurface` lists `selectDistinctOn`, and `TransactionalDatabase.transaction` takes `PgTransactionConfig`. Both must widen before a SQLite db satisfies them. |
| effect-drizzle-ext core (`./versioned-chain`) | `makeTreeTables` / `makeTreeViews` build `uuid`, `bigint`, `timestamp` columns and `pgSchema` views. The current-version view is a `NOT EXISTS` anti-join; the pointer (live) view is `selectDistinctOn([id]) … ORDER BY id, seq DESC` with `at <= now()`. | None | A dialect parameter, or a sqlite twin: `text`/`blob` ids, a bigint mode, ISO-text or integer-ms timestamps, table-name prefixes instead of schemas. The pointer view becomes `ROW_NUMBER() OVER (PARTITION BY id ORDER BY seq DESC) = 1` [S-win] or a `NOT EXISTS` newer-fact anti-join. |
| effect-drizzle-ext core (`./columns`, `./errors`) | `bytea`, `tsvector`, `jsonbSchema`; SQLSTATE `23505` | None | `blob` and JSON-text columns. An error classifier for `SQLITE_CONSTRAINT_PRIMARYKEY` / `_UNIQUE`, which the chain's `VersionConflict` / `NodeAlreadyExists` and every `onUniqueViolation` depend on. |
| `-pg/chain` (`makeVersionChain`) | Append-only inserts, the `(id, version)` PK as the race guard, `max()`, `SELECT gen_random_uuid()` to mint ids | None | An `-sqlite/chain`. The logic carries over unchanged (no locks, PK conflict as the guard), with ids minted in JS (`crypto.randomUUID()`) and the SQLite unique-violation classifier. |
| `-pg` testing / migrations / tooling | Testcontainers PG, sentinel rollback, drift guards | None | A file or `:memory:` runner (simpler than PG's), a migration runner, and drift guards over drizzle-kit's sqlite dialect. |

Shortest path: generalise core's types over the dialect, then publish an `effect-drizzle-ext-sqlite` binding (node/libsql/DO; D1 excluded or batch-only) carrying `./chain`. Then add a `pulpit-drizzle-sqlite` package mirroring `pulpit-drizzle-pg`'s modules.

## Cross-cutting PostgreSQL features → SQLite

| PostgreSQL feature (where) | SQLite equivalent | Blocker? |
| --- | --- | --- |
| `count(*) OVER ()` unpaged total (LeafStore, Edges, Proposals, Reports, Social, Memberships) | Window functions since 3.25.0; every built-in aggregate works as a window aggregate [S-win] | No |
| `DISTINCT ON (id) … ORDER BY id, …` (localised list, pointer view, `scheduled`) | Not in SQLite's grammar [S-select]. Use `ROW_NUMBER() OVER (PARTITION BY id ORDER BY …) = 1` [S-win]. The bare-column `min()`/`max()` trick picks a row arbitrarily on ties, so don't use it [S-select]. | No (rewrite) |
| `= ANY($ids)` / one array parameter (`getMany`, `countBy`, `members`, `tally`, `lookup`, `scheduled`, `anyOf`/`noneOf`) | `IN (?, …)` (Drizzle `inArray`) within the 32766-variable default since 3.32.0 [S-limits], or one JSON parameter: `IN (SELECT value FROM json_each(?))` [S-json] | No; on D1, yes unless rewritten to `json_each`, since D1 allows 100 bound parameters [CF-limits] |
| `array_position($locales, locale)` (localised list) | `json_each(?)`'s `key` column as the rank, joined on `value = locale` [S-json] | No |
| `COLLATE "C"` on strings and on the text `id` tiebreak | The default `BINARY` collation compares with `memcmp()` [S-types]. On UTF-8 text that is code-point order, so drop the clause (or say `COLLATE BINARY`). | No |
| `NULLS LAST` on every key | Supported (`ASC NULLS LAST`); SQLite's defaults are NULLS first ascending and last descending [S-select] | No |
| Scalar sort keys of one type | Columns are dynamically typed, and mixed storage classes sort NULL < numbers < text < blob [S-types]. Needs `STRICT` tables or CHECKs to keep a column to one type. | No (discipline) |
| `timestamptz` (µs) and `now()` (`published`, live view `at <= now()`, `scheduled`, defaults) | No timestamp type. Store ISO-8601 text (sorts lexically) or integer ms; `now()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Millisecond precision matches the JS `Date` the fakes use. | No |
| `uuid`, `gen_random_uuid()` (chain `mintId`, proposals, reports, edges) | Text (lowercase) or 16-byte blob; mint in JS. A lowercase-hex text uuid under BINARY sorts like the uuid's bytes. | No |
| `bigint` versions | INTEGER is 64-bit; Drizzle needs a bigint mode (`blob`/`numeric` `mode: "bigint"`) | No |
| `jsonb` (proposal `patch`/`locales`, external-id `baseline`, collection member arrays, working copies) | JSON text, with the JSON functions built in since 3.38.0. SQLite's own JSONB (3.45.0) isn't binary-compatible with PostgreSQL's [S-json], but nothing here relies on jsonb's equality or ordering. | No |
| `ON CONFLICT … DO NOTHING / DO UPDATE … WHERE` + `RETURNING` | UPSERT; RETURNING since 3.35.0, which reports both inserted and updated rows of an upsert [S-ret]; Drizzle's sqlite insert has `onConflictDoUpdate({ setWhere, targetWhere })` and `.returning()` | No |
| Data-modifying CTEs (`WITH … DELETE … INSERT`, a `RETURNING` read as a subquery) (Collections `replace`, Reactions `upsert` returning the replaced kind, Proposals `eraseAuthor`) | A CTE body is a `select-stmt` only [S-with], and a RETURNING statement "cannot be used as a subquery" [S-ret]. Use several statements in the one transaction; SQLite's later statements see the earlier ones' writes. | No (rewrite) |
| `DELETE … LIMIT` style batched erasure (`eraseAccount`, `eraseReporter`, `reassignOwner`) | `DELETE … LIMIT` needs the `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile option [S-del]. Use `WHERE rowid IN (SELECT rowid … LIMIT ?)` or a row-value `IN` [S-expr]. | No |
| `IS NOT DISTINCT FROM`; aggregate `FILTER (WHERE …)` (redaction marker) | `IS NOT DISTINCT FROM` is an alternative spelling of `IS` [S-expr]; `FILTER (WHERE expr)` is supported [S-agg] | No |
| Unique index `NULLS NOT DISTINCT` (edge natural key) | Not available: a UNIQUE index treats every NULL as distinct [S-idx]. Use a unique index on `ifnull(col, <sentinel>)` (expression indexes are allowed) [S-idx]. | No (workaround) |
| Partial unique index (one canonical path per node) | Supported [S-idx] | No |
| `FOR UPDATE` / `FOR NO KEY UPDATE` (Paths `claim`, Proposals/Reports `lock`, Edges `countAt`, Reactions) | No row locks; locking is database-wide, with one writer at a time and serializable isolation [S-iso]. Under `BEGIN IMMEDIATE` [S-tx] the whole write transaction is already exclusive, so the lock statement becomes a plain read. Edges' READ COMMITTED / lock-order rules hold trivially. | No |
| `pg_advisory_xact_lock(hashtext(pair))` (Social follow vs block) | Implied by the single writer under `BEGIN IMMEDIATE` | No |
| Session-level `pg_advisory_lock` across the publication cache refresh (`docs/seams.md` → "Publication serialises per node") | None in SQLite. The seam already allows an in-process mutex (embedded SQLite in one process) or a Durable Object per node. Remote libSQL with several app instances needs a lease row or a DO. | No (application's) |
| `digest(document_jsonb::text,'sha256')` generated `bytea` key (Documents) | No SHA-256 built in. A generated column may use only deterministic scalar functions, so no app-defined one [S-gen]. Compute the hash in JS over the kernel's `canonicalText` (already the contract for non-PG stores) and store a blob or hex text; note `hex()` is uppercase. | No |
| `tsvector` / `websearch_to_tsquery` / `ts_rank_cd` / `setweight` (Search `fullTextRank`) | FTS5: a virtual-table index kept in sync by triggers or external content, `bm25()` with per-column weights (lower is better), unicode61 and porter tokenizers [S-fts5]. The vector can't be an expression evaluated in a view, so the `fullTextRank({ vector: (columns) => SQL })` API doesn't port. D1 supports FTS5 [CF-sql]. | **Yes, redesign** (FTS tables per version row, ids mapped to FTS rowids) |
| pgvector `vector(n)` and `<=>` (Embeddings column, vector `SearchBranch`) | libSQL: `F32_BLOB(n)`, `vector_distance_cos`, `libsql_vector_idx`, `vector_top_k` [T-vec]. Plain SQLite: the sqlite-vec extension (`vec0`, pre-v1) [VEC]. D1 and DO can't load extensions; Cloudflare's answer is Vectorize [CF-vec], outside SQL. The `double precision[]` fallback becomes a blob or JSON column. | **Yes, per platform** (libSQL fine; plain SQLite needs an extension; D1/DO can't rank in-statement) |
| Interactive transactions, savepoints (`transact` always-open, nested = savepoint) | SQLite: SAVEPOINT / RELEASE [S-tx]; node, libSQL and DO drivers support them [E-node, E-libsql, E-do]. libSQL's interactive transactions lock the database for writing, with a 5-second timeout [T-tx]. D1: none [E-d1, CF-batch]. | **Yes on D1 only** |

## Seam by seam

"Blocker" is for libSQL, node SQLite and DO SQLite unless a row says otherwise. D1 is blocked for every writing seam by the transaction gap above.

| Seam (`pulpit-drizzle-pg` module) | PostgreSQL features its SQL relies on | SQLite equivalent | Blocker? |
| --- | --- | --- | --- |
| `VersionChain` (`./VersionChain` over `-pg/chain`) | `(id, version)` PK as race guard (`23505` → `VersionConflict`), `max(version)`, `gen_random_uuid()`, `bigint`, `uuid`, an ambient transaction, cascade purge | The same PK guard; under `BEGIN IMMEDIATE` a race serialises and still surfaces as a PK conflict or `StaleVersion`. JS-minted ids, a bigint mode, `ON DELETE CASCADE` (needs `PRAGMA foreign_keys=ON`). | No SQL blocker; **needs `-sqlite/chain` and a SQLite error classifier** |
| `LeafStore` / `Filter` (`./LeafStore`, `./Filter`) | Current-version view (`NOT EXISTS` anti-join), `= ANY`, `count(*) OVER ()`, `SELECT DISTINCT … ORDER BY col COLLATE "C"`, `NULLS LAST`, `::text COLLATE "C"`, `now()`, `IN (subquery)` for followers/groups | All present. Drop `COLLATE "C"` (BINARY is code-point order); `CAST(x AS TEXT)`; `now()` → `strftime`. | No |
| Localised `LeafStore` (`listLocalised`) | `DISTINCT ON (id)`, `array_position($locales, locale)`, `locale = ANY($locales)` | `ROW_NUMBER() OVER (PARTITION BY id ORDER BY rank)` with rank from `json_each(?)` | No (rewrite) |
| `PublicationStore` / `LiveView` (`./Publication`) | Pointer view by `selectDistinctOn`, `at <= now()`, `scheduled` with `DISTINCT ON` + `NOT EXISTS`, `UNION ALL` of head and live rows, a `serial` seq | Window or anti-join rewrites; `INTEGER PRIMARY KEY` seq; `UNION ALL` is standard. The cross-refresh lock is the application's (mutex/DO). | No (view builder must be rewritten in effect-drizzle-ext) |
| `DocumentStore` (`./Documents`) | `jsonb`, pgcrypto `digest` in a generated `bytea` PK, `encode(…,'hex')`, `ON CONFLICT DO NOTHING RETURNING` | Hash in JS over `canonicalText`; JSON text; blob/hex key; upsert + RETURNING | No |
| `PathStore` (`./Paths`) | Partial unique index `WHERE canonical`, `FOR UPDATE`, `ON CONFLICT DO UPDATE` | Partial unique index; writer lock replaces `FOR UPDATE`; upsert | No |
| `ProposalStore` (`./Proposals`) | `jsonb`, `gen_random_uuid`, `FOR UPDATE OF`, correlated `MAX(version)`, window total, CTE-based `eraseAuthor … LIMIT` | JSON text; JS ids; writer lock; correlated subquery; window; split statements with a `rowid IN (… LIMIT)` | No |
| `ReportStore` (`./Reports`) | `FOR UPDATE OF`, window total, `gen_random_uuid`, bounded erasure | As for proposals | No |
| `EdgeStore` (`./Edges`) | `FOR NO KEY UPDATE` lock in ascending id under READ COMMITTED, `NULLS NOT DISTINCT` unique key, `IS NOT DISTINCT FROM`, `ON CONFLICT DO NOTHING RETURNING`, `= ANY`, `members` as an un-materialised subquery, `count(*) OVER ()` | Single writer (lock is a no-op read); `ifnull()` expression unique index; `IS`; upsert; `IN`/`json_each`; subqueries | No |
| `EmbeddingStore` (`./Embeddings`) | `bytea` hash key, pgvector `vector(n)` or `double precision[]`, `queued_at DEFAULT now()`, `ON CONFLICT DO NOTHING` | Blob key; `F32_BLOB(n)` on libSQL, or a blob/JSON array elsewhere; the queue is plain | No for the store; ranking is the Search row |
| `SearchBranch` (`./Search`) | `to_tsvector`/`setweight`, `websearch_to_tsquery`, `ts_rank_cd`, trigram `similarity`, pgvector `<=>`, the scope rendered in the ranking statement, gated rows (head or live) | FTS5 tables over every searchable version row, joined to the view on the FTS rowid → node id, `bm25()` weights; vector via libSQL `vector_top_k`/`vector_distance_cos` or sqlite-vec | **Yes: redesign of the full-text API; vector unavailable in-statement on D1/DO** |
| `ExternalIdStore` (`./ExternalIds`) | Two unique keys, `jsonb` baseline, `= ANY`, `ON CONFLICT DO NOTHING RETURNING` | Same, with JSON text | No |
| `CollectionStore` (`./Collections`) | One-statement CTE `DELETE` + `INSERT … ON CONFLICT DO UPDATE` | Two statements in the transaction (SQLite has no data-modifying CTE) | No |
| `ReactionStore` (`./Reactions`) | CTE reading the replaced kind `FOR UPDATE` + upsert in one statement, `GROUP BY` tally over `= ANY`, row-value `IN (… LIMIT)` erasure | `SELECT` then upsert in the transaction; `IN`; row values are supported [S-expr] | No |
| `SocialStore` (`./Social`) | `pg_advisory_xact_lock(hashtext(…))` on the account pair, `INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING RETURNING`, window total | Single writer replaces the advisory lock; the rest is standard | No |
| `MembershipStore` / `GroupOwnerStore` (`./Memberships`) | `ON CONFLICT DO UPDATE … WHERE status='pending' RETURNING`, `UPDATE … WHERE role <> $role RETURNING`, bounded erasure, `UPDATE … WHERE id IN (SELECT … LIMIT)` | Upsert with `setWhere`; RETURNING; subquery `LIMIT` | No |
| `PurgeStore` / `AccountErasureStore` (`./Erasure`) | Cascade from `core.node`, `DELETE … RETURNING` hashes, `DELETE … WHERE hash = ANY AND NOT EXISTS`, `GROUP BY … HAVING MAX(…) FILTER (WHERE …) > COALESCE(MAX(…) FILTER …, -1)`, `IS NOT DISTINCT FROM` | `ON DELETE CASCADE` with `foreign_keys=ON`; `DELETE … RETURNING` (rows in arbitrary order [S-ret]); `FILTER`; `IS` | No |

The seams `docs/drizzle-pg.md` lists as not tree-bound (budgets, working copies, notifications, `VersionedKv`) use only upsert, `ON CONFLICT … DO UPDATE … WHERE version <= excluded.version`, `ORDER BY … LIMIT` and `count(*)`. All of that ports directly.

## Open points (not verified here)

- Which SQLite release D1 and libSQL run today. The rewrites above assume ≥ 3.35 for RETURNING, ≥ 3.38 for built-in JSON and ≥ 3.39 as a safe floor for the `IS NOT DISTINCT FROM` spelling (sqlite.org gives no version for that spelling). Check with `SELECT sqlite_version()`.
- FTS5's `trigram` tokenizer, as the replacement for a `similarity` branch, wasn't checked against the docs' version notes.
- Whether DO SQLite's single-threaded object model, one database per object, fits a CMS-wide tree. It gives transactions, but splits data across objects.

## Sources

- [S-ret] SQLite, RETURNING: https://www2.sqlite.org/lang_returning.html. Since 3.35.0; cannot be a subquery; upsert reports inserted and updated rows; arbitrary order.
- [S-with] SQLite, WITH clause: https://www2.sqlite.org/lang_with.html. The CTE body is a `select-stmt`.
- [S-tx] SQLite, transactions: https://www2.sqlite.org/lang_transaction.html. DEFERRED, IMMEDIATE and EXCLUSIVE; SQLITE_BUSY on a failed upgrade; SAVEPOINT for nesting.
- [S-iso] SQLite, isolation: https://www2.sqlite.org/isolation.html. Serializable; a single writer at a time; WAL snapshot reads.
- [S-limits] SQLite, limits: https://www2.sqlite.org/limits.html. `SQLITE_MAX_VARIABLE_NUMBER` is 32766 after 3.32.0.
- [S-types] SQLite, datatypes: https://www2.sqlite.org/datatype3.html. BINARY uses `memcmp()`; storage-class sort order.
- [S-select] SQLite, SELECT: https://www2.sqlite.org/lang_select.html. NULLS FIRST/LAST; no DISTINCT ON; bare-column min/max rules.
- [S-win] SQLite, window functions: https://www2.sqlite.org/windowfunctions.html. Since 3.25.0; built-in aggregates as window functions.
- [S-gen] SQLite, generated columns: https://www2.sqlite.org/gencol.html. Since 3.31.0; deterministic scalar functions only.
- [S-idx] SQLite, CREATE INDEX: https://www2.sqlite.org/lang_createindex.html. NULLs distinct in UNIQUE; partial and expression indexes.
- [S-agg] SQLite, aggregate functions: https://www2.sqlite.org/lang_aggfunc.html. `FILTER (WHERE expr)`.
- [S-expr] SQLite, expressions: https://www2.sqlite.org/lang_expr.html. `IS NOT DISTINCT FROM` is `IS`; row values.
- [S-json] SQLite, JSON: https://www2.sqlite.org/json1.html. Built in since 3.38.0; JSONB 3.45.0, not PostgreSQL-compatible; `json_each`.
- [S-del] SQLite, DELETE: https://www2.sqlite.org/lang_delete.html. LIMIT only with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
- [S-fts5] SQLite, FTS5: https://www2.sqlite.org/fts5.html. External content and triggers; `bm25()` column weights; tokenizers.
- [CF-limits] Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/. 100 bound parameters per query; 10 GB per database.
- [CF-batch] Cloudflare D1 Worker API: https://developers.cloudflare.com/d1/worker-api/d1-database/. `batch()` is the transaction; it rolls back the whole sequence on failure.
- [CF-sql] Cloudflare D1 SQL statements: https://developers.cloudflare.com/d1/sql-api/sql-statements/. FTS5, JSON and math supported.
- [CF-do] Cloudflare DO SQLite storage API: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/. `sql.exec()` can't run `BEGIN`/`SAVEPOINT`; use `ctx.storage.transaction()` / `transactionSync()`.
- [CF-vec] Cloudflare Vectorize: https://developers.cloudflare.com/vectorize/. Vectors live outside D1.
- [T-tx] Turso `@libsql/client` reference: https://docs.turso.tech/sdk/ts/reference. `write` = `BEGIN IMMEDIATE`; interactive transactions lock writes, with a 5-second timeout.
- [T-vec] Turso AI and embeddings: https://docs.turso.tech/features/ai-and-embeddings. `F32_BLOB`, `vector_distance_cos`, `libsql_vector_idx`, `vector_top_k`.
- [VEC] sqlite-vec: https://github.com/asg017/sqlite-vec. `vec0` KNN; pre-v1.
- [D-pkg] `drizzle-orm@1.0.0-rc.5` tarball (registry.npmjs.org). Top-level `effect-sqlite-{node,bun,wasm,do}`, `effect-libsql` and `effect-d1`; `sqlite-core/effect`; peers `@effect/sql-{sqlite-node,sqlite-bun,sqlite-wasm,sqlite-do,libsql,d1}`. `sqlite-core` has no `selectDistinctOn` and no `for()`.
- [D-d1] `drizzle-orm@1.0.0-rc.5` `effect-d1/session.js`. `transaction()` → `client.withTransaction`.
- [E-d1] `@effect/sql-d1@4.1.5` `dist/D1Client.js`. `transactionAcquirer = Effect.die("transactions are not supported in D1")`.
- [E-libsql] `@effect/sql-libsql@4.1.5` `dist/LibsqlClient.js`. `sdk.transaction("write")`, `SAVEPOINT effect_sql_<n>`.
- [E-node] `@effect/sql-sqlite-node@4.1.5` `dist/SqliteClient.js`. `beginTransaction: … "BEGIN IMMEDIATE"`.
- [E-do] `@effect/sql-sqlite-do@4.1.5` `dist/SqliteClient.js`. Storage-backed `withTransaction` when given `ctx.storage`, otherwise unsupported.
- [EDX] `@thomasfosterau/effect-drizzle-ext@0.5.0` and `-pg@0.5.0` tarballs: README entry tables; `dist/*.js` imports of `drizzle-orm/pg-core`; `database.d.ts` (`ReadSurface.selectDistinctOn`, `PgTransactionConfig`); `errors.js` (`UNIQUE_VIOLATION = "23505"`); `versioned-chain.js` (`selectDistinctOn` pointer view, `now()`); `-pg` `chain.js` (`SELECT gen_random_uuid()`). npm has no `@thomasfosterau/effect-drizzle-ext-{sqlite,d1,libsql}` (registry 404).
- Repo: `docs/seams.md`, `docs/drizzle-pg.md`, `packages/pulpit-drizzle-pg/src/*.ts` (grep of `FOR UPDATE`, `FOR NO KEY UPDATE`, `pg_advisory_xact_lock`, `DISTINCT ON`, `array_position`, `ANY(`, `COLLATE "C"`, `websearch_to_tsquery`, `vector(`), `packages/pulpit/src/Filter.ts` (`MAX_SET_VALUES = 1000`), `pnpm-workspace.yaml` (catalog `drizzle-orm: 1.0.0-rc.5`, `effect-drizzle-ext ^0.5.0`).
