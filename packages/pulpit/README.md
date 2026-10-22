# @thomasfosterau/pulpit

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, the publication, moderation and cache-serveability predicates, the content-addressed document store seam, and the edge operations factory.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

`effect` (`>=4.0.0-rc.118`) and `@thomasfosterau/effect-jsonapi` (`>=0.16.0`) are required peer dependencies; the package is built against `effect@4.0.0` and `@thomasfosterau/effect-jsonapi@0.16.0`. Node.js 22 or newer is required.

## API

Every module is a namespace on the root export (`import { Content, Registry } from "@thomasfosterau/pulpit"`) and a subpath of its own, except `./testing`, which is a subpath only, so that nothing imports the fakes by accident.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Content`, `Registry`, `VersionChain`, `Filter`, `Subtype`, `Publication`, `Documents`, `Edges`, `Proposals`, `Blobs`). |
| `./content` | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | The append-only node/version chain operations over a `VersionChainStore` seam, and the field-level version compare (`diffStates`, `compare`). |
| `./filter` | `ListFilter`, the read-predicate tree a store renders to SQL, and its in-memory `evaluate`. |
| `./subtype` | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`, `subtypeHandlers`, and the lifecycle hook seam (before / after every write). |
| `./publication` | The publication and moderation predicates, the scheduled-publication sweep window, and the cache serveability policy. |
| `./documents` | The content-addressed `DocumentStore` seam and its first-insert hook, the `DocumentHash` it is keyed by, the `documentRef` field spread, and the hash contract's `canonicalText`. |
| `./edges` | `defineEdgeOps`, the edge operations factory over an `EdgeStore` seam: relations between nodes, readable only when every end is, with declared cardinality limits. |
| `./proposals` | `defineProposals`, suggested edits over a `ProposalStore` seam: a contributor's patch against a base version, its two-tier stale / conflict classification, and accept (through the target's own update, recording `proposedBy`), reject and withdraw. |
| `./blobs` | File and media leaves: the `BlobStore` seam keyed by content hash, the file field spread, the commit-ordered byte write (`defineFileWrites`, with its `bytesPending` marker) and the usage index's edge ends. |
| `./testing` | In-memory fakes of the seams (the chain, leaf, document, edge, proposal and blob stores, an endpoint view, a follower seam), for tests only. Not on the root export. |

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
    const { changes } = yield* chain.compare(id, 0n, 1n); // { title: changed "Hello" → "Hi", summary: added null }
  });
```

Every write lands at `N_max + 1`; nothing is rewritten. A plain `update` never resurrects a tombstone (`restore` and `restoreVersion` do). A create is never an upsert (`NodeAlreadyExists`). `restoreVersion` refuses a version that cannot be fully reconstructed before writing anything. `history` is bounded (`MAX_HISTORY_LIMIT`).

**Optimistic concurrency.** `update`, `restore`, `delete` and `restoreVersion` take an optional `expectedVersion` (a `Precondition`): the head version the caller last read. If the head has moved, the write fails `StaleVersion`, which carries the head it found (`current`), and nothing is written. Without one, a write extends whatever the head is, so a column that two patches both set is last-writer-wins. The check runs against the same head read the append extends, and the append lands at that head + 1. A writer that slips in between therefore takes the `(id, version)` key first, and the later append fails `VersionConflict`. The store's key is what makes the check atomic, so the seam needs nothing new. A delete over a tombstone stays idempotent whatever the precondition (the delete it asked for has happened). A missing node is still `NodeNotFound`, and a plain `update` over a tombstone is still `NodeNotFound`, whatever version it expects.

**Comparing versions.** `diffStates(from, to)` is the field-level change set between two states: one entry per column that is `added`, `removed` or `changed`, each with its `before` and `after` values. Unchanged columns are omitted, so equal states diff to `{}`. A `null` is a value, so a column cleared to `null` is `changed`, and only a column with no key is absent (`added` / `removed`). Values compare structurally with Effect's `Equal.equals`: JSON objects and arrays by content (ignoring key order), a `Date` by its instant, and a `bigint` by value. A content-addressed document is held as its hash (`documentRef`), so it compares by hash, and a textual diff of the document is the UI's job. `compare(id, from, to)` makes two `getVersion` reads and returns both snapshots with `changes: diffStates(from.state, to.state)`. It fails `VersionNotFound` for either version, checking `from` first. A tombstone is the version's `action`, never an attribute: a version compared with the tombstone after it has no changes, and `to.action === "delete"` says the node was deleted there. The chain's `compare`, like its `getVersion`, applies no gate; `./subtype`'s `compare` is the gated one (see [`./subtype`](#subtype)).

| Export | What it is |
| --- | --- |
| `defineVersionChain(type, store, hooks?)` | The operations (`create`, `update`, `restore`, `delete`, `getVersion`, `compare`, `restoreVersion`, `history`) for one leaf type. |
| `ChainHooks`, `ChainAppendEvent`, `WriteAction` | The chain's one hook point, `beforeAppend`: shown each write's action (`create`, `update`, `delete`, `restore`, `restoreVersion`), the head it extends and its patch, after the head read and before the append, and returning the patch to apply. `./subtype`'s before hooks run through it. |
| `VersionChainStore<E, R>` | The persistence seam (see [Seams](#seams)). |
| `ChainState`, `ChainPatch`, `applyPatch` | A leaf's state at one version, the tri-state patch over it (a value sets, `null` clears, `undefined` carries forward), and the merge. |
| `Precondition` | The optional `expectedVersion` every write to an existing node takes. |
| `diffStates(from, to)`, `StateDiff`, `AttributeChange`, `VersionComparison` | The pure field-level change set between two states, its shape (`added` / `removed` / `changed` per column, with `before` / `after`), and what `compare` returns. |
| `NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `StaleVersion`, `VersionConflict` | The tagged failures: the wire's 404 / 404 / 409, a failed expected-version precondition (412 for an `If-Match`, or 409; it carries the head), and a concurrent writer's `(id, version)` collision, which is never retried. |

## `./filter`

The kernel's read predicates as data: a store renders a `ListFilter` to SQL, and `evaluate` runs it against an in-memory row, so a list filter and its row predicate can be proven to agree.

| Export | What it is |
| --- | --- |
| `ListFilter<Following>` | The predicate tree. `Following` is whatever the follower seam hands the `in` node: a subquery for SQL, a set in memory. |
| `always`, `never` | No predicate; a predicate no row satisfies (fail closed). |
| `eq`, `ne`, `isIn` | `col = v`, `col <> v`, `col IN (following)`. |
| `gt`, `gte`, `lt`, `lte`, `Comparable` | `col > v`, `col >= v`, `col < v`, `col <= v`, over a `Comparable` (`string`, `number` or `Date`). |
| `anyOf`, `noneOf`, `MAX_SET_VALUES` | `col = ANY(values)`, `col <> ALL(values)` over a literal set of `Scalar`s; an empty `anyOf` is `never`, an empty `noneOf` is `always`, and a set of more than `MAX_SET_VALUES` (1000) values, duplicates counted, is `never` (`SEC-INPUT-003`). |
| `published`, `notPublished` | Stamped and arrived; its exact complement (unstamped, or stamped in the future). |
| `and`, `or` | Combinators that drop identity parts, short-circuit on the absorbing part, and return a single part bare. |
| `evaluate(filter, row, context)` | The in-memory reading, against `context.now` and `context.contains`. |

A SQL renderer must honour this contract:

