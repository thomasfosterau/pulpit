# @thomasfosterau/pulpit-wordpress

A WordPress-compatible (`wp/v2`), read-only REST API over the chains of [`@thomasfosterau/pulpit`](../pulpit/README.md), so a headless WordPress frontend (one written against the WordPress REST API, such as `@wordpress/api-fetch` or a hand-rolled `fetch('/wp-json/wp/v2/posts?slug=…')`) can read posts, pages, media, terms and authors from a pulpit application unchanged.

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Status

**Not published.** The package is `"private": true` ([pulpit#115](https://github.com/thomasfosterau/pulpit/issues/115)). The API is specified on [pulpit#86](https://github.com/thomasfosterau/pulpit/issues/86) (the spec draft and the owner's decisions of 2026-10-15) and lands in phases:

- **Landed:** the `IdCodec` seam and the id modes ([`./ids`](#ids), [pulpit#114](https://github.com/thomasfosterau/pulpit/issues/114)), with an in-memory codec in [`./testing`](#testing). No endpoint serves them yet.
- **Phase 1:** posts, pages and media (list and get), the discovery index, `_links`, `_embed`, `_fields`, the headers and the errors. It waits for the kernel's list ordering ([pulpit#112](https://github.com/thomasfosterau/pulpit/issues/112)) and filter arms ([pulpit#113](https://github.com/thomasfosterau/pulpit/issues/113)).
- **Phase 2:** categories, tags and `/users`.
- **Phase 3:** each later kernel slice as it lands.

## Install

Once published:

```bash
pnpm add @thomasfosterau/pulpit-wordpress @thomasfosterau/pulpit effect
```

`@thomasfosterau/pulpit` and `effect` are required peer dependencies, and so are the kernel's own peers. Node.js 22 or newer is required.

## API

Every module is a namespace on the root export (`import { Ids } from "@thomasfosterau/pulpit-wordpress"`) and a subpath of its own, except `./testing`, which is a subpath only, as in the kernel.

| Subpath | Contents |
| --- | --- |
| `.` | Every module below as a namespace (`Ids`). |
| `./ids` | The `IdCodec` seam an application fills, the integer-id mode over it (`integerIds`) and the opt-in string-id mode (`stringIds`). |
| `./testing` | In-memory fakes of the adapter's seams (`makeInMemoryIdCodec`), for tests only. Not on the root export. |

## `./ids`

WordPress clients expect positive integer ids (the core route pattern is `(?P<id>[\d]+)`), and pulpit node ids are opaque strings. The adapter reads and writes ids through one of two modes:

- **`integerIds(codec)`**, the default: an application-filled [`IdCodec`](#idcodece-r-node-ids-to-wordpress-integers) maps node ids to integers and back.
- **`stringIds(options?)`**, opt-in, for clients that tolerate string ids: node ids pass through unchanged and no codec is read. `isNodeId` rejects a string that can't be a node id (a non-UUID, for a `uuid` column), so it decodes to none and never reaches a store as a malformed value. A throwing `isNodeId` is a defect of the effect, never a synchronous throw.

Both answer per input, in input order, duplicates included:

- `encode(nodeIds)` answers each node id's wire id. In integer mode it reads the codec once for the whole batch, deduplicated, and fails `UnencodableNodeId` if the codec has no integer for a node (`unmapped`), answers one that isn't a positive safe integer (`invalid-integer`), or answers one integer for two distinct node ids in the batch (`duplicate-integer`), each an application defect: the adapter encodes only nodes the read gate has let through.
- `decode(wireIds)` answers the node id each wire id names, or `Option.none()`. In integer mode a wire id that isn't a positive safe integer (`0`, a negative, a fraction, an exponent, a non-numeric string, one above `Number.MAX_SAFE_INTEGER`) is none without reaching the codec; a string must be decimal digits, and leading zeros read as decimal, as WordPress's `absint` reads them (`007` is 7). An integer the codec doesn't know is none too. `decode` fails only with the codec's own error (its error type is the codec's `E` alone), never on a malformed input.
- **A `decode` batch is capped at the kernel's `MAX_SET_VALUES`** (1000, duplicates counted; `SEC-INPUT-003`), the cap on the `= ANY($values)` set the decoded ids feed. Past it, every wire id decodes to none and the codec isn't read, failing closed as the kernel's `anyOf` does. That is closed for an `include` list or a path id, but not for `exclude`, where excluding nothing is open: the adapter must cap `include`, `exclude` and every other id list itself, before `decode` (to be enforced by pulpit#86, not built yet).

**Unknown, malformed and hidden ids answer alike (`SEC-AUTH-ENUM-001`).** Every none is answered exactly as a hidden or missing row is (`404 rest_post_invalid_id`), never as a `400` or a `500`, and a decoded id still goes through the kernel's read gate. Integer ids are guessable where UUIDs aren't, so this is what keeps them from confirming that a hidden node exists. The answer is the same; the timing is not: a malformed id skips the codec, an unknown one costs one codec read, and a hidden one a codec read and a store read. That is the same timing residue the kernel accepts between a missing and a hidden row.

```ts
import { deepStrictEqual } from "node:assert";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";
import { makeInMemoryIdCodec } from "@thomasfosterau/pulpit-wordpress/testing";

const ids = integerIds(makeInMemoryIdCodec(["node-a", "node-b"]));

deepStrictEqual(Effect.runSync(ids.encode(["node-b", "node-a", "node-b"])), [2, 1, 2]);
deepStrictEqual(Effect.runSync(ids.decode(["1", "7", "0", "1.5"])), [
  Option.some("node-a"),
  Option.none(), // unknown
  Option.none(), // not a WordPress id
  Option.none(),
]);
```

## `./testing`

In-memory fakes of the adapter's seams, for tests, mirroring the kernel's [`@thomasfosterau/pulpit/testing`](../pulpit/README.md#testing). Each implements its seam's contract under [Seams](#seams) and records its calls, so a test can pin how many reads a request made. **Not for production**; the subpath isn't on the root export.

| Export | Fakes | Test hooks |
| --- | --- | --- |
| `makeInMemoryIdCodec(nodeIds?)`, `InMemoryIdCodec` | [`IdCodec`](#idcodece-r-node-ids-to-wordpress-integers), minting 1, 2, … in assignment order, as a `bigserial` does. | `assign(nodeId)` (mint or look up), `encodeCalls()` / `decodeCalls()` (every batch, in call order). |

## Seams

The adapter is written against interfaces the application fills. Each states the shape its implementation must have; [`./testing`](#testing) has an in-memory fake of each, which implements the contract stated here.

### `IdCodec<E, R>`: node ids to WordPress integers

Filled by the application; pulpit never mints or stores the integer, and no library is expected to provide one.

```ts
interface IdCodec<E, R> {
  readonly encode: (
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, number>, E, R>;
  readonly decode: (
    integers: ReadonlyArray<number>,
  ) => Effect.Effect<HashMap.HashMap<number, string>, E, R>;
}
```

- **Suggested storage (the application's concern).** A `bigserial` column beside the node identity table (`core.node.wp_id bigserial UNIQUE`, or a table of its own keyed by node id), so each node gets an integer once, at insert. `encode` is one `id = ANY($nodeIds)` read and `decode` one `wp_id = ANY($integers)` read, each returning the rows found as a `HashMap` keyed by its input. A driver that reads `int8` / `bigint` as a string (node-postgres and postgres.js do by default) must convert it with `Number` before keying the `decode` map, and in the `encode` map's values: a `HashMap` keyed by `"42"` has no entry for `42`, so every id silently decodes to none and every request 404s. A `bigint` above `Number.MAX_SAFE_INTEGER` can't be served; `encode` fails `UnencodableNodeId` for it.
- **Method contract.** Each method is one read for the whole batch. An id the codec doesn't know is absent from the map, never a failure; `E` is the codec's own failure (its query error) and `R` its requirements. It applies no policy: the adapter encodes only nodes the read gate has let through, and passes every decoded id through the gate. `integerIds` hands it only non-empty, deduplicated batches, and `decode` only positive safe integers.
- **Stability.** A node's integer never changes and is never reused, and it is unique across every node type the adapter serves (WordPress clients cache by id, and `/posts/{id}` and `/pages/{id}` share one id space).
- **What it discloses.** A sequence reveals creation order and roughly how many nodes exist, to anyone holding two readable ids. An application for which that matters can fill the codec from a non-sequential integer instead, or serve `stringIds`.

## License

MIT
