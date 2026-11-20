---
"@thomasfosterau/pulpit": minor
---

Every subpath is now the module's PascalCase name, matching its namespace on the root barrel (`@thomasfosterau/pulpit/version-chain` is now `@thomasfosterau/pulpit/VersionChain`, `./publication` is `./Publication`, and so on). The lowercase subpaths are gone: rename each import's specifier to the namespace's name. `./testing` is unchanged.