| Node | SQL |
| --- | --- |
| `always` | no predicate (`undefined` to Drizzle's `.where`) |
| `never` | a predicate no row satisfies |
| `eq` / `ne` | `col = $v` / `col <> $v`: a `NULL` column satisfies neither, so `evaluate` drops a row whose column is `null` or absent from both |
| `in` | `col IN (<following subquery>)`: a subquery, never a materialised array. A `NULL` column satisfies none, so `evaluate` drops a row whose column is `null` or absent without asking `context.contains` |
| `gt` / `gte` / `lt` / `lte` | `col > $v` / `col >= $v` / `col < $v` / `col <= $v`. A string compares with `COLLATE "C"` (code-point order; `evaluate` does not use JavaScript's UTF-16 `<`), a `Date` as a timestamp, a number numerically, `Infinity` and `-Infinity` each equal to itself. A `NULL` column satisfies none |
| `anyOf` | `col = ANY($values)`: a bound array, each value tested as `eq` tests it. A `NULL` column satisfies none. The array never holds a `NULL` element |
| `noneOf` | `col <> ALL($values)`, each value tested as `ne` tests it. A `NULL` column satisfies none (`NULL <> ALL(…)` is `NULL`), so `noneOf` is not the complement of `anyOf` over a nullable column. Over no values it is true for every row, `NULL` included, which the constructor folds to `always`. The array never holds a `NULL` element: `2 <> ALL('{1,NULL}')` is `NULL`, so one would drop every row |
| `published` | `(col IS NOT NULL AND col <= now())`: the database's clock, one per query |
| `notPublished` | `(col IS NULL OR col > now())`, parenthesised so it cannot bind to a surrounding `AND` |
| `and` / `or` | `AND` / `OR` over the parts |

An `anyOf` / `noneOf` node with more than `MAX_SET_VALUES` values (duplicates counted) renders as `never`, and `evaluate` reads it so. The constructors already return `never` for one, so only a hand-built node reaches a renderer that way. A cap that dropped some of a `noneOf`'s values would widen the result, so the arm fails closed instead.

Some inputs are outside the contract: SQL and `evaluate` can't be made to agree on them, so `evaluate` fails closed.

- **A column of another type than the comparand**, or than any of a literal set's values, is a caller or schema error. PostgreSQL may coerce the parameter (an `integer` column against `'1'`) or raise (against `'abc'`). `evaluate` reads such a row as satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`.
- **`NaN`, and an invalid `Date`.** PostgreSQL's `float8` and `numeric` hold `NaN` equal to itself and greater than every number; JavaScript's `NaN` has no such order. Every constructor returns `never` for a `NaN` or invalid-`Date` comparand, and `anyOf` / `noneOf` return `never` for a set holding a `NaN`. `evaluate` reads a `NaN` comparand, set element or column as satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`. A renderer must never bind `NaN`: it renders a hand-built node carrying one as `never`.
- **Sub-millisecond instants.** A PostgreSQL timestamp keeps microseconds and a JavaScript `Date` milliseconds, so two instants within one millisecond of each other can compare unequal in SQL and equal in `evaluate`.

## `./subtype`

`defineSubtype` binds a leaf's CRUD, version history and list over the chain store, a current-version `LeafStore`, and the viewer seam (`viewer`, `AccessPolicy`, `FollowerSeam`), gated by `LeafAccess`:

- `reference` — writes at the corpus-write rung; when the view has a `visibility` column, reads only `public` rows below the view-private rung, apart from soft-delete. A leaf whose rows may be `followers`-visible declares the view column that plays the owner's part, `{ kind: "reference", followersOfColumn: "curatorId" }` (see [Seams](#the-viewer-the-role-axes-and-the-follower-seam)): a `followers` row is then also read by the account that column names and by its followers, and by nobody else below the view-private rung (that account's `private` rows stay the rung's alone). Without the declaration a `followers` row is the rung's alone. A write or history read to an existing row also needs the caller to be able to `get` it: a row `get` hides from them (or a missing one) fails `NodeNotFound` before the chain is reached, so only the view-deleted rung can `restore` a tombstone.
- `owned` — creates at any account (stamping the owner); other writes at owner-or-moderator; reads through `canViewOwned` (three-state visibility plus `draft`), lists through `ownedListFilter`, the same facts as a `ListFilter`. A row whose owner column holds no string (a `NULL`) has no owner: no viewer owns it and the follower seam is never asked about it, so it reads only when `public` and not a draft, or at the view-private rung.

`get`, `getMany` and `list` treat a row the viewer may not see as missing (`NodeNotFound`, never `Forbidden`). So do a reference leaf's write and history operations. An owned leaf's don't, deliberately (pulpit#24): their gate answers `Forbidden` for an existing owned row the caller doesn't own, whatever its visibility, draft or delete state, so it confirms existence to a signed-in caller; see [SECURITY.md → Existence disclosure by the write gates](https://github.com/thomasfosterau/pulpit/blob/trunk/SECURITY.md#existence-disclosure-by-the-write-gates). `subtypeHandlers(ops, { transact, cache })` wraps the operations as the handler record a JSON:API server is expected to accept (see [Seams](#seams)), writing every mutation through the resource cache.

The version history is gated like a write (`READ-009`): `getVersion(id, version)` and `compare(id, from, to)` run the same gate as `update`, through one code path, before any version is read, and then delegate to the chain's `getVersion` / `compare`. So `compare` answers exactly as `getVersion` would for `from` and then `to`: `Unauthorized`, `Forbidden` or `NodeNotFound` from the gate, whichever version is asked for, and `VersionNotFound` (naming `from` first) only to a caller the gate admits. `subtypeHandlers` doesn't expose `compare`: no JSON:API operation exists for it, so an application calls it directly.

`list` takes an optional `orderBy`, a list of `{ column, direction }` keys (`direction` is `"asc"` or `"desc"`); absent, empty or `null` is `id` ascending. The rows sort by each key in turn, a `NULL` (or absent) column after every value in both directions, then by `id` ascending, so the order is total and an offset page never skips or repeats a row. A string sorts by code point, a number or `bigint` by value, `false` before `true` and a `Date` by its instant. Each key is checked before the viewer or the store is read: a column that is not sortable, a direction other than `asc` / `desc`, or input not shaped as an order (an `orderBy` that isn't an array, a key that isn't an object, a `column` that isn't a string) fails `InvalidListOrder` and never reaches the store. Its `column` is the caller's own key, or `""` when the failing key (or a non-array `orderBy`) has no string column to name, which an adapter can map to JSON:API's `source.parameter` (the whole `sort`) rather than one field. A repeated column is dropped, since its first key already ordered every tie it could. The order decides only where the visible rows fall: the privacy, soft-delete and `where` filters choose them exactly as before, and `total` is the same under every order (`SEC-AUTH-ENUM-001`).

**Which columns sort: `sortable`, and its default.** `defineSubtype` takes an optional per-leaf `sortable` allow-list of column names. Each entry must be one of the view's `LeafStore.columns`, or `defineSubtype` throws `SubtypeDeclarationError` when the leaf is declared. With a list, only its columns sort; any other column, a declared one included, fails `InvalidListOrder`. With a list, `id` sorts only if listed; `[]` admits only the default `id`-ascending order, so any non-empty `orderBy` fails `InvalidListOrder`. **When `sortable` is omitted, every declared view column is sortable**, including columns the resource never shows. That default discloses two things to any caller:

- **The visible rows' ranking by any view column.** A caller can sort the rows it may already see by a column the API doesn't expose (a `rank`, a moderation score) and so learn that column's order among them.
- **Which names are view columns.** The `InvalidListOrder` 400 answers a name that isn't one, and a list answers one that is.

It reveals no hidden row and changes no total. Declare `sortable` to sort only by what the resource exposes; an adapter mapping a wire parameter (WordPress's `orderby`) should still map onto its own names. Every `sortable` column must hold a scalar orderable type (see the [order contract](#leafstorerow-following-e-r-the-current-version-view)).

`update`, `restore`, `delete` and `restoreVersion` (and the handlers' `update`, `restore`, `delete` and `restoreVersion`) take the chain's optional `expectedVersion` and fail `StaleVersion` when it is not the head. The write gate runs first, so a refused caller learns nothing from the failure.

**The head version on the wire** (pulpit#65). Every `LeafRow` carries its head `version` (see [Seams](#leafstorerow-following-e-r-the-current-version-view)), so a read can tell the client the version its next write should expect. The mapper stamps it as the resource object's `meta.version`, a decimal string (`bigint` has no JSON form), with `versionMeta(row)`: `toResource: (row) => ({ type: "posts", id: row.id, attributes: …, meta: versionMeta(row) })`. A single-resource response (`get`, `create`, `update`, `restore`, `restoreVersion`) also sends `versionEtag(resource)` as its `ETag` header: the strong tag `"<version>"`, read back from that `meta.version`, so the two never disagree. A collection response sends no `ETag`, since it has no single version; each resource in it still carries its own `meta.version`. The version reaches only a resource the read already serves the viewer, so it says nothing about a hidden row (`SEC-AUTH-ENUM-001`). What it does disclose about a row the viewer can see is how many versions its chain holds.

**Lifecycle hooks** (pulpit#45). A leaf's write side effects compose as `LifecycleHooks` on its definition, `hooks: Effect<LifecycleHooks<Resource, E, R>, never, R>`: an Effect, so the application holds them in a `Context` service, composes them per leaf type and provides them with a `Layer`. Omitted, a leaf has none, and a write reads nothing extra. Hooks run in array order (`composeHooks` concatenates sets), so the order is deterministic and the application's.

- **Before hooks** run inside every write (`create`, `update`, `restore`, `delete`, `restoreVersion`), after its gate and the chain's head read and before the append, in the caller's transaction. Each is shown the leaf type, the action, the node, the head the write extends (`prior`, none for a create), the patch, and the viewer, and returns the patch the write applies (the event's, or a transformed one: a derived slug, a normalised field); the next hook sees that patch. One that fails, with `WriteRejected` or the store's `E`, fails the write with nothing appended. The expected-version check still runs after it, against the same head.
- **After hooks** run in `subtypeHandlers`, once the write's `transact` has returned (the operations alone can't know when a write commits), and are shown the type, the action, the `{ id, version }` the write landed at, and the resource as the writer re-read it (none for a delete, or when the re-read failed). They never fail the write: a failure, a defect included, goes to `afterFailure`, `"log"` (the default: logged at error level, and the next hook still runs) or `"defect"` (the handler dies, though the write committed). They run uninterruptibly. The cache write-through is the first after hook (`cacheWriteThrough`), ahead of the leaf's own.
- **Durable delivery is the application's.** An after hook runs once, in process, after the commit; a side effect that must not be lost (a queue message, a webhook) belongs in a before hook, as an outbox row the same transaction writes.
- **Events fire on explicit writes only.** A delete of an already tombstoned node writes nothing and emits nothing. A version stamped to publish in the future emits nothing when its stamp arrives: drive a sweep from a cron with `./publication`'s `duePublications(since, now)` instead.

| Export | What it is |
| --- | --- |
| `defineSubtype(definition)`, `SubtypeDefinition`, `SubtypeOps` | The factory, its declaration (type, access, stores, viewer seams, row → resource mapper) and the operations it produces. |
| `subtypeHandlers(ops, config)`, `SubtypeHandlers`, `SubtypeHandlersConfig`, `ResourceCacheSeam` | The handler record with cache write-through, its `transact` boundary and the cache's write side. |
| `LifecycleHooks`, `BeforeWriteHook`, `BeforeWriteEvent`, `AfterWriteHook`, `AfterWriteEvent`, `WriteRejected` | The lifecycle hook seam: a leaf's before hooks (inside the write; may transform the patch or refuse with `WriteRejected`) and after hooks (after the commit; never fail the write), and their events. |
| `composeHooks(...sets)`, `noHooks()`, `cacheWriteThrough(cache)` | Concatenate hook sets in order; the empty set; the resource cache's write-through as an after hook. |
| `LeafAccess`, `ownedAccess(options?)` | The gate selector (`reference`, with an optional `followersOfColumn`, / `owned` with its view columns), and the owned declaration with the conventional column names. |
| `Viewer`, `ViewerAccount`, `AccessPolicy` | The viewer seam and the four role axes (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`). |
| `FollowerSeam`, `nobodyFollows(nobody)` | The follower seam and its fail-closed default. |
| `ReadScope`, `readScopeFor(viewer, policy, followers)` | A viewer's owned-material read scope (`all` / `public` / `member`). |
| `canViewOwned`, `OwnedFacts` | The owned-row read predicate and the facts it reads. |
| `ownedListFilter`, `softDeleteFilter`, `referencePrivacyFilter` | The list arms: owned visibility, the soft-delete axis, and the reference privacy axis (given `Option.some({ access, followers })`, with its followers arm). Pass that fourth argument whenever the leaf declares `followersOfColumn`: the three-argument form agrees with `get` only for a leaf without it. |
| `requireCreator`, `requireWriter` | The write gates for a create and for a write to an existing row. On a reference leaf `requireWriter` is the rung check alone; `defineSubtype` follows it with `get`'s read check. |
| `Unauthorized`, `Forbidden`, `InvalidListOrder` | The gates' failures: no signed-in viewer (401); a viewer below the rung (403, never used to hide a row). And `list`'s: an order key on a column that isn't sortable, or not shaped as an order (400; `column: ""` when the failing key has no string column). |
| `SubtypeDeclarationError` | Thrown by `defineSubtype` when the leaf is declared: a `sortable` entry that isn't a column of the view. |
| `LeafStore`, `LeafRow`, `Page`, `ListRequest`, `ListOrder`, `MAX_PAGE_LIMIT` | The current-version view seam, its row (with the head `version`) and page shapes, the list request and one key of its order, and the page cap (1000). |
| `versionMeta(row)`, `VersionMeta`, `versionEtag(resource)`, `VersionedResource` | The resource object's `meta` for the row's head version (`{ version: "3" }`), and a single-resource response's `ETag` value read back from it (`Option.some('"3"')`, none without a decimal `meta.version`). |

## `./publication`

The publication axis (stamped AND arrived), the moderation state, and the KV cache's serveability policy.

| Export | What it is |
| --- | --- |
| `isPublishedAt(stamp, now)` / `isNotPublishedAt` | Stamped AND arrived, and its exact complement (a future stamp is scheduled, not out). |
| `publishedFilter(column, wanted)` | The axis as a list-filter arm; none in, no predicate out. |
| `duePublications(since, now, column?)` | The rows whose stamp arrived in `(since, now]`, as a list filter, for an application's cron to sweep scheduled publications: a write's events fire when it is made, never when a future stamp arrives. Abutting windows (each run's `now` the next run's `since`) see each row once. |
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
    const state = {
      title: (yield* documents.put(title)).hash,
      body: (yield* documents.put(body)).hash,
    };
    const { id } = yield* chain.create({ id: Option.none(), state, actorId: Option.none() });
    return { id, body: yield* documents.get(state.body) }; // put is idempotent: the same document, the same hash
  });
