# What do ActivityPub and the AT Protocol need from a data model?

Research for thomasfosterau/pulpit#418. Protocols stay out of scope. The question is what the shared participation model has to hold so that an application could later federate it without reshaping it. Each constraint gives the protocol rule behind it, then how Pulpit's current model (docs/participation.md, docs/history-and-review.md, docs/erasure.md, docs/structure.md, docs/content-model.md, docs/media.md) fits it or conflicts with it.

Legend: **Fits** means the model already holds it. **Gap** means something is missing but could be added without breaking anything. **Conflict** means a current rule works against it.

## Summary

The two protocols agree on four points:

1. **Identity is a stable opaque key, and names are mutable attributes.** In AP this is the actor id URI; in atproto it is the DID, while the handle is mutable.
2. **A node can originate elsewhere.** It then carries a remote id: an AP `id` URI, or an atproto `at://did/collection/rkey` plus a CID.
3. **A delete from the origin means removal, not a hidden tombstone that keeps the content.**
4. **Audience is fixed when content is delivered.** It is not re-evaluated when the content is read.

Pulpit already fits on content-addressing, on append-only versions with `(id, version)` references, on taxonomies, language maps, and reshares and quotes as nodes.

The main conflicts are:

- Remote deletes have to purge rather than tombstone.
- Erasure's `anonymise` and `reassign` dispositions keep content, but a federated delete has to retract it.
- `followers` visibility is checked at read time, but delivery fixes it.
- Comments are a separate family capped by `maxDepth`, while protocol replies are ordinary posts with unbounded depth.
- Following is immediate, with no pending Follow/Accept state.
- There is no `unlisted` or `direct` visibility.
- Pulpit has no consent policies for quotes or replies (FEP-044f, postgate, threadgate).

## Constraints

### Identity

**C1. An account has a stable, opaque, protocol-independent key. Handles and usernames are mutable attributes, never keys.**
- atproto: "Handles are mutable and human-friendly account usernames"; DIDs are the long-term persistent identifiers [handle]. AT URIs built on a handle "become invalid" when the handle changes, so references should use the DID [at-uri]. A handle must be lowercased before it is stored [handle].
- AP: an actor's `id` is its global identifier (3.1). Mastodon looks up `preferredUsername` through WebFinger: it must be unique per domain and match an `acct:` URI [mastodon].
- Pulpit: **Fits.** `Viewer = Option<{ id, role }>` keys everything (owner records, `(node, account)` reactions, `(kind, from, to)` relationships) on an account id. The account row and its username belong to the application. Keep it that way: a mention, follow or block must store the account id, never a handle (C11).

**C2. An account can be remote, and the model must not assume that every account can sign in or holds a role.**
- AP: actors live on other servers and are identified by URI (3.1, 4.1). atproto: the DID identifies an account hosted on any PDS [did].
- Pulpit: **Gap.** Reactions, follows, memberships and the notification outbox all key on an account id, which a remote actor can fill if the application mints one. Nothing marks an account as remote, so the gates (`canModerate`, budgets) and notification delivery cannot tell that such an account is never a local viewer. A remote actor needs an identity row of its own, in a remote-account table owned by the application, holding the actor URI or DID. The kernel only needs these rows to be valid as account ids.

**C3. An account can move. An alias or "moved to" link belongs to the account, not to its content.**
- AP/Mastodon: `Move` with `object` set to the old account and `target` set to the new one. It is valid only if the new account's `alsoKnownAs` points back [mastodon].
- atproto: changing the DID document's `#atproto_pds` service moves an account between hosts without changing the DID [did][account]. `did:web` cannot migrate [did].
- Pulpit: **Gap**, and outside the kernel's tables. It stays the application's job. Following a Move rewrites `(follow, from, to)` rows to the new `to`, which `SocialStore` can do as an ordinary delete plus add.

### Object identity and origin

