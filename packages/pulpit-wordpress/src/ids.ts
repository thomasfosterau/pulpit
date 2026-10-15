/**
 * **WordPress ids** — the `IdCodec` seam that maps pulpit node ids (opaque
 * strings, UUIDs in both applications) to the positive integers WordPress
 * clients expect, and the two id modes the adapter reads through: integer ids
 * over an application's codec ({@link integerIds}) and the opt-in string-id
 * passthrough ({@link stringIds}). pulpit never mints or stores the integer;
 * the application fills {@link IdCodec}, typically from a `bigserial` column
 * beside its node table (package README → Seams).
 *
 * Both modes work in batches. One `encode` maps every node id in a response,
 * one `decode` every wire id in an `include` / `exclude` list or a `{id}`
 * path segment, so the codec is read once per call, never once per id
 * (`PERF-DB-001`). Each answers per input, in input order, duplicates
 * included.
 *
 * A wire id that names no node decodes to `Option.none()`, whether the codec
 * doesn't know it or it is no WordPress id at all (`0`, `-1`, `1.5`, `abc`, an
 * integer above `Number.MAX_SAFE_INTEGER`): the adapter answers it exactly as
 * it answers a hidden or missing row, so the codec can't tell a caller
 * anything the read gate wouldn't (`SEC-AUTH-ENUM-001`).
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";
 * import { makeInMemoryIdCodec } from "@thomasfosterau/pulpit-wordpress/testing";
 *
 * const codec = makeInMemoryIdCodec(["node-a", "node-b"]);
 * const ids = integerIds(codec);
 *
 * deepStrictEqual(Effect.runSync(ids.encode(["node-b", "node-a", "node-b"])), [2, 1, 2]);
 * deepStrictEqual(Effect.runSync(ids.decode(["1", "7", "0"])), [
 *   Option.some("node-a"),
 *   Option.none(),
 *   Option.none(),
 * ]);
 * ```
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress/ids
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The id codec an application supplies: two batch lookups between pulpit node
 * ids and positive WordPress integers, typically one `= ANY($ids)` read each
 * against a `bigserial` column beside the node table. `E` is the codec's own
 * failure and `R` its requirements (a Drizzle codec's query error and its
 * database service).
 *
 * Each method is one read for the whole batch and answers a `HashMap` keyed by
 * its input (as the kernel's `DocumentStore.getMany` does): an id the codec
 * doesn't know is absent from the map, never a failure.
 * It applies no policy and validates nothing; the adapter reaches it only
 * through {@link integerIds}, which hands `decode` only positive safe
 * integers, deduplicated, and never calls either method with an empty batch.
 * The integer must be stable for the life of the node, and unique across every
 * node the adapter serves.
 *
 * @since 0.1.0
 */
