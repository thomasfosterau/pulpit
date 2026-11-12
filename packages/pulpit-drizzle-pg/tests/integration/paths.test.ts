/**
 * The path store against PostgreSQL, checked step by step against the
 * kernel's `makeInMemoryPathStore` over the same claims and releases, and
 * the uniqueness guard under two concurrent claims of one path.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { PathStore, PathTaken } from "@thomasfosterau/pulpit/paths";
import { makeInMemoryPathStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makePathStore } from "../../src/paths.ts";
import { makeVersionChains } from "../../src/version-chain.ts";
import { paths, tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitPathsDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 4 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

/** Run in a committed transaction of its own; a failure is the exit's, a connection fault a defect. */
const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromiseExit(
    transact(effect).pipe(
      Effect.catchIf(
        (error) => P.isTagged(error, "SqlError"),
        (error) => Effect.die(error),
      ),
    ),
  );

const store = makePathStore({ table: paths, CurrentTransaction });
const chains = makeVersionChains({ tree, tables, CurrentTransaction });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1);
const B = id(2);
const C = id(3);

/** A step's outcome, comparable across the two stores: its value, or its failure's tag. */
const outcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ ok: value }),
    onFailure: (cause) => ({
      failed: Option.match(Exit.findErrorOption(Exit.failCause(cause)), {
        onNone: () => "defect",
        onSome: (error) => (P.isTagged(error, "PathTaken") ? "PathTaken" : "error"),
      }),
    }),
  });

/** One step over either store. */
type Step = <E, R>(paths: PathStore<E, R>) => Effect.Effect<unknown, E | PathTaken, R>;

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(`TRUNCATE pulpit_test.${getTableName(tables.root.identity)} CASCADE`),
      );
      yield* Effect.forEach(
        [A, B, C],
        (node) => chains.links.create({ id: Option.some(node), state: {}, actorId: Option.none() }),
        { concurrency: 1 },
      );
    }),
  );
});

describe("PathStore over PostgreSQL agrees with the in-memory store", () => {
  const memory = makeInMemoryPathStore();
  const steps: ReadonlyArray<readonly [string, Step]> = [
    ["A claims about", (s) => s.claim(A, "about")],
    ["B claims about: taken", (s) => s.claim(B, "about")],
    ["A moves to about-us: about becomes A's alias", (s) => s.claim(A, "about-us")],
    ["lookup about", (s) => s.lookup("about")],
    ["lookup about-us", (s) => s.lookup("about-us")],
    ["B takes over A's alias about", (s) => s.claim(B, "about")],
    ["lookup about after the takeover", (s) => s.lookup("about")],
    ["A claims about, B's canonical now: taken", (s) => s.claim(A, "about")],
    ["A re-claims its canonical path: a no-op", (s) => s.claim(A, "about-us")],
    ["canonicalOf A", (s) => s.canonicalOf(A)],
    [
      "A moves to team, then back to about-us (its alias is promoted)",
      (s) => Effect.andThen(s.claim(A, "team"), s.claim(A, "about-us")),
    ],
    ["lookup team (A's alias)", (s) => s.lookup("team")],
    ["release A: its canonical row goes, its aliases stay", (s) => s.release(A)],
    ["canonicalOf A after release", (s) => s.canonicalOf(A)],
    ["lookup team after release", (s) => s.lookup("team")],
    ["C claims about-us, freed", (s) => s.claim(C, "about-us")],
    ["lookup a path nobody holds", (s) => s.lookup("nowhere")],
    ["canonicalOf an id that is no UUID", (s) => s.canonicalOf("x")],
  ];
  it.each(steps)("%s", async (_name, step) => {
    expect(outcome(await run(step(store)))).toEqual(
      outcome(await Effect.runPromiseExit(step(memory))),
    );
  });
});

describe("the uniqueness guard", () => {
  it("two concurrent claims of one free path: exactly one wins, the other is PathTaken", async () => {
    const results = await Promise.all([run(store.claim(A, "race")), run(store.claim(B, "race"))]);
    expect(Arr.filter(results, Exit.isSuccess).length).toBe(1);
    const failure = Arr.findFirst(results, Exit.isFailure);
    expect(Option.map(failure, (exit) => String(exit.cause).includes("PathTaken"))).toEqual(
      Option.some(true),
    );
  });
});
