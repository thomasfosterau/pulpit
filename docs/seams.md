# Seams

The kernel is written against explicit interfaces, so that it doesn't depend on the packages that fill them before they publish. Each seam below states the shape its real implementation must have, and which package (if any) is expected to fill it; the issue numbers in parentheses are for maintainers and aren't needed to follow the contract. [`./testing`](#testing) has an in-memory fake of each store and of the follower seam, which implements the contract stated here.

## `VersionChain<E, R>`: the version-chain port

One leaf's chain, at the level of its operations (pulpit#246): `create`, `update`, `restore`, `delete`, `restoreVersion`, `getVersion`, `history` and `head` with effect-drizzle-ext `-pg/chain`'s `LeafChain` names, error channels and expected-version precondition, in the kernel's input types (`CreateInput`, `UpdateInput`, `Precondition`: `actorId` an `Option`, `proposedBy`, `locales`), plus `purge`. Every invariant in [`./version-chain`](history-and-review.md#version-chain) is the implementation's to hold, and `./testing`'s `versionChainConformance` is the suite it must pass; its errors name the leaf in `type`. `E` is the implementation's query error and `R` the ambient transaction; no operation opens a transaction itself.

Filled by `@thomasfosterau/pulpit-drizzle-pg`'s `makeVersionChains` (pulpit#247), delegating to `-pg/chain` over the tables effect-drizzle-ext derives from the application's tree:

- `create` / `update` / `restore` / `delete` / `restoreVersion` / `getVersion` / `history` / `head` are `-pg/chain`'s own, with the kernel's errors one to one (`NodeAlreadyExists`, `NodeNotFound`, `VersionNotFound`, `StaleVersion`, `VersionConflict`; `BrokenChain` a defect). `actorId` maps to the root version row's actor; `proposedBy` (the contributor whose accepted proposal a version applies, pulpit#49) to a root version extra (`versionColumns: { proposedBy }`, passed per write as `root`); `locales` to the chain's keyed level (`keyed`), keyed by tag, which `getVersion` returns as `locales`, omitting the key for a version that carries none. A family's translation lineage (pulpit#208, [`./translation`](participation.md#translation)) is three ordinary columns of that keyed level (`derivedFrom`, `derivedFromVersion` as text, `derivation`), so it needs nothing of the port beyond the locale level round-tripping every column it is given.
- `purge(id)` deletes the node's identity row, which cascades through every level of its chain (effect-drizzle-ext#145), as [`./purge`](erasure.md#purge)'s erasure, the documented exception to `VERSION-CHAIN-001/002`. It is a no-op for an unknown id.

The kernel keeps what is not storage: `defineVersionChain` runs a leaf's before-append hooks over the port (reading `head` and `getVersion`, then appending with `expectedVersion` pinned to that head), and `compare` is two `getVersion` reads and `diffStates`.

## `LeafStore<Row, Following, E, R>`: the current-version view

Filled by `@thomasfosterau/pulpit-drizzle-pg`'s `makeLeafStores` over the leaf's current-version view (pulpit#5, pulpit#247). Each row is a `LeafRow`: the node's `id`, the head row's `version` (a `bigint`, pulpit#65) and `action`, and the leaf's columns. The view projects `version` itself, from the same head row it reads `action` from, so a read costs no second query against the chain. `id`, `version` and `action` are the view's own names: no leaf column may take one. `columns` is the view's column names as an Effect `HashSet` (`HashSet.fromIterable(Object.keys(getColumns(view)))`, which includes `version`); `get` / `getMany` are `id = $id` / `id = ANY($ids)` reads with `LIMIT`; `list` renders its `ListFilter` (below), orders totally by its `orderBy` (below), and returns the page plus the unpaged total as a window column; `distinct({ column, where, limit, offset })` (pulpit#186) is `SELECT DISTINCT <column> … WHERE <where> AND <column> IS NOT NULL ORDER BY <column> COLLATE "C" LIMIT … OFFSET …` with the distinct count as `total` (a `NULL` or non-string value is no value), over the same rows `list` reads; `ownerOf` / `stampOwner` read and insert the node's owner row (`core.node_owner`).

**A localised leaf's view** (pulpit#56) is one row per `(id, locale)` the head carries: the locale level's row for that version, left-joined to the shared view, with the tag in a `locale` column (`LOCALE_COLUMN`). A node whose head carries no locale is one row with a `NULL` locale. `columns` includes `locale`; `list` reads these rows, and renders the `locale` filter arm over that column. `get` / `getMany` read the shared row, one per node, without the locale level. A publish-gated localised leaf's `LiveView.list` reads the same shape at the live version.

**The localised list read** (pulpit#272), `listLocalised({ where, orderBy, limit, offset, locales })`, serves one of those rows per node: of a node's rows matching `where` whose locale is in `locales`, the one whose locale comes first there. A node carrying none is absent. The chosen rows are then ordered and paged as `list` orders them, and `total` counts nodes:

```sql
SELECT *, count(*) OVER () AS total FROM (
  SELECT DISTINCT ON (id) * FROM view
  WHERE <where> AND locale = ANY($locales)
  ORDER BY id, array_position($locales, locale)
) chosen
ORDER BY <orderBy>, id LIMIT $limit OFFSET $offset
```

`LiveView.listLocalised` is the same over the rows `LiveView.list` chooses for its `headFor` (the head for the viewer's own rows, else the live version). A view without a locale level has no locale rows, so it reads none.

The list order contract (pulpit#112). `orderBy` arrives checked: every column is sortable (in the leaf's `sortable` list or, without one, in `columns`), every direction is `asc` or `desc`, and no column appears twice. Empty means `id` ascending alone. The store renders it as

```sql
ORDER BY <column> ASC|DESC NULLS LAST, …, id ASC
```

- **`NULLS LAST` in both directions**, spelled out on every key, because PostgreSQL defaults to `NULLS FIRST` for `DESC`.
- **`id ASC` closes every order, in byte order**, so no two rows tie and an `OFFSET` page never skips or repeats a row while the data holds still. A `uuid` id already sorts by its bytes; a text id needs `id COLLATE "C" ASC`, as the fake sorts ids by code point. Pagination is by `LIMIT` / `OFFSET`; there is no cursor to carry the order key.
- **A sort key's column holds one scalar orderable type**: text, numeric, boolean, timestamp or bigint. `json` / `jsonb` and array columns are outside the contract: PostgreSQL refuses to order `json`, and orders `jsonb` by its own rules, which the fake doesn't reproduce. An adapter must not offer such a column for sorting, and a leaf's `sortable` list must not name one.
- **A string key sorts with `COLLATE "C"`** (code-point order), as the filter's comparisons do. A store that sorts under another collation must accept that its order can differ from the in-memory fake's. A `Date` sorts by its instant, a number or `bigint` by value, and `false` before `true`; the fake places `NaN` after every number, as PostgreSQL's `float8` does.
- **Timestamp precision.** PostgreSQL stores a `timestamptz` to the microsecond and a JavaScript `Date` holds milliseconds, so two rows the fake sees as tied (the same millisecond, ordered by `id`) can be ordered by their microseconds in SQL. A test that needs both to agree should seed timestamps whole to the millisecond.
- **The order never changes membership.** It is applied after `where`, and `total` is the same under every order.

`makeInMemoryLeafStore` in [`./testing`](#testing) follows this contract.

## `ListFilter<Following>` → SQL: the filter renderer

The rendering contract is the table under [`./filter`](content-model.md#filter). `Following` is the follower seam's subquery (Drizzle's `SQLWrapper`), rendered as `col IN (<subquery>)`, never a materialised array. `published` / `notPublished` use the database's `now()` and are parenthesised. A string comparison (`gt` / `gte` / `lt` / `lte`) uses the `"C"` collation, so it orders by code point as `evaluate` does; `anyOf` / `noneOf` bind their values as one array parameter.

## The viewer, the role axes and the follower seam

effect-auth is a required peer of the kernel (pulpit#5, option (c)). It publishes the same rules: `OwnedAccess` (`canView`, `readScope`, the `IsFollower` service, read fail-closed, `serveableAxes`), `Guard` (`Unauthorized`, `Forbidden`, and the kit `Guard.make` returns: `requireRoleAtLeast`, `requireOwnerOrRole`), `Ladder` and `Cacheability.publiclyServeable`, plus `ownedListFilter` in `@thomasfosterau/effect-auth-drizzle`. Until `OwnedAccess` carries every axis below (moderation, no owner, reference rows and the `group` audience; the effect-auth issue drafted on pulpit#5), the kernel keeps its own predicates and the application fills these seams, from effect-auth's guard kit through `accessPolicyFromGuards` / `viewerFromGuards`:

- `Viewer = Option<{ id, role }>`: the request's signed-in account, or none for an anonymous request (effect-auth's session context).
- `AccessPolicy`: four predicates over a signed-in account (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`). Each compares the account's role against an application-named rung on its role ladder (effect-auth's `Ladder.make`, checked through the `Guard.make` kit's `hasRoleAtLeast` / `requireRoleAtLeast`). Each must fail closed on an unknown role.
- `FollowerSeam<Following, R>`: `isFollower(followerId, ownerId)` answers one row's question, and `following(followerId)` returns the list filter's `in` set (effect-auth's `IsFollower`). `nobodyFollows(nobody)` is the fail-closed default when a runtime provides none (effect-auth's `isFollowerNever`).
- **The audience seam** (pulpit#194): the follower seam's optional `isMember(accountId, groupId)` and `groups(accountId)` answer the `group` visibility state, one row and one list at a time. `groups` is the list filter's `in` set, a subquery that is never materialised (`group_id IN (SELECT group_id FROM memberships WHERE account_id = $viewer)`). Without them no `group` row opens beyond its owner and the view-private rung. `./audience`'s `audienceSeam(store)` fills both.
- **A leaf's group column.** A leaf that carries `group` rows declares `groupColumn` on its `LeafAccess` (both kinds): a view column holding the id of the group the row is shared with, in the id space the audience seam takes. The list renders `visibility = 'group' AND <column> IN (<groups>)` (with `draft = false` and `moderation = 'approved'` on an owned leaf that declares them), and `get` shows the row when `isMember(viewer, <column>)` answers true; a non-string value names no group and is never asked of the seam. On an owned leaf a declared column the view lacks fails closed like the other declared columns (the leaf reads no row); on a reference leaf it opens no `group` row.
- **A reference leaf's followers column.** A reference leaf that carries `followers` rows declares `followersOfColumn` on its `LeafAccess`: a column of its current-version view (the `LeafStore`'s `columns` must include it) holding the id of the account that, with its followers, may read the row, in the same id space the follower seam takes. It is the application's column, under any name; pulpit adds no id brand for it. The list renders it as `visibility = 'followers' AND (<column> = <viewer> OR <column> IN (<following>))` and `get` shows the row when the column is the viewer's id or `isFollower(viewer, <column>)` answers true, so a `NULL` (or any non-string) value names nobody: it matches no viewer and is never asked of the seam. The named account and its followers read its `followers` rows; its `private` rows are read only at the view-private rung. A declared column the view lacks opens no `followers` row.
- `ReadScope` and `canViewOwned` are the kernel's spelling of effect-auth's `OwnedReadScope` / `OwnedAccess.readScope` and `OwnedAccess.canView`, extended with the moderation axis (`unapproved`, pulpit#154) and the no-owner reading (pulpit#85), which effect-auth's row shape has no field for.
- `Unauthorized` / `Forbidden` are effect-auth's `Guard` errors, re-exported from `./subtype` (and the barrel), so a guard's failure and the kernel's are one class each. Each needs a `message` (and takes an optional `code`); the kernel's say what was refused and never which row.

From effect-auth's guard kit, the wiring is:

```ts
import { accessPolicyFromGuards, viewerFromGuards } from "@thomasfosterau/pulpit/subtype";

const guards = Guard.make({ ladder: Roles, viewer: CurrentViewer });
const policy = accessPolicyFromGuards(guards, {
  viewPrivate: "moderator",
  viewDeleted: "moderator",
  moderate: "moderator",
  writeCorpus: "contributor",
}); // each axis is the kit's `ladder.hasAtLeast`, fail-closed off the ladder
const viewer = viewerFromGuards(guards); // Effect<Viewer, never, CurrentViewer>
// The `OwnedAccess.IsFollower` service is a `FollowerSeam<OwnedAccess.FollowingSet, never>` as it stands.
```

`tests/effect-auth.test.ts` pins that this wiring makes `canViewOwned` and `readScopeFor` agree with `OwnedAccess.make({ guards, viewPrivate })`'s `canView` and `readScope` for every visibility × draft × viewer × follows cell, that `accessPolicyFromGuards` answers every axis as the kit's `decideRole` does, and that `isPubliclyServeable` agrees with `Cacheability.publiclyServeable(OwnedAccess.serveableAxes)` (`CACHE-AUTH-005`). Those matrices are the parity tests the kernel's delegation to `OwnedAccess` must pass once it ships the missing axes.

**Browser safety.** effect-auth's root entry also re-exports modules that import `node:crypto` (`TokenHash`, `Cipher`); it is `sideEffects: false`, so a bundler drops them, but an unbundled browser load would not. The kernel imports effect-auth from `./subtype` only (its `Guard` errors and types), never from `./registry` or `./content`, which stay `effect` + `effect-jsonapi`: a browser client imports those subpaths, not the root barrel.

## `SubtypeHandlers`: the handler record

The record a JSON:API server's resource handlers are expected to accept. effect-jsonapi's server skeleton has shipped as its `ResourceHandlers` namespace (`make`, `readOnly`, `related`; exported since 0.15.0, and pulpit's peer is `>=0.17.0`), and `subtypeResourceHandlers(handlers, config)` wires the record onto `ResourceHandlers.make` (pulpit#5, below). One entry per endpoint (`list`, `get`, `create`, `update`, `delete`): the reads return the resource the document assembler wraps, and each write returns a `CommittedWrite`, the committed `{ id, version }` and the resource as its writer re-read it (`Option`), plus `restore` and `restoreVersion`, which have no JSON:API endpoint and are called directly. Each write runs inside the config's `transact` (always-open: a nested call opens a savepoint), re-reads the row outside it as the writer, and hands it to the leaf's after hooks, the cache write-through (`cacheWriteThrough`) first (see [`./subtype`](read-model.md#subtype) → Lifecycle hooks). When that re-read fails, as it does for a write that hides the row from its own writer (a corpus writer below the view-private rung making a reference row `private`), the handler evicts the entry, so the cache never keeps the superseded resource (`CACHE-AUTH-005`, pulpit#107), and answers the committed write with no resource (`resource: Option.none()`) rather than a `NodeNotFound` for a write that committed. Any other re-read failure (a store error, a defect) evicts the same way and propagates unchanged. An interrupt can't come between a committed write and its write-through or eviction: once the operation has succeeded, a failure of `transact` (an interrupt included) evicts too, since the write may have committed, while a write the gate or the precondition refuses never touches the cache (should `transact` retry internally, only its last attempt counts). **On effect-jsonapi's `ResourceHandlers`** (pulpit#5). `subtypeResourceHandlers(handlers, config)` builds the five CRUD handlers `ResourceHandlers.make` returns, keyed by the endpoint names `Group.flat` declares, over the record. Its config is `make`'s (`segment`, `listQuery`, `linkBase`, and optionally `include`, `viewer`, `capabilities`, `maxPageLimit`) without `ops`, `cache` or `transact`, plus the resource's JSON:API `type` and three mappings from the endpoint's decoded inputs: `listRequest(query)` → `ListRequest`, `createInput(payload)` → `{ id, state }` and `updateInput(payload)` → `{ id, patch, expectedVersion? }`. Annotate the two payload parameters with the payload schemas' `Type`; nothing else infers them. Every write goes through the record, so it keeps the record's `transact`, writer re-read, after hooks and cache write-through. effect-jsonapi is given no `cache` or `transact`, so it neither writes the cache nor opens a second boundary, and its mutation tail re-reads the row once more through `get` to assemble the document (one extra read per write). An `update` whose payload `id` isn't the route's fails effect-jsonapi's `Conflict` before any operation runs. A `create` or `update` whose committed write hides the row from its writer answers effect-jsonapi's committed identifier document, `{ data: { type, id, meta: { version } } }` at the endpoint's own status (`201` / `200`), not a 404 that would invite a duplicating retry (effect-jsonapi's `hiddenWrite`, keyed on `NodeNotFound`; pulpit#107), so declare the group with `Group.flat({ …, hiddenWrites: true })`: effect-jsonapi's `Registry.FamilyFor` rejects these handlers for a group that doesn't. `restore` and `restoreVersion` stay on the record. The handlers fail with the record's tagged errors; mapping them onto the wire is the application's `ServerErrors`. The viewer and read-scope seams stay pulpit's until effect-auth's `OwnedAccess` carries the kernel's axes; delegating `LeafAccess` to it stays open on pulpit#5.

`update`, `delete` and `restoreVersion` take an optional `expectedVersion`. A client learns the head version from the resource it read: `meta.version`, or the single-resource response's `ETag` (`versionEtag`; see [`./subtype`](read-model.md#subtype) → The head version on the wire). Mapping a request's `If-Match` (the tag's value) onto `expectedVersion`, and a `StaleVersion` failure onto `412 Precondition Failed`, is the HTTP layer's job, and so effect-jsonapi's: 0.17.0 has no such mapping, and setting the `ETag` header is the application's until it has.

## `DocumentStore<Document, E, R>`: the content-addressed document store

Filled by `@thomasfosterau/pulpit-drizzle-pg`'s `makeDocumentStore` over a `makeDocumentTable` (pulpit#247), or by the application over its own document tables (the apps' `inline_documents` / `block_documents`; pulpit#53). Expected schema: a table per document family holding the document as `jsonb`, keyed by its hash, which the database generates:

```sql
hash_id bytea PRIMARY KEY GENERATED ALWAYS AS (digest(document_jsonb::text, 'sha256')) STORED,
document_jsonb jsonb NOT NULL
```

**The hash contract.** The hash is SHA-256 (pgcrypto's `digest(…, 'sha256')`) over the UTF-8 bytes of the document's canonical text. The canonical text is PostgreSQL's `jsonb` text output (`document_jsonb::text`, in a `UTF8` database):

- object keys are deduplicated (the last wins) and ordered shorter-first by UTF-8 byte length, then bytewise;
- `": "` follows each key and `", "` separates members and elements, with no other whitespace;
- a string escapes `"`, `\` and the control characters below U+0020 (as `\b`, `\f`, `\n`, `\r`, `\t`, otherwise `\u00xx` in lowercase hex), and nothing else;
- a number is written as `numeric` prints it, never with an exponent (`1e21` is `1000000000000000000000`, `1e-7` is `0.0000001`), and it keeps the scale it was written with: `{"n":1.0}` is `{"n": 1.0}` and `{"n":1}` is `{"n": 1}`, two different hashes although `jsonb` `=` calls the documents equal.

So structurally equal documents share a hash whatever their member order, provided their numbers are spelled alike; that holds for documents serialised as `JSON.stringify` does (shortest round-trip digits, so `1.0` is written `1`). The hash is exchanged as a `DocumentHash`, the 32 bytes as 64 lowercase hex characters (`encode(hash_id, 'hex')`). A store that does not run on Postgres must reproduce these bytes exactly: `canonicalText(json)` in [`./documents`](content-model.md#documents) produces the canonical text (pinned, with its hashes, to Postgres), and the store hashes its UTF-8 bytes. `makeInMemoryDocumentStore` in [`./testing`](#testing) is the reference store, for tests only.

**The grammar check** (pulpit#264). A version row carries only a document's hash, and the application stores the document before it writes the version, so the check sits in two places, and a family declares both: `checkedDocumentStore` refuses an off-grammar document at `put`, so it is never stored, and `documentCheckHook` (in the leaf's `LifecycleHooks.before`) reads back every document a write references and refuses the write, so no version references an unchecked document whichever path stored it (an import, a proposal's accept, another store). A field the patch leaves absent keeps its already-checked reference and isn't read; `null` clears it.

```ts
import { checkedDocumentStore, documentCheckHook } from "@thomasfosterau/pulpit/documents";

// `postBodyCheck` is the application's, e.g. prosekit-utilities' PostBody allow-list.
const bodies = checkedDocumentStore(documentStore, "body", postBodyCheck);
const hooks = {
  before: [
    documentCheckHook({
      type: "posts",
      fields: ["body"],
      documents: documentStore,
      check: postBodyCheck,
    }),
  ],
  after: [],
};
```

Method contract: `put` is `INSERT … ON CONFLICT DO NOTHING RETURNING hash_id`, and when the insert returns no row it reads the row that conflicted, `hash_id = digest($document::jsonb::text, 'sha256')`; it never updates a stored row (`DOC-001`). It returns `{ hash, inserted }`, `inserted` being whether the `RETURNING` gave a row back, so `onDocumentInsert` can tell a first insert from a no-op. `get` is `hash_id = $hash`; `getMany` is one `hash_id = ANY($hashes)` read, returning the documents found keyed by hash. `E` and `R` are as for the chain store, and the store never opens a transaction itself. A first insert's side effects (both apps enqueue an embedding job) go through `onDocumentInsert` (pulpit#45).

**The apps' column differs.** Both apps generate the hash as `digest(document_jsonb::text::bytea, 'sha256')`. The `::bytea` cast parses the text as `bytea` escape-format input, so it agrees with the contract only on a document whose canonical text has no backslash. A document with a `"`, a newline, a tab or another escaped character in a string or key fails to insert (`invalid input syntax for type bytea`), and one with a literal backslash hashes different bytes (pulpit#71 tracks the apps' fix). Gardeneria's no-row lookup, `document_jsonb = $document`, also differs from the contract's: `jsonb` `=` ignores a number's scale, so it can match a row stored at another hash. The contract's spelling, `digest(document_jsonb::text, 'sha256')`, uses pgcrypto's `text` overload, which is immutable and therefore valid in a generated column; `convert_to(…, 'UTF8')` gives the same bytes but is only stable, so a generated column can't use it.

## `DocumentCheck<Document, R>`: the grammar check

`(field, document) => Effect<void, DocumentViolation, R>`: whether `document` is allowed in `field`, failing `DocumentViolation { field, message }` (the message is the wire's 422 detail) and nothing else. It reads only the document; `R` is whatever the checker needs (usually nothing). The application fills it, one grammar per document field, with prosekit-utilities' allow-list checkers (`PostBody`, `CommentBody`, `InlineTitle`, …; prosekit-utilities#156, the owner decision on pulpit#202). The kernel imports no grammar. It must be total over the stored document type: a document it can't parse is a violation, not a defect.

## `EdgeStore<Row, Following, E, R>`: the edge table

Filled by the application over each edge family's own table (pulpit#52); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `created_at` (`timestamptz NOT NULL DEFAULT now()`), one column per end holding the node id (a foreign key to the node identity table, `core.node`) with an index each, the family's qualifier columns, and, for a family that resolves re-assertions, a unique index on its natural key (`NULLS NOT DISTINCT` when a key column is nullable).

Method contract:

- `get` is `id = $id LIMIT 1`.
- `list` INNER JOINs each end's current-version view on `view.id = edge.<end column>`, under the end's alias, so an edge whose end has no view row is never listed. It renders `where` with the `ListFilter` renderer: a column `alias.name` resolves to that alias's view column, and a bare column to the edge table's. It orders by `created_at, id` and applies `LIMIT` / `OFFSET`. It returns the unpaged total as a window column (`count(*) OVER ()`), so the total is exact whenever the page has a row. An empty page reports `0`, including a page past the end of a non-empty list. That is gardeneria's documented rule, and the in-memory fake (`makeInMemoryEdgeStore` in [`./testing`](#testing)) follows it.
- `countAt({ column, nodeId, where })` is `count(*)` over the same INNER JOINs as `list`, where `column = $nodeId` and `where` holds (rendered as `list` renders it). The create passes the viewer's `EDGE-001` filter and every end's liveness (`action` is `create` or `update`), so only edges the caller can read with every end live are counted ([#77](https://github.com/thomasfosterau/pulpit/issues/77), [#93](https://github.com/thomasfosterau/pulpit/issues/93)). On a family that declares `validity`, `where` also holds the overlap with the new edge's interval ([#210](https://github.com/thomasfosterau/pulpit/issues/210)). The create calls it inside its transaction for the cardinality check, once for each bounded end. The store locks the node first, so two creates at one node serialise and can't both take the last place. Three rules make that lock work:
  - **Lock with `FOR NO KEY UPDATE`:** `SELECT 1 FROM core.node WHERE id = $nodeId FOR NO KEY UPDATE`. Don't use `FOR UPDATE`. Every insert that references the node by foreign key (an edge in any family, or any other row keyed to `core.node`) takes `FOR KEY SHARE` on it, and `FOR UPDATE` would block those inserts for the rest of the transaction. `FOR NO KEY UPDATE` still conflicts with itself, so the creates still serialise.
  - **Run under READ COMMITTED** (PostgreSQL's default). There, the count after the lock wait sees the edge that the previous lock holder committed. Under REPEATABLE READ, the count reads the snapshot taken before the wait, so two creates can both see room and the node can overshoot its limit.
  - **Lock in ascending node id.** `create` calls `countAt` in ascending `nodeId` order, not declaration order. A self-referential family with two bounded ends (`a → b` and `b → a`) therefore locks its pair in one order, and two such creates can't deadlock. A store that locks anything else in `countAt` must keep to that order.
- `existing(values)` is the id of the stored edge whose unique-key columns match `values` (`IS NOT DISTINCT FROM`), `LIMIT 1`; always none for a family without a unique key.
- `insert(values)` is `INSERT … ON CONFLICT DO NOTHING RETURNING id`: the new id, or none when the key was taken (a racing writer, which the create then resolves through `existing`).
- `delete(id)` is `DELETE … WHERE id = $id RETURNING id`: whether a row went.
- `closeValidity(id, column, to)`, required only by a family that declares `validity`, is `UPDATE … SET <column> = $to WHERE id = $id RETURNING id`: whether a row was updated. It is the one statement that updates an edge, and it sets the interval's end column alone (`EDGE-002`); `closeValidity` checks the narrowing before calling it.
- `members({ column, otherColumn, ids, where })` returns, as the `Following` the list filter's `in` node takes, the subquery `SELECT e.<column> FROM <edge> e` over the same INNER JOINs as `list`, `WHERE e.<otherColumn> = ANY($ids) AND <where>` (rendered as `list` renders it). In SQL it builds the subquery and reads nothing (a Drizzle `SQLWrapper`, the same type the follower seam's `following` returns, so the edge store and the leaf store share one `Following`). The in-memory fake computes the id set through its own list path. `memberFilter` and `nonMemberFilter` pass the viewer's `EDGE-001` filter and the named ids, and never call it with no ids or more than `MAX_SET_VALUES`. The subquery never yields a `NULL` (an edge end column is `NOT NULL`), which `nonMemberFilter`'s `NOT IN` relies on.
- `countBy({ column, ids, where })` returns a `HashMap` from node id to count: `SELECT e.<column>, count(*) FROM <edge> e` over the same INNER JOINs as `list`, `WHERE e.<column> = ANY($ids) AND <where> GROUP BY e.<column>`, one statement for every id. A node with no matching edge has no key (`countBy` fills in `0`). `countBy` passes the viewer's `EDGE-001` filter, and never calls it with no ids, a duplicate id or more than `MAX_SET_VALUES`.

`E` and `R` are as for the chain store, and the store never opens a transaction itself. Each end's `EndpointView` is the endpoint leaf's own `LeafStore` (its `columns` and `get`).

## `ProposalStore<E, R>`: the proposal table

Filled by the application over its own proposal table (gardeneria's `participation.proposal`); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `target_node_id` (a foreign key to `core.node`), `author_id`, `patch` (`jsonb`, as submitted), `locales` (`jsonb`, nullable: a localised leaf's per-locale patch as submitted, pulpit#184), `rationale` (nullable), `base_version` (`bigint`), `state` (`pending | accepted | rejected | withdrawn`), `submitted_at` (`timestamptz NOT NULL DEFAULT now()`), and the nullable `decided_at`, `decided_by`, `decision_note` and `applied_version` (with `(target_node_id, applied_version)` a foreign key to the root version table). Index `author_id`, `target_node_id`, and the pending rows.

Method contract: `insert` inserts the row; `get(id)` is `id = $id LIMIT 1`, joined to `core.node` for `targetType`, with the target's head version as a correlated scalar subquery (`SELECT MAX(version) … WHERE id = target_node_id`: one indexed lookup per row, never a per-render aggregate over every node's versions); `lock(id)` is the row alone, `FOR UPDATE`, so two decisions on one proposal serialise; `close(id, decision)` updates the pending row's status, decider, timestamp, note and applied version; `list` renders `where` over the columns `authorId`, `targetId`, `targetType`, `status` and `targetOwnerId` (the target's owner, `core.node_owner`, `NULL` for none; a `LEFT JOIN`), orders by `submitted_at DESC, id DESC`, applies `LIMIT` / `OFFSET` and returns the unpaged total as a window column, each row with its target's head version as `get` reads it; `eraseAuthor({ accountId, replacement, limit })` (account erasure, pulpit#207) touches at most `limit` rows: it deletes the account's non-`accepted` rows, sets `author_id` to `replacement` on its `accepted` ones and `decided_by` to `replacement` where the account decided, and returns how many rows it changed (a CTE over `… WHERE author_id = $1 OR decided_by = $1 ORDER BY id LIMIT $limit`). `E` and `R` are as for the chain store, and the store never opens a transaction itself.

## `BlobStore<E, R>`: the byte store

Filled by the application over its object storage (R2 in gardeneria, S3 or a local directory elsewhere); no library is expected to provide one. Keys are `blobKey(contentHash)` (`sha256/<hash>`), never a node id.

Method contract:

- `put(key, bytes, head)` writes the object, with `head.mediaType` as its content type. It is idempotent: a key always holds the same bytes.
- `get` returns the bytes or none.
- `head` returns `{ byteSize, mediaType }` or none, without reading the body.
- `delete` removes the object; only purge calls it.
- `publicUrl(key)` is the URL a reader fetches, when the store serves one.
- `signedUploadUrl`, when the store offers one, signs a direct client upload of `key`'s bytes. The node stays `bytesPending` until `confirmBytes` sees them.

`E` is the store's own failure, and `R` whatever its client needs.

## `MetadataExtractor<E, R>`, `MediaReferences<E, R>` and `RenditionTransform<A, E, R>`: the media seams

Filled by the application; no library is expected to provide them.

- `MetadataExtractor.extract(upload)` reads the upload's bytes (an EXIF parser, `ffprobe`, a media service's probe) and returns `MediaMetadata`: the `kind`, and each of `width`, `height`, `durationSeconds` and `exif` as an `Option`. It applies no policy; `stripLocation` is applied after it. A failure (its `E`) fails the upload before anything is written. An extractor that re-encodes to strip the bytes' own EXIF does so here, before the bytes reach the store.
- `MediaReferences.referencing(contentHash, limit)` lists up to `limit` `{ type, id }` nodes whose versions reference the hash, in any order: an index on the file leaves' `content_hash` (`SELECT type, id FROM file_versions WHERE content_hash = $1 LIMIT $2`), or the file-usage edges. It applies no visibility: the gate re-reads each node through its own leaf, and a ref the reader can't see counts for nothing.
- `RenditionTransform.render({ contentHash, width, format })` produces the variant (a URL, a response, bytes), keyed by all three so it can be cached immutably. It is called only after the gate has passed, with a width from the policy's buckets and a format from its list.

## `PathStore<E, R>`: the path table

Filled by `@thomasfosterau/pulpit-drizzle-pg`'s `makePathStore` over a `makePathTable` (pulpit#247), or by the application, over a path table per routable namespace (gardeneria's `pages` canonical paths plus `page_slugs`; pulpit#57): `(path PRIMARY KEY, node_id, canonical boolean)`. At most one canonical row per node is held as a partial unique index on `node_id WHERE canonical`. It runs in the caller's transaction and applies no policy. `lookup(path)` is the row by key. `canonicalOf(id)` is the node's canonical row. `claim(id, path)` is one statement or one transaction step: it fails `PathTaken` when another node's canonical row holds `path`. Otherwise it turns the node's canonical row, if any, into an alias, and upserts `path` as the node's canonical row, replacing an alias row at it, whoever's. `release(id)` deletes the node's canonical row and keeps its aliases. `makeInMemoryPathStore` in [`./testing`](#testing) follows this contract.

## `ReportStore<E, R>`: the member report table

Filled by the application over its own report table (gardeneria's `user_reports`); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `target_node_id` (a foreign key to `core.node`), `reporter_id`, `reason`, `details` (nullable), `status` (`open | resolved | dismissed`), `filed_at` (`timestamptz NOT NULL DEFAULT now()`), and the nullable `resolved_at`, `resolved_by` and `resolution_note`. Index `reporter_id`, `target_node_id`, and the open rows.

Method contract: `insert` inserts the row; `get(id)` is `id = $id LIMIT 1`, joined to `core.node` for `targetType`; `lock(id)` is the same row `FOR UPDATE`, so two resolutions serialise; `close(id, resolution)` updates the open row's status, resolver, timestamp and note; `list` renders `where` over `reporterId`, `targetId`, `targetType` and `status`, orders by `filed_at DESC, id DESC`, applies `LIMIT` / `OFFSET` and returns the unpaged total as a window column; `eraseReporter({ accountId, replacement, limit })` (account erasure, pulpit#207) deletes at most `limit` of the reports the account filed and sets `resolved_by` to `replacement` where it resolved one, returning how many rows it changed. `E` and `R` are as for the chain store, and the store never opens a transaction itself.

## `BudgetCounter<E, R>` and `WriteCountStore<E, R>`: the write budget counter

Filled by the application for each family it throttles (pulpit#199); no library is expected to provide one. `take(request)` spends one write of `request.action` by `request.accountId` on `request.type` and answers whether it was within `request.limit` writes since `request.since`. It runs in the caller's transaction, so a write that rolls back spends nothing a transactional counter recorded. Two shapes fill it:

- **Counting** (`countingCounter(store)`, the default shape): `WriteCountStore.countSince({ type, action, accountId, since })` is `SELECT count(*) FROM <the family's table> WHERE <author column> = $accountId AND <created column> >= $since`, over an index on `(author column, created column)`. The write's own row is the spend, so `take` records nothing. Exact, but two concurrent transactions can both see room.
- **Atomic**: a counter with its own state (a Durable Object, a counter row taken `FOR UPDATE`) checks and records the spend in one step, and records nothing when it answers `false`.

`makeInMemoryBudgetCounter` and `makeInMemoryWriteCountStore` in [`./testing`](#testing) follow this contract.

## `PublicationStore<E, R>` and `LiveView<Row, Following, E, R>`: the live pointer

Filled by `@thomasfosterau/pulpit-drizzle-pg`'s `makePublications` over effect-drizzle-ext's pointer level for a publish-gated leaf (pulpit#46, pulpit#247).

The publication log is an append-only table: `node_id`, `version` (`bigint`, `NULL` for an unpublish, with `(node_id, version)` a foreign key to the root version table), `at`, `actor_id`, `recorded_at`, plus a serial `seq` for record order. Its methods:

- `record` inserts a fact.
- `effective(id)` is the most recently recorded fact whose `at` has arrived: `SELECT … WHERE node_id = $id AND at <= now() ORDER BY seq DESC LIMIT 1`.
- `facts(id, limit)` is `ORDER BY seq LIMIT $limit`.
- `scheduled(ids)` (pulpit#220) is, per node, the most recently recorded fact that names a version, whose `at` is still ahead, and that no later-recorded fact overtakes (a later record whose `at` is no later than its own would be effective by then, so the schedule never takes effect), in one read: `SELECT DISTINCT ON (node_id) … FROM fact f WHERE node_id = ANY($ids) AND version IS NOT NULL AND at > now() AND NOT EXISTS (SELECT 1 FROM fact g WHERE g.node_id = f.node_id AND g.seq > f.seq AND g.at <= f.at) ORDER BY node_id, seq DESC`. A node with none is absent.

The live view is a view over the leaf's version tables. For each node it gives the row at the effective fact's version (joined through the same `DISTINCT ON (node_id) … ORDER BY node_id, seq DESC` over the facts with `at <= now()`), with:

- `version` = the effective fact's version, the representation it serves, so its `meta.version` and ETag change only when what readers see does and never disclose an unpublished edit;
- the node's head `action`, so a tombstone hides it too;
- `draft` = `false`;
- `publishedAt` = the fact's `at`;
- the owner column.

A node whose effective fact is an unpublish, or that has none, has no live row.

`get` / `getMany` read it by id. `listLocalised` (pulpit#272) is `LeafStore.listLocalised` over the same chosen rows. `list` is `UNION ALL` of the current-version view's rows matching `headFor` (the viewer's own rows; `never` for the anonymous) and the live rows of every other node, then `where`, the order and the page, as `LeafStore.list` renders them.

`distinct` (pulpit#186) reads the distinct values of one column over that same `UNION ALL` of chosen rows, as `LeafStore.distinct` reads the current-version view, so a reader counts a node through the row they would list.

On a gated leaf the current-version view computes `draft` as `NOT EXISTS (a live row)` too, and a stored draft column is ignored.

**Publication serialises per node** (owner decision on pulpit#164). A `publish` or `unpublish` appends a fact and no version, so its cache write-through and eviction carry the node's head. Two publication operations on one head therefore compare equal in the cache's compare-on-set, and their order there isn't protected the way two chain writes' is. A publish whose write-through arrives late can re-cache a resource that an unpublish on the same head has already evicted (`CACHE-AUTH-005`). The application closes that gap by running the publication operations on one node one at a time.

- **The lock spans the whole handler call.** It covers the transaction and the cache refresh `subtypeHandlers` runs after it, which reads the live resource and writes it through.
- **A row lock alone is not enough.** A row lock that `transact` takes on the node (`SELECT 1 FROM core.node WHERE id = $id FOR NO KEY UPDATE`) serialises the facts. It is released at commit, before the refresh, so it does not cover the write-through.
- **Hold a lock across the call.** A transaction-independent lock does: a session-level advisory lock (`pg_advisory_lock(hashtext($id))`, released after the refresh), a Durable Object per node, or an in-process mutex keyed by node id where one process serves every write.

A pair stamp (`(head version, publication seq)`, compared lexicographically) would remove the need. It is the fallback if a store turns out unable to lock, and isn't in the seam today. A read-through fill on a gated leaf stamps the live row's `version`, which is below the head once the node has an unpublished edit, so the cache refuses it: a gated leaf's cache is filled by its write-throughs, which is the safe side.

## `WorkingCopyStore<E, R>`: the autosave buffer

Filled by the application: a table keyed `(node_id, user_id)` holding the patch (`jsonb`), `base_version` and `saved_at`, or a KV namespace. Methods:

- `put` upserts the copy;
- `get` reads it;
- `discard` deletes it, idempotently;
- `eraseAccount(userId, limit)` deletes at most `limit` of the account's copies and returns how many (account erasure, pulpit#207).

It is the one overwritable store in the kernel's seams, and nothing in it is ever a version.

## `PurgeStore<E, R>`: erasure

Filled by the application, over the same tables as its other stores. Like them it applies no policy, runs in the caller's transaction and never opens one. `definePurge` calls its three methods in order:

- `eraseNode(id)` deletes every row of the node: each chain level's version rows, the root version rows and the identity row (`core.node`), the owner row, and every row keyed to the node in the other seams' tables (working copies, proposals, publication facts, path claims and aliases, reports, and edges with the node at either end). An `ON DELETE CASCADE` from the identity row does most of it. It returns the `DocumentHash`es and `ContentHash`es the deleted version rows carried, each once (`DELETE … RETURNING` over the columns that carry them). An id with no rows deletes nothing and returns none.
- `deleteUnreferencedDocuments(hashes)` deletes each of `hashes` that no remaining version row of any leaf references, and returns those it deleted: `DELETE FROM documents WHERE hash = ANY($1) AND NOT EXISTS (…)` over every column that carries a document reference.
- `unreferencedBlobs(hashes)` returns those of `hashes` that no remaining version row references, for `definePurge` to delete from the `BlobStore` once the transaction has returned.

Erasure is the only path that deletes a version row, a document or bytes (`VERSION-CHAIN-001/002`, `DOC-001`): nothing else may call these methods' SQL.

## `AccountErasureStore<E, R>`: owner records and the redaction marker

Filled by the application, over its owner table (`core.node_owner`) and its version tables, which it only reads (pulpit#207): every version erasure writes goes through the family's `VersionChain`. Like every store it applies no policy and never opens a transaction; `defineAccountErasure` runs each call inside one `transact`.

- `ownedNodes({ accountId, type, limit })` is the ids of leaf `type`'s nodes whose owner row names the account: `SELECT node_id … JOIN core.node USING (id) WHERE owner_id = $1 AND type = $2 ORDER BY node_id LIMIT $3`.
- `setOwner({ type, id, ownerId })` replaces the node's owner row with `ownerId`, or deletes it for none. `core.node_owner.owner_id` stays `ON DELETE RESTRICT`: this is the explicit retract or reassign it asks for.
- `unredactedNodes({ accountId, type, redactedAs, limit })` is at most `limit` ids, by id, of leaf `type`'s nodes still to redact: the head is not a tombstone, some version names the account as its actor or `proposedBy`, and no later version has actor `redactedAs` (`IS NOT DISTINCT FROM`, so none matches `NULL`) and no `proposedBy`. One grouped read over the root version table: `… GROUP BY id HAVING MAX(version) FILTER (WHERE actor_id = $1 OR proposed_by = $1) > COALESCE(MAX(version) FILTER (WHERE actor_id IS NOT DISTINCT FROM $redactedAs AND proposed_by IS NULL), -1)`, restricted to live heads, `ORDER BY id LIMIT $limit`, served by an index on `(actor_id)` and one on `(proposed_by)`. It writes nothing.

## `SearchBranch<Following, E, R>` and `EmbeddingStore<E, R>`: search and embeddings

Filled by the application over its own search views and embedding tables (pulpit#204); no library is expected to provide one.

- A `SearchBranch`'s `search({ query, scope, headFor, limit })` is one ranked query over the leaf's search view, returning at most `limit` ids, best first. It must render `scope` (the leaf's `searchScopeFilter`) into the same statement that ranks, as the leaf's `list` renders its filter, and on a publish-gated leaf match over the rows `LiveView.list` reads for `headFor` (the leaf's `searchHeadFor`; per node its head when it matches, else its live row), so the branch is one value for every viewer; a branch over an ungated leaf ignores `headFor`; a branch that ranks first and filters after leaks a hidden row's rank into the others'. A full-text branch is `ts_rank_cd` over the projection's `setweight` vector, a trigram one `similarity`, a vector one `ORDER BY embedding <=> $query` with a `LIMIT`, a literal-id branch an exact match (ISBN, DOI, QID). It applies no other policy and never opens a transaction.
- An `EmbeddingStore` is the queue and the vector column. `enqueue(hash)` inserts an outbox row (`ON CONFLICT DO NOTHING`); `pending(limit)` is the oldest `limit` queued hashes and, for the sweep, any stored document whose vector is still `NULL` (`ORDER BY queued_at LIMIT $limit`); `write(vectors)` sets each document's vector and deletes its queue row in one statement; `discard(hashes)` deletes queue rows. An `Embedder` is the model: one call per batch, one vector per text, in order.

## `ReactionStore<E, R>`: the reaction table

Filled by the application over its own reaction table (gardeneria's `social.reactions`): `node_id` (a foreign key to `core.node`, `ON DELETE CASCADE`), `account_id` (`ON DELETE CASCADE`), `kind` (`text`), `reacted_at` (`timestamptz NOT NULL DEFAULT now()`), with primary key `(node_id, account_id)` and an index on `(account_id, reacted_at DESC)`. `upsert` is `INSERT … ON CONFLICT (node_id, account_id) DO UPDATE SET kind = EXCLUDED.kind, reacted_at = EXCLUDED.reacted_at` returning the replaced kind (read in the same statement through a CTE); `delete` is `DELETE … RETURNING`; `tally(nodeIds)` is one `SELECT node_id, kind, count(*) … WHERE node_id = ANY($ids) GROUP BY node_id, kind`; `byAccount` is `WHERE account_id = $id ORDER BY reacted_at DESC, node_id LIMIT … OFFSET …`; `eraseAccount(accountId, limit)` deletes at most `limit` of the account's rows (`DELETE … WHERE (node_id, account_id) IN (SELECT … WHERE account_id = $id LIMIT $limit)`) and returns how many. It applies no policy and never opens a transaction.

## `VersionedKv<E, R>`: the cache's key-value store

Filled by the application, for `./cache`'s `makeResourceCache` (pulpit#205). Each entry is `{ version, value }`, where `value` is the resource's JSON encoding or none for an eviction, and `version` is the rank the cache orders by (`2·version`, plus one for an eviction); the store compares it as a plain number.

- `get(key)` returns the entry, or none when there is no entry or it has expired.
- `putIfNotBehind(key, entry, ttlSeconds)` writes the entry, with that TTL, unless the stored entry's version is higher. It returns whether it wrote. The compare and the write must be **one atomic step**:
  - a Durable Object's single-threaded storage;
  - Redis, as a Lua script, or `WATCH` / `MULTI`;
  - SQL, as `INSERT … ON CONFLICT (key) DO UPDATE … WHERE cache.version <= EXCLUDED.version`.

  Workers KV alone has no conditional write, so it can't fill this seam. The store applies no policy.

## `CollectionStore<E, R>`: the membership table

Filled by the application over its own membership table:

- **Columns:** `parent_id` and `member_id` (foreign keys to `core.node`, `ON DELETE CASCADE`) and `position` (`integer`), with primary key `(parent_id, member_id)` and an index on `(parent_id, position)`.
- **`entries(parentId, limit)`** is `ORDER BY position, member_id LIMIT $limit`.
- **`replace(parentId, entries)`** rewrites the parent's order in one statement: a `DELETE` of the parent's rows and an `INSERT` of the new ones, in the caller's transaction.

It applies no policy and never opens a transaction. A versioned family's parent column is a `jsonb` array of member ids on the parent's version table.

## `SocialStore<Following, E, R>`: the relationship table

Filled by the application over its own relationship table (gardeneria's `social.follows`, widened by a `kind`): `kind` (`follow | mute | block`), `from_id` and `to_id` (account foreign keys, `ON DELETE CASCADE`), `at` (`timestamptz NOT NULL DEFAULT now()`), primary key `(kind, from_id, to_id)`, with indexes on `(kind, to_id, at DESC)` and `(kind, from_id, at DESC)`. `add` (a mute) is `INSERT … ON CONFLICT DO NOTHING RETURNING`; `addFollow` and `addBlock` first take one lock on the unordered account pair in the caller's transaction (`pg_advisory_xact_lock` on it), so the two are atomic against each other: `addFollow` is `INSERT … SELECT … WHERE NOT EXISTS (a block either way) ON CONFLICT DO NOTHING`, answering `blocked` when a block stands, and `addBlock` inserts the block and deletes both follows; `remove` is `DELETE … RETURNING`; `has` is an `EXISTS`; `list` is one page by `from_id` or `to_id`, `ORDER BY at DESC`, then the other account's id, with the window total; `isFollowing` is the follower seam's `EXISTS` (a failure reads as `false`, failing closed); `followingOf(follower)` is the subquery `SELECT to_id … WHERE kind = 'follow' AND from_id = $follower`, and `silencedBy(viewer)` the same over `kind IN ('mute', 'block')`, both never materialised; `eraseAccount(accountId, limit)` deletes at most `limit` of the rows from or to the account and returns how many. It applies no policy and never opens a transaction.

## `MembershipStore<Following, E, R>`: the membership table

Filled by the application over its own membership table (in-the-dark's `group_members`, gardeneria's `social.group_memberships`): `group_id` (a foreign key to the app's group table, `ON DELETE CASCADE`), `account_id` (`ON DELETE CASCADE`), `role` (`member | admin`), `status` (`active | pending`, pulpit#227), `invited_by` (the inviting account, `NULL` on an active row; `ON DELETE CASCADE`), `at` (`timestamptz NOT NULL DEFAULT now()`), primary key `(group_id, account_id)`, with an index on `(account_id)`. **Every membership read (`roleOf`, `list`, `isMember`, `groupsOf`) and `remove` and `setRole` take `status = 'active'` rows alone**; a pending row is an invitation, read and written only by the invitation methods. `add` is `INSERT … ON CONFLICT (group_id, account_id) DO UPDATE SET status = 'active', role = EXCLUDED.role, at = EXCLUDED.at WHERE memberships.status = 'pending' RETURNING` (a direct add activates a pending invitation; an active row is untouched); `setRole` is `UPDATE … SET role = $role WHERE … AND role <> $role RETURNING`; `remove` is `DELETE … RETURNING`; `roleOf` reads one row's role; `list` is one page `ORDER BY at, account_id` with the window total; `removeGroup` is `DELETE … WHERE group_id = $id`; `isMember` is the audience seam's `EXISTS` (a failure reads as `false`, failing closed); `groupsOf(account)` is the subquery `SELECT group_id … WHERE account_id = $account`, never materialised; `eraseAccount(accountId, limit)` deletes at most `limit` rows, of the account's rows of both statuses and the pending rows it invited, counted together (`DELETE … WHERE (group_id, account_id) IN (SELECT … WHERE account_id = $1 OR (status = 'pending' AND invited_by = $1) LIMIT $limit)`), and returns how many (pulpit#274); `removeGroup` deletes both statuses. The invitation methods: `invite` is `INSERT … status = 'pending' … ON CONFLICT DO NOTHING RETURNING`; `invitationOf` reads the pending row; `accept` is `UPDATE … SET status = 'active', at = $at, invited_by = NULL WHERE … AND status = 'pending' RETURNING`; `removeInvitation` is `DELETE … WHERE … AND status = 'pending' RETURNING`; `invitations` is one page of pending rows by group or by account, `ORDER BY at` then the other key, with the window total. It applies no policy and never opens a transaction.

## `GroupOwnerStore<E, R>`: the groups' owners

Filled by the application over its own group table (in-the-dark's `groups.owner_id`), the same records `GroupOwnership.ownerOf` reads, for account erasure (pulpit#274). `reassignOwner(accountId, to, limit)` makes `to` the owner of at most `limit` of the groups `accountId` owns and returns how many changed (`UPDATE groups SET owner_id = $to WHERE id IN (SELECT id … WHERE owner_id = $accountId ORDER BY id LIMIT $limit)`, `PERF-DB-001`). A reassigned group no longer names the account, so a repeated call moves on and answers `0` once none is left. It leaves the group's memberships and invitations alone, applies no policy and never opens a transaction.

## `OutboxStore<Kind, E, R>`, `InboxStore<Kind, E, R>` and `PreferenceStore<E, R>`: the notification tables

The outbox is one row per event, `(id, kind, recipient_id, actor_id, subject_tag, subject_type, subject_id, at, processed_at)`: `enqueue` inserts the drafts in the caller's transaction (never its own: that is what makes a rolled-back write notify nobody), minting each id; `pending(limit)` reads the unprocessed rows oldest first (`ORDER BY at, id LIMIT $limit`, an index on `(processed_at, at, id)`); `markProcessed(ids)` stamps them, idempotently. The inbox is keyed by the event's id (one recipient per event): `add` is `INSERT … ON CONFLICT (event_id) DO NOTHING` and answers whether a row went in; `list` pages a recipient's entries newest first (`at DESC, id DESC`) with the unpaged total, optionally unread only; `markRead(recipient, ids, at)` stamps only that recipient's unread entries among `ids` and answers how many; `unreadCount` counts. The preference table is keyed by account (`channels text[]`, `muted_kinds text[]`); `get` answers none for an account that never set any. None of the three applies policy or opens a transaction; each fails only with its `E`.

## `DeliverySeam<Kind, E, R>` and `SubjectGate<E, R>`: delivery and the subject's read

`deliver(channel, event)` sends one notification on one of the application's channels (`push`, `email`, …): rendering the copy and choosing the transport are the application's. Delivery is at-least-once, so the transport dedups by `event.id`. A `SubjectGate` answers whether a recipient may read a node: build it with `subjectGateFromGet(leaf.get, asRecipient)`, where `asRecipient(recipientId)` runs an effect as that account (the application provides its viewer for it), so the leaf's own read rule decides and nothing re-spells it.

## `MentionExtractor<Document>`: the mention extractor

`(document) => ReadonlyArray<string>`: the account ids a document mentions, in any order, duplicates allowed (`mentionCreatedHook` dedups them). Pure and total over the stored document type: a document that mentions nobody, or that it can't read a mention in, returns `[]`. The application fills it with its document grammar's extractor (for ProseKit, prosekit-utilities' `extractMentions` over the editor's inline `mention` atom `{ id, label }`, once it is released; until then any function of this shape), and the kernel imports no grammar. It returns ids as the document stores them, and the kernel doesn't check that one names an account: an extractor that must drop stale ids filters them itself. `./testing`'s `jsonMentionExtractor` is the reference fake.

## `ExternalIdStore<E, R>`: the external-identifier table

`./reference-import`'s links (pulpit#209), one table per family or one with a family column: `(authority, external_id, node_id, baseline)`, unique on `(authority, external_id)` and on `(authority, node_id)`, the node foreign key `ON DELETE CASCADE`, `baseline` a nullable `jsonb` of the declared fields' values the last import sent. `lookup(authority, externalIds)` reads every given id's link in one `WHERE authority = $1 AND external_id = ANY($2)`. `link` inserts `ON CONFLICT DO NOTHING` and answers `"linked"`, `"present"` (exactly this link is stored) or `"taken"` (either unique key belongs to another link). `recordBaseline` replaces one link's baseline. Store semantics: no policy, no transaction of its own, fails only with its `E`.

## `ResourceCacheSeam` and the `serveable` hook: the resource cache

Filled by the application: a read-through resource cache it owns (pulpit#5, pulpit#6). No library is expected to provide one; effect-web dropped its Cloudflare package, and with it the planned cache (effect-web#33). The cache's write side is `set(id, resource, version, locale?)` / `delete(id, version)`, both never failing (the cache swallows a store fault).

**Compare-on-set** (pulpit#121). Each call carries the node version it speaks for: the version the write landed at for the handlers' write-through and eviction, and the head version its read saw for a read-through fill, which goes through `set` too. The cache keeps, per id, the highest version either call has given it. A `set` below that version is a no-op; a `set` at or above it stores the resource (or, when not serveable, evicts it and keeps the version); a `delete` evicts and raises the version. The kept version must outlive the entry it evicted, at least as long as an entry lives. That way neither a racing writer's late write-through nor a fill that read before a hiding write can re-cache a resource older than one already evicted or replaced (`CACHE-AUTH-005`). The compare and the write are one atomic step: a conditional write (a SQL `INSERT … ON CONFLICT … DO UPDATE … WHERE cached.version <= excluded.version`, a Durable Object, a compare-and-swap). A store without one, such as Workers KV, which is eventually consistent and has no conditional put, cannot honour this seam on its own. `makeInMemoryResourceCache` in [`./testing`](#testing) is the reference.

**A localised leaf's entries are keyed by locale** (pulpit#184; owner decision there: the cache's key includes the locale). One entry per `(id, locale)` a reader was served, so `Accept-Language` never answers one locale from another's entry; the read-through fill passes the locale it served as `set`'s fourth argument. A version covers every locale of a node, so the compare-on-set version is kept per id across them: a `set` of any locale below it is a no-op, a `set` above it drops the id's other locales (older versions), and `delete` evicts every locale of the id. The kernel never writes a localised leaf through: its writer's re-read is the node's shared row, no locale's representation, so with `SubtypeHandlersConfig.localised: true` the handlers evict at every write's version instead. `makeInMemoryResourceCache` and `./cache`'s `makeResourceCache` both key by locale (pulpit#271), checked by one shared case table.

**Only committed writes are cached** (pulpit#124). `transact` is always-open, so inside an outer transaction it is a SAVEPOINT and its return is not a commit. `SubtypeHandlersConfig.inTransaction` says which: over `effect/sql`, `Effect.map(Effect.serviceOption(client.transactionService), Option.isSome)`, read once `transact` has returned. When it reads true, the handlers evict at the write's version instead of writing through, so an outer rollback leaves no cached entry; the eviction raises the cache's version, so a read-through fill below it is refused until the next write or a fill at that version, which is the safe side. Once `transact` offers an after-commit hook, the write-through moves onto it.

Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as the cache's `serveable` option; the cache applies it on both its read and write paths and evicts on a non-serveable write.

## `./testing`

In-memory fakes of the kernel's seams, for tests: an adapter's or an application's suite can run the real operations (`defineVersionChain`, `defineSubtype`, `defineEdgeOps`, …) over them without a database. Each fake implements its seam's contract as stated under [Seams](#seams), in memory and with no SQL, and enforces what the real table's schema enforces (a primary or unique key) and nothing the operations are responsible for. They are the fakes the kernel's own suites run against, so they are its reference semantics for each seam.

**Not for production.** Every fake keeps its rows in memory for the life of the value, persists nothing, never opens a transaction and has no concurrency control. The subpath isn't on the root export, so production code never pulls it in by accident.

```ts
import { deepStrictEqual } from "node:assert";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineSubtype, type LeafRow } from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";

const chain = makeInMemoryVersionChain("terms");
const terms = defineSubtype({
  type: "terms",
  access: { kind: "reference" },
  chain,
  leaves: makeInMemoryLeafStore(chain, { columns: ["name"] }),
  viewer: Effect.succeedSome({ id: "u-editor", role: "editor" }),
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: (account) => account.role === "editor",
  },
  followers: makeInMemoryFollowers([]), // who follows whom: [follower, [followed, …]]
  toResource: (row: LeafRow) => ({ id: row.id, name: row["name"] }),
});

const program = Effect.gen(function* () {
  const { id } = yield* terms.create({ id: Option.none(), state: { name: "Ferns" } });
  return yield* terms.get(id);
});
deepStrictEqual(Effect.runSync(program).name, "Ferns");
```

| Export | Fakes | Test hooks |
| --- | --- | --- |
| `makeInMemoryVersionChain(type)`, `InMemoryVersionChain` | [`VersionChain`](#versionchaine-r-the-version-chain-port) for one leaf, holding every chain invariant over an append log with the `(id, version)` key (`VersionConflict`), minting sequential UUID-shaped ids. | `rows()` (every appended row), `dropState(id, version)` (a partial chain), `raceNextAppend(id)` (a concurrent writer). |
| `versionChainConformance(harness, runner)`, `ConformanceHarness`, `ConformanceChain`, `ConformanceRunner` | The `VersionChain` conformance suite: every invariant, registered through the `describe` / `it` / `expect` it is given (no test-runner dependency), against whatever `harness.make` returns. The kernel runs it against `makeInMemoryVersionChain`; pulpit-drizzle-pg runs it against its Drizzle chain on PostgreSQL. Its locale case writes a `heading` column, never a shared one, as a tree's keyed level must. | `dropState` / `raceNextAppend` on a `ConformanceChain`, optional: the cases that need them are skipped without. |
| `makeInMemoryAccountErasureStore(leaves)`, `InMemoryErasureLeaf` | [`AccountErasureStore`](#accounterasurestoree-r-owner-records-and-the-redaction-marker) over in-memory leaves: their owner stamps, and their chains' rows read for the redaction marker. | Read through the leaves' `owners()` and the chains' `rows()`. |
| `makeInMemoryLeafStore(chain, { columns, now?, localised? })`, `InMemoryLeafStore`, `InMemoryLeafStoreOptions` | [`LeafStore`](#leafstorerow-following-e-r-the-current-version-view), as the current-version view over an in-memory chain plus the owner stamps; `list` evaluates the `ListFilter` in memory and sorts by the list order contract (`NULLS LAST`, code-point strings, `id` last). With `localised: true`, the view gains `locale` and `list` reads one row per `(id, locale)`. `distinct` reads the same rows `list` does. | `owners()` (the stamps), `dropOwner(id)` (an ownerless owned node). |
| `makeInMemoryDocumentStore()`, `InMemoryDocumentStore` | [`DocumentStore`](#documentstoredocument-e-r-the-content-addressed-document-store), hashing exactly as the hash contract says (SHA-256 over `./documents`' `canonicalText`, pinned to hashes taken from Postgres). | `stored()` (every document by hash), `writes()` (how many `put`s inserted), `remove(hashes)` (the purge fake's delete). |
| `makeInMemoryEdgeStore({ ends, uniqueKey, now? })`, `InMemoryEdgeStore`, `InMemoryEdgeStoreOptions` | [`EdgeStore`](#edgestorerow-following-e-r-the-edge-table), with the unique key (`NULLS NOT DISTINCT`), the INNER JOIN of each end's view, and the window-column total. | `rows()` (every edge, hidden ones included), `raceNextInsert(winner)` (a concurrent writer). |
| `makeInMemoryNodes(columns)`, `InMemoryNodes` | `EndpointView`, an end's view whose rows a test writes directly (an `InMemoryLeafStore` is one too). | `put(row)`. |
| `makeInMemoryProposalStore({ chain, leaves })`, `InMemoryProposalStore` | [`ProposalStore`](#proposalstoree-r-the-proposal-table), reading each listing's head version from `chain` and its `targetOwnerId` from `leaves`' owner stamps; newest first, `id` descending on a tie. | `rows()` (every proposal as it now stands). |
| `makeInMemoryBlobStore()`, `InMemoryBlobStore`, `InMemoryBlob`, `InMemoryBlobFailure` | [`BlobStore`](#blobstoree-r-the-byte-store), with `memory://<key>` URLs and no signed upload. | `objects()` (every stored object), `failNextPut()` (a byte write failing after the commit). |
| `makeInMemoryMediaReferences()`, `InMemoryMediaReferences` | [`MediaReferences`](#metadataextractore-r-mediareferencese-r-and-renditiontransforma-e-r-the-media-seams), the refs recorded against each hash, in insertion order. | `add(contentHash, ref)`, `removeNode(ref)` (a purge). |
| `makeInMemoryPathStore()`, `InMemoryPathStore` | [`PathStore`](#pathstoree-r-the-path-table), one entry per path, with `claim`'s `PathTaken` and alias rules in one step. | `entries()` (every stored path and its entry). |
| `makeInMemoryBudgetCounter()`, `InMemoryBudgetCounter` | An atomic [`BudgetCounter`](#budgetcountere-r-and-writecountstoree-r-the-write-budget-counter): it counts the spends it admitted in the window and records one only when it answers `true`. | `spends()` (every admitted spend). |
| `makeInMemoryWriteCountStore()`, `InMemoryWriteCountStore`, `RecordedWrite` | [`WriteCountStore`](#budgetcountere-r-and-writecountstoree-r-the-write-budget-counter), counting the recorded writes at or after `since`. | `record(write)` (the row a write inserts). |
| `makeInMemoryReportStore()`, `InMemoryReportStore` | [`ReportStore`](#reportstoree-r-the-member-report-table), evaluating the filter in memory, newest first with `id` descending on a tie. | `rows()` (every report as it now stands). |
| `makeInMemoryResourceCache(serveable)`, `InMemoryResourceCache` | [`ResourceCacheSeam`](#resourcecacheseam-and-the-serveable-hook-the-resource-cache), with compare-on-set: a `set` below the highest version held for an id is a no-op, and a `delete` raises it. A localised leaf's entries are keyed by locale under the one per-id version (pulpit#184). | `get(id, locale?)` (what it would serve), `versionOf(id)` (the version held, set or evicted). |
| `makeInMemoryPublication({ chain, leaves, now? })`, `InMemoryPublication` | [`PublicationStore`](#publicationstoree-r-and-liveviewrow-following-e-r-the-live-pointer) and `LiveView` over an in-memory chain and leaf store, plus the gated leaf's current-version view with `draft` computed from the log. | `recorded()` (every fact). |
| `makeInMemoryWorkingCopyStore()`, `InMemoryWorkingCopyStore` | [`WorkingCopyStore`](#workingcopystoree-r-the-autosave-buffer), one copy per `(id, userId)`. | `copies()`. |
| `makeInMemoryPurgeStore({ chains, documents?, documentColumns?, blobColumns?, dependents? })`, `InMemoryPurgeStoreOptions` | [`PurgeStore`](#purgestoree-r-erasure), erasing a node's rows from every chain (and, through `dependents`, from other fakes) and reading a hash as referenced while any remaining row carries it in a declared column. |  |
| `makeInMemorySearchBranch({ name, weight?, rows, score, now })` | [`SearchBranch`](#searchbranchfollowing-e-r-and-embeddingstoree-r-search-and-embeddings), ranking the rows the scope admits by `score` (best first, ties by id). |  |
| `scopeCheckedBranch(branch, { rows, now })` | Wraps any branch; fails `SearchScopeLeak` on a hit whose row the scope doesn't admit or `rows` lacks. |  |
| `makeInMemoryEmbeddingStore()`, `InMemoryEmbeddingStore` | [`EmbeddingStore`](#searchbranchfollowing-e-r-and-embeddingstoree-r-search-and-embeddings), a queue in insertion order (idempotent `enqueue`; a hash with a vector is never queued again). | `queued()`, `vectors()`. |
| `makeInMemoryReactionStore()`, `InMemoryReactionStore` | [`ReactionStore`](#reactionstoree-r-the-reaction-table), keyed `(nodeId, accountId)`: `upsert` replaces, `tally` groups by node and kind, `byAccount` is newest first. | `rows()`. |
| `makeInMemoryVersionedKv()`, `InMemoryVersionedKv` | [`VersionedKv`](#versionedkve-r-the-caches-key-value-store), comparing and writing in one step; an entry past its TTL reads as absent (the Effect `Clock`, so `TestClock` steers expiry). | `peek(key)`, `poke(key, entry)` (a corrupt value). |
| `makeInMemoryCollectionStore()`, `InMemoryCollectionStore` | [`CollectionStore`](#collectionstoree-r-the-membership-table), each parent's entries replaced whole and read back by position, then member id. | `rows()`. |
| `makeInMemorySocialStore()`, `InMemorySocialStore` | [`SocialStore`](#socialstorefollowing-e-r-the-relationship-table), keyed `(kind, from, to)`; `followingOf` and `silencedBy` are `HashSet`s. | `rows()`. |
| `makeInMemoryMembershipStore()`, `InMemoryMembershipStore` | [`MembershipStore`](#membershipstorefollowing-e-r-the-membership-table), keyed `(groupId, accountId)` across active rows and pending invitations; `groupsOf` is a `HashSet`. | `rows()` (active), `pending()`. |
| `makeInMemoryGroupOwners(owners)`, `InMemoryGroupOwners` | [`GroupOwnership`](participation.md#audience) and [`GroupOwnerStore`](#groupownerstoree-r-the-groups-owners) over one map of group id to owner, seeded with `[groupId, ownerId]` pairs; `reassignOwner` takes the account's groups in group-id order. | `owners()`, `put(groupId, ownerId)`, `remove(groupId)`. |
| `makeInMemoryExternalIdStore()`, `InMemoryExternalIdStore` | [`ExternalIdStore`](#externalidstoree-r-the-external-identifier-table), unique on `(authority, externalId)` and `(authority, nodeId)`. | `links()`. |
| `jsonMentionExtractor` | [`MentionExtractor`](#mentionextractordocument-the-mention-extractor) over a JSON document tree: the string `attrs.id` of every `{ type: "mention" }` object, at any depth, in document order. |  |
| `makeInMemoryFollowers(table)`, `InMemoryFollowing` | [`FollowerSeam`](#the-viewer-the-role-axes-and-the-follower-seam) over an explicit table of who follows whom; the `in` set is a `HashSet` of account ids, where SQL's is a subquery. |  |

`now` is the instant the list filter's `published` / `notPublished` compare against (and, for the edge store, the base of the minted `createdAt`s). Pass a fixed `Date` for a deterministic suite; left out, each call reads the Effect `Clock`, so `TestClock` steers it. The role ladder and the `AccessPolicy` are the application's, so `./testing` ships none.
