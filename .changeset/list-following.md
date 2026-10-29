---
"@thomasfosterau/pulpit": minor
---

Let a leaf's `list` take an edge family's `memberFilter` (pulpit#189). `ListRequest` gains a `Following` parameter (`ListRequest<Following = never>`, `where: ListFilter<Following>`), and `SubtypeOps` a fourth (`SubtypeOps<Resource, E, R, Following = never>`), which `defineSubtype` fills from its follower seam. The change only widens types, so existing code still compiles.
