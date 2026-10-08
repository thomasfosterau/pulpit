---
"@thomasfosterau/pulpit": patch
---

`defineSubtype`'s `get` and `getMany` no longer serve a row that its `list` hides (`SEC-AUTH-ENUM-001`). The row predicate now fails closed exactly where the list filter does:

- a reference row is visible only when the view has no `visibility` column, the viewer holds the view-private rung, or its `visibility` is exactly `public` (a `followers` or out-of-enum value was served by `get`);
- an owned row's draft is anything but an explicit `false` (a `NULL` draft was read as published);
- an owned leaf whose view lacks a declared column shows no row, as its list shows none.

`isPubliclyServeable` likewise refuses a present `draft` that isn't exactly `false` (`null` included), where it refused only `true`.
