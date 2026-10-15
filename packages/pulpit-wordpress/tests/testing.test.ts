/**
 * The `./testing` fakes' own behaviour: the in-memory id codec's minting, its
 * answers for unknown ids and its call log. Its use through the id modes is
 * in `ids.test.ts`.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import { makeInMemoryIdCodec } from "../src/testing.ts";

// oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary the rule asks for
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

describe("makeInMemoryIdCodec", () => {
  it("mints 1, 2, … in assignment order, and answers an assigned id's integer again", () => {
    const codec = makeInMemoryIdCodec(["a", "b", "a"]);
    expect(codec.assign("c")).toBe(3);
    expect(codec.assign("a")).toBe(1);
    expect(codec.assign("d")).toBe(4);
  });

  it("answers only the ids it knows, in both directions", () => {
    const codec = makeInMemoryIdCodec(["a", "b"]);
    expect(run(codec.encode(["b", "x"]))).toEqual(HashMap.make(["b", 2]));
    expect(run(codec.decode([2, 9]))).toEqual(HashMap.make([2, "b"]));
  });

  it("logs every batch, and its log is a copy", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    const batch = ["a"];
    run(codec.encode(batch));
    batch.push("mutated");
    run(codec.decode([1]));
    run(codec.decode([]));
    expect(codec.encodeCalls()).toEqual([["a"]]);
    expect(codec.decodeCalls()).toEqual([[1], []]);
    expect(codec.encodeCalls()).not.toBe(codec.encodeCalls());
  });
});
