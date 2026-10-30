/**
 * The id modes over the `IdCodec` seam (pulpit#114): batching, input order,
 * duplicates, unknown and malformed wire ids, the codec's contract failures,
 * and the string-id passthrough. The adapter's endpoints (pulpit#86 phase 1)
 * pin the 404 for an unknown id against a hidden row; here the codec's half
 * is pinned: every id that names no node decodes to the same `none`, without
 * a failure.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MAX_SET_VALUES } from "@thomasfosterau/pulpit/filter";
import { integerIds, stringIds, UnencodableNodeId, type IdCodec } from "../src/ids.ts";
import { makeInMemoryIdCodec } from "../src/testing.ts";

// oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary the rule asks for
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

/** What a hostile input or a broken callback throws. */
class Boom {
  readonly reason = "boom";
}

class CodecDown extends Schema.TaggedError<CodecDown>()("CodecDown", {}) {}

/** A codec whose every read fails, so a test can show it was never read. */
const failingCodec: IdCodec<CodecDown, never> = {
  encode: () => Effect.fail(new CodecDown()),
  decode: () => Effect.fail(new CodecDown()),
};

/** A codec answering a fixed (possibly broken) integer for every node id. */
const constantCodec = (integer: number): IdCodec<never, never> => ({
  encode: (nodeIds) =>
    Effect.succeed(HashMap.fromIterable(nodeIds.map((nodeId) => [nodeId, integer] as const))),
  decode: () => Effect.succeed(HashMap.empty()),
});

const some = Option.some;
const none = Option.none();

/** Whether an effect dies (a defect), rather than failing or throwing. */
const dies = <A, E>(effect: Effect.Effect<A, E>): boolean => {
  // oxlint-disable-next-line effect/effect-run-in-body -- the test harness is the runtime boundary the rule asks for
  const exit = Effect.runSyncExit(effect);
  return Exit.isFailure(exit) && Cause.hasDies(exit.cause);
};

/** A wire-id batch whose every read throws, as a hostile input might. */
const throwingBatch = (): ReadonlyArray<string> =>
  new Proxy<Array<string>>(["1"], {
    get: () => {
      throw new Boom();
    },
  });