**C4. A node can originate elsewhere and carry a remote id. Within a family, one remote id names one node.**
- AP: objects "MUST have unique global identifiers" that are dereferenceable URIs under the origin's authority (3.1). The inbox MUST de-duplicate activities by `id` (5.2).
- atproto: a record is addressed as `at://<did>/<collection-nsid>/<rkey>` [at-uri]. The rkey is usually a TID, 1–512 ASCII characters, and case-sensitive [record-key].
- Pulpit: **Fits in principle.** `./ReferenceImport`'s `ExternalIdStore` already enforces "one `(authority, externalId)`, one node; at most one id per authority per node", and `create` accepts a caller id (`id: Option`). Remote ids must not become node ids, because an AP id is up to 8 KB and an atproto id is a tuple. Keep minting local ids and link the remote id through a store shaped like `ExternalIdStore`. Note that `ReferenceImport` is scoped to reference leaves and to a bot actor. Remote UGC belongs to an owned leaf whose owner is the remote account (C2), and the declaration currently rejects such a leaf.

**C5. The canonical id is stable and separate from the human URL.**
- AP: `id` identifies an object, and `url` points to "one or more representations" of it [as-vocab]. Mastodon uses `url` as the permalink [mastodon].
- Pulpit: **Fits.** `./Paths` keeps a canonical path plus aliases, and the path can change. A federation id must therefore derive from the node id, not from the path; the path is only `url`. The node id is never reused after a purge, because AP origins must not re-point an id.

**C6. A reference can be pinned to a version by content hash.**
- atproto: a plain AT URI "is not a strong reference" because the record can change. Replies (`root`, `parent`), likes, reposts and quotes (`embed.record`) all use `com.atproto.repo.strongRef` (`uri` + `cid`) [post][like][repost][embed-record][strongref].
- Pulpit: **Fits conceptually.** A node is `(id, version)`, and documents and blobs are addressed by SHA-256. The hashes are not atproto CIDs, though. Pulpit hashes the canonical text of a Postgres `jsonb` value [seams], while a CID is CIDv1 over DRISL-CBOR [data-model], so a CID cannot be derived from a Pulpit hash. Store a remote CID as an opaque attribute next to the remote id. Do not try to derive one. Blob bytes are the exception: an atproto blob CID uses the `raw` codec with SHA-256, so Pulpit's `contentHash` of the same bytes is the same digest [data-model][media]. That property is worth keeping.

**C7. A remote object's authority is its origin, and only the origin may change it.**
- AP: a server-to-server Update MUST be authorised, "at minimum" by a same-origin check (7.3). Content from a non-origin server should not be trusted without verification (B.2).
- atproto: records are signed by the repo's key [repository].
- Pulpit: **Gap**, a projection rule. A remote node's versions are written only by its remote owner, through the import path, never by local `update` or proposals. Local moderation can still hide such a node, because the moderation state is a column of the version row.

### Edits

**C8. An edit replaces the whole object and is stamped with `updated`. Older revisions may not exist remotely.**
- AP: a server-to-server Update is a full replacement (7.3). Client-to-server Update is partial and top-level only, with `null` deleting a field (6.3.1). Mastodon (3.5+) treats an `Update` as an edit only when `updated` is present [mastodon].
- atproto: an update carries only the new value. A repo keeps current state only, and `prev` is "virtually always `null`" [repository]. The firehose `ops` carry `cid` and `prev` [sync].
- Pulpit: **Fits.** Every edit appends a version, and an incoming remote edit can append a version too. The local history of a remote node then starts at the version first seen, and `compare` only covers versions received. The tri-state `ChainPatch` (value, `null`, `undefined`) also maps onto C2S partial Update. Outbound, an edit is sent as the full head state.

### Deletes and erasure

**C9. A delete from the origin removes the content. Any marker that stays carries no content.**
- AP: on Delete the receiver "SHOULD remove its copy" and "MAY" keep a Tombstone (7.4). A Tombstone has `formerType` and `deleted` [as-vocab], and a request for it SHOULD return 410 Gone (6.4). Remote deletion "cannot be enforced".
- atproto: deletion leaves no "trace or tombstone of previous contents" [repository]. Mirrors should honour deletions "in a timely manner" [sync], and when an account is deleted, "content should be removed from the network" [account].
- Pulpit: **Conflict for remote nodes.** A Pulpit tombstone "hides a node and keeps every version of its content", and the view-deleted rung can still read it [erasure]. A remote Delete therefore has to go through `./Purge`. A content-free stub (id, `formerType`, `deleted`) can be kept so that replies and reshares point at a gone node, the way `ReshareTarget` already answers `Unavailable` [structure].

