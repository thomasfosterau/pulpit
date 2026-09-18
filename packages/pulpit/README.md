# `@thomasfosterau/pulpit`

The versioned-content kernel of an Effect headless CMS: the Content model fields and registry flags on `@thomasfosterau/effect-jsonapi`, the append-only node/version chain operations, the subtype operation factory with owned / reference-data access, and the publication, moderation and cache-serveability predicates.

[![CI](https://github.com/thomasfosterau/pulpit/actions/workflows/ci.yml/badge.svg)](https://github.com/thomasfosterau/pulpit/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@thomasfosterau/pulpit.svg)](https://www.npmjs.com/package/@thomasfosterau/pulpit) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Installation

```bash
npm install @thomasfosterau/pulpit effect @thomasfosterau/effect-jsonapi
```

`effect` (`>=4.0.0-rc.112`) and `@thomasfosterau/effect-jsonapi` (`>=0.14.0`) are peer dependencies, built against `effect@4.0.0-rc.115` and `@thomasfosterau/effect-jsonapi@0.14.0`. Node.js 22 or newer is required.

## Overview

The package is being extracted slice by slice from the `thomasfosterau/website` and `thomasfosterau/gardeneria` applications (the plan is [pulpit#1](https://github.com/thomasfosterau/pulpit/issues/1)). This release is the scaffold: an empty package whose toolchain, gates and release pipeline are in place. The subpaths below arrive with their slices.

| Subpath | Slice | Contents |
| --- | --- | --- |
| `./content` | pulpit#3 | The Content-axis field spreads (`visibility`, `draft`, timestamps, the tombstone), `ownerRef`, the base `content` resource. |
| `./registry` | pulpit#3 | The registry flag vocabulary (`owned` ⊕ `referenceData`, `pageable`, `agent`, `searchable`) and `validateRegistry`. |
| `./version-chain` | pulpit#4 | The append-only node/version chain operations over a store seam. |
| `./subtype` | pulpit#5 | `LeafAccess`, the read scope and viewer predicates, the write gates, `defineSubtype`. |
| `./publication` | pulpit#6 | The publication and moderation predicates and the cache serveability policy. |
