# Content model

The kernel's content model: the Content-axis field spreads (`./content`), the registry's flag vocabulary and checks (`./registry`), the content-addressed document store (`./documents`), and the read predicates as data (`./filter`), including the contract a SQL renderer of `ListFilter` must honour. Each export's own contract is in its TSDoc; this page holds the prose that spans exports.

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
| `RegistryEntry`, `RESOURCE_FLAGS` | The entry shape and its flags: `pageable`, `agent`, `owned`, `referenceData`, `searchable`, `routable`, `localised` (a locale level in its chain; see [Localisation](read-model.md#subtype)). `owned` and `referenceData` are mutually exclusive. A marker level omits `resource` and `id`; a flag is literal `true` or omitted (never `undefined`). |
| `resourceOf(entry)` | The entry's resource as an `Option`: `Option.none()` for a marker level, which omits `resource`. |
| `parent(key)`, `root` | Declare an entry's parent with its key literal preserved (`Option.some` widens it to `string`, which empties every typed derivation). |
| `validateRegistry(entries, checks?)` | Unique keys, parents resolve, a flag implies a resource, the trust axis, id / wire-type lockstep; then the application's own `RegistryCheck`s. |
| `branchOf(entry, byKey, roots)` | The branch root an entry sits under, walking marker levels. |
| `flaggedMembers(entries, flag)`, `branchMembers(entries, root, roots, parents?)` | The resources themselves, typed as the precise member tuple, ready for `Schema.Union`. |
| `identifiersOf(members)` | The members' `identifier` schemas, for a linkage-ref union. |
| `registryWireTypes(entries, roots)` | The wire types of every flag family and branch — what a wire-identity test pins and a subtype factory checks its `access` against. |

## `./documents`

The content-addressed document store. A version row carries a document's hash rather than another copy of the document, so a long document edited many times is stored once per distinct content, and history (which is never pruned) stays small. A stored document is never rewritten and a changed document is a new hash (`DOC-001`), so `restoreVersion` restores the reference, and the old hash still reads back the old document.

```ts
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { documentRef, type DocumentStore } from "@thomasfosterau/pulpit/documents";
import { defineVersionChain, type VersionChain } from "@thomasfosterau/pulpit/version-chain";

export const NoteResource = Resource.make("notes", {
  attributes: { ...documentRef("title"), ...documentRef("body") }, // each a DocumentHash
});

const program = <Document, E, R>(
  documents: DocumentStore<Document, E, R>,
  port: VersionChain<E, R>,
  title: Document,
  body: Document,
) =>
  Effect.gen(function* () {
    const chain = defineVersionChain("notes", port);
    const state = {
      title: (yield* documents.put(title)).hash,
      body: (yield* documents.put(body)).hash,
    };
    const { id } = yield* chain.create({ id: Option.none(), state, actorId: Option.none() });
    return { id, body: yield* documents.get(state.body) }; // put is idempotent: the same document, the same hash
  });
```

The document type is a parameter: its schema and validation are the application's, and pulpit never imports them. The hash is the store's to derive; the algorithm and the bytes it is taken over are in [Seams](seams.md#seams), and `canonicalText` produces those bytes for a store that doesn't run on Postgres.

| Export | What it is |
| --- | --- |
| `DocumentStore<Document, E, R>`, `DocumentPut` | The store seam: `put` (idempotent, returns `{ hash, inserted }`, `inserted` only when it wrote the row), `get`, `getMany` (see [Seams](seams.md#seams)). |
| `onDocumentInsert(store, hook)`, `DocumentInserted` | The store with a first-insert hook (both apps enqueue an embedding job): it runs after a `put` that inserted, never after one that found the document stored, inside the `put`'s transaction, and its failure fails the `put`. |
| `DocumentHash` | A SHA-256 document hash as 64 lowercase hex characters. |
| `documentRef(key)` | The attribute spread for a version row's document reference: the hash, required on the resource and at create, carried forward at update, never cleared. |
| `canonicalText(json)` | The canonical text the hash contract takes SHA-256 over (Postgres's `jsonb` text output), for a store that doesn't run on Postgres. |
| `DocumentCheck<Document, R>`, `DocumentViolation` | The grammar seam (pulpit#264): `(field, document)` succeeds for a document the field's grammar allows and fails `DocumentViolation { field, message }` otherwise (see [Seams](seams.md#seams)). |
| `checkedDocumentStore(store, field, check)` | The store with the field's grammar check before `put`: an off-grammar document fails `DocumentViolation` and is never stored (`DOC-001`). One per document field. |
| `documentCheckHook({ type, fields, documents, check })`, `DocumentCheckDeclaration`, `DOCUMENT_VIOLATION` | The grammar check as a before-write hook: a `create`, `update` or `restore` whose patch (or any locale's) sets a declared document field is refused with `WriteRejected` (reason `DOCUMENT_VIOLATION <field>: <message>`) when the referenced document fails its check or isn't stored; one `getMany` per write. `restoreVersion` is exempt (it re-applies a checked version). |

## `./filter`

The kernel's read predicates as data: a store renders a `ListFilter` to SQL, and `evaluate` runs it against an in-memory row, so a list filter and its row predicate can be proven to agree.

| Export | What it is |
| --- | --- |
| `ListFilter<Following>` | The predicate tree. `Following` is whatever the follower seam hands the `in` node: a subquery for SQL, a set in memory. |
| `always`, `never` | No predicate; a predicate no row satisfies (fail closed). |
| `eq`, `ne`, `isIn` | `col = v`, `col <> v`, `col IN (<seam subquery>)`: the follower seam's followed accounts, or an edge family's members (`EdgeOps.memberFilter`). |
| `isNotIn` | `(col IS NULL OR col NOT IN (<seam subquery>))`: the exact complement of `isIn` over the same seam set, a `NULL` column included; an edge family's non-members (`EdgeOps.nonMemberFilter`, [#191](https://github.com/thomasfosterau/pulpit/issues/191)). |
| `gt`, `gte`, `lt`, `lte`, `Comparable` | `col > v`, `col >= v`, `col < v`, `col <= v`, over a `Comparable` (`string`, `number` or `Date`). |
| `anyOf`, `noneOf`, `MAX_SET_VALUES` | `col = ANY(values)`, `col <> ALL(values)` over a literal set of `Scalar`s; an empty `anyOf` is `never`, an empty `noneOf` is `always`, and a set of more than `MAX_SET_VALUES` (1000) values, duplicates counted, is `never` (`SEC-INPUT-003`). |
| `isNull` | `col IS NULL`: the one node a `NULL` column satisfies on its own, so `or(isNull(col), noneOf(col, values))` is an exclusion that keeps an unset column. |
| `published`, `notPublished` | Stamped and arrived; its exact complement (unstamped, or stamped in the future). |
| `locale(locales)`, `LOCALE_COLUMN` | The locale arm (pulpit#56): a localised view's rows in one of `locales`. Empty, or more than `MAX_SET_VALUES`, is `never`. |
| `and`, `or` | Combinators that drop identity parts, short-circuit on the absorbing part, and return a single part bare. |
| `evaluate(filter, row, context)` | The in-memory reading, against `context.now` and `context.contains`. |

A SQL renderer must honour this contract:

| Node | SQL |
| --- | --- |
| `always` | no predicate (`undefined` to Drizzle's `.where`) |
| `never` | a predicate no row satisfies |
| `eq` / `ne` | `col = $v` / `col <> $v`: a `NULL` column satisfies neither, so `evaluate` drops a row whose column is `null` or absent from both |
| `in` | `col IN (<seam subquery>)`: the subquery a seam hands over (the follower seam's `following`, or `EdgeStore.members`), never a materialised array. A `NULL` column satisfies none, so `evaluate` drops a row whose column is `null` or absent without asking `context.contains` |
| `notIn` | `(col IS NULL OR col NOT IN (<seam subquery>))`, over the same subquery `in` takes, so `in` and `notIn` partition every row. A `NULL` column satisfies it, and `evaluate` keeps a row whose column is `null` or absent without asking `context.contains`. The subquery must never yield a `NULL`: `NOT IN` over a set holding one is `NULL` for every row |
| `gt` / `gte` / `lt` / `lte` | `col > $v` / `col >= $v` / `col < $v` / `col <= $v`. A string compares with `COLLATE "C"` (code-point order; `evaluate` does not use JavaScript's UTF-16 `<`), a `Date` as a timestamp, a number numerically, `Infinity` and `-Infinity` each equal to itself. A `NULL` column satisfies none |
| `anyOf` | `col = ANY($values)`: a bound array, each value tested as `eq` tests it. A `NULL` column satisfies none. The array never holds a `NULL` element |
| `noneOf` | `col <> ALL($values)`, each value tested as `ne` tests it. A `NULL` column satisfies none (`NULL <> ALL(…)` is `NULL`), so `noneOf` is not the complement of `anyOf` over a nullable column. Over no values it is true for every row, `NULL` included, which the constructor folds to `always`. The array never holds a `NULL` element: `2 <> ALL('{1,NULL}')` is `NULL`, so one would drop every row |
| `isNull` | `col IS NULL`; `evaluate` reads a column that is `null` or absent as satisfying it |
| `published` | `(col IS NOT NULL AND col <= now())`: the database's clock, one per query |
| `notPublished` | `(col IS NULL OR col > now())`, parenthesised so it cannot bind to a surrounding `AND` |
| `locale` | `col = ANY($locales)` over the view's `locale` column, as `anyOf`; a row with a `NULL` locale satisfies none, and on a view with no locale level it renders as `never` |
| `and` / `or` | `AND` / `OR` over the parts |

An `anyOf` / `noneOf` node with more than `MAX_SET_VALUES` values (duplicates counted) renders as `never`, and `evaluate` reads it so. The constructors already return `never` for one, so only a hand-built node reaches a renderer that way. A cap that dropped some of a `noneOf`'s values would widen the result, so the arm fails closed instead.

Some inputs are outside the contract: SQL and `evaluate` can't be made to agree on them, so `evaluate` fails closed.

- **A column of another type than the comparand**, or than any of a literal set's values, is a caller or schema error. PostgreSQL may coerce the parameter (an `integer` column against `'1'`) or raise (against `'abc'`). `evaluate` reads such a row as satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`.
- **`NaN`, and an invalid `Date`.** PostgreSQL's `float8` and `numeric` hold `NaN` equal to itself and greater than every number; JavaScript's `NaN` has no such order. Every constructor returns `never` for a `NaN` or invalid-`Date` comparand, and `anyOf` / `noneOf` return `never` for a set holding a `NaN`. `evaluate` reads a `NaN` comparand, set element or column as satisfying no `eq`, `ne`, comparison, `anyOf` or `noneOf`. A renderer must never bind `NaN`: it renders a hand-built node carrying one as `never`.
- **Sub-millisecond instants.** A PostgreSQL timestamp keeps microseconds and a JavaScript `Date` milliseconds, so two instants within one millisecond of each other can compare unequal in SQL and equal in `evaluate`.
