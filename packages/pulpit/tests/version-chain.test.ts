/**
 * The version-chain discipline against the in-memory store — every invariant
 * `src/version-chain.ts` lists, each on the minimal chain that exercises it.
 * The spec is gardeneria's node writers (`packages/database/src/nodes.ts`)
 * and `defineVersionOpsE` (`apps/api/src/operations/subtype.ts`).
 *
 * @module tests/version-chain
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import {
  applyPatch,
  defineVersionChain,
  MAX_HISTORY_LIMIT,
  StaleVersion,
  type ChainState,
  type ChainWrite,
  type Precondition,
  type VersionChainOps,
} from "../src/version-chain.ts";
import { makeInMemoryChainStore } from "./in-memory-chain.ts";

const ACTOR = Option.some("u-author");
const ID = "00000000-0000-4000-8000-00000000abcd";

const setup = () => {
  const store = makeInMemoryChainStore();
  const chain = defineVersionChain("posts", store);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
  return { store, chain, run, exit };
};

/** The failure's tag, or `none` for a success — what the refusal assertions compare. */
const tagOf = (result: Exit.Exit<unknown, { readonly _tag: string }>): Option.Option<string> =>
  Exit.isFailure(result)
    ? Option.map(Exit.findErrorOption(result), (error) => error._tag)
    : Option.none();

const initial: ChainState = { title: "First", body: "Hello", summary: "s" };

describe("applyPatch — the tri-state rule", () => {
  it("a value sets, null clears, undefined and absence carry forward", () => {
    expect(applyPatch(initial, { title: "Second", summary: null, body: undefined })).toEqual({
      title: "Second",
      body: "Hello",
      summary: null,
    });
    expect(applyPatch(initial, {})).toEqual(initial);
  });
});

describe("create", () => {
  it("inserts the node and version 0, minting the id when none is supplied", async () => {
    const { store, chain, run } = setup();
    const written = await run(chain.create({ id: Option.none(), state: initial, actorId: ACTOR }));
    expect(written.version).toBe(0n);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]).toMatchObject({ id: written.id, type: "posts", action: "create" });
    expect(store.rows()[0]!.actorId).toEqual(ACTOR);
  });

  it("uses a caller-supplied id, and is never an upsert over an existing node", async () => {
    const { store, chain, run, exit } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    const again = await exit(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR }));
    expect(tagOf(again)).toEqual(Option.some("NodeAlreadyExists"));
    // Nothing was minted onto the existing node.
    expect(store.rows()).toHaveLength(1);
  });

  it("maps a version-0 collision the store reports (a racing create) to NodeAlreadyExists", async () => {
    const { store, chain, exit } = setup();
    store.raceNextAppend(ID);
    const raced = await exit(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    expect(tagOf(raced)).toEqual(Option.some("NodeAlreadyExists"));
  });
});

describe("update — append and carry forward", () => {
  it("appends at N_max + 1 and carries unpatched columns forward", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    const first = await run(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
    const second = await run(chain.update({ id: ID, patch: { summary: null }, actorId: ACTOR }));
    expect([first.version, second.version]).toEqual([1n, 2n]);
    expect(store.rows().map((row) => row.action)).toEqual(["create", "update", "update"]);
    expect(store.rows()[2]!.state).toEqual({ title: "Second", body: "Hello", summary: null });
  });

  it("never rewrites an existing version row", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    const before = store.rows()[0];
    await run(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
    await run(chain.delete(ID, ACTOR));
    expect(store.rows()[0]).toBe(before);
    expect(store.rows().map((row) => row.version)).toEqual([0n, 1n, 2n]);
  });

  it("fails NodeNotFound for an unknown id", async () => {
    const { chain, exit } = setup();
    expect(tagOf(await exit(chain.update({ id: ID, patch: {}, actorId: ACTOR })))).toEqual(
      Option.some("NodeNotFound"),
    );
  });

  it("never resurrects a tombstone (VERSION-CHAIN-006)", async () => {
    const { store, chain, run, exit } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    await run(chain.delete(ID, ACTOR));
    const refused = await exit(chain.update({ id: ID, patch: { title: "x" }, actorId: ACTOR }));
    expect(tagOf(refused)).toEqual(Option.some("NodeNotFound"));
    expect(store.rows()).toHaveLength(2);
  });

  it("surfaces a concurrent writer's collision rather than retrying over it", async () => {
    const { store, chain, run, exit } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    store.raceNextAppend(ID);
    const raced = await exit(chain.update({ id: ID, patch: { title: "x" }, actorId: ACTOR }));
    expect(tagOf(raced)).toEqual(Option.some("VersionConflict"));
    expect(store.rows()).toHaveLength(1);
  });
});