describe("integerIds: encode", () => {
  it("answers each node id's integer in input order, duplicates included, from one read", () => {
    const codec = makeInMemoryIdCodec(["a", "b", "c"]);
    const ids = integerIds(codec);
    expect(ids.mode).toBe("integer");
    expect(run(ids.encode(["c", "a", "c", "b", "a"]))).toEqual([3, 1, 3, 2, 1]);
    expect(codec.encodeCalls()).toEqual([["c", "a", "b"]]);
    expect(codec.decodeCalls()).toEqual([]);
  });

  it("reads nothing for an empty batch", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    expect(run(integerIds(codec).encode([]))).toEqual([]);
    expect(codec.encodeCalls()).toEqual([]);
  });

  it("fails UnencodableNodeId for a node id the codec doesn't know", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    const error = run(Effect.flip(integerIds(codec).encode(["a", "missing"])));
    expect(error).toEqual(new UnencodableNodeId({ nodeId: "missing", reason: "unmapped" }));
    expect(codec.encodeCalls()).toEqual([["a", "missing"]]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "fails UnencodableNodeId when the codec answers %s, which no WordPress id is",
    (integer) => {
      const error = run(Effect.flip(integerIds(constantCodec(integer)).encode(["a"])));
      expect(error).toEqual(new UnencodableNodeId({ nodeId: "a", reason: "invalid-integer" }));
    },
  );

  it("encodes Number.MAX_SAFE_INTEGER, the largest WordPress id", () => {
    const ids = integerIds(constantCodec(Number.MAX_SAFE_INTEGER));
    expect(run(ids.encode(["a"]))).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it("passes the codec's own failure through", () => {
    expect(run(Effect.flip(integerIds(failingCodec).encode(["a"])))).toEqual(new CodecDown());
  });

  it("fails duplicate-integer when the codec answers one integer for two node ids", () => {
    const error = run(Effect.flip(integerIds(constantCodec(5)).encode(["a", "a", "b"])));
    expect(error).toEqual(new UnencodableNodeId({ nodeId: "b", reason: "duplicate-integer" }));
  });

  it("encodes one node id repeated as its one integer, never a duplicate", () => {
    expect(run(integerIds(constantCodec(5)).encode(["a", "a"]))).toEqual([5, 5]);
  });

  it("dies, never throws, on a batch that throws", () => {
    const encoded = integerIds(makeInMemoryIdCodec(["a"])).encode(throwingBatch());
    expect(dies(encoded)).toBe(true);
  });
});

describe("integerIds: decode", () => {
  it("answers each wire id's node in input order, duplicates included, from one read", () => {
    const codec = makeInMemoryIdCodec(["a", "b", "c"]);
    const decoded = run(integerIds(codec).decode(["3", 1, "3", "2", 1]));
    expect(decoded).toEqual([some("c"), some("a"), some("c"), some("b"), some("a")]);
    expect(codec.decodeCalls()).toEqual([[3, 1, 2]]);
    expect(codec.encodeCalls()).toEqual([]);
  });

  it("answers none for an integer the codec doesn't know, in place, never failing", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    const decoded = run(integerIds(codec).decode(["9", "1", "9"]));
    expect(decoded).toEqual([none, some("a"), none]);
    expect(codec.decodeCalls()).toEqual([[9, 1]]);
  });

  it.each<[string, string | number]>([
    ["zero", "0"],
    ["a zero number", 0],
    ["negative zero", -0],
    ["a negative string", "-1"],
    ["a negative number", -1],
    ["a decimal fraction", "1.5"],
    ["a fractional number", 1.5],
    ["an exponent", "1e3"],
    ["a hexadecimal string", "0x10"],
    ["a signed string", "+1"],
    ["padding", " 1"],
    ["a trailing newline", "1\n"],
    ["an empty string", ""],
    ["a word", "abc"],
    ["a UUID", "3f0c4e5a-0000-4000-8000-000000000000"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["MAX_SAFE_INTEGER + 1 as a number", Number.MAX_SAFE_INTEGER + 1],
    ["MAX_SAFE_INTEGER + 1 as a string", "9007199254740992"],
    ["MAX_SAFE_INTEGER + 2 as a string", "9007199254740993"],
    ["a 400-digit string", "9".repeat(400)],
  ])("answers none for %s without reading the codec", (_, wireId) => {
    // A codec that fails if read: decode must never reach it, and never fail.
    expect(run(integerIds(failingCodec).decode([wireId]))).toEqual([none]);
  });

  it("answers a malformed id exactly as an unknown one, and reads only the valid ids", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    const decoded = run(integerIds(codec).decode(["abc", "1", "0", "2", -5]));
    expect(decoded).toEqual([none, some("a"), none, none, none]);
    expect(codec.decodeCalls()).toEqual([[1, 2]]);
  });

  it("reads WordPress's leading zeros as decimal, and accepts MAX_SAFE_INTEGER", () => {
    const codec = makeInMemoryIdCodec();
    run(integerIds(codec).decode(["007", "9007199254740991", 7]));
    expect(codec.decodeCalls()).toEqual([[7, Number.MAX_SAFE_INTEGER]]);
  });

  it("reads nothing for an empty batch", () => {
    const codec = makeInMemoryIdCodec(["a"]);
    expect(run(integerIds(codec).decode([]))).toEqual([]);
    expect(codec.decodeCalls()).toEqual([]);
  });

  it(`reads a batch of MAX_SET_VALUES (${MAX_SET_VALUES}) ids, duplicates counted`, () => {
    const codec = makeInMemoryIdCodec(["a"]);
    const wireIds = Array.from({ length: MAX_SET_VALUES }, () => "1");
    expect(run(integerIds(codec).decode(wireIds))).toEqual(wireIds.map(() => some("a")));
    expect(codec.decodeCalls()).toEqual([[1]]);
  });

  it("answers none throughout past MAX_SET_VALUES, without reading the codec", () => {
    // Duplicates count, as the kernel's anyOf counts them: one id, repeated.
    const wireIds = Array.from({ length: MAX_SET_VALUES + 1 }, () => "1");
    const decoded = run(integerIds(failingCodec).decode(wireIds));
    expect(decoded).toEqual(wireIds.map(() => none));
  });

  it("dies, never throws, on a batch that throws", () => {
    const decoded = integerIds(makeInMemoryIdCodec(["a"])).decode(throwingBatch());
    expect(dies(decoded)).toBe(true);
  });

  it("passes the codec's own failure through once a valid id reaches it", () => {
    expect(run(Effect.flip(integerIds(failingCodec).decode(["1"])))).toEqual(new CodecDown());
  });

  it("round-trips encode through decode", () => {
    const ids = integerIds(makeInMemoryIdCodec(["a", "b"]));
    const encoded = run(ids.encode(["b", "a"]));
    expect(run(ids.decode(encoded))).toEqual([some("b"), some("a")]);
    expect(run(ids.decode(encoded.map(String)))).toEqual([some("b"), some("a")]);
  });
});

describe("stringIds", () => {
  it("passes node ids through unchanged in both directions, reading no codec", () => {
    const ids = stringIds();
    expect(ids.mode).toBe("string");
    const nodeIds = ["3f0c4e5a-0000-4000-8000-000000000000", "b", "b"];
    const encoded = run(ids.encode(nodeIds));
    expect(encoded).toEqual(nodeIds);
    expect(encoded).not.toBe(nodeIds);
    expect(run(ids.decode(encoded))).toEqual(nodeIds.map(some));
  });

  it("answers none for an empty string or a number, in place", () => {
    expect(run(stringIds().decode(["a", "", 1, "1"]))).toEqual([some("a"), none, none, some("1")]);
  });

  it("answers none for a string isNodeId rejects", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const ids = stringIds({ isNodeId: (wireId) => uuid.test(wireId) });
    const valid = "3f0c4e5a-0000-4000-8000-000000000000";
    expect(run(ids.decode([valid, "1", "not-a-uuid"]))).toEqual([some(valid), none, none]);
  });

  it("answers none throughout past MAX_SET_VALUES", () => {
    const ids = stringIds();
    const atCap = Array.from({ length: MAX_SET_VALUES }, () => "a");
    expect(run(ids.decode(atCap))).toEqual(atCap.map(some));
    expect(run(ids.decode([...atCap, "a"]))).toEqual([...atCap, "a"].map(() => none));
  });

  it("makes an isNodeId that throws a defect, never a synchronous throw", () => {
    const ids = stringIds({
      isNodeId: () => {
        throw new Boom();
      },
    });
    let decoded: Effect.Effect<ReadonlyArray<Option.Option<string>>> = Effect.succeed([]);
    expect(() => {
      decoded = ids.decode(["a"]);
    }).not.toThrow();
    expect(dies(decoded)).toBe(true);
  });

  it("takes an explicit undefined as the default", () => {
    expect(run(stringIds({ isNodeId: undefined }).decode(["", "a"]))).toEqual([none, some("a")]);
  });
});