```

The document type is a parameter: its schema and validation are the application's, and pulpit never imports them. The hash is the store's to derive; the algorithm and the bytes it is taken over are in [Seams](#seams), and `canonicalText` produces those bytes for a store that doesn't run on Postgres.

| Export | What it is |
| --- | --- |
| `DocumentStore<Document, E, R>`, `DocumentPut` | The store seam: `put` (idempotent, returns `{ hash, inserted }`, `inserted` only when it wrote the row), `get`, `getMany` (see [Seams](#seams)). |
| `onDocumentInsert(store, hook)`, `DocumentInserted` | The store with a first-insert hook (both apps enqueue an embedding job): it runs after a `put` that inserted, never after one that found the document stored, inside the `put`'s transaction, and its failure fails the `put`. |
| `DocumentHash` | A SHA-256 document hash as 64 lowercase hex characters. |
| `documentRef(key)` | The attribute spread for a version row's document reference: the hash, required on the resource and at create, carried forward at update, never cleared. |
| `canonicalText(json)` | The canonical text the hash contract takes SHA-256 over (Postgres's `jsonb` text output), for a store that doesn't run on Postgres. |

## `./edges`

`defineEdgeOps` binds the operations of an edge family: a relation between nodes, stored as a row of its own (an id, a `createdAt`, one column per end holding that end's node id, and the family's own qualifier columns) outside both nodes' tables. It is ported from gardeneria's `defineEdgeOpsE`:

- `list`: one page under the family's own `where`, at most `MAX_PAGE_LIMIT` (1000) rows, ordered by `createdAt` then `id`, with the unpaged total.
- `get`: one edge by id.
- `create`: asserts the edge. On a collision with a stored edge on the family's unique key, `onConflict: "ignore"` returns the stored edge's id with `created: false` when the caller can read that edge and its every end is live (a re-assertion is idempotent, and never rewrites the stored qualifiers); `"fail"`, the default, fails `EdgeConflict`, and so does `"ignore"` when the stored edge is hidden from the caller or has a tombstoned end (the view-deleted rung reads such an edge but can't link to a tombstone, so it can't resolve to one either).
- `delete`: a hard `DELETE`. There is no update: correcting an edge is deleting it and asserting the right one.

Writes gate on the declaration's `writeGate`. The default, `corpusWriteGate`, is the corpus-write rung, right for an edge between two reference leaves. `rungGate((policy) => policy.canModerate)` puts a family on another rung. An owned-child edge (gardeneria's observation → disorder) passes a gate that reads its owned end's owner, typically `requireWriter` from `./subtype`.

On top of the port, pulpit enforces three rules:

- **Endpoint visibility** (`EDGE-001`). Each end declares its endpoint leaf's `access` and its current-version view (`nodes`; the leaf's own `LeafStore` fits). An edge is readable only if the viewer can read the node at every end, by the rule that leaf's own `get` and `list` apply, a reference leaf's followers arm included. `get` fails `EdgeNotFound` for a hidden edge, and `list` omits it, never `Forbidden` (`SEC-AUTH-ENUM-001`). A related list (the edges at one node) is `list` filtered on that end's column, so it omits every edge whose other end is hidden, and the related list of a hidden node is empty. The list filter (`endpointFilter`) and the per-endpoint predicate (`canViewEndpoint`) read the same facts, so they never disagree. A create naming a node the viewer can't read fails `NodeNotFound`, before the write gate runs, so a 403 never confirms that the node exists.
- **Endpoint lifecycle.** A tombstoned end hides its edges from every viewer below the view-deleted rung, and a create can't name it, whoever asks. The view-deleted rung reads a tombstoned end as the leaf's own `get` reads the tombstone, by its access rule ([#93](https://github.com/thomasfosterau/pulpit/issues/93)), so it can `list`, `get` and `delete` an edge whose only hidden end is tombstoned: a moderator can find and remove a retired node's stale edges. An end hidden for any other reason (a `private` node below the view-private rung, say) still hides the edge from that rung. Nothing is deleted, so restoring the node (`restore`) brings its edges back as they were.
- **Cardinality.** An end's `maxEdges` bounds how many edges one node at that end may hold; a create past it fails `EdgeCardinalityExceeded` (with the end, the node and the limit). It must be a positive safe integer: `defineEdgeOps` throws `EdgeDeclarationError` when the family is declared otherwise, and likewise for an end alias containing a `.`. A create counts only the edges at the node that the caller can read and whose every end is live ([#77](https://github.com/thomasfosterau/pulpit/issues/77), [#93](https://github.com/thomasfosterau/pulpit/issues/93)). A re-assertion of a stored edge resolves before the count, so it stays idempotent at a full node. Counting that way has three consequences:
  - **A refusal discloses nothing hidden**; see [What a write discloses](#what-a-write-discloses).
  - **A tombstoned partner frees its slot at once.** Its edge stays stored and stops counting, so tombstoning a partner never freezes a node.
  - **The limit holds per caller, and can be overshot.** Edges a writer can't read don't count against that writer, so a node can end up holding more than `maxEdges` edges in all. Restoring a tombstoned partner brings its edge back without a check (a restore is a chain write and reads no edge), which can put a node past its limit. An over-limit node keeps its edges, and every create at it fails `EdgeCardinalityExceeded` until enough are deleted. Only a caller who can read every edge at the node (the view-private rung, typically) is held to the limit over all of them; an edge to a tombstoned end never counts, for anyone.

### What a write discloses

The read operations never reveal a hidden edge (`SEC-AUTH-ENUM-001`), and nor does a write's answer ([#93](https://github.com/thomasfosterau/pulpit/issues/93)). `create` runs in this order: ends, then the write gate, then the unique-key collision, then the cardinality count. A node the caller can't read is `NodeNotFound` whoever asks, and only a caller the gate admits reaches the collision and the count. There:

- **The count reads no hidden edge.** `EdgeCardinalityExceeded` depends only on the edges the caller can read at the node, so a node holding hidden edges answers exactly as one holding none. The cost is the weaker limit under Cardinality: a writer who can't read every edge at a node can take it past `maxEdges` in all.
- **A collision says only that the key is taken.** `EdgeConflict` carries only the family's type. Under `"fail"` a collision with a hidden edge answers exactly as one with a readable edge; under `"ignore"` only a readable, live edge resolves to `{ created: false, id }`, and otherwise (a hidden edge, or one with a tombstoned end, whoever asks) it is `EdgeConflict`. That the key is taken is the unique index's own answer, so it can't be hidden. That says something about a hidden edge only in a family whose unique key leaves an end out (gardeneria's page slugs key on the path, not the page): there, a writer who gets `EdgeConflict` with no readable edge holding the key learns that some edge it can't read does, though not which, nor at which node. Where the key covers every end, a colliding edge joins the same nodes the create just showed to be live and readable, so it is readable itself. A family that must not reveal even that should key on every end.

An owned leaf's `./subtype` writes answer differently, by decision (pulpit#24): its write and history gates deliberately confirm to a signed-in caller that an owned row exists (`Forbidden` for one they don't own, `NodeNotFound` for none). A reference leaf's hide a row as `get` does (pulpit#101). See [SECURITY.md → Existence disclosure by the write gates](https://github.com/thomasfosterau/pulpit/blob/trunk/SECURITY.md#existence-disclosure-by-the-write-gates).

**An edge isn't a node.** It has no version chain, so the chain's append-only rules (`VERSION-CHAIN-001/002`) don't govern it, and its hard delete rewrites no version row. Tombstoning a node leaves its edges stored.

### Taxonomies

pulpit ships no category or tag vocabulary: a taxonomy is a reference-data leaf plus an edge family.

- **The terms** are a `reference` leaf (`defineSubtype` with `access: { kind: "reference" }`), written at the corpus rung, versioned like any other node. A hierarchy is a parent column on that leaf, or a second edge family between terms.
- **An assignment** is an edge family whose ends are the term leaf and the classified leaf. `maxEdges` on the classified end says how many terms one node may hold (1 for a single-choice taxonomy); on the term end, how many nodes one term may classify. `onConflict: "ignore"` makes re-assigning a term idempotent.
- **Who may assign** is the write gate: the corpus rung for curated assignments, or a gate on the classified node's owner when members classify their own rows.
- **A node's terms, and a term's nodes,** are `list` filtered on one end. Either list hides what the viewer can't read at the other end, and a tombstoned term drops out of every list below the view-deleted rung until it is restored.
- **Retiring a term** is tombstoning it. Its assignments stay stored and stop counting towards the classified end's `maxEdges` ([#77](https://github.com/thomasfosterau/pulpit/issues/77)), so in a single-choice taxonomy the nodes it classified can be reassigned at once. The view-deleted rung still lists the stale assignments and can delete them. Restoring the term brings them back, and a node reassigned meanwhile then holds two terms, past its limit; it keeps both until one is deleted, and refuses a further assignment meanwhile.

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

## `./proposals`

Suggested edits (pulpit#49). A contributor proposes a patch to a node they can read; the node's writer accepts it (appending it as a new version) or rejects it, and the proposer may withdraw it while it is pending. A proposal is a plain row, not a node: the target, the patch as submitted, the `baseVersion` it was written against (stamped from the target's head, never client-supplied), its status (`pending | accepted | rejected | withdrawn`), the decider and the timestamps.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineProposals } from "@thomasfosterau/pulpit/proposals";

const pages = defineProposals({
  type: "pages",
  target: pageOps, // the leaf's defineSubtype operations
  chain, // its chain store: the head a proposal is stamped with
  ownerOf: pageLeaves.ownerOf,
  proposals: proposalStore,
  viewer,
  policy,
  canPropose: () => true, // any signed-in account (gardeneria); website: contributor+
  attributes: ["title", "body"], // the leaf's update fields, in declaration order
  decode: decodePageUpdate, // the leaf's update decoder over a patch's values
});

const program = Effect.gen(function* () {
  const { id } = yield* pages.submit({
    targetId,
    patch: { title: "Better" },
    rationale: Option.none(),
  });
  const review = yield* pages.review(id); // { baseState: "clean" | "moved", conflict: { state, conflictingAttributes } }
  return yield* pages.accept(id, { note: Option.some("thanks") }); // the { id, version } it appended
});
```

