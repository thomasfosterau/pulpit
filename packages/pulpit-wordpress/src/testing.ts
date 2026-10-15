/**
 * **In-memory fakes of the adapter's seams**, mirroring the kernel's
 * `@thomasfosterau/pulpit/testing`: the reference semantics of each seam's
 * contract in the package README → Seams, and the fakes the adapter's own
 * suites and an application's tests run against.
 *
 * **Not for production.** Each fake keeps its rows in a closure for the life
 * of the value and persists nothing. Each also records the batches it was
 * called with (`encodeCalls`, `decodeCalls`), a test hook a real codec has no
 * counterpart for, so a test can pin how many reads a request made.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { integerIds } from "@thomasfosterau/pulpit-wordpress/ids";
 * import { makeInMemoryIdCodec } from "@thomasfosterau/pulpit-wordpress/testing";
 *
 * const codec = makeInMemoryIdCodec(["node-a"]);
 * codec.assign("node-b");
 *
 * deepStrictEqual(Effect.runSync(integerIds(codec).encode(["node-a", "node-b", "node-a"])), [1, 2, 1]);
 * // One read for the whole batch, deduplicated.
 * deepStrictEqual(codec.encodeCalls(), [["node-a", "node-b"]]);
 * ```
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress/testing
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import type { IdCodec } from "./ids.ts";

/**
 * The in-memory {@link IdCodec}: an integer per node id, minted from 1 in the
 * order ids are assigned, as a `bigserial` column mints them. Its methods
 * never fail and answer only the ids assigned, as a real codec's table does.
 *
 * @since 0.1.0
 */
export interface InMemoryIdCodec extends IdCodec<never, never> {
  /**
   * The integer of `nodeId`, minting the next one if the id has none yet.
   * Assigning an id twice answers the same integer.
   */
  readonly assign: (nodeId: string) => number;
  /** Every batch `encode` was called with, in call order. */
  readonly encodeCalls: () => ReadonlyArray<ReadonlyArray<string>>;
  /** Every batch `decode` was called with, in call order. */
  readonly decodeCalls: () => ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * An {@link InMemoryIdCodec}, with `nodeIds` assigned 1, 2, … in order.
 *
 * @since 0.1.0
 */
export const makeInMemoryIdCodec = (nodeIds: Iterable<string> = []): InMemoryIdCodec => {
  let integers = HashMap.empty<string, number>();
  let nodes = HashMap.empty<number, string>();
  const encodeCalls: Array<ReadonlyArray<string>> = [];
  const decodeCalls: Array<ReadonlyArray<number>> = [];

  const assign = (nodeId: string): number =>
    Option.getOrElse(HashMap.get(integers, nodeId), () => {
      const integer = HashMap.size(integers) + 1;
      integers = HashMap.set(integers, nodeId, integer);
      nodes = HashMap.set(nodes, integer, nodeId);
      return integer;
    });
  Arr.fromIterable(nodeIds).forEach(assign);

  /** The entries of `table` at `keys`, as a codec's `= ANY($keys)` read answers. */
  const pick = <K, V>(table: HashMap.HashMap<K, V>, keys: ReadonlyArray<K>) =>
    HashMap.fromIterable(
      Arr.getSomes(
        keys.map((key) => Option.map(HashMap.get(table, key), (value) => [key, value] as const)),
      ),
    );

  return {
    assign,
    encode: (batch) =>
      Effect.sync(() => {
        encodeCalls.push(Arr.copy(batch));
        return pick(integers, batch);
      }),
    decode: (batch) =>
      Effect.sync(() => {
        decodeCalls.push(Arr.copy(batch));
        return pick(nodes, batch);
      }),
    encodeCalls: () => Arr.copy(encodeCalls),
    decodeCalls: () => Arr.copy(decodeCalls),
  };
};
