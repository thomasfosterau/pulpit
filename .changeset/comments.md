---
"@thomasfosterau/pulpit": minor
---

Add `./comments` (and the `Comments` namespace): the comments family (pulpit#50).

- `defineComments({ comments, leaves, targets, viewer, policy, moderation, authorColumn, maxDepth? })` wraps a comment leaf (a versioned owned leaf with `./moderation`'s `moderationHook`) with `create`, `get` and `listByTarget`.
- A comment reads only through three gates: its own leaf's `get`, the moderation gate (`canViewModerated` / `moderationListFilter`: an unapproved comment reads only to its author and the moderate rung), and the target leaf's own `get` (a comment on a target the viewer can't read is `NodeNotFound`).
- Reply depth is `maxDepth` (default `1`; `0` flat); a reply past it fails `CommentDepthExceeded`, and a malformed `maxDepth` throws `CommentDeclarationError`.
