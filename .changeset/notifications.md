---
"@thomasfosterau/pulpit": minor
---

Add `./notifications` (pulpit#197): an outbox of content events written in the triggering write's own transaction (`notificationHook` on a chain write, `emitting` around any other write), derivations for the kernel's kinds (`comment.replied`, `comment.moderated`, `content.flagged`, `proposal.decided`, `follow.created`, `mention.created`), a fan-out (`defineNotifications(…).sweep`) that checks each recipient against the subject leaf's own read, mute, block and their preferences, an inbox, and a delivery seam. `./testing` adds `makeInMemoryOutbox`, `makeInMemoryInbox`, `makeInMemoryPreferenceStore` and `makeInMemoryDelivery`.
