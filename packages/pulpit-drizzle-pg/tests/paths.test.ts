/**
 * The path store's handling of a query's rows, with no database (a canned
 * transaction): the pre-check refusing another node's canonical row before
 * any write, the guarded upsert refusing a lost race, and the reads. The
 * claims run step by step against PostgreSQL, a concurrent pair included, in
 * `tests/integration/paths.test.ts`.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makePathStore } from "../src/Paths.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, paths } from "./fixtures/tree.ts";

const store = makePathStore({ table: paths, CurrentTransaction: database.CurrentTransaction });
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";

const runWith = <X, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<X, E, typeof database.CurrentTransaction.Identifier>,
) => {
  const { tx, calls } = cannedTransaction(rows);
  return Effect.map(
    Effect.result(Effect.provideService(effect, database.CurrentTransaction, tx)),
    (value) => ({ value, calls }),
  );
};

describe("makePathStore over canned rows", () => {
  it.effect("claim refuses another node's canonical row before writing anything", () =>
    Effect.gen(function* () {
      const { value, calls } = yield* runWith(
        [{ nodeId: B, canonical: true }],
        store.claim(A, "about"),
      );
      expect(value._tag).toBe("Failure");
      expect(calls).toEqual(["select", "from", "where", "for"]);
    }),
  );

  it.effect("claim demotes, then upserts; an upsert the guard refuses is PathTaken", () =>
    Effect.gen(function* () {
      const won = yield* runWith(
        [{ nodeId: A, canonical: false, path: "about" }],
        store.claim(A, "about"),
      );
      expect(won.value._tag).toBe("Success");
      expect(won.calls).toEqual([
        "select",
        "from",
        "where",
        "for",
        "update",
        "set",
        "where",
        "insert",
        "values",
        "onConflictDoUpdate",
        "returning",
      ]);
      const lost = yield* runWith([], store.claim(A, "about"));
      expect(lost.value._tag).toBe("Failure");
    }),
  );

  it.effect("lookup, canonicalOf and release; an id that is no UUID holds no path", () =>
    Effect.gen(function* () {
      expect(
        (yield* runWith([{ nodeId: A, canonical: true }], store.lookup("about"))).value,
      ).toMatchObject({
        success: Option.some({ nodeId: A, canonical: true }),
      });
      expect((yield* runWith([{ path: "about" }], store.canonicalOf(A))).value).toMatchObject({
        success: Option.some("about"),
      });
      expect((yield* runWith([], store.canonicalOf("x"))).calls).toEqual([]);
      expect((yield* runWith([], store.release(A))).calls).toEqual(["delete", "where"]);
      expect((yield* runWith([], store.release("x"))).calls).toEqual([]);
    }),
  );
});