**C10. A local delete or erasure has to reach the objects that were federated.**
- Same rules as C9, applied outbound. A delete can only be propagated if the system knows where the object went.
- Pulpit: **Conflict.** Account erasure's `anonymise` (the default for comments) keeps the content without an owner, and `reassign` keeps content under the tombstone account [erasure]. Both work locally, but a federated comment then never gets retracted. A family that federates needs the `purge` disposition, or an erasure step that emits a Delete for every federated node the account wrote. Erasure already supports application `relations`, which is where an outbox of Deletes could go. A local tombstone on a federated node should also emit a Delete, which makes a `restore` a fresh Create to the remote side.

### Replies and threads

**C11. A reply is an ordinary post with `inReplyTo` (AP), or with `root` + `parent` (atproto), and threads have unbounded depth.**
- AP: `inReplyTo` identifies what an object responds to, and `replies` is a Collection [as-vocab]. Mastodon builds threads from `inReplyTo` and pre-fetches up to 5 same-server replies [mastodon].
- atproto: `reply` requires both `root` and `parent` as strongRefs [post].
- Pulpit: **Partial conflict.** A comment stores `targetType`, `targetId`, `parentId` and `depth`, and a reply past `maxDepth` (default 1) fails [participation]. There are three problems:
  - A remote reply nested deeper than `maxDepth` cannot be stored.
  - A reply from a remote server is itself a post, not a comment, so the comment/post split is a local presentation choice.
  - atproto requires a stored `root` as well as `parent`. Pulpit's `targetId` is effectively the root, which fits.

  Accepting a remote reply needs one of two things: an import that clamps depth (flattening to the deepest allowed parent), or an unbounded `maxDepth` on families that federate.

