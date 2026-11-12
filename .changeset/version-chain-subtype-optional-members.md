---
"@thomasfosterau/pulpit": minor
---

**Breaking:** `./version-chain` and `./subtype` spell their optional members as bare `?: T` (pulpit#238). Each was `?: T | undefined`; under `exactOptionalPropertyTypes` an explicit `undefined` no longer type-checks, so a caller with no value omits the key. The values themselves are unchanged, and every reader treats an absent key as before. The tri-state patches (`ChainPatch`, `LocalePatch`, where `null` clears or drops and an `undefined` key carries forward) are wire contracts and unchanged.

`./version-chain`:

- `Precondition.expectedVersion` is `?: bigint`, and so is every `expectedVersion` built on it (`UpdateInput`, `./subtype`'s `RestoreRequest` / `UpdateRequest`, the handlers' and `delete` / `restoreVersion`'s precondition).
- `CreateInput.locales` and `VersionSnapshot.locales` are `?: LocaleStates`. `UpdateInput.locales` and `ChainAppendEvent.locales` are `?: LocalePatch`.
- `UpdateInput.proposedBy` is `?: Option.Option<string>` (was `?: Option.Option<string> | undefined`).
- `ChainHooks.beforeAppend` and `beforeAppendLocales` are `?: (event) => …`.

`./subtype`:

- `FollowerSeam.isMember` and `groups`, `ReadScope`'s member `groups`, and `OwnedFacts.groupId`.
- `LeafAccess`'s `followersOfColumn` and `groupColumn` (both kinds), and `ownedAccess`'s `draft`, `moderation` and `group` options (`?: boolean`).
- `SubtypeDefinition`'s `sortable`, `hooks`, `search`, `locales` and `publication`, and `PublicationDeclaration.preview`.
- `ListRequest.orderBy` and `OwnersRequest.among`.
- `CreateRequest.locales` and `RestoreRequest.locales`; `UpdateRequest.proposedBy` is `?: Option.Option<string>`.
- `PublishOptions.version` and `at`.
- `BeforeWriteHook.locales`, `LifecycleHooks.afterFailure` (`composeHooks` now omits the key when no set gives one), `defineSearchProjection`'s `languageColumn` and `SubtypeHandlersConfig.localised`.

`./testing`: `InMemoryLeafStoreOptions.localised` and `now`, and `ConformanceChain.dropState` and `raceNextAppend`. The conformance suite's expected-version case no longer passes an explicit `undefined`.
