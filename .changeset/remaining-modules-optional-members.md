---
"@thomasfosterau/pulpit": minor
---

**Breaking:** the remaining kernel modules spell their optional members as bare `?: T` (pulpit#238). Each was `?: T | undefined`. Under `exactOptionalPropertyTypes` an explicit `undefined` no longer type-checks, so a caller with no value omits the key. The values and their defaults are unchanged, and every reader treats an absent key as before.

- `./budgets`: `WriteBudget.exempt`.
- `./collections`: `CollectionDefinition.mode`.
- `./comments`: `CommentsDefinition.maxDepth` and `CommentListRequest.orderBy`.
- `./discovery`: `DiscoveryCursor.locale`, `DiscoveryRequest.after` and `locale`, and `DiscoveryDefinition.serveable`.
- `./erasure`: `ErasureFamily.accountColumns` and `cache`; `AccountErasureDefinition`'s `blobs`, `proposals`, `reports`, `reactions`, `social`, `workingCopies`, `memberships`, `relations` and `batchSize`; and `AccountErasureOps.erase`'s `maxBatches` option.
- `./moderation`: `defineReports`' `budget`.
- `./proposals`: `ProposalsDefinition`'s `forbidden`, `localeAttributes` and `budget`; `ProposalOps.submit`'s `locales`; and `validateProposalPatch`'s `locales` and `localeAttributes` options.
- `./purge`: `PurgeDefinition`'s `blobs` and `cache`.
- `./social`: `SocialDefinition.accounts`.
- `./testing`: `makeInMemoryPurgeStore`'s `documents`, `documentColumns`, `blobColumns` and `dependents`.

`./audience`'s `addMember` and `invite` keep their `role?: MembershipRole` parameter; only the implementation's default changed spelling.
