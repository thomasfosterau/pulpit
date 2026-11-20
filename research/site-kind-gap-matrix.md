# What does each kind of site need, and what does the kernel already cover?

Research for [#413](https://github.com/thomasfosterau/pulpit/issues/413), on the "Pulpit for any kind of site" map ([#412](https://github.com/thomasfosterau/pulpit/issues/412)). Read against `trunk` as checked out on 2026-11-20: `docs/*.md` and `packages/pulpit/src/*`.

## Answer in one line

The kernel already covers the hard, shared core (versioned content, publication and scheduling, gated reads, localisation, taxonomies, paths, menus, media, search, feeds and sitemaps, comments, reactions, the follow graph, groups, moderation, notifications, erasure). What it lacks is mostly **vocabulary and per-kind state on top of that core**: profiles and roles, a page/block model with SEO fields, member tiers and paid gating, a multi-site boundary, forum topic state (pin, lock, unread), social post semantics (reposts as posts, polls, content warnings, hashtags, timelines, DMs), news editorial (embargo, corrections, live blogs, workflow status) and product/catalogue content.

## How to read the matrix

- **Status** is the kernel's coverage of the capability, as a site of that kind needs it:
  - **C**, covered: a kernel module does it today, or a documented recipe over kernel modules does.
  - **P**, partial: the parts exist but the kind needs something they don't do, or the application must assemble a missing piece (named in the notes).
  - **M**, missing: no module or recipe; the application would build it outside the kernel.
  - **·**: not needed by that kind of site, or marginal.
- **Kinds**: Blog (personal blog; WordPress, Ghost), News (news site; a newsroom CMS such as Arc XP, WordPress VIP), Mkt (small-business marketing site; Webflow, WordPress pages), Forum (Discourse), Social (Mastodon, Bluesky), Ecom (the content side of an ecommerce site; Shopify's product content, not transactions).
- **Module** is the kernel subpath (`packages/pulpit/src/<Module>.ts`, guide in `docs/`).

## The matrix

### Content and history

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Typed content leaves, any shape | `Registry`, `Content`, `Subtype` | C | C | C | C | C | C | The application declares each leaf; the kernel ships no `post`/`page`/`topic` type yet (the vocabulary ticket, #421). |
| Rich-text body, grammar check | `Documents` | C | C | C | C | C | C | Content-addressed, `DocumentCheck` seam; the grammar (ProseKit) is the app's. |
| Version history, compare, restore | `VersionChain`, `Subtype` | C | C | C | P | P | C | Forum/social want a public "edited" marker and edit history visible to readers (Mastodon `edited_at`, StatusEdit; Discourse post revisions); the kernel gates history like a write (`READ-009`), so readers can't see it. |
| Optimistic concurrency, autosave | `VersionChain`, `WorkingCopy` | C | C | C | · | · | C | |
| Suggested edits / review | `Proposals` | C | C | C | P | · | C | Forum wikis (Discourse TL3 "make wiki") are a different model: community-editable posts, not proposals. |
| Editorial workflow status (draft → pending review → ready → published) | `Publication`, `Proposals` | P | P | P | · | · | P | `draft` and the live pointer exist; WordPress's `pending` status and a newsroom's multi-stage desk workflow (assign, edit, copy, legal) do not. |
| Scheduled publishing | `Subtype` (`publication`), `Publication.duePublications` | C | C | C | · | P | C | Publication facts with a future `at`. Mastodon's ScheduledStatus is the same need for social. |
| Embargo (published at T, not discoverable / not syndicated before T; or held from a partner) | `Publication` | · | P | · | · | · | P | A future `publish` covers "not visible before T". Separate embargo semantics (visible to named partners or wire subscribers early; a hard "do not publish before" guard on the editor's own publish) are missing. |
| Unpublish, discard draft, preview link | `Subtype` (`publication`, `preview`) | C | C | C | · | · | C | Preview token signing is the app's. |
| Soft delete / restore | `VersionChain`, `Subtype` | C | C | C | C | C | C | |
| Hard erasure, account erasure | `Purge`, `Erasure` | C | C | C | C | C | C | |
| Localisation, fallback reads | `Subtype` (locale level), `Pages`, `Translation` | C | C | C | P | P | C | Forum/social posts carry a *language* (Mastodon `language`), not a set of translations; the leaf can store it as a column but nothing filters a timeline by it. |
| Machine translation lineage | `Translation` | C | C | C | · | · | C | |
| External import / reconcile | `ReferenceImport` | P | P | P | · | · | P | Reference leaves only. WordPress import, wire-service ingest (news) and product feeds from a commerce backend need owned-leaf or other-backend import (#414). |

### Access, accounts and sites

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Visibility: public / followers / group / private | `Content`, `Subtype`, `Social`, `Audience` | C | C | C | C | P | C | Mastodon's four levels are `public`, `unlisted`, `private` (followers), `direct`. `unlisted` (readable, kept out of public timelines and discovery) and `direct` (the mentioned accounts only) have no kernel state. Discourse also has unlisted topics. |
| Roles and capability rungs | `Subtype` (`AccessPolicy`), effect-auth | P | P | P | P | P | P | Four rungs over an app-named role ladder. No shipped roles (author / editor / admin; Discourse moderator, category moderator) and no per-section or per-category roles. Profiles and roles are #424. |
| Graduated trust (rights earned by activity) | `Budgets` | · | · | · | M | P | · | Discourse trust levels gate links, images, flags, editing others' titles. The kernel has write budgets per account, not trust levels. |
| Profiles (public author/account pages) | none | M | M | P | M | M | · | `Relations` bylines read "the app's profile leaf"; there is no profile module (#424). |
| Member tiers and paid gating | none | M | M | · | · | · | P | Ghost: `public`, `members`, `paid`, specific tiers per post; newsletters per member. The kernel's `group` visibility can stand in for one tier, but "tier X or higher" and a paywall preview (excerpt to non-members) are missing; payments are out of scope. Ecom needs "members-only" or wholesale content at most. |
| Password-protected content | none | P | · | P | · | · | · | WordPress `post_password`. The preview grant is per node and signed; there is no reader-supplied secret. |
| Multi-site (many sites, one install) | none | M | M | M | M | M | M | WordPress Multisite: per-site content, shared users, path- or domain-based sites, domain mapping. Arc XP: one story circulated to several websites and sections. The kernel has no site key on nodes, paths, caches, discovery or search, so path claims and sitemaps are install-wide. #425. |
| Federation-ready identities (remote accounts, remote content) | none | · | · | · | P | M | · | Owned rows name a local owner id; nothing represents a remote actor or an object URI (Mastodon `uri`). #418. |

### Structure, routing and pages

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Categories, tags, hierarchies | `Edges` (taxonomies recipe) | C | C | C | C | P | C | Social hashtags are extracted from text and created by anyone, which the corpus-written term leaf doesn't model (no "tag from document" extractor, unlike `MentionExtractor`). |
| Term counts, include/exclude filters | `Edges` (`countBy`, `memberFilter`) | C | C | C | C | C | C | |
| Routable paths, aliases, redirects | `Paths` | C | C | C | C | P | C | Social URLs are `/@handle/id`, not claimed slugs. Free-form redirect rules are the site's. Paths are install-wide (see multi-site). |
| Standalone pages | `Pages` | C | C | C | C | · | C | |
| Navigation menus | `Links`, `Collections` | C | C | C | C | · | C | |
| Page and block model (sections, reusable blocks, layouts) | none | P | P | M | · | · | M | "There is no page builder" (`docs/structure.md`). Marketing landing pages and product pages are block compositions (Webflow, WordPress blocks). #423, #417. |
| Ordered collections (curated lists, albums, front-page slots) | `Collections` | C | C | C | · | P | C | Bounded at 1000 members. A news front page's slots/zones (Arc XP's WebSked/collections) fit; Mastodon "featured" profile posts fit. |
| Sticky / pinned / featured | `Collections` (as a recipe) | P | P | · | P | P | P | WordPress `sticky_posts`, Discourse pinned topics (global or per category, per-user dismissal), Mastodon profile pins. A collection can hold the pins; there's no pin flag, pin expiry or per-viewer dismissal. |
| Multiple bylines / co-authors | `Relations` (bylines), `Collections` | C | C | · | · | · | · | Credit only; no co-author write rights. Contributor roles (photographer, editor) are columns the app adds. |
| Series / related content | `Edges`, `Collections` | C | C | C | · | · | C | |
| Reference fields between types (Webflow reference / multi-reference) | `Edges` | C | C | C | C | C | C | |

### Participation

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Comments, threaded, moderated | `Comments`, `Moderation` | C | C | · | P | P | P | Depth-bounded replies to a target. A forum reply and a social reply are first-class posts of their own (Mastodon `in_reply_to_id`), which `Comments` doesn't make them. #422. Product reviews (Ecom) are comments with a rating. |
| Forum topics: closed (locked), archived, unlisted, pinned, slow mode, auto-close timers | none | · | · | · | M | P | · | Discourse topic states. Comment-level "replies off" on a post (Bluesky threadgate, closing comments in WordPress) is the same lock, so it is partial for Social and Blog. |
| Reply controls (who may reply: mentioned, followers, following, a list) | `Social` (`interactionAllowed`) | · | · | · | · | M | · | Bluesky threadgate's four rules; Mastodon quote approval. Only the block check exists. |
| Accepted answers | `Relations` (`acceptedAnswerGate`) | · | · | · | C | · | P | Ecom product Q&A. |
| Reactions / likes | `Reactions` | C | C | · | C | C | C | One reaction per account per node. |
| Reshares / boosts / quotes | `Relations` (`defineReshares`) | · | · | · | P | P | · | Boost is a reshare edge; a quote post (Mastodon `quote`, Bluesky embed) is a post with its own body plus a target. Reshares in a timeline need the timeline (below). |
| Bookmarks / saved items | none | · | · | · | M | M | P | Mastodon `bookmarked`, Discourse bookmarks with reminders; Ecom wishlists (content side). A private edge family could do it; no recipe. |
| Polls | none | · | P | · | M | M | · | Mastodon Poll, Discourse polls. |
| Content warnings, sensitive media | none | · | · | · | P | M | · | Mastodon `spoiler_text` and `sensitive`; Bluesky self-labels. Columns an app could add; nothing reads them. |
| Labels (third-party moderation labels, hide/warn per label) | `Moderation` (classifier grading) | · | · | · | P | M | · | Bluesky labels and labelers. The kernel grades a classifier and holds a single moderation state, not a set of labels with viewer-chosen handling. |
| Flags / reports, review queue | `Moderation` | C | C | · | C | C | P | Discourse "flags hide at threshold" is the documented recipe. |
| Spam throttle | `Budgets` | C | C | P | C | C | P | Captcha and spam scoring are the app's. Marketing forms need it too. |
| Mentions and notifications | `Notifications` | C | C | · | C | C | · | Delivery transports are the app's. |
| Follow / mute / block | `Social` | P | · | · | C | C | · | Follow requests (locked accounts) are "a later slice". Following a *tag* or *category* (Discourse watching a category, Ghost per-newsletter) isn't modelled. |
| Topic/thread subscription and watching levels | none | · | · | · | M | P | · | Discourse watching / tracking / normal / muted per topic and category. Mastodon "mute conversation". |
| Unread / read tracking | none | · | · | · | M | P | · | Discourse's unread and new lists, last read post per topic. The notifications inbox has unread state for notifications only. |
| Groups, private spaces | `Audience` | · | · | · | C | C | · | Discourse groups and restricted categories map to `group` visibility. |
| Direct / private messages | none | · | · | · | M | M | · | Discourse personal messages, Mastodon `direct`. A `group` row or a private leaf with recipients could carry one; no recipient-list visibility. |
| Home timeline (posts from followed accounts, reshares mixed in) | `Subtype` (`FollowerSeam`), `Filter`, `Social.silencedFilter` | · | · | · | · | P | · | `isIn(followed)` gives a following-only list over one leaf; a merged, multi-leaf timeline with reshares and keyset paging is the app's. |
| Newsletters, email to subscribers | `Notifications` (delivery seam) | P | P | P | P | · | · | Ghost sends posts as newsletters with per-newsletter subscription. Notifications fan out events to recipients; there's no "send this post to list X" broadcast or subscriber list. |
| Forms and lead capture (form definitions, submissions) | none | · | · | M | · | · | P | Webflow forms; contact and quote-request forms. A submission is write-only UGC from anonymous visitors, which no owned leaf allows (creates need an account). |

### Media, search, discovery and delivery

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Uploads, file leaves, alt text, captions, licence | `Blobs`, `Media` | C | C | C | C | C | C | |
| Image renditions, responsive sizes | `Media` (`defineRenditions`) | C | C | C | C | C | C | Transform is the app's. |
| Galleries, albums | `Media` (`defineAlbum`) | C | C | C | · | C | C | Product image galleries. |
| Video / audio (podcasts, embeds, link cards) | `Media` (metadata only) | P | P | P | · | P | P | Streaming is the app's. Link previews (Mastodon `card`) and oEmbed embeds are missing. |
| Full-text and semantic search | `Search`, `Subtype` (search scope) | C | C | C | C | C | P | Ecom search wants facets (counts per attribute value); `countBy` covers taxonomy facets only. |
| RSS/Atom/JSON feeds, sitemap | `Discovery` | C | P | C | C | P | C | News needs the Google News sitemap (`news:publication_date`, `news:title`, only articles from the last two days, ≤1000 per file); the discovery metadata lacks a publication name and language field for it. Social wants per-account feeds; feasible as a filtered family. |
| SEO metadata (title, description, OG image, canonical, noindex) | `Discovery` (`DiscoveryMetadata`) | P | P | P | P | · | P | `DiscoveryMetadata` projects title, summary, image, schema.org type and dates. No editable SEO overrides, canonical-URL override, `noindex`, or per-locale `hreflang` alternates. |
| Structured data types (NewsArticle, LiveBlogPosting, Product) | `Discovery` (`schemaType`) | C | P | C | C | · | P | A schema.org type string per family. News properties (`dateline`, `correction`, `backstory`) and Product properties come from the app's resource. |
| Resource cache, CDN purge hints | `Cache`, `Discovery.purgeHintHook` | C | P | C | C | C | C | News scale (#412) asks for front-page and listing invalidation; purge hints carry `discovery:<type>` and `node:` tags but no tag per collection, term or path, so a front page built from a collection isn't purged when a member changes. |
| WordPress-compatible read API | `pulpit-wordpress` | C | C | C | · | · | · | Phase 1 landed (posts, pages, media); categories, tags and users are phase 2. |

### Kind-specific content

| Capability | Module | Blog | News | Mkt | Forum | Social | Ecom | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Live blog (a story with a stream of timestamped updates, pinned key update) | `Collections`, `Edges` | · | M | · | · | · | · | Arc XP and schema.org `LiveBlogPosting` / `liveBlogUpdate`. Recipe-able as child leaves plus a collection, but nothing pushes updates or orders them as a stream. |
| Corrections and update notes (append-only, public) | `VersionChain` | P | P | · | · | · | · | Every edit is a version, but readers can't see history, and a correction is an editorial note with its own date, not a diff. |
| Article kinds (news, opinion, analysis, sponsored) | `Edges` (taxonomy) | · | C | · | · | · | · | schema.org NewsArticle subtypes; `AdvertiserContentArticle` should drive a disclosure label. |
| Wire and syndication (ingest from agencies, syndicate out) | `ReferenceImport` | · | P | · | · | · | · | Reference leaves only; see import above. |
| Business info (address, hours, contact, locations) | none | · | · | P | · | · | P | A reference leaf the app declares; no recipe, no `LocalBusiness` mapping. |
| Testimonials, team, services, FAQs | `Subtype`, `Collections` | · | · | C | · | · | C | Plain leaves plus collections. |
| Product content (title, description, media, options, variant content, specs) | `Subtype`, `Media`, `Edges` | · | · | · | · | · | P | Shopify: variants are combinations of option values, publication per sales channel, metafields. Leaves, galleries and taxonomies cover the static parts; options × variants and per-channel publication are missing. Price, stock and orders stay outside (out of scope). |
| Product catalogue, smart collections (rule-based membership) | `Collections`, `Edges`, `Filter` | · | · | · | · | · | P | Manual collections fit `Collections`. Shopify's smart collections (membership by rule over fields or metafields) are a saved `ListFilter`, which the kernel doesn't persist. |
| Commerce-system link (external product id, sync of transactional facts for display) | `ReferenceImport` (external ids) | · | · | · | · | · | P | `ExternalIdStore` links an external id to a node; read-through display of price or stock from the commerce system has no seam. |

## The gaps

Ordered by how many kinds each blocks and how central it is.

1. **Multi-site boundary** (all six kinds; #425). No site key on nodes, paths, caches, discovery, search or menus. Path claims and sitemaps are install-wide, so two sites can't both have `/about`. Needs: a site scope threaded through `Paths`, `Discovery`, `Cache`, `Search` and the registry, shared or per-site accounts (WordPress shares users across a network), and optional cross-site circulation (Arc XP).
2. **Profiles and roles** (all kinds; #424). Author pages, member profiles, account display, shipped default roles (author/editor/admin, moderator), and scoped roles (per category or section).
3. **Page and block model with SEO fields** (Blog, News, Mkt, Ecom; #423, #417). No blocks, layouts or reusable sections; no editable SEO overrides (meta description, OG image, canonical, `noindex`, `hreflang`).
4. **A shared post model for replies, topics and social posts** (Forum, Social; #422). `Comments` makes a reply subordinate to a target. Forums and social need replies as first-class posts, plus topic state (closed, archived, unlisted, pinned, slow mode, timers) and reply controls (Bluesky threadgate).
5. **Per-viewer reading state**: unread tracking, topic and category watching levels, bookmarks (Forum, Social). Nothing in the kernel keeps per-account, per-node read state other than the notification inbox.
6. **Social post semantics**: `unlisted` and `direct` visibility, quote posts, polls, content warnings and labels, hashtags from text, a merged home timeline, follow requests, DMs (Social; partly Forum). Plus federation-ready identities (#418).
7. **Member tiers, paid gating and newsletters** (Blog, News). Ghost's `public / members / paid / tier` visibility, a paywall excerpt, and sending a post to a subscriber list. Payments stay out.
8. **News editorial**: a workflow status beyond draft (pending review, desk stages), embargo beyond a scheduled publish, public corrections, live blogs, Google News sitemap fields, and purge tags for front-page collections and terms (News).
9. **Anonymous submissions (forms and lead capture)** (Mkt, Ecom). Every write needs an account; a contact form is an anonymous write-only submission with a throttle and spam check.
10. **Product content**: options and variants, per-channel publication, rule-based (smart) collections as saved filters, attribute facets, and a read-through seam for commerce facts shown beside content (Ecom).

Smaller gaps: password-protected posts, link cards and oEmbed, `LocalBusiness` and business-info recipes, wire ingest into owned leaves, public edit markers.

## What is already strong

Worth saying because it bounds the work: a personal blog is close to fully covered (missing only profiles, SEO overrides, tiers and newsletters); a marketing site's gaps are concentrated in the page/block model, SEO fields and forms; a forum's in topic state and reading state; social is the furthest away, since it needs its own post model, timelines and visibility levels.

## Sources

Kernel (primary, this repo at `trunk`):

- `docs/README.md`, `docs/content-model.md`, `docs/read-model.md`, `docs/history-and-review.md`, `docs/structure.md`, `docs/participation.md`, `docs/media.md`, `docs/discovery-and-search.md`, `docs/erasure.md`, `docs/wordpress.md`, `docs/seams.md`.
- `packages/pulpit/src/Content.ts` (four visibility states, "the kernel is multi-tenant"), `packages/pulpit/src/Registry.ts`.
- Issues #412 (map and standing decisions), #413, and the open map tickets #414–#425 named above.

Reference products (public documentation):

- WordPress post statuses: <https://wordpress.org/documentation/article/post-status/>
- WordPress sticky posts: <https://developer.wordpress.org/themes/functionality/sticky-posts/>
- WordPress Multisite: <https://developer.wordpress.org/advanced-administration/multisite/>; domain mapping: <https://developer.wordpress.org/advanced-administration/multisite/domain-mapping/>
- Ghost members: <https://docs.ghost.org/members>; members in themes (visibility, tiers, newsletters): <https://docs.ghost.org/themes/members>; tiers: <https://ghost.org/help/tiers>
- Discourse closed, unlisted and archived topics: <https://meta.discourse.org/t/understanding-closed-unlisted-and-archived-topics/51238>; trust levels: <https://meta.discourse.org/t/trust-level-permissions-reference/224824>
- Mastodon Status entity: <https://docs.joinmastodon.org/entities/Status/>; ScheduledStatus: <https://docs.joinmastodon.org/entities/ScheduledStatus/>; Poll: <https://docs.joinmastodon.org/entities/Poll/>
- Bluesky labels and moderation: <https://docs.bsky.app/docs/advanced-guides/moderation>; thread gates: <https://bsky.network/docs/about-bluesky-content/thread-gates>
- Google News sitemaps: <https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap>
- schema.org news types: <https://schema.org/docs/news.html>; `LiveBlogPosting`: <https://schema.org/LiveBlogPosting>
- Arc XP live blogging and circulation (page titles only; the article bodies did not render): <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/implementing-live-blogging-in-arc-xp.html>, <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/how-arc-xp-handles-uncirculated-stories.html>
- Webflow multi-reference fields: <https://help.webflow.com/hc/en-us/articles/33961260360083>
- Shopify variants: <https://help.shopify.com/en/manual/products/variants>; smart collections with metafields: <https://help.shopify.com/en/manual/custom-data/metafields/smart-collections>

Claims not drawn from a fetched page: WordPress `post_password` and the `sticky_posts` option (well-known WordPress core behaviour; the post-status page doesn't cover them); Discourse pinning, bookmarks, watching levels and personal messages (Discourse product behaviour; the pages fetched cover topic states and trust levels only); Webflow forms and SEO settings (product behaviour; the fetched page covers reference fields only).
