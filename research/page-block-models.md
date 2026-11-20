# How do headless CMSs model rendering-agnostic pages and blocks?

Research for thomasfosterau/pulpit#417. Feeds the page-model ticket. Compares Portable Text (Sanity), the WordPress block grammar (Gutenberg), Contentful rich text and references, Payload blocks, Strapi components and dynamic zones, Editor.js, and ProseMirror (which Pulpit's applications already use through ProseKit). For each it covers nesting, references, reusable sections, per-block localisation, validation, and diffing and versioning. It then sets out which ideas fit Pulpit's content-addressed documents (`docs/content-model.md` → `./Documents`).

Citations are in brackets and resolve to the [Sources](#sources) list. Where a primary page did not say something, the text says so instead of filling the gap from memory.

## What Pulpit has today (the baseline)

- **Documents are opaque, content-addressed values.** A version row holds a `DocumentHash` (SHA-256 over Postgres `jsonb` canonical text), never the document itself. A stored document is never rewritten (`DOC-001`). `restoreVersion` restores the reference. The document type is a type parameter, and the kernel imports no grammar. (docs/content-model.md, docs/seams.md "The hash contract")
- **The grammar is a seam.** `DocumentCheck` runs at `put` (`checkedDocumentStore`) and in a before-write hook (`documentCheckHook`). The application fills it with prosekit-utilities allow-lists (`PostBody`, `InlineTitle`, …). (docs/seams.md)
- **Other readers are seams too.** Mentions (`MentionExtractor`) and translation segments (`./Translation`, "prosekit-utilities fills it for documents") are both filled by the application. Media uses are an edge family plus a `MediaReferences` index that the rendition gate reads. (docs/participation.md, docs/media.md)
- **Diffs work at field level.** `diffStates` compares a document column by its hash, and "a textual diff of the document is the UI's job". (docs/history-and-review.md)
- **Localisation is a locale level of translated columns.** A document column listed in `defineLocaleLevel({ columns: ["title", "body"] })` holds one hash per locale. Path, draft, visibility and publication are shared across locales. (docs/read-model.md, docs/structure.md `./Pages`)
- **`./Pages` routes documents but builds no pages.** It is a routable, localised leaf, and the docs say "there is no page builder". Menus are `./Links` over `./Collections`. (docs/structure.md)
- **Both applications already split document storage by kind.** They keep `inline_documents` and `block_documents` tables (docs/seams.md). So "a block document" already exists as a storage family, just not as a kernel concept.

## The systems

### Portable Text (Sanity)

- **Shape.** "Rich text as an array of blocks, themselves arrays of children spans" [PT]. A text block has `_type`, `style`, `children`, `markDefs`, `listItem` and `level`. Custom block types (image, code, embed) sit in the same root array and need only a `_type` [PT].
- **Nesting is deliberately shallow.** There are two levels: blocks, then spans. Lists are not trees. Each list item is a flat block, and "the list position is derived from the position the block has in the array", with `level` expressing "visual nesting" [PT]. Inline formatting has two kinds of mark. Decorators are bare strings. Annotations are keys into `markDefs`, which hold the data, for example a link's `href` [PT].
- **Identity.** Sanity array objects "must have a unique `_key`", generated at creation and "immutable throughout the lifetime of the object". Patches address an item by key (`["pets", {_key: "…"}, "name"]`) because an index "can be wrong if the order in the array changes" [SAN-PATHS]. Keys are what make concurrent edits merge safely.
- **References.** A custom block or annotation holds a reference to another document, such as an image block with an asset reference [PT]. The reference is resolved at query time and never copied into the text.
- **Localisation.** Sanity offers both field-level localisation (one document, every language in it, all published together) and document-level localisation (one document per language, joined by references, published independently). Document-level is "best for translating content using Portable Text" [SAN-I18N].
- **Rendering-agnostic** by construction. Serializers map `_type` and `style` to output [PT].

### WordPress block grammar (Gutenberg)

- **Shape.** In memory, a post is a tree of `{ clientId, type, attributes, innerBlocks }`, but that tree "only ever exists in memory". What gets stored is `post_content`: HTML with "HTML comments as explicit block delimiters" and attributes "as JSON literals inside the comment" [WP-FLOW] [WP-MARKUP]. For example, `<!-- wp:image {"sizeSlug":"large"} --><figure>…</figure><!-- /wp:image -->`.
- **Attribute sources.** An attribute can be read back out of the saved HTML (`attribute`, `text`, `html`, `query`) or kept in the comment delimiter when no source is given. `meta` is deprecated. The `content` role marks user-editable text, and `local` marks data that is never saved [WP-ATTR].
- **Nesting.** `innerBlocks` nests to any depth, and each block type defines the inner blocks it allows [WP-FLOW].
- **Static and dynamic blocks.** A static block saves its rendered markup. A dynamic block saves only a self-closing delimiter and its attributes, and is rendered on the server [WP-FLOW] [WP-MARKUP].
- **Validation means "does the saved HTML still match `save()`".** A block whose markup no longer matches is invalid. Recovery is a `deprecated` array of old `save` functions, tried in order, with `migrate` to lift old attributes. "Deprecations don't chain" [WP-DEPR]. This is the price of storing rendered output.
- **Reusable sections.** The `core/block` block (a synced pattern, formerly a "reusable block") stores `ref` (a number, the id of the `wp_block` post holding the pattern) and an `overrides` object for per-instance content [WP-COREBLOCK]. Unsynced patterns are copies made when inserted.
- **Versioning.** Revisions store full `post_content`. Block identity (`clientId`) is not persisted, so a diff between revisions is a text diff of serialised HTML.
- **Not rendering-agnostic.** Static blocks bake presentation into the stored artifact. This is the main thing for a headless kernel to avoid.

### Contentful rich text and references

- **Shape.** A single root `{ nodeType: "document", content: [...] }`. Nodes have `nodeType` and `data`, plus `content` or `value`/`marks`. There are three node kinds: Block, Inline and Text. Only blocks sit under the root, and some blocks constrain their children (lists hold list items) [CF-RT].
- **Nesting rules are fixed.** "Nested documents are not allowed", and "custom node types and marks are not allowed" [CF-RT]. Extension happens through embedded entries, not new node types.
- **References.** `embedded-entry-block`, `embedded-entry-inline`, `embedded-asset-block` and `entry-hyperlink` carry `data.target.sys = { type: "Link", linkType: "Entry" | "Asset", id }`. The REST API returns linked items in `includes`, which is the same idea as JSON:API's `included`. GraphQL does not resolve them inside the JSON [CF-RT].
- **Reusable sections are entries.** A "block" that needs structure, reuse or its own lifecycle is an entry of some content type, embedded or linked [CF-RT] [CF-CT]. The rich text holds only the link.
- **Validation is declarative and per field.** Rich text has `enabledNodeTypes` and `enabledMarks`, and per-node `nodes.<type>.linkContentType` and `size` limits on embeds. Link fields have `linkContentType` and `linkMimetypeGroup`. Validations apply to existing entries only "until they are re-published" [CF-CT].
- **Localisation.** It is per field (`localized: true`) [CF-CT]. Rich text "is localizable and behaves the same way in both the web app and the API" [CF-RTL]. That is, a whole document per locale. The tutorial does not say how embedded entries resolve per locale.

### Payload blocks

- **Shape.** A `blocks` field "stores an array of objects, where each object is a 'block' with its own schema". Each item records `blockType` (the block's slug), an optional editor-facing `blockName`, and a row id that is regenerated on paste [PL-BLOCKS]. A block can hold any field, including further `blocks` or `array` fields, so nesting is open.
- **Reuse is at the schema level.** `blockReferences` lets one block definition be shared across collections, "isolated from the collection / global config" [PL-BLOCKS]. That reuses a schema, not content. Reusing content means a relationship to another document.
- **Validation.** There are `minRows` and `maxRows`, a `validate` function that runs on both client and server, and `filterOptions` to restrict the blocks allowed. A block that is no longer allowed fails on save [PL-BLOCKS].
- **Localisation at either grain.** `localized` on the whole `blocks` field keeps "a separate localized copy of all data in that field". Alternatively, individual fields inside a block can be localized while the layout stays shared [PL-L10N]. A localized field is stored as an object keyed by locale. Switching `localized` on or off loses data unless it is migrated. Per-locale publish status is "experimental" [PL-L10N].
- **Versions are full snapshots.** Each version stores "a full copy of the document" in a versions collection, `maxPerDoc` defaults to 100, and the admin UI shows diffs [PL-VER]. The docs do not say how the diff is computed.

### Strapi components and dynamic zones

- **Shape.** A component is a single typed object. A dynamic zone is a list of components, and each item names its type in `__component` [ST-DZ].
- **Identity is fragile.** On update, an item that carries its `id` is updated. One without an `id` is deleted and recreated, and items left out of the request are removed [ST-DZ]. So a block's identity is a storage row id, and a client that drops it loses the block's history.
- **Localisation.** Fields without localisation "have one value common to all locales". "Dynamic zones and components [can] differ from one locale to another", and a localised zone can have a different structure per locale. Shared components and zones are read-only in non-default locales [ST-I18N].
- The pages I read do not state a nesting-depth limit. Treat any limit as unverified.

### Editor.js

- **Shape.** `save()` returns `{ time, blocks: [{ id, type, data }], version }`. `type` is the tool's key in the editor config, and `data` is whatever the tool returns [EJS-SAVE]. The format is a flat array of opaque per-tool payloads, and the saving docs describe no nesting.
- **Validation.** A tool's `validate(savedData)` returns a boolean, and failing blocks are skipped on save [EJS-VALID]. That is a client-side filter, not a stored-grammar check.
- No reference, localisation or versioning model. Editor.js is an editor, not a CMS, so those are left to the host.

### ProseMirror / ProseKit (what Pulpit's applications store)

- **Shape.** "A ProseMirror document is a node, which holds a fragment containing zero or more child nodes." Inline content is "a flat sequence, with the markup attached as metadata", so marks behave like Portable Text marks, not like nested DOM. The form is canonical: adjacent text with equal marks is merged, and empty text is disallowed [PM-GUIDE]. JSON is `node.toJSON()` and `schema.nodeFromJSON` [PM-GUIDE].
- **Nesting and validation come from the schema.** Content expressions (`"paragraph+"`, `"block+"`, groups) define the valid child sequences, `attrs` take defaults, and `marks` lists the marks allowed per node. Validation is after the fact (`node.check()`, `createChecked`), because "not every node-manipulating function … checks" [PM-GUIDE]. This is the most expressive grammar of the systems here, and it is what prosekit-utilities' allow-lists already enforce.
- **Identity.** "Nodes are simply values". They carry no ids and no parent links [PM-GUIDE]. A stable block id has to be an attribute the schema declares.
- **Change model.** Edits are positional steps with step maps. Steps can be inverted and rebased, rebasing "can fail", and collaboration needs a "central authority" that orders the steps [PM-GUIDE]. Steps are an editing-session concept. They are not what a CMS version history stores.

## Comparison

| | Portable Text | Gutenberg | Contentful RT | Payload blocks | Strapi DZ | Editor.js | ProseMirror |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stored form | JSON array | HTML + comment JSON | JSON tree | JSON/rows per field | rows per component | JSON array | JSON tree |
| Nesting | 2 levels; lists flat via `level` | any (`innerBlocks`) | fixed node rules; no nested documents | any (blocks in blocks) | component in zone; limit unverified | flat | any, by content expression |
| Block identity | `_key`, immutable | `clientId`, memory only | none in RT | row `id`, regenerated on paste | storage `id`; omitted means recreated | `id` | none (values); add as attr |
| References | reference objects, resolved at query | `core/block` `ref`; ids in attrs | `sys.Link` + `includes` | relationship fields | relation fields | none | atom node attrs (app-defined) |
| Reusable content | referenced documents | synced pattern (`wp_block`) + overrides | linked entries | relationship (schema reuse via `blockReferences`) | relations; components reuse schema | none | none built in |
| Localisation | field-level or document-level | per post (plugins) | per field: whole RT per locale | whole field, or nested fields | per field; structure may differ per locale | none | none built in |
| Validation | schema in Studio | `save()` output match + deprecations | `enabledNodeTypes`, marks, embed types, sizes | rows, `filterOptions`, `validate` | schema | per-tool `validate` filter | content expressions, `check()` |
| Versioning / diff | keyed patches on documents | revision = full `post_content` | entry versions | full snapshot per version, UI diff | replace semantics | none | steps (session only) |
| Rendering-agnostic | yes | no (static blocks) | yes | yes | yes | yes | yes |

## Trade-offs that matter for Pulpit

1. **Store data, not rendered output.** Gutenberg's validity rule (saved HTML must equal `save()`) forces a chain of deprecations every time a renderer changes [WP-DEPR]. Every other system stores data and renders at the edge. Pulpit's kernel already never renders, and its block grammar should keep it that way: no HTML strings as block content, except perhaps an explicit `html` escape-hatch block the application can forbid.
2. **Use a tree grammar or a flat list, but use one grammar for body and layout.** Flat lists (Editor.js, Strapi zones, Payload top-level blocks) are easy to diff and localise but cannot express "columns holding cards". Portable Text keeps text flat and pushes structure into typed custom objects. ProseMirror and Gutenberg allow a full tree. Pulpit's applications already store ProseMirror JSON, so a page body as a ProseMirror document under a "page" grammar (top-level section nodes holding block nodes holding inline content) needs no new store and reuses `DocumentCheck`.
3. **Give blocks stable identity, or diff and translation stay coarse.** Every system with collaborative or per-block operations gives blocks a stable, immutable key (Sanity `_key` [SAN-PATHS]). Systems without one either lose history on edit (Strapi's omit-id-means-recreate [ST-DZ]) or diff text (Gutenberg). ProseMirror nodes have no identity [PM-GUIDE], so the page grammar should require an `id` attr on every top-level and section-level block, generated at creation and never changed by edits. It is part of the document, so it is part of the hash, which is fine because it is immutable.
4. **Embed a reference, never a copy.** Contentful's `sys.Link` + `includes` [CF-RT], Sanity references and Gutenberg's `core/block` `ref` [WP-COREBLOCK] all keep the target outside the text and resolve it at read. For Pulpit that is the only option that respects gating. A copied media URL or entry body would bypass the target leaf's read gate, `EDGE-001`, and the rendition gate's "some node the viewer can read must reference the bytes" (docs/media.md).
5. **Reusable sections are either synced (a separate node) or copies (a template).** Synced sections need their own lifecycle: Gutenberg's `wp_block` post, Contentful entries. Per-instance overrides (Gutenberg `overrides` [WP-COREBLOCK]) are the costly part, because they create a merge between section and instance. Payload's `blockReferences` is reuse of a schema, not of content [PL-BLOCKS], and is a separate concern.
6. **Localisation grain.** There are three patterns:
   - Whole document per locale: Contentful [CF-RTL], Payload's localized `blocks` field [PL-L10N], Sanity document-level [SAN-I18N]. Simple. Structure may differ by locale.
   - Shared structure with localised leaf fields: Payload nested `localized` [PL-L10N], Strapi shared zones [ST-I18N]. Layout stays in sync, but there is a field per locale per block and a data-loss hazard when toggling.
   - Hybrid: Strapi lets a whole zone be localised or shared [ST-I18N].

   Sanity recommends whole-document localisation for rich text specifically [SAN-I18N].
7. **Versioning grain.** Payload snapshots the whole document per version [PL-VER]. Sanity patches by key. ProseMirror steps are positional and session-scoped [PM-GUIDE]. Pulpit's content addressing already gives Payload's snapshot semantics at hash-dedup cost, and it never prunes.

## Which ideas fit Pulpit's documents

Recommendations for the page-model ticket, ordered by how directly they follow from the existing design:

1. **The page model is a grammar, not a store.** Add no new module for block storage. A page is a `./Pages` leaf whose layout is a document column (for example `body` or `layout`) under a page grammar. The grammar is filled by the application through `DocumentCheck`, like `PostBody`. The kernel can ship the *recipe* and the seams. In keeping with "no application vocabulary", the block vocabulary (`hero`, `cards`, `cta`) stays the application's, or lives in prosekit-utilities.
2. **Require a stable `id` attr on structural blocks.** Following Sanity's `_key` [SAN-PATHS], make it a grammar rule the check enforces: present, unique within the document, and a fixed format. It gives:
   - a block-level diff for `compare`: match blocks by id, then report each as added, removed, moved or changed. A changed block's subtree can be compared by canonical text, so an equal subtree costs nothing.
   - alignment of translation segments across locales (`./Translation`).
   - stable anchors for comments or proposals on a block.
   This extends `diffStates` (which today stops at the hash) as an optional, grammar-aware `DocumentDiff` seam. It does not change `diffStates`.
3. **References are atom nodes holding `{ type, id }`, read through gates.** A media block holds the media node's id, never its `contentHash` or a URL. An "embedded entry" or "synced section" block holds the section node's id. This mirrors Contentful's `sys.Link` [CF-RT].
   - Resolution is a kernel-shaped read: collect the refs (a `ReferenceExtractor` seam, shaped exactly like `MentionExtractor`), then batch `getMany` per leaf. Hidden refs are **omitted, never forbidden**, as `./Links` already does (`SEC-AUTH-ENUM-001`). The result is an `included`-style map beside the document, as Contentful's `includes` and JSON:API do.
   - The same extractor, run in a before or after hook on write, maintains the file-usage edges and the `MediaReferences` index the rendition gate reads (docs/media.md). That closes the loop that "maintaining the edges is the referencing leaf's job" leaves open.
4. **Reusable sections are their own leaf.** A synced section is a node (a reference leaf, versioned, localised, publishable) referenced by id. It gets history, review, publication and erasure from the existing modules for free.
   - Decide whether a page follows the section's live version (floating, like Gutenberg and Contentful) or pins a version. Content addressing makes pinning cheap: a ref can carry an optional `version`. Floating should be the default, so that editing a footer section updates every page.
   - Defer per-instance overrides. They are the costliest part of Gutenberg's design [WP-COREBLOCK].
   - Templates (unsynced patterns) need no kernel support. They are documents copied at create.
5. **Localise the whole document per locale. This is the existing locale level, unchanged.** `body` listed in `defineLocaleLevel` gives one hash per locale. That matches Contentful, Payload's localized `blocks` field and Sanity's advice for rich text [CF-RTL] [PL-L10N] [SAN-I18N].
   - Content addressing makes it cheap: a block left untranslated is the same bytes. With per-block storage (below) it is the same row.
   - Stable block ids let a translator UI show "block X in `en` against block X in `fr`" and flag drift.
   - Avoid the shared-structure, localised-leaf pattern. It would need a document that spans locales, which breaks one-hash-per-locale-column and Payload's documented data-loss hazard on toggle [PL-L10N] shows the cost.
6. **Validation stays the two-place grammar check.** Model the page grammar on ProseMirror content expressions (structure) plus Contentful-style declarative limits [CF-CT]: allowed block types per region, allowed reference target types per ref node (`linkContentType`), and min/max counts.
   - Reference *liveness* (does the target exist, can the viewer read it) belongs at read, not in `DocumentCheck`, which "reads only the document".
   - A grammar change cannot rewrite old documents (`DOC-001`), and `restoreVersion` is exempt from the check. So the grammar needs an evolution story Gutenberg lacked: a version tag in the document root (`attrs.grammar: 2`), and read-time upgraders that are pure functions from old to new. That is Gutenberg's `deprecated`/`migrate` [WP-DEPR], but over data rather than markup, and chained explicitly.
7. **Optional: content-address per block, not only per page.** The applications already have a `block_documents` family. A page document whose top-level sections are `{ id, hash }` refs to separately stored block documents (a Merkle shape) would mean:
   - an edit to one section stores one new small document, not a new copy of the whole page.
   - `compare` can name changed blocks by comparing hashes without reading the documents.
   - an untranslated section is shared across locales by hash.

   The costs: one more `getMany` per read, a grammar check over the composed page rather than one document, and an erasure walk over block hashes. Payload's full snapshot per version [PL-VER] suggests whole-page storage is acceptable at CMS scale. Treat this as an optimisation behind the same grammar, not a first-version requirement.

Things that do **not** fit:

- Gutenberg's HTML serialisation. It is rendering-coupled.
- ProseMirror steps as history. They are positional and session-scoped, and Pulpit's history is snapshots by hash.
- Strapi's id-optional replace semantics. They lose block identity.
- Payload's per-field `localized` inside blocks, for the reasons in item 5.

## Open questions for the page-model ticket

- Should the kernel ship a reference grammar (a minimal page schema with section, block, `ref` atom and media atom) in `./testing` as a fake, the way `jsonMentionExtractor` is? Or should all of it live in prosekit-utilities?
- Should a ref to a section default to floating (live) or pinned? Publication interacts with this: a published page that floats onto a draft section has to read the section's *live* view.
- Is a block-level `DocumentDiff` seam worth adding before a UI needs it?
- Should the page-level fields (SEO metadata, layout template) be shared columns or part of the document? Shared columns can be queried and filtered (`./Filter`). The document is opaque to SQL.

## Sources

- [PT] Portable Text specification: https://github.com/portabletext/portabletext
- [SAN-PATHS] Sanity, "How form paths work" (`_key`): https://www.sanity.io/docs/studio/how-form-paths-work
- [SAN-I18N] Sanity, Localization: https://www.sanity.io/docs/studio/localization
- [WP-FLOW] WordPress Block Editor Handbook, Data Flow and Data Format: https://developer.wordpress.org/block-editor/explanations/architecture/data-flow/
- [WP-MARKUP] WordPress Block Editor Handbook, Markup representation of a block: https://developer.wordpress.org/block-editor/getting-started/fundamentals/markup-representation-block/
- [WP-ATTR] WordPress Block Editor Handbook, Attributes: https://developer.wordpress.org/block-editor/reference-guides/block-api/block-attributes/
- [WP-DEPR] WordPress Block Editor Handbook, Deprecation: https://developer.wordpress.org/block-editor/reference-guides/block-api/block-deprecation/
- [WP-COREBLOCK] WordPress core, `core/block` block.json (`ref`, `overrides`), changeset 57377: https://core.trac.wordpress.org/changeset/57377/trunk/src/wp-includes/blocks/block/block.json
- [CF-RT] Contentful, Rich Text concepts: https://contentful.com/developers/docs/concepts/rich-text.md
- [CF-CT] Contentful CMA, Content types (validations, `localized`): https://contentful.com/developers/docs/references/content-management-api/content-types.md
- [CF-RTL] Contentful, Rich Text and Localization: https://contentful.com/developers/docs/tutorials/general/rich-text-and-localization.md
- [PL-BLOCKS] Payload, Blocks field: https://payloadcms.com/docs/fields/blocks
- [PL-L10N] Payload, Localization: https://payloadcms.com/docs/configuration/localization
- [PL-VER] Payload, Versions: https://payloadcms.com/docs/versions
- [ST-DZ] Strapi, Components and dynamic zones (Entity Service, deprecated in v5 in favour of the Document Service): https://docs.strapi.io/cms/api/entity-service/components-dynamic-zones
- [ST-I18N] Strapi, Internationalization: https://docs.strapi.io/cms/features/internationalization
- [EJS-SAVE] Editor.js, Saving data: https://editorjs.io/saving-data
- [EJS-VALID] Editor.js, Saved data validation: https://editorjs.io/saved-data-validation
- [PM-GUIDE] ProseMirror Guide: https://prosemirror.net/docs/guide/
- Pulpit: `docs/content-model.md`, `docs/seams.md`, `docs/structure.md`, `docs/media.md`, `docs/read-model.md`, `docs/history-and-review.md`, `docs/participation.md` (at /home/claude/pulpit).
