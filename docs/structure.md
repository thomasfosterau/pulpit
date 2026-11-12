# Structure and routing

Relations between nodes (`./edges`, taxonomies included), routable paths and aliases (`./paths`), the page recipe (`./pages`), ordered collections (`./collections`), link lists (`./links`) and the UGC relation patterns over them (`./relations`).

## `./edges`

`defineEdgeOps` binds the operations of an edge family: a relation between nodes, stored as a row of its own (an id, a `createdAt`, one column per end holding that end's node id, and the family's own qualifier columns) outside both nodes' tables. It is ported from gardeneria's `defineEdgeOpsE`:

- `list`: one page under the family's own `where`, at most `MAX_PAGE_LIMIT` (1000) rows, ordered by `createdAt` then `id`, with the unpaged total.
- `get`: one edge by id.
- `create`: asserts the edge. On a collision with a stored edge on the family's unique key, `onConflict: "ignore"` returns the stored edge's id with `created: false` when the caller can read that edge and its every end is live (a re-assertion is idempotent, and never rewrites the stored qualifiers); `"fail"`, the default, fails `EdgeConflict`, and so does `"ignore"` when the stored edge is hidden from the caller or has a tombstoned end (the view-deleted rung reads such an edge but can't link to a tombstone, so it can't resolve to one either).
- `delete`: a hard `DELETE`. There is no general update: correcting an edge is deleting it and asserting the right one.
- `closeValidity(id, at)`: the one update an edge takes, on a family that declares `validity` ([#210](https://github.com/thomasfosterau/pulpit/issues/210), `EDGE-002`). It sets the interval's `to` column to `at` and nothing else, so an office holding or a membership ends without losing its row. It only narrows: `at` may not fall after a closed end nor before the start (`InvalidValidity`), and a family without `validity` is `InvalidValidity` too. A missing or hidden edge is `EdgeNotFound` (checked before the write gate), then the gate's failures.
- `memberFilter(end, otherIds)`: edge membership as a list filter for the leaf at `end` ([#113](https://github.com/thomasfosterau/pulpit/issues/113)). It is `id IN (<the end's node ids of the edges whose other end is one of otherIds>)`, so `memberFilter("post", termIds)` passed to the posts' `list` as `where` answers `?categories=1,2`. It counts only edges the viewer can read (`EDGE-001`, the same `endpointFilter` as `list`), so a hidden term, a hidden post or a tombstoned end below the view-deleted rung never makes a row a member. No ids, more than `MAX_SET_VALUES` (`SEC-INPUT-003`), an `end` the family doesn't declare, or a family without exactly two ends all give `never` without reading the store.
- `nonMemberFilter(end, otherIds)`: the complement of `memberFilter` ([#191](https://github.com/thomasfosterau/pulpit/issues/191)), `(id IS NULL OR id NOT IN (…))` over the same `members` subquery under the `notIn` node, so it answers `?categories_exclude=1,2`; `memberFilter` and `nonMemberFilter` partition the rows a leaf's `list` reads. Only edges the viewer can read count as a membership (`EDGE-001`): a row whose only edge to `otherIds` is hidden from the viewer is not excluded, so the hidden edge is never confirmed. An exclusion fails closed by excluding nothing: no ids, more than `MAX_SET_VALUES` (an adapter caps its list first), an `end` the family doesn't declare, or a family without exactly two ends all give `always` without reading the store.
- `countBy(end, ids, where?)`: the number of edges the viewer can read at each node of `ids` at end `end` ([#185](https://github.com/thomasfosterau/pulpit/issues/185)), in one grouped store read: a taxonomy term's post count for every term on a page. It counts exactly the edges `list` would show (`EDGE-001`, the same `endpointFilter`, narrowed by the family's optional `where`), so a hidden or tombstoned node at `end` counts `0` and its edges are never confirmed. Every requested id (deduplicated) has a key, `0` when it has no readable edge. More than `MAX_SET_VALUES` ids, or an `end` the family doesn't declare, answers `0` for every id without reading the store.

Writes gate on the declaration's `writeGate`. The default, `corpusWriteGate`, is the corpus-write rung, right for an edge between two reference leaves. `rungGate((policy) => policy.canModerate)` puts a family on another rung. An owned-child edge (gardeneria's observation → disorder) passes a gate that reads its owned end's owner, typically `requireWriter` from `./subtype`.

The optional members here (an end's `maxEdges`, the declaration's `onConflict`, `writeGate` and `validity`, and the store's `closeValidity`) are bare `?: T` (pulpit#238): a caller that has no value omits the key rather than passing `undefined`.

On top of the port, pulpit enforces three rules:

- **Endpoint visibility** (`EDGE-001`). Each end declares its endpoint leaf's `access` and its current-version view (`nodes`; the leaf's own `LeafStore` fits). An edge is readable only if the viewer can read the node at every end, by the rule that leaf's own `get` and `list` apply, a reference leaf's followers arm included. `get` fails `EdgeNotFound` for a hidden edge, and `list` omits it, never `Forbidden` (`SEC-AUTH-ENUM-001`). A related list (the edges at one node) is `list` filtered on that end's column, so it omits every edge whose other end is hidden, and the related list of a hidden node is empty. The list filter (`endpointFilter`) and the per-endpoint predicate (`canViewEndpoint`) read the same facts, so they never disagree. A create naming a node the viewer can't read fails `NodeNotFound`, before the write gate runs, so a 403 never confirms that the node exists.
- **Endpoint lifecycle.** A tombstoned end hides its edges from every viewer below the view-deleted rung, and a create can't name it, whoever asks. The view-deleted rung reads a tombstoned end as the leaf's own `get` reads the tombstone, by its access rule ([#93](https://github.com/thomasfosterau/pulpit/issues/93)), so it can `list`, `get` and `delete` an edge whose only hidden end is tombstoned: a moderator can find and remove a retired node's stale edges. An end hidden for any other reason (a `private` node below the view-private rung, say) still hides the edge from that rung. Nothing is deleted, so restoring the node (`restore`) brings its edges back as they were.
- **Cardinality.** An end's `maxEdges` bounds how many edges one node at that end may hold; a create past it fails `EdgeCardinalityExceeded` (with the end, the node and the limit). It must be a positive safe integer: `defineEdgeOps` throws `EdgeDeclarationError` when the family is declared otherwise, and likewise for an end alias containing a `.`. A create counts only the edges at the node that the caller can read and whose every end is live ([#77](https://github.com/thomasfosterau/pulpit/issues/77), [#93](https://github.com/thomasfosterau/pulpit/issues/93)). A re-assertion of a stored edge resolves before the count, so it stays idempotent at a full node. Counting that way has three consequences:
  - **A refusal discloses nothing hidden**; see [What a write discloses](#what-a-write-discloses).
  - **A tombstoned partner frees its slot at once.** Its edge stays stored and stops counting, so tombstoning a partner never freezes a node.
  - **The limit holds per caller, and can be overshot.** Edges a writer can't read don't count against that writer, so a node can end up holding more than `maxEdges` edges in all. Restoring a tombstoned partner brings its edge back without a check (a restore is a chain write and reads no edge), which can put a node past its limit. An over-limit node keeps its edges, and every create at it fails `EdgeCardinalityExceeded` until enough are deleted. Only a caller who can read every edge at the node (the view-private rung, typically) is held to the limit over all of them; an edge to a tombstoned end never counts, for anyone.

- **Validity intervals** ([#210](https://github.com/thomasfosterau/pulpit/issues/210)). A family may declare `validity: { from, to }`, two edge columns holding when the edge starts and stops holding: a `Date`, or `NULL` for open, over `[from, to)`. A create checks both bounds are dates or `NULL` and that `from` is not after `to` (`InvalidValidity`, before the store is read). `maxEdges` then counts only the edges at the node whose interval overlaps the new one, so an office held by one person at a time takes a successor once the last holding ends, and refuses one that overlaps it. `validAt(validity, at)` is the list filter for the edges valid at an instant (`from IS NULL OR from <= at`, and `to IS NULL OR to > at`), passed to `list` as `where`. The two columns must differ, and the store must offer `closeValidity`; `defineEdgeOps` throws `EdgeDeclarationError` otherwise.

### What a write discloses

The read operations never reveal a hidden edge (`SEC-AUTH-ENUM-001`), and nor does a write's answer ([#93](https://github.com/thomasfosterau/pulpit/issues/93)). `create` runs in this order: ends, then the write gate, then the unique-key collision, then the cardinality count. A node the caller can't read is `NodeNotFound` whoever asks, and only a caller the gate admits reaches the collision and the count. There:

- **The count reads no hidden edge.** `EdgeCardinalityExceeded` depends only on the edges the caller can read at the node, so a node holding hidden edges answers exactly as one holding none. The cost is the weaker limit under Cardinality: a writer who can't read every edge at a node can take it past `maxEdges` in all.
- **A collision says only that the key is taken.** `EdgeConflict` carries only the family's type. Under `"fail"` a collision with a hidden edge answers exactly as one with a readable edge; under `"ignore"` only a readable, live edge resolves to `{ created: false, id }`, and otherwise (a hidden edge, or one with a tombstoned end, whoever asks) it is `EdgeConflict`. That the key is taken is the unique index's own answer, so it can't be hidden. That says something about a hidden edge only in a family whose unique key leaves an end out (gardeneria's page slugs key on the path, not the page): there, a writer who gets `EdgeConflict` with no readable edge holding the key learns that some edge it can't read does, though not which, nor at which node. Where the key covers every end, a colliding edge joins the same nodes the create just showed to be live and readable, so it is readable itself. A family that must not reveal even that should key on every end.

An owned leaf's `./subtype` writes answer differently, by decision (pulpit#24): its write and history gates deliberately confirm to a signed-in caller that an owned row exists (`Forbidden` for one they don't own, `NodeNotFound` for none). A reference leaf's hide a row as `get` does (pulpit#101). See [SECURITY.md → Existence disclosure by the write gates](../SECURITY.md#existence-disclosure-by-the-write-gates).

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
| `EdgeValidity`, `validAt(validity, at)`, `CloseValidity`, `InvalidValidity` | A family's validity interval columns, the list filter for the edges valid at an instant, the store's interval-closing method, and a malformed or widening interval (422). |
| `EdgeDeclarationError` | A malformed family (an end alias with a `.`, a `maxEdges` that isn't a positive safe integer, a `validity` naming one column twice, or a `validity` over a store without `closeValidity`), thrown by `defineEdgeOps` when the family is declared, never as an Effect failure. |

## `./paths`

Routable content (pulpit#57). A path claim lives on the root node: one path per content item. The locale is chosen when the resolved node is read, never by the path, so a slug translation is not a claim of its own (pulpit#56's model (b)). `routable(ops, { column, paths, chain })` wraps a leaf's `defineSubtype` operations, so that each write keeps the node's claim in step with the state it landed at:

```ts
import { routable } from "@thomasfosterau/pulpit/paths";

const pages = routable(pageOps, { column: "slug", paths: pagePaths, chain });
const handlers = subtypeHandlers(pages, { transact, inTransaction, cache }); // the claims run inside `transact`

pages.resolve("about"); // { kind: "node", id, resource } | { kind: "redirect", id, path } | PathNotFound
```

- **Claims follow the node's lifecycle.** A write that leaves the node live claims the path its state holds in `column` (a string; anything else claims nothing). A tombstone, or a state without a path, frees the claim. A restore (`restore` or `restoreVersion`) re-claims its path, or fails `PathTaken` (409) when another node holds it now. The claim runs after the append, in the same transaction, so a refused claim rolls the append back with it. The state is read from `chain` ungated, so a write that hides the row from its own writer still keeps its claim right.
- **A path change records an alias.** The old path resolves as a redirect to the canonical one, until another node claims it (a canonical claim takes over an alias). A revert promotes the node's own alias back.
- **Resolution is gated** (`SEC-AUTH-ENUM-001`). `resolve(path)` reads the node through the leaf's own `get`, so the path of a hidden node (private, a draft, a tombstone), and an alias to one, is `PathNotFound`, never a redirect. So is an alias whose node has no canonical path now.
- **What `PathTaken` discloses.** It names the path, never the holder, but it says that some node holds the path, whether or not the writer can read it, as a unique-key conflict does.

Free-form redirects (patterns, a 404 log) are the site's. The path's syntax is the attribute's schema (effect-schema-ext's `Ids.slug`, once it publishes).

| Export | What it is |
| --- | --- |
| `routable(ops, config)`, `RoutableOps`, `RoutableConfig` | A leaf's operations with path claims and `resolve`, and what it takes: the path column, the `PathStore` and the chain store. |
| `Resolution` | What a path resolves to: `{ kind: "node", id, resource }` or `{ kind: "redirect", id, path }`. |
| `PathStore`, `PathEntry` | The path-table seam and one stored path (its node, canonical or alias). |
| `PathTaken`, `PathNotFound` | Another node holds the path canonically (409); no node the viewer can read answers to it (404). |

## `./pages`

The page recipe (pulpit#201): standalone, routable, localised documents (an About page, help, terms, a landing page) assembled from the existing modules, plus the one read that joins them. Nothing here is a new store or a new read rule.

- **The leaf.** A `defineSubtype` leaf, usually a reference leaf (corpus material written at the corpus-write rung; gardeneria's pages are moderator+), with a locale level (`defineLocaleLevel`) for the translated columns and, for drafts and scheduled pages, the publication pointer (`publication`, pulpit#46). The path column is shared, never translated: a claim lives on the root node, so one page is one path in every locale.
- **The collection.** A page collection (a path namespace) is a root claim in `./paths`: one `PathStore` per collection, each wrapped with `routable`. There is no namespace concept beyond that (owner decision on pulpit#201).
- **The read.** `resolveLocalised(pages, { defaultLocale })` returns `(path, locale) => …`. It resolves the path through the leaf's gated `resolve` and reads the node through `getLocalised` in the order `localeFallbacks(locale, defaultLocale)` gives: the requested tag, each shorter prefix of it (`pt-BR` → `pt`), then the default.

```ts
import { resolveLocalised } from "@thomasfosterau/pulpit/pages";
import { routable } from "@thomasfosterau/pulpit/paths";
import { defineLocaleLevel, defineSubtype } from "@thomasfosterau/pulpit/subtype";

const pageOps = defineSubtype({
  type: "pages",
  access: { kind: "reference" },
  chain,
  leaves: publication.leaves, // the live view: readers see the published version
  publication: { live: publication.live, facts: publication.facts },
  locales: defineLocaleLevel({ columns: ["title", "body"] }),
  viewer,
  policy,
  followers,
  toResource,
});
const pages = routable(pageOps, { column: "slug", paths: helpPaths, chain }); // one PathStore per collection
const resolve = resolveLocalised(pages, { defaultLocale: "en" });

resolve("about", "pt-BR");
// { kind: "node", id, locale: "pt", resource } — render it
// { kind: "redirect", id, path }               — 301 to `path`
// PathNotFound                                 — 404
```

- **Not-found, never forbidden** (`SEC-AUTH-ENUM-001`). Every rule is the leaf's own. A private page, a draft or one never published, a scheduled page whose stamp hasn't arrived, a tombstoned page, an alias to any of these, and a page that carries none of the fallback locales all resolve as `PathNotFound`, exactly as a path nobody claims. The owner and the view-private rung read the head, as `get` does.
- **An alias redirects without reading a locale.** The canonical path is the node's and is shared by every locale.
- **Tags are compared exactly.** BCP 47 is case-insensitive, but the locale rows are not, so normalise a tag's case before it reaches the read.

Navigation menus are an [ordered link list](#links) over `./collections` (pulpit#266), and there is no page builder.

| Export | What it is |
| --- | --- |
| `resolveLocalised(ops, config)`, `LocalisedRoutes`, `LocalisedRoutesConfig` | The page resolution read over a routable, localised leaf, the two reads it joins, and its default locale. |
| `LocalisedResolution` | What it answers: `{ kind: "node", id, locale, resource }` or `{ kind: "redirect", id, path }`. |
| `localeFallbacks(requested, defaultLocale)` | The locale order a read tries. |

## `./collections`

Ordered collections (pulpit#193): positioned members of a parent node, such as a list's items, an album's media, a byline's authors or a menu's entries.

```ts
import { defineCollection } from "@thomasfosterau/pulpit/collections";

const items = defineCollection({
  type: "list-items",
  parent: listOps, // the parent leaf's `defineSubtype` operations
  members: itemOps, // the member leaf's
  store: collectionStore,
  mode: { kind: "mutable" }, // the default; or { kind: "versioned", column: "memberOrder", chain: listChain }
});

items.append(listId, itemId);
items.move(listId, itemId, 0);
items.list(listId, { limit: 50, offset: 0 }); // { rows: [{ memberId, index, resource }], total }
```

- **Both models, one store** (owner decision on pulpit#193). A family picks its model:
  - **`mutable`** (the default) keeps the order beside the chain, like an edge: a write changes the store and nothing else.
  - **`versioned`** also appends a parent version through the parent leaf's own `update` on every write. The version records the whole order (the member ids, in order) in a declared parent column, so `VERSION-CHAIN-001` covers it and history shows each reorder. After the parent's `restoreVersion`, `resync(parentId)` replaces the store's order with the one the restored version records, keeping only the members the writer can read, as `append` does (the column is writable through the parent's own `update`). The column names every member, the ones a reader of the parent can't read included, so wrap the parent leaf's `toResource` with `hideRecordedOrder(column, toResource)` to keep it out of the parent's resource (`EDGE-001`). The parent's history still shows it, behind the write gate.
- **The gates.**
  - A read passes the parent's read gate: a hidden parent is `NodeNotFound`, never `Forbidden` (`SEC-AUTH-ENUM-001`).
  - Each member is read through the member leaf's own `getMany`. A member the viewer can't read is omitted from the page and from its total, as `EDGE-001` omits an edge with a hidden end, and `index` counts only the members shown.
  - A write passes the parent's write gate (`authorize`), and the member it adds must be one the writer can read (`NodeNotFound` otherwise).
- **Bounded** (`SEC-INPUT-003`). A collection holds at most `MAX_COLLECTION_SIZE` (1000) members (`CollectionFull` past it), so every read and reorder reads the whole order once. Pages are clamped to `MAX_PAGE_LIMIT`.
- **Failures.** Adding a member twice is `AlreadyMember` (409); moving or removing one that isn't there is `NotMember` (404). `move` clamps the index to the order's bounds.

| Export | What it is |
| --- | --- |
| `defineCollection(definition)`, `CollectionDefinition`, `CollectionOps`, `CollectionMode`, `CollectionMember` | The factory, its declaration, the operations (`list`, `append`, `move`, `remove`, `resync`), the two models and a listed member. |
| `hideRecordedOrder(column, toResource)` | A parent leaf's `toResource` without a versioned family's order column (`EDGE-001`). |
| `CollectionStore`, `CollectionEntry`, `MAX_COLLECTION_SIZE` | The membership table seam (see [Seams](seams.md#seams)), one member's place and the size bound. |
| `AlreadyMember`, `NotMember`, `CollectionFull` | The failures: 409, 404, 409. |

## `./links`

Ordered link lists (pulpit#266): an ordered, localised list of links under a parent node, read for one viewer, with nested lists (pulpit#313). A navigation menu is the usual example; the kernel names no menu type (a `menu` is a leaf the application binds, like a `page`), so the module is the generic shape and this section shows a menu and its sub-menus.

- **The list** is a `./collections` collection of entry nodes under the parent (the menu), in either order model.
- **The entry leaf** is a `defineSubtype` leaf with a locale level. Its columns hold the target (a path, or a node id) and, translated, the label.
- **The target** is a path, resolved through `./pages`' `resolveLocalised`, a node, read through its leaf's gated `getMany`, or another list: a nested list (a sub-menu) is an entry whose target is another parent of the same collection, so it needs no storage of its own.

```ts
import { defineLinkList } from "@thomasfosterau/pulpit/links";
import { resolveLocalised } from "@thomasfosterau/pulpit/pages";

const nav = defineLinkList({
  type: "menu-links",
  defaultLocale: "en",
  entries: menuItems, // defineCollection({ parent: menuOps, members: itemOps, store })
  entryLeaf: itemOps, // a localised leaf: `label` is translated
  target: (item) =>
    typeof item.path === "string"
      ? Option.some({ kind: "path", path: item.path })
      : typeof item.submenu === "string"
        ? Option.some({ kind: "list", id: item.submenu }) // another menu: a sub-menu
        : Option.none(),
  resolve: resolveLocalised(pages, { defaultLocale: "en" }),
  nodes: pages, // for entries that name a node: `{ kind: "node", id }`
  maxDepth: 3, // the default, DEFAULT_LINK_DEPTH: the menu and two levels of sub-menus
});

nav.list(menuId, "pt-BR");
// [{ entryId, index, locale: "pt", entry, target: { kind: "path", id, path } },
//  { entryId, index, locale, entry, target: { kind: "list", id, links: [/* the sub-menu's links */] } }, …]
```

- **One gated read**, `list(parentId, locale)`: the links the viewer may follow, in the collection's order, with each entry read in the first of `localeFallbacks(locale, defaultLocale)` it carries. A path target that goes through an alias is returned as the node's canonical path.
- **Omitted, never forbidden** (`SEC-AUTH-ENUM-001`). An entry is dropped when the viewer can't read the entry, when it carries none of the fallback locales, when `target` returns none, and when its target isn't followable: a hidden, unpublished, scheduled or tombstoned page, an unclaimed path, an alias to a hidden node, or a node `getMany` omits. The rest are renumbered from 0, so the result leaves no gap and carries neither an omitted entry's id nor its target. A parent the viewer can't read is `NodeNotFound`.
- **Every rule is the leaves'.** The owner and the view-private rung read the head, so they see the entries others can't.
- **Nested lists, read in place.** A `{ kind: "list", id }` target is read by the same gated read, recursively, and returned as `{ kind: "list", id, links }` with its links renumbered from 0. It is omitted like any hidden entry (`SEC-AUTH-ENUM-001`) when the viewer can't read its parent, when none of its links is one they may follow (it is never returned empty), when it is the list it sits in or one above it (a cycle), and when it would sit deeper than `maxDepth` levels (the top list is level 1; `1` reads a flat list; `DEFAULT_LINK_DEPTH`, 3, when absent). A list reached by two entries, not above either, is read under each. Cycles are cut at read time, not refused at write time: the collection's writes know nothing of what an entry targets.
- **Bounded** (`SEC-INPUT-003`): at most `MAX_COLLECTION_SIZE` entries over every level together, each read through its own gate, taken in reading order (the top list's entries, then each nested list where its entry sits); a nested list the budget leaves empty is omitted.

| Export | What it is |
| --- | --- |
| `defineLinkList(definition)`, `LinkListDefinition`, `LinkListOps` | The factory, its declaration and its one read, `list`. |
| `Link`, `LinkTarget`, `FollowedTarget` | A returned link, what an entry points at (a path, a node or a nested list), and what that resolved to. |
| `DEFAULT_LINK_DEPTH` | The nesting cap a definition without `maxDepth` reads under: 3. |

## `./relations`

Three UGC relation patterns (pulpit#200), after gardeneria's posts (`sharedId`), questions and answers, and `blog_post_authors`. Each is a recipe over `./edges` or `./collections` plus a small helper; none adds a read rule, so every node is read through its own leaf's gate.

```ts
import { defineEdgeOps } from "@thomasfosterau/pulpit/edges";
import { defineCollection } from "@thomasfosterau/pulpit/collections";
import {
  acceptedAnswerGate,
  defineReshares,
  nodeWriteGate,
} from "@thomasfosterau/pulpit/relations";

// A reshare: an edge family with one target per sharing post, written by whoever may write the post.
const reshareEdges = defineEdgeOps({
  type: "reshares",
  ends: {
    sharer: { column: "sharerId", type: "posts", access, nodes: postLeaves, maxEdges: 1 },
    target: { column: "targetId", type: "posts", access, nodes: postLeaves },
  },
  writeGate: nodeWriteGate("sharerId", "posts", posts),
  …
});
const reshares = defineReshares({
  type: "reshares",
  sharer: posts,
  target: posts,
  edges: reshareStore,
  sharerColumn: "sharerId",
  targetColumn: "targetId",
});
reshares.targetOf(postId); // Option<{ _tag: "Visible", target } | { _tag: "Unavailable" }>
reshares.targetsOf(pageOfPostIds); // the same, for a feed page, in three bounded reads

// An accepted answer: one per question, written by the question's writer, for one of its own answers.
const accepted = defineEdgeOps({
  type: "accepted-answers",
  ends: {
    question: { column: "questionId", type: "questions", access, nodes: questionLeaves, maxEdges: 1 },
    answer: { column: "answerId", type: "answers", access, nodes: answerLeaves },
  },
  writeGate: acceptedAnswerGate({
    questionType: "questions",
    questions,
    questionColumn: "questionId",
    answerColumn: "answerId",
    answers: answerLeaves,
    parentColumn: "questionId", // the answer view's column naming its question
  }),
  …
});

// A byline: the post's credited authors, in order, over the app's profile leaf.
const byline = defineCollection({ type: "post-authors", parent: posts, members: profiles, store });
```

- **Reshares** (owner decision on pulpit#200). The reshare edge family keeps `EDGE-001`: its `list` and `get` hide an edge whose target the viewer can't read, and its `create` refuses a target the writer can't read. A reshare of a node that has _since_ become unreadable is still shown, as a placeholder: `defineReshares` reads the stored edge itself, outside `EDGE-001`, for a sharing node the viewer can read (`NodeNotFound` otherwise, as its `get`), and answers the target through the target leaf's own `getMany`, so a private, draft, unpublished or tombstoned target is `{ _tag: "Unavailable" }`, carrying neither its id nor its content. What a reader of the sharing node learns is only that it reshared _something_. A target that has been purged leaves no edge (its row is gone), so the post reads as resharing nothing. A quote is the same family with a body on the sharing node.
- **Accepted answers.** `acceptedAnswerGate` runs after `./edges` has checked that the viewer can read both ends. It is the question's own write gate (`authorize`: its owner or the moderate rung on an owned question, the corpus-write rung on a reference one), then the constraint that the answer's `parentColumn` names the question (`AnswerNotOfQuestion`, 422, otherwise; only a writer of the question learns it). `maxEdges: 1` at the question holds one accepted answer; changing it is a delete (gated the same way) and a create.
- **Bylines are credit only** (owner decision on pulpit#200). They are an ordered collection (`./collections`) of the accounts' profile nodes, read through the profile leaf's own gate and written through the post's write gate. A credited co-author gets no write right: the post's `requireWriter` reads the owner record, never the byline, so a co-author's `update` is `Forbidden`, and so is their edit of the byline.

| Export | What it is |
| --- | --- |
| `defineReshares(definition)`, `ReshareDefinition`, `ReshareOps`, `ReshareTarget` | The reshare reads: the target through its own gate, or the placeholder. |
| `nodeWriteGate(column, type, leaf)` | An edge write gate admitting whoever may write the node at one end. |
| `acceptedAnswerGate(declaration)`, `AcceptedAnswerDeclaration`, `AnswerNotOfQuestion` | The accepted-answer write gate and its 422. |
