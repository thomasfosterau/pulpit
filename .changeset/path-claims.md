---
"@thomasfosterau/pulpit": minor
---

Routable content: path claims tied to the chain, slug aliases and gated resolution (pulpit#57).

- The new `./paths` subpath (and the root barrel's `Paths` namespace) has `routable(ops, { column, paths, chain })`, which wraps a leaf's operations.
  - Each write keeps the root node's path claim in step with the state it landed at. A live state claims its path, and a path change leaves the old path as an alias that redirects. A tombstone, or a state with no path, frees the claim.
  - A restore re-claims its path, or fails the new `PathTaken` when another node took it.
  - `resolve(path)` answers `{ kind: "node" }` or `{ kind: "redirect" }` through the leaf's own read gate. A hidden node's path, or an alias to one, is the new `PathNotFound`, never a redirect (`SEC-AUTH-ENUM-001`).
- The `PathStore` seam (`lookup`, `canonicalOf`, `claim`, `release`) and its in-memory fake, `makeInMemoryPathStore` in `./testing`.
- `./registry`: the new `routable` flag, projected by `registryWireTypes`.