describe("restore — the explicit resurrection surface", () => {
  it("writes over a tombstone as an update, bringing the node back live", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    await run(chain.delete(ID, ACTOR));
    const restored = await run(chain.restore({ id: ID, patch: { title: "Back" }, actorId: ACTOR }));
    expect(restored.version).toBe(2n);
    expect(store.rows()[2]).toMatchObject({
      action: "update",
      state: { ...initial, title: "Back" },
    });
  });
});

describe("delete — the tombstone", () => {
  it("appends a delete version that carries the full state forward", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    const deleted = await run(chain.delete(ID, ACTOR));
    expect(deleted).toEqual({ id: ID, version: 1n, alreadyDeleted: false });
    expect(store.rows()[1]).toMatchObject({ action: "delete", state: initial });
  });

  it("is idempotent: a second delete returns the existing tombstone and writes nothing", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    await run(chain.delete(ID, ACTOR));
    const again = await run(chain.delete(ID, ACTOR));
    expect(again).toEqual({ id: ID, version: 1n, alreadyDeleted: true });
    expect(store.rows()).toHaveLength(2);
  });

  it("fails NodeNotFound for an unknown id", async () => {
    const { chain, exit } = setup();
    expect(tagOf(await exit(chain.delete(ID, ACTOR)))).toEqual(Option.some("NodeNotFound"));
  });
});

describe("getVersion / restoreVersion — history as data", () => {
  const history = async () => {
    const context = setup();
    await context.run(
      context.chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }),
    );
    await context.run(
      context.chain.update({ id: ID, patch: { title: "Second", summary: null }, actorId: ACTOR }),
    );
    return context;
  };

  it("getVersion reconstructs any version's state, read-only", async () => {
    const { store, chain, run } = await history();
    const zero = await run(chain.getVersion(ID, 0n));
    expect(zero).toMatchObject({ version: 0n, action: "create", state: initial });
    expect(store.rows()).toHaveLength(2);
  });

  it("restoreVersion re-applies the snapshot as a NEW update version", async () => {
    const { store, chain, run } = await history();
    const restored = await run(chain.restoreVersion(ID, 0n, ACTOR));
    expect(restored.version).toBe(2n);
    expect(store.rows()[2]).toMatchObject({ version: 2n, action: "update", state: initial });
    // Versions 0 and 1 are untouched.
    expect(store.rows()[1]!.state).toEqual({ title: "Second", body: "Hello", summary: null });
  });

  it("restoreVersion restores from a tombstone, over a tombstone", async () => {
    const { store, chain, run } = await history();
    await run(chain.delete(ID, ACTOR));
    const restored = await run(chain.restoreVersion(ID, 2n, ACTOR));
    expect(restored.version).toBe(3n);
    expect(store.rows()[3]).toMatchObject({ action: "update" });
    expect(store.rows()[3]!.state).toEqual(store.rows()[2]!.state);
  });

  it("refuses an unknown version, and a partial chain, before writing anything", async () => {
    const { store, chain, exit } = await history();
    expect(tagOf(await exit(chain.restoreVersion(ID, 9n, ACTOR)))).toEqual(
      Option.some("VersionNotFound"),
    );
    store.dropState(ID, 0n);
    expect(tagOf(await exit(chain.restoreVersion(ID, 0n, ACTOR)))).toEqual(
      Option.some("VersionNotFound"),
    );
    expect(tagOf(await exit(chain.getVersion(ID, 0n)))).toEqual(Option.some("VersionNotFound"));
    expect(store.rows()).toHaveLength(2);
  });
});