**C12. Reply and quote permissions are per-object policies stored with the object.**
- atproto: `threadgate` (whose rkey equals the root post's) allows replies from `mentionRule`, `followerRule`, `followingRule` or `listRule`. An empty list means no one may reply. It also keeps up to 300 `hiddenReplies` [threadgate]. `postgate` holds `embeddingRules` (`disableRule`) and `detachedEmbeddingUris` [postgate].
- AP: FEP-044f defines `interactionPolicy.canQuote` (automatic or manual approval) together with a `QuoteRequest` → `QuoteAuthorization` handshake. A post with no `canQuote` is not quotable [fedify]. Mastodon implements it and reduces policies to public, followers, following or nobody [mastodon]. GoToSocial's `canReply`, `canLike` and `canAnnounce` follow the same model [fedify].
- Pulpit: **Gap.** Comments are gated by readability of the target, by moderation and by `interactionAllowed` (block). No author-set reply or quote policy exists, and nothing records a "detached" quote. These policies are per-node data, and the gate predicates (mentioned, follower, following, group) already exist in `./Social` and `./Audience`.

### Shares and quotes

**C13. A boost or repost has its own identity and can be undone. A quote is a post that references another.**
- AP: `Announce` is an activity with its own id. The receiver SHOULD add it to the object's `shares` (7.11), and `Undo` reverses it (6.10). Mastodon reads quotes as FEP-044f `quote`, `quoteUri` or `_misskey_quote`, and keeps only the first [mastodon].
- atproto: `app.bsky.feed.repost` is a record (`subject`: strongRef, optional `via`). A quote is a post whose `embed` is `app.bsky.embed.record`, which can render as `viewNotFound`, `viewBlocked` or `viewDetached` [repost][embed-record].
- Pulpit: **Fits.** `./Relations` reshares are a sharing node plus an edge with `maxEdges: 1`, and "a quote is the same family with a body". An unreadable or purged target already renders as `Unavailable` or as nothing [structure]. One gap: the `via` (repost-of-a-repost) chain is not modelled.

### Reactions

**C14. A like is unique per (actor, object), has its own id, and can be undone.**
- AP: a `Like` is added to the object's `likes` (7.10) and to the actor's `liked` (6.8), and `Undo` reverses it.
- atproto: `app.bsky.feed.like` has `subject` (strongRef), `createdAt` and optional `via`, with a TID key [like].
- Pulpit: **Fits, with two gaps.**
  - The `(node, account)` key with kind replacement fits a single Like. A non-"like" kind has no standard AP or atproto form, so only one declared kind maps to `Like`.
  - **Gap:** a reaction row has no id or remote id. An `Undo{Like}` or an atproto delete names the like record, so the import needs the remote id to find the row. This calls for an `ExternalIdStore`-like link for facts, not only for nodes.
  - `unreact` hard-deletes, which fits.

### Social graph

**C15. A follow can be pending until it is accepted.**
- AP: Follow → Accept/Reject. A follow joins `following` only after Accept (6.5, 7.5–7.7). Mastodon auto-accepts unless `manuallyApprovesFollowers` is set [mastodon].
- atproto: `app.bsky.graph.follow` (`subject`: DID) is unilateral, and duplicates are ignored [follow].
- Pulpit: **Gap.** "Following is immediate; follow requests are a later slice" [participation]. AP needs the pending state for both directions: an outgoing follow to a remote account is pending until its Accept arrives, and an incoming follow is pending when the local account locks. `./Audience` invitations are the same shape and could serve as the model.

**C16. Blocks can be public facts. Mutes are private.**
- atproto: `app.bsky.graph.block` is a repo record ("blocks are public in Bluesky") [block]. Mutes are not repo records. They are held privately by the AppView (`app.bsky.graph.muteActor` is a procedure, not a record; this file could not re-read that lexicon, see Gaps).
- AP: a Block SHOULD stop the blocked actor interacting and SHOULD NOT be delivered to them (6.9).
- Pulpit: **Fits.** Block and mute are `(kind, from, to)` facts, mutes are private, and a block suppresses interaction only [participation]. The model allows a block to be published without change, because publishing it is a projection concern.

### Addressing and audience

**C17. Audience is decided when content is delivered and recorded per object. It needs more states than public, followers and private.**
- AP: addressing is `to`, `cc`, `bto`, `bcc` and `audience`, set by the client (6.1). Collections are expanded at delivery (7.1). `bto` and `bcc` MUST be stripped before delivery. Mastodon derives visibility as follows [mastodon]:

  | Mastodon visibility | Addressing |
  | --- | --- |
  | `public` | `as:Public` in `to` |
  | `unlisted` | `as:Public` in `cc` |
  | followers-only (`private`) | the followers collection, without Public |
  | `limited` | named actors, at least one of them not mentioned |
  | `direct` | named actors, all of them mentioned |

- atproto: a repo stores "public records" only [repository], so non-public content cannot go there at all.
- Pulpit: **Conflict and gap.**
  - `Visibility` is `public | followers | private` (plus `group`) [content-model]. It has no `unlisted`, and no direct or limited form addressed to named accounts.
  - Pulpit decides `followers` at read time ("stops being the moment the follow ends") [participation]. A delivered followers-only post stays with every follower who received it. The model should record that delivery happened, either as the addressed set or as a "federated at version N to audience X" fact, and should treat a later narrowing as unenforceable remotely (as AP says of deletes).
  - Only `public` rows can go to atproto. `group` maps to AP addressing to member actors (or `bto`), and its membership changes cannot be recalled either.
  - Drafts, `pending` moderation and unpublished rows must never be delivered. The read gates already express these rules, so delivery should go through the same gate that serves an anonymous or follower read.

### Mentions, hashtags, rich text

**C18. A mention is an account reference (an actor URI or a DID) plus a text span, and in AP it also addresses the post.**
- AP: a `Mention` is a Link [as-vocab]. Mastodon requires mentioned actors to appear in `to` or `cc` to receive the post, and needs the `Mention` tag before it will notify [mastodon].
- atproto: the mention facet is `{ did }` on a byte slice, where `byteStart` is inclusive and `byteEnd` exclusive, counted in UTF-8 bytes rather than UTF-16 [facet].
- Pulpit: **Fits.** `MentionExtractor` turns a document into account ids, and the document grammar belongs to the application [participation]. Federation needs the extractor's output to map onto account ids that have remote identities (C2). The span offsets belong to the document grammar, so they stay outside the kernel. Mention fan-out already gates on readability and blocks.

**C19. A hashtag is a normalised string on the post, not necessarily a term node.**
- AP/Mastodon: a `Hashtag` tag (not in the core AS vocabulary), with names lowercased and ASCII-folded [mastodon].
- atproto: a tag facet, or up to 8 `tags` of at most 64 graphemes each, without the `#` [post][facet].
- Pulpit: **Fits.** A taxonomy is a reference leaf plus an edge family [structure]. Incoming tags have to be matched by normalised name, and may create terms (C4 import). The normalisation rule should be declared once.

### Language, warnings, media

**C20. Content can carry several languages and self-applied content warnings.**
- AP: `contentMap`, `nameMap` and `summaryMap` [as-vocab]. Mastodon uses `summary` as the content warning and `sensitive` [mastodon].
- atproto: `langs` (up to 3) and `labels` as self-labels, "effectively content warnings" [post].
- Pulpit: **Fits.** The locale level is a per-locale map [read-model]. A content warning or sensitivity flag is an application column. Note that `langs` labels one text, while a Pulpit locale is a translation; a single-language remote post is a node with one locale.

**C21. Media is referenced by content hash with a declared MIME type and size.**
- atproto: a blob has `ref` (raw CID), `mimeType` and `size` [data-model].
- AP/Mastodon: an `attachment` with `url`, `summary` (alt text) and `blurhash` [mastodon].
- Pulpit: **Fits.** Version rows carry `contentHash`, `byteSize` and `mediaType`, and SHA-256 matches (C6) [media]. A remote attachment can also stay a URL that has not been fetched, so a File leaf should be able to point at bytes held elsewhere (`bytesPending` comes close).

### Timestamps and data types

**C22. Keep the declared creation time apart from the receive time, and keep values within atproto's data model.**
- atproto: `createdAt` is "client-declared" [post]. The data model has no floats, and its integers are 64-bit, with 53 bits recommended [data-model].
- AP: `published` and `updated` [as-vocab].
- Pulpit: **Gap (minor).** `createdAt` and `updatedAt` are read-only timestamps the chain stamps. A remote node needs the origin's `published` time as a separate attribute, or the import has to be allowed to set it. A JSON float in a state column would not encode into atproto (which allows no floats), so a federating family should avoid floats.

## Gaps in this research

- Several lexicon and spec fetches failed, so some claims rest on documents this file did not re-read:
  - the full AS2 Section 5 notes;
  - FEP-044f on codeberg (robots-blocked; FEP-044f is cited via Fedify's documentation and Mastodon's);
  - `app.bsky.graph.muteActor`, behind the C16 mute claim.
- The AS2 `formerType` and `deleted` definitions are cited from the AS2 term index; the fetch only confirmed that both are Tombstone properties.
- The emoji reactions found in practice (Misskey `EmojiReact`, FEP-c0e0) were not researched.

## Sources

- [ap] W3C ActivityPub, https://www.w3.org/TR/activitypub/ (sections 3.1, 3.3, 4.1, 5.x, 6.1–6.10, 7.1–7.12, B.2)
- [as-vocab] W3C Activity Streams 2.0 Vocabulary, https://www.w3.org/TR/activitystreams-vocabulary/ (Tombstone, Mention, id/url, inReplyTo, replies, to/cc/bto/bcc, language maps)
- [mastodon] Mastodon, ActivityPub, https://docs.joinmastodon.org/spec/activitypub/
- [fedify] Fedify, Interaction controls (FEP-044f, GoToSocial policy model), https://fedify.dev/manual/interaction-controls
- [did] atproto DID, https://atproto.com/specs/did
- [handle] atproto Handle, https://atproto.com/specs/handle
- [at-uri] atproto AT URI Scheme, https://atproto.com/specs/at-uri-scheme
- [record-key] atproto Record Key, https://atproto.com/specs/record-key
- [repository] atproto Repository, https://atproto.com/specs/repository
- [data-model] atproto Data Model, https://atproto.com/specs/data-model
- [account] atproto Account Hosting, https://atproto.com/specs/account
- [sync] atproto Sync, https://atproto.com/specs/sync
- [post] [like] [repost] [follow] [block] [threadgate] [postgate] [embed-record] [facet] [strongref]: lexicons at https://github.com/bluesky-social/atproto/tree/main/lexicons (`app/bsky/feed/{post,like,repost,threadgate,postgate}.json`, `app/bsky/graph/{follow,block}.json`, `app/bsky/embed/record.json`, `app/bsky/richtext/facet.json`, `com/atproto/repo/strongRef.json`)
- Pulpit: `docs/participation.md`, `docs/history-and-review.md`, `docs/erasure.md`, `docs/structure.md` (Edges, Paths, Relations), `docs/content-model.md`, `docs/read-model.md`, `docs/media.md`, `docs/seams.md` at /home/claude/pulpit.
