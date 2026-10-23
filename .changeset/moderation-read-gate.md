---
"@thomasfosterau/pulpit": minor
---

An owned leaf can opt into the moderation read gate (pulpit#154). The owned `LeafAccess` gains `moderationColumn: Option<string>` (`ownedAccess({ moderation: true })` names `moderationState`). When it is declared, `get` / `getMany` / `list` show a row whose state isn't exactly `approved` only to its owner and the view-private rung, as they do a draft. `canViewOwnedRow` and `ownedListFilter` carry the arm together. `OwnedFacts` gains `unapproved` (`false` for a leaf without the axis). An owned access declaration written as a literal must now name `moderationColumn` (`Option.none()` keeps today's reads).
