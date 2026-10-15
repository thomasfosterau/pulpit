---
"@thomasfosterau/pulpit": patch
---

An owned row whose owner column holds no string (a `NULL`, an absent key, a value outside the type) now reads as having no owner in `defineSubtype`'s `get` / `getMany` and `./edges`' `canViewEndpoint`, instead of as the column's `String` form (`"null"`, `"undefined"`). No viewer is its owner and the follower seam is never asked about it, so it is visible only when `public` and not a draft, or to the view-private rung, exactly as `list` shows it. Before, a viewer whose id was `"null"` took the owner arm for a `NULL`-owned row, and a `followers` row asked the seam `isFollower(viewer, "null")`, which a SQL seam over a `uuid` column fails as a cast error. `canViewOwned` and `OwnedFacts` are unchanged.
