---
"@thomasfosterau/pulpit": patch
---

`./social`: a follow can no longer stand across a concurrent block. The block check now runs inside the follow's write: the new store methods `addFollow` and `addBlock` are atomic against each other under one lock on the account pair. With an `AccountVisibility` seam, the public `followers` / `following` lists answer a subject the viewer can't see as an account with no relationships, and their `total` (now an `Option`, in the new `RelatedPage`) is none instead of the store's count, which included hidden accounts.
