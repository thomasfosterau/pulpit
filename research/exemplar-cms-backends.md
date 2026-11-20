# Which enterprise or headless CMSs should test the backend abstraction?

Research for thomasfosterau/pulpit#415 (wayfinder #412). Feeds #420 (how a backend declares its capabilities). WordPress, the first exemplar, is mapped separately (#414).

**Short answer.** Use **Payload** and **Contentful**, and add **Sanity** only if the sync-source mode stays in scope.

- **Payload** is self-hosted, MIT-licensed and runs in CI next to the existing PostgreSQL service. It maps almost every chain capability, so it is the "rich backend" case.
- **Contentful** is the enterprise SaaS case. Its optimistic concurrency is strict and maps one to one onto `StaleVersion`. Its history only has publish snapshots, it has no merge writes, it has field-level locales and a closed rich-text AST, and it has quotas.
- **Sanity** is the change-feed and opaque-revision case. It has a resumable SSE listener, string `_rev` versions instead of counters, drafts held as sibling documents, locales by convention only, and history cut off by retention.

Each one breaks a different assumption in the `VersionChain` port that WordPress does not break (see [Why these three](#why-these-three)).

Sources are the vendors' own documentation, fetched on 2026-11-20 (listed at the end). A claim marked *(unverified)* comes from prior knowledge, not from a page fetched for this note. Check it before relying on it.

## What the kernel asks of a backend

These are the capabilities from #414, read against `docs/history-and-review.md` and `docs/seams.md`:

- **Versioned chain.** Append-only; every write lands at `N_max + 1` with a `bigint` version. It has `history`, `getVersion` and `compare` (over `diffStates`), plus `restoreVersion`, which appends N+1 with an old state, and tombstone deletes.
- **Tri-state patch.** A value sets a field, `null` clears it, and an absent key carries it forward.
- **Optimistic concurrency.** `expectedVersion` fails with `StaleVersion`, and a concurrent append collides with `VersionConflict`.
- **Drafts / live pointer.** `PublicationStore` and `LiveView`; the `WorkingCopy` autosave writes no versions (`VERSION-CHAIN-001`).
- **Others.** Scheduled publishing, edges/taxonomies, paths, comments, reactions, media and renditions, a locale level per version (`LocaleStates`), owners and visibility (private/followers/group/public), and search.
- **For #420.** Auth, a change feed (for the sync-source mode), and the licensing and hosting needed to test against the backend.

## Survey

| | Contentful | Sanity | Payload | Drupal (JSON:API) | Strapi 5 | Directus | AEM (Sites OpenAPI) |
|---|---|---|---|---|---|---|---|
| **History** | Snapshot on each publish/republish only [C2][C3]. Versioning on the `master` environment only [C3]. Field or whole-entry rollback in the web app [C3]. | Transaction log; document at a revision or time [S1]. Retention: Free 3 d, Growth 90 d, Enterprise 365 d; older revisions truncated into one [S5]. Pricing lists the History API under Enterprise [S6]. | Every save is a full-copy version in `{slug}_versions`. `maxPerDoc` defaults to 100 (0 keeps all). REST/GraphQL/Local `restoreVersion` [P1]. | Revisions readable by `?resourceVersion=` (`rel:latest-version`, `rel:working-copy`, `id:N`), Node and Media only. Read-only, with no revision collection [D1]. | Content History on Growth/Enterprise only, 14 / 30–90 days. Admin UI only, and API writes create no versions [St1]. | `revisions` with `data` and `delta` [Di1]. `POST /utils/revert/{revision}` (REST only) [Di2]. Named content versions are promoted with per-field review [Di3]. | `GET/POST /cf/fragments/{id}/versions`, `POST …/versions/restore/{versionId}` [A1]. |
| **Draft / publish / schedule** | Published vs current. Scheduled actions publish/unpublish an entry, asset or release: ≤500 pending, ≤200 per minute, ≤5 years ahead, IANA timezone [C4]. Free plan has no scheduled publishing [C9]. | `drafts.<id>` beside `<id>`; `versions.<release>.<id>` for releases [S3]. Actions API (publish, unpublish, discard, release schedule) [S4]. Scheduled drafts on Growth, releases on Enterprise [S3][S6]. | `_status`; `draft: true` writes only to the versions table, so the main collection stays published. `schedulePublish` needs a jobs queue [P2]. | Content Moderation: published default revision plus a draft working copy; Draft/Published/Archived states [D4]. Scheduling via the contrib Scheduler [D5]. | Draft & Publish is free; scheduling needs Releases (Growth/Enterprise) [St2]. | Content versions (`draft` plus named) promoted to published [Di3]. | Publish and unpublish endpoints exist [A1]. |
| **Locales** | Per-locale field values (`/fields/<f>/<locale>`) [C5], locale fallback chain [C6]. Per-locale publishing on Premium only [C5]. Free has 2 locales [C9]. | No built-in layer: field-level or document-level by schema convention or plugin; fallback with GROQ `coalesce()` [S7]. | Field-level `localized: true`, fallback, `locale=all` [P4]. Per-locale status is experimental [P4]. | Entity translations. Core JSON:API can PATCH a translation but cannot add or delete one; the contrib JSON:API Multilingual module adds both [D2]. | i18n built in *(unverified)*. | `translations` junction scaffolding [Di2]. | Language copies/MSM *(unverified)*. |
| **Concurrency** | `X-Contentful-Version` is required on update [C1]; `VersionMismatch` returns 409 [C7]. No merge: the PUT replaces the whole entry; JSON Patch is the alternative [C1][C5]. | `ifRevisionID` on mutations: "if the document's current revision ID doesn't match", the mutation fails [S2]. `_rev` is an opaque string. | No version check. Pessimistic document lock that API callers bypass by default (`overrideLock: true`) [P3]. | The `EntityChangedConstraint` timestamp check ("modified by another user") [D3]. Whether it fires over JSON:API is *(unverified)*. | None found. | None found. | `If-Match` is required on PUT/PATCH, with 412 on conflict and 428 when missing [A2]. |
| **References / rich text** | Links to entries and assets, resolved up to 10 levels [C5]. Rich text is a JSON AST with a fixed node set: custom nodes and marks are not allowed [C8]. | References *(weak/strong unverified)*; Portable Text *(unverified)*. | Relationship (polymorphic) plus a virtual reverse `join` [P6]; Lexical rich text *(unverified)*. | Entity references; HTML text fields. | Relations; "blocks" field *(unverified)*. | M2O/O2M/M2M. | Fragment references. |
| **Change feed** | Webhooks (`save`, `auto_save`, `publish`, `unpublish`, `delete` …). Retries 2× about 30 s apart on 429/5xx; a timeout is not retried. Best-effort exactly-once with `X-Contentful-Idempotency-Key`. No stated ordering [C10]. | Listen API: SSE filtered by GROQ, with `previousRev` and `resultRev`, optional before/after documents. Resumable with `Last-Event-ID` (`welcomeback` or `reset`) [S8]. | In-process hooks *(unverified: no built-in webhooks)*. | None in core *(unverified)*. | Webhooks *(unverified)*. | Flows/WebSockets *(unverified)*. | *(unverified)* |
| **Auth** | Bearer CMA tokens [C1]. | Bearer tokens; ACL applied to every past revision by current permission [S1]. | Built-in auth collections *(unverified detail)*. | Drupal permissions [D6]; methods per the child pages. | API tokens *(unverified)*. | Static or user tokens *(unverified)*. | Bearer (IMS) [A1]. |
| **Licence / test hosting** | Proprietary SaaS. Free: 1 space, 2 environments, 2 locales, 10k records, 100k API calls/month, hard caps [C9]. 7 req/s default [C1]. | Proprietary Content Lake. Free: 2 public datasets, 250k API requests/month, 3-day history [S6]. | MIT [P5]. Self-host on PostgreSQL or SQLite [P6]. | GPL-2.0-or-later [D7]. Self-host (PHP). | MIT unless code in `ee/` is used or a cloud account exists; history and releases are paid [St3][St1]. | MSCL (source-available). Free under $5M revenue and 50 employees; registration keys; GPLv3 after 4 years [Di4]. | Proprietary (AEM as a Cloud Service); no free test tier found. |

## Recommendation

### Why these three

Each one stresses an assumption the WordPress map leaves standing:

| Assumption in the kernel | WordPress | Payload | Contentful | Sanity |
|---|---|---|---|---|
| A version is a dense `bigint` per node | revision post ids | version document ids, ordered by time | integer `sys.version` | **opaque string `_rev`** |
| History is complete and append-only | revisions (prunable) | complete unless `maxPerDoc` prunes (default 100) | **publish snapshots only** | **retention-truncated** (3/90/365 d) |
| `expectedVersion` → `StaleVersion` | none | **lock only, bypassed by default** | **strict, 409** | **strict, opaque id** |
| The tri-state patch is a merge | merge | merge | **whole-entry replace** (or JSON Patch) | set/unset patch |
| A locale level per version | none (plugins) | **native field-level, fallback** | **native field-level, fallback** | convention only |
| A change feed for sync-source mode | none in core | in-process hooks | lossy webhooks | **resumable SSE** |
| It can be tested in CI | Docker | **Docker + existing PG service** | SaaS free space (quotas, secret) | SaaS free dataset (quotas, secret) |

1. **Payload (primary, self-hosted).**
   - It is the only candidate where every chain operation has a counterpart: full-copy versions, `restoreVersion`, and drafts written only to the versions table (which is exactly the live pointer). It also has autosave-as-version, `schedulePublish` and native field-level locales with fallback [P1][P2][P4].
   - Its two gaps are useful tests. It has no optimistic concurrency, so `StaleVersion` has to be emulated (or declared absent), which tests #420's degrade path [P3]. `maxPerDoc` pruning conflicts with append-only history unless set to 0 [P1].
   - MIT and Node/TypeScript mean it runs in `vp run ci` against the PostgreSQL service CI already has.
2. **Contentful (the enterprise SaaS).**
   - Its strict `X-Contentful-Version`/409 is the only surveyed precondition besides AEM's If-Match that maps one to one onto `StaleVersion` [C1][C7].
   - It tests the other half of #420: history that exists only at publish points [C2][C3], so `history`/`compare` are partial while concurrency is full. Writes that replace the whole entry force the adapter to read-modify-write [C1]. A closed rich-text node set [C8] checks `DocumentCheck`'s grammar against a foreign schema. Plan-gated features (scheduling, per-locale publishing) [C4][C5][C9] force capability declaration per *account*, not per backend type.
   - It also checks rate limits (429 + reset header) and hard quotas [C1][C9].
   - AEM covers the same ground (If-Match on PUT/PATCH [A2], explicit versions and restore [A1]) but has no accessible test instance, so Contentful stands in for it.
3. **Sanity (optional: only if sync-source mode stays).**
   - Its version is an opaque `_rev` string [S2], which tests whether the kernel's `bigint` version can be adapter-opaque or needs a mapping table.
   - Its Listen API is the only surveyed change feed with resume semantics (`Last-Event-ID`, `welcomeback`/`reset`) and before/after revisions [S8], which a sync source needs.
   - Drafts are sibling documents (`drafts.<id>`, `versions.<release>.<id>`) [S3], a third live-pointer shape. Locales exist only by schema convention [S7], the clean "none" case for the locale level.
   - History is cut off by plan retention, and the History API may be Enterprise-only [S5][S6].

### Not chosen

- **Drupal (JSON:API)** overlaps WordPress: self-hosted PHP with taxonomies, comments and path aliases in core. Its JSON:API revision access is read-only, limited to Node and Media, and has no history collection [D1]. Pick it instead of Payload only if testing a JSON:API-wire backend (pulpit already speaks JSON:API through effect-jsonapi) matters more. Content Moderation's default-vs-working-copy revisions [D4] are a good live-pointer case.
- **Strapi** keeps history in the admin UI only, on a paid plan, and API writes create no versions [St1]. Releases are paid [St2] and there is no concurrency check, so it repeats WordPress's gaps.
- **Directus** has revisions with deltas and revert [Di1][Di2] and named versions [Di3], but it is weaker than Payload on every chain axis, and it now needs registration keys under the MSCL [Di4].
- **AEM** has the strongest concurrency contract, but no free or test instance; see Contentful above.

## Capability maps

These use the full/partial/none scale from #414 and cover reading and writing over each CMS's own API.

### Payload (REST or Local API)

| Capability | Mark | What maps, what's lost |
|---|---|---|
| Versioned chain: history, getVersion | **full** | `findVersions`/`findVersionByID` over full-copy versions [P1]. Version ids are not `bigint`s, so a dense number has to be derived from `createdAt` order. `maxPerDoc` must be 0, or old versions are pruned (breaks append-only). |
| compare | **full** | Kernel-side `diffStates` over two full copies (the Admin UI diff is not an API) [P1]. |
| restoreVersion | **full** | `POST /api/{slug}/versions/:id` [P1]. Whether the restore appends a new version or rewrites the main document is *(unverified)*. |
| Tombstone delete / restore | **partial** | Delete removes the document *(unverified: no soft delete in core)*, so a tombstone needs a status field. |
| Optimistic concurrency | **none** (emulated) | Lock only, bypassed by default (`overrideLock: true`) [P3]. A read-then-compare is racy without the lock. |
| Drafts / live pointer | **full** | Main collection = published; `draft: true` writes go to versions only [P2]. |
| WorkingCopy (autosave, no version) | **partial** | Payload autosave *creates* draft versions [P1], so the kernel's buffer has to stay pulpit-side. |
| Scheduled publishing | **full** | `schedulePublish` plus a running jobs queue [P2]. |
| Edges / taxonomies | **partial** | Relationship fields (polymorphic) and virtual `join` [P6]. Edge rows with their own attributes need a collection. |
| Paths | **partial** | No path/alias model; a slug field plus a pulpit-side `PathStore`. |
| Comments / reactions | **none** | Application collections only. |
| Media / renditions | **full** | Uploads with `imageSizes`, crop and focal point [P5u]; storage via plugin/hooks. |
| Locales | **full** | Field-level `localized`, fallback, `locale=all` [P4]. Per-locale publish status is experimental [P4]. |
| Owners / visibility | **partial** | Access functions return query constraints per request [P2], so row-level rules are expressible, but `followers`/`group` sets must be written as Payload access code. |
| Search | **partial** | `where` queries *(unverified: full-text needs a plugin)*. |
| Change feed | **partial** | In-process hooks *(unverified)*; a remote sync source needs its own webhook. |

### Contentful (CMA for writes, CDA/CPA for reads)

| Capability | Mark | What maps, what's lost |
|---|---|---|
| Versioned chain: history, getVersion | **partial** | Snapshots exist only for publishes/republishes and only on `master` [C2][C3]. Saves between publishes are lost. |
| compare | **partial** | `diffStates` over two snapshots; only between published points. |
| restoreVersion | **partial** | No restore endpoint found. The adapter has to PUT a snapshot's fields back, which appends via the normal update [C1][C3]. |
| Tombstone delete | **partial** | Delete, with archive allowed only when unpublished [C5]; a delete leaves no tombstone history. |
| Optimistic concurrency | **full** | `X-Contentful-Version` → 409 `VersionMismatch` [C1][C7]; `StaleVersion.current` needs a re-read. |
| Tri-state patch | **partial** | PUT replaces the whole entry with no merge [C1]; JSON Patch cannot address unset fields without the whole locale sub-object [C5]. |
| Drafts / live pointer | **full** | CMA current vs CDA published; publish/unpublish [C5]. |
| Scheduled publishing | **partial** | Scheduled actions (publish/unpublish; entry/asset/release), capped at 500 pending, not on Free [C4][C9]. |
| Edges / taxonomies | **partial** | Entry/asset Links, resolved up to 10 levels [C5]; no edge attributes. |
| Paths | **none** | Slug fields by convention. |
| Comments / reactions | **none** | Entry comments are editorial (paid plans [C9]), not public participation. |
| Media / renditions | **full** | Assets plus the Images API's URL-parameter transforms [C11]. |
| Locales | **full** | Per-locale field values with a fallback chain [C5][C6]. Per-locale publishing is Premium only [C5]; Free has 2 locales [C9]. |
| Owners / visibility | **none** | Space roles govern editors; delivery is published-or-not. |
| Search | **partial** | CDA filters (`match` …) [C1]; no hybrid or semantic search. |
| Change feed | **partial** | Webhooks: 3 attempts, idempotency key, no ordering guarantee [C10]. Lossy, so it needs reconciliation. |

### Sanity (Mutations, Actions, Query, History and Listen APIs)

| Capability | Mark | What maps, what's lost |
|---|---|---|
| Versioned chain: history, getVersion | **partial** | Document at a revision or time, plus a transaction log [S1]. Retention-truncated (3/90/365 d) [S5]; the History API may be Enterprise-only [S6]. Revisions are opaque strings. |
| compare | **partial** | `diffStates` over two fetched revisions, within retention. |
| restoreVersion | **partial** | Fetch the old revision and `createOrReplace` it [S1][S2]. Studio "revert" exists; no API endpoint found. |
| Optimistic concurrency | **full** | `ifRevisionID` [S2]. `StaleVersion.current` has to carry a string. |
| Tri-state patch | **full** | Patch `set`/`unset` *(operation names unverified)*. |
| Drafts / live pointer | **full** | `drafts.<id>` vs `<id>`; publish via Actions [S3][S4]. A draft is one mutable document, not a version. |
| Scheduled publishing | **partial** | Scheduled drafts (Growth) and releases (Enterprise); scheduled versions are locked [S3][S6]. |
| Edges / taxonomies | **partial** | Reference fields *(unverified detail)*; no edge rows. |
| Paths | **none** | Slug convention. |
| Comments / reactions | **none** | — |
| Media / renditions | **full** | Asset documents plus URL-parameter transforms (`w`, `h`, `crop`, `fit`, `fm`) [S9]. |
| Locales | **none** (convention) | Field- or document-level by schema; GROQ `coalesce()` for fallback [S7]. |
| Owners / visibility | **none** | Dataset public/private; custom roles on Enterprise only [S6]. |
| Search | **partial** | GROQ queries *(text match unverified)*. |
| Change feed | **full** | SSE Listen with GROQ filter, before/after revisions and resume [S8]. |

## Findings for #420

- **Version identity must be adapter-defined.** The candidates use a `bigint` counter (Contentful), an opaque string (Sanity) and document ids ordered by time (Payload). Either the kernel's `version` becomes an opaque, ordered token per backend, or adapters keep a mapping table, and a mapping table breaks the system-of-record-only design.
- **History completeness is a separate capability from history existence.** The three cases are publish-only (Contentful), retention-truncated (Sanity, Strapi) and prunable (Payload `maxPerDoc`). `VERSION-CHAIN-001/002` can only hold on a complete-history backend, so the declaration needs at least `none | publishPoints | retained(d) | complete`.
- **Concurrency is three-valued:** a strict precondition (Contentful, Sanity, AEM), a timestamp or lock (Drupal, Payload), or nothing (Strapi, WordPress).
- **Capabilities vary by plan, not only by product.** Contentful's scheduling and per-locale publishing and Sanity's releases and History API depend on the plan, so a backend has to declare its capabilities at layer construction from configuration or probing, not statically per adapter.
- **Every candidate has the live pointer**, in four shapes: separate APIs (Contentful), sibling documents (Sanity), a versions table vs the main row (Payload) and a default vs latest revision (Drupal). The kernel's own write-free autosave is never native: Payload's and Contentful's autosaves write.
- **Nothing maps comments, reactions or audience visibility.** None of the candidates offers public participation, so these always stay pulpit-side tables beside a remote system of record. That makes a mixed (remote chain plus local participation) deployment the normal case.

## Sources

Contentful
- [C1] CMA overview (version locking, no-merge updates, rate limits, filters): https://www.contentful.com/developers/docs/references/content-management-api/
- [C2] Snapshots: https://contentful.com/developers/docs/references/content-management-api/snapshots.md
- [C3] Versioning FAQ: https://www.contentful.com/help/faq/versioning/
- [C4] Scheduled actions: https://contentful.com/developers/docs/references/content-management-api/scheduled-actions.md
- [C5] Entries: https://contentful.com/developers/docs/references/content-management-api/entries.md
- [C6] Locales: https://contentful.com/developers/docs/references/content-management-api/locales.md
- [C7] Errors (VersionMismatch, 409): https://contentful.com/developers/docs/references/errors.md
- [C8] Rich text: https://contentful.com/developers/docs/concepts/rich-text.md
- [C9] Pricing: https://www.contentful.com/pricing/
- [C10] Webhooks: https://contentful.com/developers/docs/webhooks/overview.md
- [C11] Images API: https://contentful.com/developers/docs/references/images-api.md

Sanity
- [S1] History API: https://www.sanity.io/docs/http-reference/history
- [S2] Mutation API: https://www.sanity.io/docs/http-reference/mutation
- [S3] Drafts: https://www.sanity.io/docs/content-lake/drafts
- [S4] Actions API: https://www.sanity.io/docs/content-lake/dispatch-actions
- [S5] History experience (retention): https://www.sanity.io/docs/content-lake/history-experience
- [S6] Pricing: https://www.sanity.io/pricing
- [S7] Localization: https://www.sanity.io/docs/studio/localization
- [S8] Listen API: https://www.sanity.io/docs/http-reference/listen
- [S9] Image URLs: https://www.sanity.io/docs/apis-and-sdks/image-urls

Payload
- [P1] Versions: https://payloadcms.com/docs/versions/overview
- [P2] Drafts: https://payloadcms.com/docs/v3/versions/drafts.md
- [P3] Locked documents: https://payloadcms.com/docs/admin/locked-documents
- [P4] Localization: https://payloadcms.com/docs/configuration/localization
- [P5] Licence: https://github.com/payloadcms/payload/blob/main/LICENSE.md
- [P5u] Uploads: https://payloadcms.com/docs/upload/overview
- [P6] Join field (relationships, PostgreSQL/SQLite storage): https://payloadcms.com/docs/fields/join

Drupal
- [D1] JSON:API revisions: https://www.drupal.org/docs/8/modules/jsonapi/revisions
- [D2] JSON:API translations: https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/translations
- [D3] EntityChangedConstraint: https://api.drupal.org/api/drupal/core%21lib%21Drupal%21Core%21Entity%21Plugin%21Validation%21Constraint%21EntityChangedConstraint.php/11.x
- [D4] Content Moderation overview: https://www.drupal.org/docs/8/core/modules/content-moderation/overview
- [D5] Scheduler (contrib): https://www.drupal.org/project/scheduler
- [D6] JSON:API module: https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/jsonapi
- [D7] Licensing: https://www.drupal.org/about/licensing

Strapi
- [St1] Content History: https://docs.strapi.io/cms/features/content-history
- [St2] Draft & Publish: https://docs.strapi.io/cms/features/draft-and-publish
- [St3] Licence: https://github.com/strapi/strapi/blob/develop/LICENSE

Directus
- [Di1] Revisions API: https://directus.com/docs/api/revisions
- [Di2] Utilities (revert, translations): https://directus.com/docs/api/utilities
- [Di3] Content versioning: https://directus.com/docs/guides/content/content-versioning
- [Di4] v12 licence change: https://directus.com/resources/directus-v12-license-change

AEM
- [A1] Sites API, Fragment Versioning: https://adobe-sites.redoc.ly/tag/Fragment-Versioning
- [A2] Sites API (If-Match on PUT/PATCH, 412/428): https://adobe-sites.redoc.ly/