- **Classification comes in two tiers.** `classifyProposalBase(base, head)` is `clean` or `moved` from two version numbers, with no read, so `get` and `list` give it for every pending row. `classifyProposalConflict(baseSnapshot, headSnapshot, touchedKeys)` is `clean`, `stale` (the target moved, but no touched attribute changed) or `conflicting`, over `diffStates`; it needs two version reads, so only `review` and `accept` run it. A touched attribute either state lacks (kept outside the chain) counts as conflicting on a moved target: fail closed.
- **The patch rules** (`validateProposalPatch`, at submit and again at accept): an object with at least one key; no `PROPOSAL_FORBIDDEN_KEYS` (`id`, `type`, `visibility`, `draft`, `publishedAt`, plus the leaf's own `forbidden`), checked before unknown keys; no key outside `attributes` (refused, never dropped); then the leaf's `decode`. A failure is `InvalidProposalPatch` (422).
- **Accept appends through the target's own `update`** (`PUB-003`), as the account that accepted, with the head it classified against as `expectedVersion` and the proposer as the version's `proposedBy`; a conflicting proposal fails `ProposalConflict` (409) and writes nothing, and an edit landing between the classification and the append fails `StaleVersion`. The append and the proposal's close run in the caller's transaction, so they commit together. It runs the target's before hooks but not `subtypeHandlers`' cache write-through: an application that caches the target writes the accepted version through itself.
- **Gates.** `submit`: signed in (`Unauthorized`), at `canPropose` (`Forbidden`), and able to `get` the target (`NodeNotFound` otherwise, never `Forbidden`). `review`, `accept`, `reject`: the target's write gate (`requireWriter`) before the proposal's status is disclosed; `review` and `accept` then read the versions through the target's gated `compare`. A proposal whose target was deleted can still be rejected. `withdraw`: its author (`Forbidden` for anyone else). A decided proposal fails `ProposalClosed` (409). `get` / `list`: the moderate rung reads every proposal; any other signed-in account reads its own and those on targets it owns; the anonymous read none, and a proposal the viewer can't read is `ProposalNotFound`.

Rate limiting, notifications and the wire shape (a JSON:API `proposals` resource) are the application's.

| Export | What it is |
| --- | --- |
| `defineProposals(definition)`, `ProposalsDefinition`, `ProposalOps` | The factory, its declaration and the operations (`submit`, `get`, `list`, `review`, `accept`, `reject`, `withdraw`). |
| `ProposalStore`, `ProposalRow`, `ProposalListing`, `ProposalDecision` | The table seam (see [Seams](#seams)), its row, a read's row with the target's head version, and the write that closes a pending row. |
| `ProposalStatus`, `ProposalView`, `ProposalReview` | The status vocabulary, and a read's and a review's result. |
| `classifyProposalBase`, `classifyProposalConflict`, `ProposalBaseState`, `ProposalConflictState`, `ProposalConflictVerdict` | The two tiers of classification and their verdicts. |
| `validateProposalPatch`, `ValidatedPatch`, `PROPOSAL_FORBIDDEN_KEYS` | The patch rules, a patch that passed them, and the keys no proposal may carry. |
| `ProposalNotFound`, `ProposalClosed`, `ProposalConflict`, `InvalidProposalPatch` | The failures: 404, 409 (already decided), 409 (the target changed underneath), 422. |

## `./blobs`

File and media leaves (pulpit#55). A file is an ordinary leaf (owned, like a member's image, or reference material) whose version row carries `fileResourceFields`: the `contentHash` of its bytes, their `byteSize` and `mediaType`, the original `filename`, and `bytesPending`. The bytes live behind a `BlobStore` the application supplies (R2, S3), under `blobKey(contentHash)`, so a version's bytes are immutable. New bytes are a new hash and a new version, `restoreVersion` restores the reference to the old bytes, and equal bytes are stored once.

```ts
import * as Option from "effect/Option";
import { defineFileWrites, fileUrl } from "@thomasfosterau/pulpit/blobs";

const files = defineFileWrites({ leaf: imageOps, blobs: r2, transact });
const written =
  yield *
  files.create({
    id: Option.none(),
    state: { visibility: "public" },
    upload: { bytes, mediaType: "image/png", filename: "fern.png" },
  });
// written.bytesPending: true when the post-commit byte write failed
fileUrl(row, r2); // none while the row's bytesPending is anything but false
```

- **Bytes are written after the chain commits.** `create` and `replace`:
  1. hash the upload (`sha256Hex`);
  2. append the version through the leaf's own operations inside `transact`, with `bytesPending: true` unless the store already holds those bytes;
  3. put the bytes once `transact` has returned;
  4. append `bytesPending: false` over exactly that version.
- **A failed byte write leaves the node pending.** If the put, or its confirmation, fails, the node stays `bytesPending` and the write still succeeds, reporting `bytesPending: true`. `fileUrl` gives no URL for it, so no reader is pointed at missing bytes.
- **`confirmBytes({ id, version, contentHash })` finishes a pending version** once the bytes are there (a retry, or a client's signed upload). It never lands over a later version (`StaleVersion`).
- **Nothing garbage-collects bytes.** They stay for as long as any version references them; purge (pulpit#58) is the one removal path, and `BlobStore.delete` is there for it.
- **Usage is an edge family.** "Where is this file used" is answered by `./edges`, using `fileUsageEnds({ user, file })` as a family's ends, so `EDGE-001` hides every use whose content the viewer can't read. Maintaining the edges is the referencing leaf's job, or an after hook's. Key the edge table uniquely on `(user_id, file_id)` and declare `onConflict: "ignore"`.
- **The writes bypass `subtypeHandlers`.** They go through the leaf's operations, so its gates, preconditions and before hooks apply, but not the handlers' cache write-through and after hooks.
- **Stays in the app:** the adapters, image transforms, EXIF extraction and video streaming.

| Export | What it is |
| --- | --- |
| `BlobStore`, `BlobHead` | The byte-store seam (see [Seams](#seams)) and what it knows of one object. |
| `ContentHash`, `sha256Hex(bytes)`, `blobKey(hash)` | The content hash (SHA-256, 64 lowercase hex characters), its Web Crypto derivation, and the store key it gives. |
| `fileResourceFields`, `FileColumns` | The file version's attribute spread (all read-only) and its columns. |
| `defineFileWrites(definition)`, `FileWriteOps`, `Upload`, `FileWrite` | The commit-ordered writes (`create`, `replace`, `confirmBytes`), an upload, and what a write reports. |
| `fileUrl(file, blobs)` | A version's URL, or none while its bytes are pending. |
| `fileUsageEnds({ user, file })` | The usage index's edge ends (`userId`, `fileId`). |

## `./testing`

In-memory fakes of the kernel's seams, for tests: an adapter's or an application's suite can run the real operations (`defineVersionChain`, `defineSubtype`, `defineEdgeOps`, …) over them without a database. Each fake implements its seam's contract as stated under [Seams](#seams), in memory and with no SQL, and enforces what the real table's schema enforces (a primary or unique key) and nothing the operations are responsible for. They are the fakes the kernel's own suites run against, so they are its reference semantics for each seam.

**Not for production.** Every fake keeps its rows in memory for the life of the value, persists nothing, never opens a transaction and has no concurrency control. The subpath isn't on the root export, so production code never pulls it in by accident.

```ts
import { deepStrictEqual } from "node:assert";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { defineSubtype, type LeafRow } from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "@thomasfosterau/pulpit/testing";

const chain = makeInMemoryChainStore();
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
| `makeInMemoryChainStore()`, `InMemoryChainStore` | [`VersionChainStore`](#versionchainstoree-r-the-version-chain-persistence), with the `(id, version)` key (`VersionConflict`) and sequential UUID-shaped `mintId`s. | `rows()` (every appended row), `dropState(id, version)` (a partial chain), `raceNextAppend(id)` (a concurrent writer). |
| `makeInMemoryLeafStore(chain, { columns, now? })`, `InMemoryLeafStore`, `InMemoryLeafStoreOptions` | [`LeafStore`](#leafstorerow-following-e-r-the-current-version-view), as the current-version view over an in-memory chain plus the owner stamps; `list` evaluates the `ListFilter` in memory and sorts by the list order contract (`NULLS LAST`, code-point strings, `id` last). | `owners()` (the stamps), `dropOwner(id)` (an ownerless owned node). |
| `makeInMemoryDocumentStore()`, `InMemoryDocumentStore` | [`DocumentStore`](#documentstoredocument-e-r-the-content-addressed-document-store), hashing exactly as the hash contract says (SHA-256 over `./documents`' `canonicalText`, pinned to hashes taken from Postgres). | `stored()` (every document by hash), `writes()` (how many `put`s inserted). |
| `makeInMemoryEdgeStore({ ends, uniqueKey, now? })`, `InMemoryEdgeStore`, `InMemoryEdgeStoreOptions` | [`EdgeStore`](#edgestorerow-following-e-r-the-edge-table), with the unique key (`NULLS NOT DISTINCT`), the INNER JOIN of each end's view, and the window-column total. | `rows()` (every edge, hidden ones included), `raceNextInsert(winner)` (a concurrent writer). |
| `makeInMemoryNodes(columns)`, `InMemoryNodes` | `EndpointView`, an end's view whose rows a test writes directly (an `InMemoryLeafStore` is one too). | `put(row)`. |
| `makeInMemoryProposalStore({ chain, leaves })`, `InMemoryProposalStore` | [`ProposalStore`](#proposalstoree-r-the-proposal-table), reading each listing's head version from `chain` and its `targetOwnerId` from `leaves`' owner stamps; newest first, `id` descending on a tie. | `rows()` (every proposal as it now stands). |
| `makeInMemoryBlobStore()`, `InMemoryBlobStore`, `InMemoryBlob`, `InMemoryBlobFailure` | [`BlobStore`](#blobstoree-r-the-byte-store), with `memory://<key>` URLs and no signed upload. | `objects()` (every stored object), `failNextPut()` (a byte write failing after the commit). |
| `makeInMemoryFollowers(table)`, `InMemoryFollowing` | [`FollowerSeam`](#the-viewer-the-role-axes-and-the-follower-seam) over an explicit table of who follows whom; the `in` set is a `HashSet` of account ids, where SQL's is a subquery. |  |

`now` is the instant the list filter's `published` / `notPublished` compare against (and, for the edge store, the base of the minted `createdAt`s). Pass a fixed `Date` for a deterministic suite; left out, each call reads the Effect `Clock`, so `TestClock` steers it. The role ladder and the `AccessPolicy` are the application's, so `./testing` ships none.

## Seams

The kernel is written against explicit interfaces, so that it doesn't depend on the packages that fill them before they publish. Each seam below states the shape its real implementation must have, and which package (if any) is expected to fill it; the issue numbers in parentheses are for maintainers and aren't needed to follow the contract. [`./testing`](#testing) has an in-memory fake of each store and of the follower seam, which implements the contract stated here.

### `VersionChainStore<E, R>`: the version-chain persistence

Expected to be a Drizzle store built over the application's version tables (effect-drizzle-ext's `./versioned-chain`, once it publishes; pulpit#4). Expected schema:

- a root version table (the apps' `core.node_version`) keyed `(id, version bigint)`, carrying `action` (`create | update | delete`, the single home of currency and tombstone state), `timestamp`, `user_id` (the row's `actorId`) and `proposed_by` (nullable: the row's `proposedBy`, the contributor whose accepted proposal the version applies; pulpit#49); plus the identity row (`core.node`: `id`, `type`) inserted at version 0;
- one version table per chain level keyed `(id, version)` with the `(id, version)` → parent-version FK, carrying that level's domain columns (6NF fact tables for a fact-scoped level).

Method contract: `head` is `SELECT … ORDER BY version DESC LIMIT 1` on the root table; `snapshot` reads every level at `(id, version)` and returns none when ANY level is missing (no partial state); `append` inserts the root row and every level's row at the given version (at version 0 the identity row too) and maps a primary-key violation on `(id, version)` to `VersionConflict`; `entries` is `ORDER BY version ASC LIMIT $limit`; `mintId` is a UUID. `E` is the store's query error and `R` the ambient transaction (`EffectDrizzleQueryError` and `CurrentTransaction` for the Drizzle store). The store never opens a transaction itself.

### `LeafStore<Row, Following, E, R>`: the current-version view

Expected to be a Drizzle store over the leaf's current-version view (pulpit#5). Each row is a `LeafRow`: the node's `id`, the head row's `version` (a `bigint`, pulpit#65) and `action`, and the leaf's columns. The view projects `version` itself, from the same head row it reads `action` from, so a read costs no second query against the chain. `id`, `version` and `action` are the view's own names: no leaf column may take one. `columns` is the view's column-name set (`getColumns(view)`, which includes `version`); `get` / `getMany` are `id = $id` / `id = ANY($ids)` reads with `LIMIT`; `list` renders its `ListFilter` (below), orders totally by its `orderBy` (below), and returns the page plus the unpaged total as a window column; `ownerOf` / `stampOwner` read and insert the node's owner row (`core.node_owner`).

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

### `ListFilter<Following>` → SQL: the filter renderer

The rendering contract is the table under [`./filter`](#filter). `Following` is the follower seam's subquery (Drizzle's `SQLWrapper`), rendered as `col IN (<subquery>)`, never a materialised array. `published` / `notPublished` use the database's `now()` and are parenthesised. A string comparison (`gt` / `gte` / `lt` / `lte`) uses the `"C"` collation, so it orders by code point as `evaluate` does; `anyOf` / `noneOf` bind their values as one array parameter.

### The viewer, the role axes and the follower seam

Expected to come from effect-auth once it publishes (pulpit#5). Its default branch already has them, unpublished (release PR effect-auth#177): `OwnedAccess` (`canView`, `readScope`, the `IsFollower` service, read fail-closed, `serveableAxes`), `Guard` (`Unauthorized`, `Forbidden`, and the kit `Guard.make` returns: `requireRoleAtLeast`, `requireOwnerOrRole`), `Ladder` and `Cacheability.publiclyServeable`, plus `ownedListFilter` in `@thomasfosterau/effect-auth-drizzle`. Until it publishes, the application supplies:

- `Viewer = Option<{ id, role }>`: the request's signed-in account, or none for an anonymous request (effect-auth's session context).
- `AccessPolicy`: four predicates over a signed-in account (`canViewPrivate`, `canViewDeleted`, `canModerate`, `canWriteCorpus`). Each compares the account's role against an application-named rung on its role ladder (effect-auth's `Ladder.make`, checked through the `Guard.make` kit's `hasRoleAtLeast` / `requireRoleAtLeast`). Each must fail closed on an unknown role.
- `FollowerSeam<Following, R>`: `isFollower(followerId, ownerId)` answers one row's question, and `following(followerId)` returns the list filter's `in` set (effect-auth's `IsFollower`). `nobodyFollows(nobody)` is the fail-closed default when a runtime provides none (effect-auth's `isFollowerNever`).
- **A reference leaf's followers column.** A reference leaf that carries `followers` rows declares `followersOfColumn` on its `LeafAccess`: a column of its current-version view (the `LeafStore`'s `columns` must include it) holding the id of the account that, with its followers, may read the row, in the same id space the follower seam takes. It is the application's column, under any name; pulpit adds no id brand for it. The list renders it as `visibility = 'followers' AND (<column> = <viewer> OR <column> IN (<following>))` and `get` shows the row when the column is the viewer's id or `isFollower(viewer, <column>)` answers true, so a `NULL` (or any non-string) value names nobody: it matches no viewer and is never asked of the seam. The named account and its followers read its `followers` rows; its `private` rows are read only at the view-private rung. A declared column the view lacks opens no `followers` row.
- `ReadScope` and `canViewOwned` (effect-auth's `OwnedReadScope` / `OwnedAccess.readScope` and `OwnedAccess.canView`) live here until effect-auth publishes its own; then pulpit consumes its read scope and keeps only the rendering into `ListFilter`.
- `Unauthorized` / `Forbidden` (effect-auth's `Guard` errors) are defined here until effect-auth publishes them.

### `SubtypeHandlers`: the handler record

The record a JSON:API server's resource handlers are expected to accept. effect-jsonapi's server skeleton has shipped as its `ResourceHandlers` namespace (`make`, `readOnly`, `related`; exported since 0.15.0, and pulpit's peer is `>=0.16.0`), but `subtypeHandlers` isn't wired to it yet (pulpit#5). One entry per endpoint (`list`, `get`, `create`, `update`, `delete`) returns the resource the document assembler wraps, plus `restore` and `restoreVersion`, which have no JSON:API endpoint and are called directly. Each write runs inside the config's `transact` (always-open: a nested call opens a savepoint), re-reads the row outside it as the writer, and hands it to the leaf's after hooks, the cache write-through (`cacheWriteThrough`) first (see [`./subtype`](#subtype) → Lifecycle hooks). When that re-read fails, as it does for a write that hides the row from its own writer (a corpus writer below the view-private rung making a reference row `private`), the handler evicts the entry and then fails with the re-read's error (`NodeNotFound`), so the cache never keeps the superseded resource (`CACHE-AUTH-005`, pulpit#107). Any other re-read failure (a store error, a defect) evicts the same way and propagates unchanged. An interrupt can't come between a committed write and its write-through or eviction: once the operation has succeeded, a failure of `transact` (an interrupt included) evicts too, since the write may have committed, while a write the gate or the precondition refuses never touches the cache (should `transact` retry internally, only its last attempt counts). The writer of a committed write it can no longer read still gets that `NodeNotFound`; the decided `{ id, version }` response waits on effect-jsonapi's handler contract, which has no body-less success (pulpit#107). When it is wired, `subtypeHandlers` maps onto `ResourceHandlers`' real handler signatures (the request context, the query decode, the document assembly), and its error catalogue replaces the tags here.

`update`, `delete` and `restoreVersion` take an optional `expectedVersion`. A client learns the head version from the resource it read: `meta.version`, or the single-resource response's `ETag` (`versionEtag`; see [`./subtype`](#subtype) → The head version on the wire). Mapping a request's `If-Match` (the tag's value) onto `expectedVersion`, and a `StaleVersion` failure onto `412 Precondition Failed`, is the HTTP layer's job, and so effect-jsonapi's: 0.16.3 has no such mapping, and setting the `ETag` header is the application's until it has.

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

So structurally equal documents share a hash whatever their member order, provided their numbers are spelled alike; that holds for documents serialised as `JSON.stringify` does (shortest round-trip digits, so `1.0` is written `1`). The hash is exchanged as a `DocumentHash`, the 32 bytes as 64 lowercase hex characters (`encode(hash_id, 'hex')`). A store that does not run on Postgres must reproduce these bytes exactly: `canonicalText(json)` in [`./documents`](#documents) produces the canonical text (pinned, with its hashes, to Postgres), and the store hashes its UTF-8 bytes. `makeInMemoryDocumentStore` in [`./testing`](#testing) is the reference store, for tests only.

Method contract: `put` is `INSERT … ON CONFLICT DO NOTHING RETURNING hash_id`, and when the insert returns no row it reads the row that conflicted, `hash_id = digest($document::jsonb::text, 'sha256')`; it never updates a stored row (`DOC-001`). It returns `{ hash, inserted }`, `inserted` being whether the `RETURNING` gave a row back, so `onDocumentInsert` can tell a first insert from a no-op. `get` is `hash_id = $hash`; `getMany` is one `hash_id = ANY($hashes)` read, returning the documents found keyed by hash. `E` and `R` are as for the chain store, and the store never opens a transaction itself. A first insert's side effects (both apps enqueue an embedding job) go through `onDocumentInsert` (pulpit#45).

**The apps' column differs.** Both apps generate the hash as `digest(document_jsonb::text::bytea, 'sha256')`. The `::bytea` cast parses the text as `bytea` escape-format input, so it agrees with the contract only on a document whose canonical text has no backslash. A document with a `"`, a newline, a tab or another escaped character in a string or key fails to insert (`invalid input syntax for type bytea`), and one with a literal backslash hashes different bytes (pulpit#71 tracks the apps' fix). Gardeneria's no-row lookup, `document_jsonb = $document`, also differs from the contract's: `jsonb` `=` ignores a number's scale, so it can match a row stored at another hash. The contract's spelling, `digest(document_jsonb::text, 'sha256')`, uses pgcrypto's `text` overload, which is immutable and therefore valid in a generated column; `convert_to(…, 'UTF8')` gives the same bytes but is only stable, so a generated column can't use it.

### `EdgeStore<Row, Following, E, R>`: the edge table

Filled by the application over each edge family's own table (pulpit#52); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `created_at` (`timestamptz NOT NULL DEFAULT now()`), one column per end holding the node id (a foreign key to the node identity table, `core.node`) with an index each, the family's qualifier columns, and, for a family that resolves re-assertions, a unique index on its natural key (`NULLS NOT DISTINCT` when a key column is nullable).

Method contract:

- `get` is `id = $id LIMIT 1`.
- `list` INNER JOINs each end's current-version view on `view.id = edge.<end column>`, under the end's alias, so an edge whose end has no view row is never listed. It renders `where` with the `ListFilter` renderer: a column `alias.name` resolves to that alias's view column, and a bare column to the edge table's. It orders by `created_at, id` and applies `LIMIT` / `OFFSET`. It returns the unpaged total as a window column (`count(*) OVER ()`), so the total is exact whenever the page has a row. An empty page reports `0`, including a page past the end of a non-empty list. That is gardeneria's documented rule, and the in-memory fake (`makeInMemoryEdgeStore` in [`./testing`](#testing)) follows it.
- `countAt({ column, nodeId, where })` is `count(*)` over the same INNER JOINs as `list`, where `column = $nodeId` and `where` holds (rendered as `list` renders it). The create passes the viewer's `EDGE-001` filter and every end's liveness (`action` is `create` or `update`), so only edges the caller can read with every end live are counted ([#77](https://github.com/thomasfosterau/pulpit/issues/77), [#93](https://github.com/thomasfosterau/pulpit/issues/93)). The create calls it inside its transaction for the cardinality check, once for each bounded end. The store locks the node first, so two creates at one node serialise and can't both take the last place. Three rules make that lock work:
  - **Lock with `FOR NO KEY UPDATE`:** `SELECT 1 FROM core.node WHERE id = $nodeId FOR NO KEY UPDATE`. Don't use `FOR UPDATE`. Every insert that references the node by foreign key (an edge in any family, or any other row keyed to `core.node`) takes `FOR KEY SHARE` on it, and `FOR UPDATE` would block those inserts for the rest of the transaction. `FOR NO KEY UPDATE` still conflicts with itself, so the creates still serialise.
  - **Run under READ COMMITTED** (PostgreSQL's default). There, the count after the lock wait sees the edge that the previous lock holder committed. Under REPEATABLE READ, the count reads the snapshot taken before the wait, so two creates can both see room and the node can overshoot its limit.
  - **Lock in ascending node id.** `create` calls `countAt` in ascending `nodeId` order, not declaration order. A self-referential family with two bounded ends (`a → b` and `b → a`) therefore locks its pair in one order, and two such creates can't deadlock. A store that locks anything else in `countAt` must keep to that order.
- `existing(values)` is the id of the stored edge whose unique-key columns match `values` (`IS NOT DISTINCT FROM`), `LIMIT 1`; always none for a family without a unique key.
- `insert(values)` is `INSERT … ON CONFLICT DO NOTHING RETURNING id`: the new id, or none when the key was taken (a racing writer, which the create then resolves through `existing`).
- `delete(id)` is `DELETE … WHERE id = $id RETURNING id`: whether a row went.

`E` and `R` are as for the chain store, and the store never opens a transaction itself. Each end's `EndpointView` is the endpoint leaf's own `LeafStore` (its `columns` and `get`).

### `ProposalStore<E, R>`: the proposal table

Filled by the application over its own proposal table (gardeneria's `participation.proposal`); no library is expected to provide one. Expected schema: `id` (a UUID primary key), `target_node_id` (a foreign key to `core.node`), `author_id`, `patch` (`jsonb`, as submitted), `rationale` (nullable), `base_version` (`bigint`), `state` (`pending | accepted | rejected | withdrawn`), `submitted_at` (`timestamptz NOT NULL DEFAULT now()`), and the nullable `decided_at`, `decided_by`, `decision_note` and `applied_version` (with `(target_node_id, applied_version)` a foreign key to the root version table). Index `author_id`, `target_node_id`, and the pending rows.

Method contract: `insert` inserts the row; `get(id)` is `id = $id LIMIT 1`, joined to `core.node` for `targetType`, with the target's head version as a correlated scalar subquery (`SELECT MAX(version) … WHERE id = target_node_id`: one indexed lookup per row, never a per-render aggregate over every node's versions); `lock(id)` is the row alone, `FOR UPDATE`, so two decisions on one proposal serialise; `close(id, decision)` updates the pending row's status, decider, timestamp, note and applied version; `list` renders `where` over the columns `authorId`, `targetId`, `targetType`, `status` and `targetOwnerId` (the target's owner, `core.node_owner`, `NULL` for none; a `LEFT JOIN`), orders by `submitted_at DESC, id DESC`, applies `LIMIT` / `OFFSET` and returns the unpaged total as a window column, each row with its target's head version as `get` reads it. `E` and `R` are as for the chain store, and the store never opens a transaction itself.

### `BlobStore<E, R>`: the byte store

Filled by the application over its object storage (R2 in gardeneria, S3 or a local directory elsewhere); no library is expected to provide one. Keys are `blobKey(contentHash)` (`sha256/<hash>`), never a node id.

Method contract:

- `put(key, bytes, head)` writes the object, with `head.mediaType` as its content type. It is idempotent: a key always holds the same bytes.
- `get` returns the bytes or none.
- `head` returns `{ byteSize, mediaType }` or none, without reading the body.
- `delete` removes the object; only purge calls it.
- `publicUrl(key)` is the URL a reader fetches, when the store serves one.
- `signedUploadUrl`, when the store offers one, signs a direct client upload of `key`'s bytes. The node stays `bytesPending` until `confirmBytes` sees them.

`E` is the store's own failure, and `R` whatever its client needs.

### `ResourceCacheSeam` and the `serveable` hook: the resource cache

Filled by the application: a KV read-through resource cache it owns (pulpit#5, pulpit#6). No library is expected to provide one; effect-web dropped its Cloudflare package, and with it the planned cache (effect-web#33). The cache's write side is `set(id, resource)` / `delete(id)`, both never failing (the cache swallows a KV fault). Its security policy is `serveablePolicy({ owned, publishGated })` from `./publication`, passed as the cache's `serveable` option; the cache applies it on both its read and write paths and evicts on a non-serveable write.

## License

MIT
