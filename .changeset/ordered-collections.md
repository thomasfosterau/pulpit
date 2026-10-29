---
"@thomasfosterau/pulpit": minor
---

Ordered collections (pulpit#193): a new `./collections` module (also the root's `Collections` namespace). `defineCollection` binds `list`, `append`, `move`, `remove` and `resync` over a `CollectionStore` seam, with the order kept beside the chain (`mutable`, the default) or versioned with the parent (`versioned`: each write appends a parent version recording the order in a declared column, and `resync` restores the store from the head after a `restoreVersion`). Reads pass the parent's read gate and omit a member the viewer can't read from the page and its total; writes pass the parent's write gate. A collection holds at most `MAX_COLLECTION_SIZE` members (`CollectionFull`); `AlreadyMember` and `NotMember` are the other failures. `./testing` adds `makeInMemoryCollectionStore`.
