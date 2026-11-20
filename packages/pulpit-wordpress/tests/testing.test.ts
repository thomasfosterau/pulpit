/**
 * The `./testing` fakes' own behaviour: the in-memory id codec's minting, its
 * answers for unknown ids and its call log. Its use through the id modes is
 * in `ids.test.ts`.
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import { makeInMemoryIdCodec } from "../src/testing.ts";

describe("makeInMemoryIdCodec", () => {
  it("mints 1, 2, … in assignment order, and answers an assigned id's integer again", () => {
    const codec = makeInMemoryIdCodec(["a", "b", "a"]);
    expect(codec.assign("c")).toBe(3);
    expect(codec.assign("a")).toBe(1);
    expect(codec.assign("d")).toBe(4);
  });

  it.effect("answers only the ids it knows, in both directions", () =>
    Effect.gen(function* () {
      const codec = makeInMemoryIdCodec(["a", "b"]);
      expect(yield* codec.encode(["b", "x"])).toEqual(HashMap.make(["b", 2]));
      expect(yield* codec.decode([2, 9])).toEqual(HashMap.make([2, "b"]));
    }),
  );

  it.effect("logs every batch, and its log is a copy", () =>
    Effect.gen(function* () {
      const codec = makeInMemoryIdCodec(["a"]);
      const batch = ["a"];
      yield* codec.encode(batch);
      batch.push("mutated");
      yield* codec.decode([1]);
      yield* codec.decode([]);
      expect(codec.encodeCalls()).toEqual([["a"]]);
      expect(codec.decodeCalls()).toEqual([[1], []]);
      expect(codec.encodeCalls()).not.toBe(codec.encodeCalls());
    }),
  );
});