describe("history", () => {
  it("lists the chain oldest first", async () => {
    const { chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    await run(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
    await run(chain.delete(ID, ACTOR));
    const entries = await run(chain.history(ID));
    expect(entries.map((entry) => [entry.version, entry.action])).toEqual([
      [0n, "create"],
      [1n, "update"],
      [2n, "delete"],
    ]);
    expect(entries.every((entry) => entry.timestamp instanceof Date)).toBe(true);
  });

  it("is bounded: the limit applies, and is capped", async () => {
    const { store, chain, run } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    await run(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
    expect(await run(chain.history(ID, 1))).toHaveLength(1);
    // A non-positive or oversized limit is clamped, never passed through.
    let requested = 0;
    const spy = defineVersionChain("posts", {
      ...store,
      entries: (id, limit) => {
        requested = limit;
        return store.entries(id, limit);
      },
    });
    await run(spy.history(ID, 1_000_000));
    expect(requested).toBe(MAX_HISTORY_LIMIT);
    await run(spy.history(ID, 0));
    expect(requested).toBe(1);
  });

  it("fails NodeNotFound for an id with no versions", async () => {
    const { chain, exit } = setup();
    expect(tagOf(await exit(chain.history(ID)))).toEqual(Option.some("NodeNotFound"));
  });
});

describe("expectedVersion — the optimistic-concurrency precondition", () => {
  /** A node at head 1: version 0 created, version 1 updated. */
  const atHeadOne = async () => {
    const context = setup();
    await context.run(
      context.chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }),
    );
    await context.run(context.chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
    return context;
  };

  type Write = (
    chain: VersionChainOps<never, never>,
    precondition: Precondition,
  ) => Effect.Effect<ChainWrite, { readonly _tag: string }>;

  /** Every write that extends an existing chain, each taking the precondition. */
  const writes: ReadonlyArray<readonly [string, Write]> = [
    [
      "update",
      (chain, precondition) =>
        chain.update({ id: ID, patch: { title: "Third" }, actorId: ACTOR, ...precondition }),
    ],
    [
      "restore",
      (chain, precondition) =>
        chain.restore({ id: ID, patch: { title: "Third" }, actorId: ACTOR, ...precondition }),
    ],
    ["delete", (chain, precondition) => chain.delete(ID, ACTOR, precondition)],
    ["restoreVersion", (chain, precondition) => chain.restoreVersion(ID, 0n, ACTOR, precondition)],
  ];

  describe.each(writes)("%s", (_name, write) => {
    it("writes when the expected version is the head", async () => {
      const { store, chain, run } = await atHeadOne();
      const written = await run(write(chain, { expectedVersion: 1n }));
      expect(written.version).toBe(2n);
      expect(store.rows()).toHaveLength(3);
    });

    it("writes nothing when the expected version is stale, and the error carries the head", async () => {
      const { store, chain, exit } = await atHeadOne();
      const before = store.rows();
      const result = await exit(write(chain, { expectedVersion: 0n }));
      expect(Option.map(Exit.findErrorOption(result), (error) => error._tag)).toEqual(
        Option.some("StaleVersion"),
      );
      const error = Option.getOrUndefined(Exit.findErrorOption(result));
      expect(error).toBeInstanceOf(StaleVersion);
      expect(error).toMatchObject({ type: "posts", id: ID, expected: 0n, current: 1n });
      // The chain is exactly as it was: no row appended, none rewritten.
      expect(store.rows()).toEqual(before);
    });

    it("an expected version ahead of the head is stale too", async () => {
      const { store, chain, exit } = await atHeadOne();
      const result = await exit(write(chain, { expectedVersion: 5n }));
      expect(tagOf(result)).toEqual(Option.some("StaleVersion"));
      expect(store.rows()).toHaveLength(2);
    });

    it("without one (absent, or an explicit undefined) the write extends whatever the head is", async () => {
      const absent = await atHeadOne();
      expect((await absent.run(write(absent.chain, {}))).version).toBe(2n);
      const explicit = await atHeadOne();
      const written = await explicit.run(write(explicit.chain, { expectedVersion: undefined }));
      expect(written.version).toBe(2n);
    });
  });

  it("is race-safe: two writers expecting the same head, interleaved, cannot both write", async () => {
    const { store, run, exit } = await atHeadOne();
    // Writer B reads head 1 (and its state); in the gap before B appends,
    // writer A, who also read head 1, appends version 2. B's append extends
    // the head it read, so it lands on version 2 and hits the (id, version)
    // key, rather than re-reading and silently writing version 3 over A.
    let raced = false;
    const interleaved = defineVersionChain("posts", {
      ...store,
      snapshot: (id, version) =>
        Effect.tap(store.snapshot(id, version), () =>
          raced
            ? Effect.void
            : Effect.andThen(
                Effect.sync(() => {
                  raced = true;
                }),
                defineVersionChain("posts", store).update({
                  id: ID,
                  patch: { title: "A" },
                  actorId: ACTOR,
                  expectedVersion: 1n,
                }),
              ),
        ),
    });
    const loser = await exit(
      interleaved.update({ id: ID, patch: { title: "B" }, actorId: ACTOR, expectedVersion: 1n }),
    );
    expect(tagOf(loser)).toEqual(Option.some("VersionConflict"));
    expect(store.rows()).toHaveLength(3);
    expect(store.rows()[2]!.state["title"]).toBe("A");
    // A writer that re-reads now sees head 2, and its stale expectation is refused up front.
    const late = await exit(
      interleaved.update({ id: ID, patch: { title: "B" }, actorId: ACTOR, expectedVersion: 1n }),
    );
    expect(tagOf(late)).toEqual(Option.some("StaleVersion"));
    expect(store.rows()).toHaveLength(3);
    expect(
      (await run(interleaved.update({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 2n })))
        .version,
    ).toBe(3n);
  });

  it("a delete over a tombstone stays idempotent, whatever the precondition", async () => {
    const { store, chain, run } = await atHeadOne();
    await run(chain.delete(ID, ACTOR, { expectedVersion: 1n }));
    const again = await run(chain.delete(ID, ACTOR, { expectedVersion: 1n }));
    expect(again).toEqual({ id: ID, version: 2n, alreadyDeleted: true });
    expect(store.rows()).toHaveLength(3);
  });

  it("restore over a tombstone checks the tombstone's version; update still refuses it as NotFound", async () => {
    const { store, chain, run, exit } = await atHeadOne();
    await run(chain.delete(ID, ACTOR));
    expect(
      tagOf(await exit(chain.update({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 2n }))),
    ).toEqual(Option.some("NodeNotFound"));
    expect(
      tagOf(await exit(chain.restore({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 1n }))),
    ).toEqual(Option.some("StaleVersion"));
    expect(store.rows()).toHaveLength(3);
    const restored = await run(
      chain.restore({ id: ID, patch: {}, actorId: ACTOR, expectedVersion: 2n }),
    );
    expect(restored.version).toBe(3n);
  });

  it("an unknown id is NodeNotFound and an unknown restore target VersionNotFound, before the precondition", async () => {
    const { chain, exit } = await atHeadOne();
    const other = "00000000-0000-4000-8000-00000000ffff";
    expect(
      tagOf(
        await exit(chain.update({ id: other, patch: {}, actorId: ACTOR, expectedVersion: 0n })),
      ),
    ).toEqual(Option.some("NodeNotFound"));
    expect(tagOf(await exit(chain.delete(other, ACTOR, { expectedVersion: 0n })))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(tagOf(await exit(chain.restoreVersion(ID, 9n, ACTOR, { expectedVersion: 0n })))).toEqual(
      Option.some("VersionNotFound"),
    );
  });
});

describe("a store that breaks its own contract", () => {
  it("dies (a defect, not a typed miss) when the head has no reconstructable state", async () => {
    const { store, chain, run, exit } = setup();
    await run(chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }));
    store.dropState(ID, 0n);
    const result = await exit(chain.update({ id: ID, patch: {}, actorId: ACTOR }));
    expect(Exit.hasDies(result)).toBe(true);
  });
});
