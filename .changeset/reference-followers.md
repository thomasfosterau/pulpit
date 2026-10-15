---
"@thomasfosterau/pulpit": minor
---

Reference leaves may carry `followers` visibility (pulpit#92). A reference `LeafAccess` takes an optional `followersOfColumn`: the view column holding the id of the account whose followers may read a `followers` row. With it, `get`, `getMany`, `list`, the reference write and history gates, and an edge end over the leaf (`canViewEndpoint` / `endpointFilter`) show a `followers` row to those followers, and to nobody else below the view-private rung; the account the column names gets no owner rights, and a value that is not a string names nobody and is never asked of the follower seam. Without it, a `followers` reference row stays hidden below the rung, as before. `referencePrivacyFilter` takes an optional fourth argument, `Option.some({ access, followers })`, for the followers arm; its three-argument form is unchanged.
