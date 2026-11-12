/**
 * The `VersionChain` port's mapping, with no database: `fromLeafChain` over a
 * fake `-pg/chain` leaf chain (the kernel's in-memory chain re-spoken in
 * `-pg/chain`'s inputs and errors) passes the kernel's conformance suite, so
 * every input and error crosses the seam one to one. The same suite runs
 * over PostgreSQL in `tests/integration/`.
 */

import * as Pg from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import {
  makeInMemoryVersionChain,
  versionChainConformance,
  type InMemoryVersionChain,
} from "@thomasfosterau/pulpit/testing";
import {
  NodeAlreadyExists,
  NodeNotFound,
  StaleVersion,
  VersionConflict,
  VersionNotFound,
} from "@thomasfosterau/pulpit/version-chain";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { describe, expect, it } from "vite-plus/test";
import {
  fromLeafChain,
  ProposedByUnrecorded,
  type ErasedLeafChain,
} from "../src/internal/leaf-chain.ts";
import { makeVersionChains } from "../src/version-chain.ts";
import { database, plainTables, tables, tree } from "./fixtures/tree.ts";

/** Each kernel error re-raised as the `-pg/chain` class of the same name. */
const pg = {
  NodeNotFound: (error: NodeNotFound) => new Pg.NodeNotFound({ type: error.type, id: error.id }),
  VersionNotFound: (error: VersionNotFound) =>
    new Pg.VersionNotFound({ type: error.type, id: error.id, version: error.version }),
  NodeAlreadyExists: (error: NodeAlreadyExists) =>
    new Pg.NodeAlreadyExists({ type: error.type, id: error.id }),
  StaleVersion: (error: StaleVersion) =>
    new Pg.StaleVersion({
      type: error.type,
      id: error.id,
      expected: error.expected,
      current: error.current,
    }),
  VersionConflict: (error: VersionConflict) =>
    new Pg.VersionConflict({ id: error.id, version: error.version }),
};

/** A create's errors, as `-pg/chain` raises them. */
const createErrors = Match.type<NodeAlreadyExists | VersionConflict>().pipe(
  Match.tagsExhaustive({
    NodeAlreadyExists: pg.NodeAlreadyExists,
    VersionConflict: pg.VersionConflict,
  }),
);
/** An update's, restore's or delete's errors. */
const writeErrors = Match.type<NodeNotFound | StaleVersion | VersionConflict>().pipe(
  Match.tagsExhaustive({
    NodeNotFound: pg.NodeNotFound,
    StaleVersion: pg.StaleVersion,
    VersionConflict: pg.VersionConflict,
  }),
);
/** A restoreVersion's errors. */
const restoreErrors = Match.type<VersionNotFound | StaleVersion | VersionConflict>().pipe(
  Match.tagsExhaustive({
    VersionNotFound: pg.VersionNotFound,
    StaleVersion: pg.StaleVersion,
    VersionConflict: pg.VersionConflict,
  }),
);

/** Every root extra each write was handed, in order. */
type RootLog = Array<Option.Option<string>>;

/** A key the kernel's inputs carry only when present (they are bare `?:`). */
const present = <K extends string, V>(key: K, value: Option.Option<V>) =>
  Option.match(value, {
    onNone: () => ({}),
    onSome: (defined) => R.singleton(key, defined),
  });

/** A `-pg/chain` leaf chain over the kernel's in-memory one. */
const fakeLeafChain = (
  memory: InMemoryVersionChain,
  roots: RootLog,
): ErasedLeafChain<never, never> => {
  const merge =
    (write: InMemoryVersionChain["update"]): ErasedLeafChain<never, never>["update"] =>
    (input) => {
      roots.push(Option.fromUndefinedOr(input.root?.proposedBy));
      return Effect.mapError(
        write({
          id: input.id,
          patch: input.patch,
          ...present("locales", Option.fromUndefinedOr(input.keyed)),
          actorId: Option.fromUndefinedOr(input.actor),
          ...present("expectedVersion", Option.fromUndefinedOr(input.expectedVersion)),
        }),
        writeErrors,
      );
    };
  return {
    create: (input) =>
      Effect.mapError(
        memory.create({
          id: Option.fromUndefinedOr(input.id),
          state: input.state,
          ...present("locales", Option.fromUndefinedOr(input.keyed)),
          actorId: Option.fromUndefinedOr(input.actor),
        }),
        createErrors,
      ),
    update: merge(memory.update),
    restore: merge(memory.restore),
    delete: (id, options) =>
      Effect.mapError(
        memory.delete(
          id,
          Option.fromUndefinedOr(options.actor),
          present("expectedVersion", Option.fromUndefinedOr(options.expectedVersion)),
        ),
        writeErrors,
      ),
    restoreVersion: (id, version, options) =>
      Effect.mapError(
        memory.restoreVersion(
          id,
          version,
          Option.fromUndefinedOr(options.actor),
          present("expectedVersion", Option.fromUndefinedOr(options.expectedVersion)),
        ),
        restoreErrors,
      ),
    getVersion: (id, version) =>
      Effect.mapBoth(memory.getVersion(id, version), {
        onFailure: pg.VersionNotFound,
        onSuccess: (snapshot) => ({
          version: snapshot.version,
          action: snapshot.action,
          timestamp: snapshot.timestamp,
          state: snapshot.state,
          keyed: snapshot.locales ?? {},
        }),
      }),
    head: memory.head,
    history: (id, limit) => Effect.mapError(memory.history(id, limit), pg.NodeNotFound),
  };
};