export interface IdCodec<E, R> {
  /**
   * The integer of each node id it knows, keyed by node id. The adapter
   * encodes only an id the read gate has already let through.
   */
  readonly encode: (
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, number>, E, R>;
  /** The node id of each integer it knows, keyed by integer. */
  readonly decode: (
    integers: ReadonlyArray<number>,
  ) => Effect.Effect<HashMap.HashMap<number, string>, E, R>;
}

/**
 * An id as a WordPress client sends it: a path segment or a list item of a
 * query parameter (a string), or a number a caller has already parsed.
 *
 * @since 0.1.0
 */
export type WireId = number | string;

/**
 * The failure of {@link integerIds}' `encode` when the application's codec
 * breaks its contract for a node the adapter is about to serve: it has no
 * integer for the node (`unmapped`), or answers one that isn't a positive safe
 * integer (`invalid-integer`). The node is already readable, so this is an
 * application defect, never a hidden row; the adapter answers it as a server
 * error.
 *
 * @since 0.1.0
 */
export class UnencodableNodeId extends Schema.TaggedError<UnencodableNodeId>()(
  "UnencodableNodeId",
  {
    nodeId: Schema.String,
    reason: Schema.Literals(["unmapped", "invalid-integer"]),
  },
) {}

/**
 * The id mode the adapter reads and writes ids through, built by
 * {@link integerIds} or {@link stringIds}. `W` is the wire id it emits
 * (`number` or `string`), `E` its failure and `R` its requirements.
 *
 * @since 0.1.0
 */
export interface WireIds<W extends WireId, E, R> {
  /** Which mode this is: `integer` over a codec, or `string` passthrough. */
  readonly mode: "integer" | "string";
  /**
   * The wire id of each node id, in input order, duplicates included: one
   * codec read for the whole batch (none for an empty one). Fails with `E`
   * (the codec's failure) or, in integer mode, {@link UnencodableNodeId}.
   */
  readonly encode: (nodeIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<W>, E, R>;
  /**
   * The node id each wire id names, in input order, duplicates included, or
   * `Option.none()` for one that names no node (`SEC-AUTH-ENUM-001`): one
   * codec read for the whole batch, and none when no input is a valid id.
   * Fails only with the codec's `E`, never on a malformed input.
   */
  readonly decode: (
    wireIds: ReadonlyArray<WireId>,
  ) => Effect.Effect<ReadonlyArray<Option.Option<string>>, E, R>;
}

// ── Integer ids ───────────────────────────────────────────────────────

const decimalDigits = /^[0-9]+$/;

/**
 * Whether `value` is an id WordPress could have minted: a positive safe
 * integer.
 */
const isWordPressInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * A wire id as a WordPress integer, or none. A string must be decimal digits
 * only (WordPress's route pattern is `[\d]+`, and `absint` reads leading
 * zeros as decimal, so `007` is 7); a number must already be an integer.
 */
const toWordPressInteger = (wireId: WireId): Option.Option<number> => {
  const value = Predicate.isNumber(wireId)
    ? wireId
    : decimalDigits.test(wireId)
      ? Number(wireId)
      : Number.NaN;
  return isWordPressInteger(value) ? Option.some(value) : Option.none();
};

/**
 * Integer ids over the application's {@link IdCodec}: the adapter's default
 * mode. `encode` answers each node id's integer, failing with
 * {@link UnencodableNodeId} if the codec has none or answers a value that
 * isn't a positive safe integer. `decode` answers `Option.none()` for a wire
 * id that isn't a positive safe integer (`0`, a negative, a fraction, a
 * non-numeric string, one above `Number.MAX_SAFE_INTEGER`) without consulting
 * the codec, and for an integer the codec doesn't know: both answer as a
 * hidden row does (`SEC-AUTH-ENUM-001`), never as a bad request or a server
 * error. Each method reads the codec at most once per call, with the batch
 * deduplicated (`PERF-DB-001`).
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import { integerIds, type IdCodec } from "@thomasfosterau/pulpit-wordpress/ids";
 *
 * // An application codec over a `bigserial` column, here a fixed table.
 * const table: ReadonlyArray<readonly [string, number]> = [["3f0c…", 42]];
 * const codec: IdCodec<never, never> = {
 *   encode: (nodeIds) =>
 *     Effect.succeed(HashMap.fromIterable(table.filter(([id]) => nodeIds.includes(id)))),
 *   decode: (integers) =>
 *     Effect.succeed(
 *       HashMap.fromIterable(
 *         table.filter(([, n]) => integers.includes(n)).map(([id, n]) => [n, id] as const),
 *       ),
 *     ),
 * };
 *
 * const ids = integerIds(codec);
 * deepStrictEqual(Effect.runSync(ids.decode(["42", "43", "-42"])), [
 *   Option.some("3f0c…"),
 *   Option.none(),
 *   Option.none(),
 * ]);
 * ```
 *
 * @since 0.1.0
 */
export const integerIds = <E, R>(
  codec: IdCodec<E, R>,
): WireIds<number, E | UnencodableNodeId, R> => ({
  mode: "integer",
  encode: (nodeIds) =>
    Arr.isReadonlyArrayNonEmpty(nodeIds)
      ? Effect.flatMap(codec.encode(Arr.dedupe(nodeIds)), (found) =>
          Effect.forEach(
            nodeIds,
            (nodeId) =>
              Option.match(HashMap.get(found, nodeId), {
                onNone: () => Effect.fail(new UnencodableNodeId({ nodeId, reason: "unmapped" })),
                onSome: (integer) =>
                  isWordPressInteger(integer)
                    ? Effect.succeed(integer)
                    : Effect.fail(new UnencodableNodeId({ nodeId, reason: "invalid-integer" })),
              }),
            // Each step is a pure lookup in the one map already read.
            { concurrency: 1 },
          ),
        )
      : Effect.succeed([]),
  decode: (wireIds) => {
    const integers = wireIds.map(toWordPressInteger);
    const wanted = Arr.dedupe(Arr.getSomes(integers));
    if (!Arr.isReadonlyArrayNonEmpty(wanted)) {
      return Effect.succeed(integers.map(() => Option.none()));
    }
    return Effect.map(codec.decode(wanted), (found) =>
      integers.map(Option.flatMap((integer) => HashMap.get(found, integer))),
    );
  },
});

// ── String ids ────────────────────────────────────────────────────────

/**
 * The options of {@link stringIds}.
 *
 * @since 0.1.0
 */
export interface StringIdsOptions {
  /**
   * Whether a string could be a node id at all. A string it rejects decodes
   * to `Option.none()` and never reaches a store, so a malformed id is a 404
   * rather than a database error: an application whose node ids are a `uuid`
   * column passes a UUID test. Defaults to accepting any non-empty string.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; absent is the default test
  readonly isNodeId?: ((wireId: string) => boolean) | undefined;
}

/**
 * The opt-in string-id mode, for clients that tolerate string ids: node ids
 * pass through unchanged in both directions and no codec is read. `decode`
 * answers `Option.some` of each string `isNodeId` accepts, and
 * `Option.none()` for a number or a rejected string; whether the node exists
 * and is readable is the read gate's to answer, as for any id
 * (`SEC-AUTH-ENUM-001`). It never fails.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { stringIds } from "@thomasfosterau/pulpit-wordpress/ids";
 *
 * const ids = stringIds({ isNodeId: (id) => id.startsWith("node-") });
 * deepStrictEqual(Effect.runSync(ids.encode(["node-a"])), ["node-a"]);
 * deepStrictEqual(Effect.runSync(ids.decode(["node-a", "1", 1])), [
 *   Option.some("node-a"),
 *   Option.none(),
 *   Option.none(),
 * ]);
 * ```
 *
 * @since 0.1.0
 */
export const stringIds = (
  // oxlint-disable-next-line effect/prefer-option-over-null -- the optional-parameter form of the `?: T | undefined` convention (AGENTS.md → Conventions); absent is every default
  options?: StringIdsOptions | undefined,
): WireIds<string, never, never> => {
  const isNodeId = options?.isNodeId ?? Str.isNonEmpty;
  return {
    mode: "string",
    encode: (nodeIds) => Effect.succeed(Arr.copy(nodeIds)),
    decode: (wireIds) =>
      Effect.succeed(
        wireIds.map((wireId) =>
          Predicate.isString(wireId) && isNodeId(wireId) ? Option.some(wireId) : Option.none(),
        ),
      ),
  };
};