const harness = (recordsProposedBy: boolean) => {
  const memory = makeInMemoryVersionChain("notes");
  const roots: RootLog = [];
  const chain = fromLeafChain(fakeLeafChain(memory, roots), {
    type: "notes",
    purge: memory.purge,
    recordsProposedBy,
  });
  return { memory, roots, chain };
};

versionChainConformance(
  {
    type: "notes",
    make: async () => {
      const { memory, chain } = harness(true);
      return { chain, dropState: memory.dropState, raceNextAppend: memory.raceNextAppend };
    },
    run: (effect) => Effect.runPromiseExit(effect),
  },
  { describe, it, expect },
);

describe("fromLeafChain — proposedBy, the root version extra", () => {
  const ID = "00000000-0000-4000-8000-000000000001";
  const actorId = Option.some("u-editor");
  const created = (recordsProposedBy: boolean) =>
    Effect.gen(function* () {
      const context = harness(recordsProposedBy);
      yield* context.chain.create({ id: Option.some(ID), state: { title: "A" }, actorId });
      return context;
    });

  it("records the contributor of an accepted proposal, and nothing for a plain write", async () => {
    const { roots } = await Effect.runPromise(
      Effect.tap(created(true), ({ chain }) =>
        Effect.andThen(
          chain.update({ id: ID, patch: {}, actorId, proposedBy: Option.some("u-contributor") }),
          chain.restore({ id: ID, patch: {}, actorId, proposedBy: Option.none() }),
        ),
      ),
    );
    expect(roots).toEqual([Option.some("u-contributor"), Option.none()]);
  });

  it("dies rather than dropping a contributor the tree cannot record", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(created(false), ({ chain }) =>
        chain.update({ id: ID, patch: {}, actorId, proposedBy: Option.some("u-contributor") }),
      ),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
    const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(Schema.is(ProposedByUnrecorded)(defect)).toBe(true);
    expect(Schema.is(ProposedByUnrecorded)(defect) ? defect.message : "").toContain(
      "no proposedBy column",
    );
  });

  it("writes a plain update over a tree without the column", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(created(false), ({ chain }) => chain.update({ id: ID, patch: {}, actorId })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("fromLeafChain — the driver's own failure", () => {
  class QueryFailed extends Schema.TaggedError<QueryFailed, { readonly brand: unique symbol }>()(
    "QueryFailed",
    {},
  ) {}
  const failed = Effect.fail(new QueryFailed());
  const failing: ErasedLeafChain<QueryFailed, never> = {
    create: () => failed,
    update: () => failed,
    restore: () => failed,
    delete: () => failed,
    restoreVersion: () => failed,
    getVersion: () => failed,
    head: () => failed,
    history: () => failed,
  };
  const chain = fromLeafChain(failing, {
    type: "notes",
    purge: () => failed,
    recordsProposedBy: true,
  });
  const ID = "00000000-0000-4000-8000-000000000002";
  const actorId = Option.none<string>();

  it("passes through every operation unchanged", async () => {
    const operations: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
      chain.create({ id: Option.none(), state: {}, actorId }),
      chain.update({ id: ID, patch: {}, actorId }),
      chain.restore({ id: ID, patch: {}, actorId }),
      chain.delete(ID, actorId),
      chain.restoreVersion(ID, 0n, actorId),
      chain.getVersion(ID, 0n),
      chain.history(ID),
      chain.head(ID),
      chain.purge(ID),
    ];
    const outcomes = await Effect.runPromise(
      Effect.forEach(operations, (operation) => Effect.flip(operation), { concurrency: 1 }),
    );
    expect(Arr.map(outcomes, (error) => Schema.is(QueryFailed)(error))).toEqual(
      Arr.replicate(true, 9),
    );
  });
});

describe("fromLeafChain — an id that is no UUID names no node", () => {
  const { chain } = harness(true);
  const actorId = Option.none<string>();
  const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.map(Effect.flip(effect), (error) => error._tag));

  it("answers as an unknown id does, without reaching the chain", async () => {
    expect(await tag(chain.update({ id: "not-a-uuid", patch: {}, actorId }))).toBe("NodeNotFound");
    expect(await tag(chain.restore({ id: "1", patch: {}, actorId }))).toBe("NodeNotFound");
    expect(await tag(chain.delete("X", actorId))).toBe("NodeNotFound");
    expect(await tag(chain.history("x"))).toBe("NodeNotFound");
    expect(await tag(chain.getVersion("x", 0n))).toBe("VersionNotFound");
    expect(await tag(chain.restoreVersion("x", 0n, actorId))).toBe("VersionNotFound");
    expect(await Effect.runPromise(chain.head("00000000-0000-4000-8000-00000000ABCD"))).toEqual(
      Option.none(),
    );
    await Effect.runPromise(chain.purge("x"));
  });
});

describe("makeVersionChains", () => {
  it("binds one port per leaf of the tree", () => {
    const chains = makeVersionChains({
      tree,
      tables,
      CurrentTransaction: database.CurrentTransaction,
    });
    expect(Arr.sort(R.keys(chains), Str.Order)).toEqual(["links", "notes", "posts"]);
    expect(Arr.sort(R.keys(chains.notes), Str.Order)).toEqual([
      "create",
      "delete",
      "getVersion",
      "head",
      "history",
      "purge",
      "restore",
      "restoreVersion",
      "update",
    ]);
  });

  it("builds over a tree whose root version table records no proposedBy", () => {
    const chains = makeVersionChains({
      tree,
      tables: plainTables,
      CurrentTransaction: database.CurrentTransaction,
    });
    expect(Arr.sort(R.keys(chains), Str.Order)).toEqual(["links", "notes", "posts"]);
  });
});
