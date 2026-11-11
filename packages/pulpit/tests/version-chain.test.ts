/**
 * The version-chain discipline against the in-memory store — every invariant
 * `src/version-chain.ts` lists, each on the minimal chain that exercises it.
 * The spec is gardeneria's node writers (`packages/database/src/nodes.ts`)
 * and `defineVersionOpsE` (`apps/api/src/operations/subtype.ts`).
 *
 * @module tests/version-chain
 */

import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  applyPatch,
  defineVersionChain,
  diffStates,
  StaleVersion,
  VersionNotFound,
  type ChainAppendEvent,
  type ChainPatch,
  type ChainState,
  type VersionChain,
} from "../src/version-chain.ts";
import {
  makeInMemoryVersionChain,
  versionChainConformance,
  type InMemoryVersionChain,
} from "../src/testing.ts";

const ACTOR = Option.some("u-author");
const ID = "00000000-0000-4000-8000-00000000abcd";

const setup = () => {
  const store = makeInMemoryVersionChain("posts");
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

describe("diffStates — the field-level change set", () => {
  it("a null set and a cleared value are present values: a clear is changed, never removed", () => {
    expect(diffStates({ summary: "s" }, { summary: null })).toStrictEqual({
      summary: { _tag: "changed", before: "s", after: null },
    });
    expect(diffStates({ summary: null }, { summary: "s" })).toStrictEqual({
      summary: { _tag: "changed", before: null, after: "s" },
    });
    expect(diffStates({ summary: null }, { summary: null })).toStrictEqual({});
  });

  it("an attribute absent on one side is added or removed, and null on the other is not absence", () => {
    expect(diffStates({ title: "a" }, { title: "a", summary: null })).toStrictEqual({
      summary: { _tag: "added", after: null },
    });
    expect(diffStates({ title: "a", summary: null }, { title: "a" })).toStrictEqual({
      summary: { _tag: "removed", before: null },
    });
    expect(diffStates({}, { body: "b" })).toStrictEqual({ body: { _tag: "added", after: "b" } });
    expect(diffStates({ body: "b" }, {})).toStrictEqual({ body: { _tag: "removed", before: "b" } });
  });

  it("equal states diff to the empty set, and unchanged columns are omitted", () => {
    expect(diffStates(initial, { ...initial })).toStrictEqual({});
    expect(diffStates({}, {})).toStrictEqual({});
    expect(R.keys(diffStates(initial, { ...initial, title: "Second" }))).toStrictEqual(["title"]);
  });

  it("is directed: swapping the sides swaps added / removed and before / after", () => {
    const forward = diffStates({ title: "a", gone: 1 }, { title: "b", fresh: 2 });
    expect(forward).toStrictEqual({
      title: { _tag: "changed", before: "a", after: "b" },
      gone: { _tag: "removed", before: 1 },
      fresh: { _tag: "added", after: 2 },
    });
    expect(diffStates({ title: "b", fresh: 2 }, { title: "a", gone: 1 })).toStrictEqual({
      title: { _tag: "changed", before: "b", after: "a" },
      fresh: { _tag: "removed", before: 2 },
      gone: { _tag: "added", after: 1 },
    });
  });

  it("compares JSON structurally: by content, not by reference, and ignoring key order", () => {
    const meta = { tags: ["a", "b"], seo: { title: "t", index: true } };
    const sameContent = { seo: { index: true, title: "t" }, tags: ["a", "b"] };
    expect(diffStates({ meta }, { meta: sameContent })).toStrictEqual({});
    // An array is ordered, and a nested change is a change of the column.
    const reordered = { ...meta, tags: ["b", "a"] };
    expect(diffStates({ meta }, { meta: reordered })).toStrictEqual({
      meta: { _tag: "changed", before: meta, after: reordered },
    });
    const nested = { ...meta, seo: { title: "t", index: false } };
    expect(diffStates({ meta }, { meta: nested })).toStrictEqual({
      meta: { _tag: "changed", before: meta, after: nested },
    });
  });

  it("compares a Date by its instant and a bigint by value, never by their JSON spelling", () => {
    const at = "2026-01-01T00:00:00.000Z";
    // A fresh Date each call: equal instants, never the same object.
    const date = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
    expect(diffStates({ at: date(at), n: 10n }, { at: date(at), n: 10n })).toStrictEqual({});
    const later = date("2026-01-01T00:00:00.001Z");
    expect(diffStates({ at: date(at) }, { at: later })).toStrictEqual({
      at: { _tag: "changed", before: date(at), after: later },
    });
    // A Date is not the ISO string it serialises to, and a bigint is not the number.
    expect(diffStates({ at: date(at) }, { at })).toStrictEqual({
      at: { _tag: "changed", before: date(at), after: at },
    });
    expect(diffStates({ n: 10n }, { n: 10 })).toStrictEqual({
      n: { _tag: "changed", before: 10n, after: 10 },
    });
    expect(diffStates({ n: 10n }, { n: 11n })).toStrictEqual({
      n: { _tag: "changed", before: 10n, after: 11n },
    });
  });

  it("compares a content-addressed document reference by hash: changed or unchanged", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect(diffStates({ body: first }, { body: first })).toStrictEqual({});
    expect(diffStates({ body: first }, { body: second })).toStrictEqual({
      body: { _tag: "changed", before: first, after: second },
    });
  });
});

describe("compare — two getVersion reads and diffStates", () => {
  const created = async () => {
    const context = setup();
    await context.run(
      context.chain.create({ id: Option.some(ID), state: initial, actorId: ACTOR }),
    );
    return context;
  };

  it.each([0n, 1n])("the same version on both sides (%s) is the empty set", async (version) => {
    const { chain, run } = await created();
    await run(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
    const same = await run(chain.compare(ID, version, version));
    expect(same.changes).toStrictEqual({});
    expect([same.from.version, same.to.version]).toStrictEqual([version, version]);
  });

  it("reports what the tri-state patch did: a set and a clear change, a carry-forward does not", async () => {
    const { store, chain, run } = await created();
    await run(
      chain.update({
        id: ID,
        patch: { title: "Second", summary: null, body: undefined },
        actorId: ACTOR,
      }),
    );
    const comparison = await run(chain.compare(ID, 0n, 1n));
    expect(comparison.changes).toStrictEqual({
      title: { _tag: "changed", before: "First", after: "Second" },
      summary: { _tag: "changed", before: "s", after: null },
    });
    expect(comparison.from).toMatchObject({ version: 0n, action: "create", state: initial });
    expect(comparison.to).toMatchObject({ version: 1n, action: "update" });
    // Read-only.
    expect(store.rows()).toHaveLength(2);
  });

  it("reports a column a version gained as added, and one a restore dropped as removed", async () => {
    const { chain, run } = await created();
    await run(chain.update({ id: ID, patch: { subtitle: null }, actorId: ACTOR }));
    await run(chain.restoreVersion(ID, 0n, ACTOR));
    expect((await run(chain.compare(ID, 0n, 1n))).changes).toStrictEqual({
      subtitle: { _tag: "added", after: null },
    });
    expect((await run(chain.compare(ID, 1n, 2n))).changes).toStrictEqual({
      subtitle: { _tag: "removed", before: null },
    });
  });

  it("a tombstone on the to side is its action, not an attribute: the state it carried forward is unchanged", async () => {
    const { chain, run } = await created();
    await run(chain.delete(ID, ACTOR));
    const comparison = await run(chain.compare(ID, 0n, 1n));
    expect(comparison.changes).toStrictEqual({});
    expect([comparison.from.action, comparison.to.action]).toStrictEqual(["create", "delete"]);
  });

  it("a tombstone on the from side: a restore over it reports only what the content did", async () => {
    const { chain, run } = await created();
    await run(chain.delete(ID, ACTOR));
    await run(chain.restore({ id: ID, patch: { title: "Back" }, actorId: ACTOR }));
    const comparison = await run(chain.compare(ID, 1n, 2n));
    expect(comparison.changes).toStrictEqual({
      title: { _tag: "changed", before: "First", after: "Back" },
    });
    expect([comparison.from.action, comparison.to.action]).toStrictEqual(["delete", "update"]);
    // Across the tombstone, from the live version before it, the same change.
    expect((await run(chain.compare(ID, 0n, 2n))).changes).toStrictEqual(comparison.changes);
  });

  it.each([
    ["from", 8n, 1n, 8n, [8n]],
    ["to", 0n, 9n, 9n, [0n, 9n]],
    ["from and to", 8n, 9n, 8n, [8n]],
  ] as const)(
    "fails VersionNotFound for a missing %s version, naming it (from first)",
    async (_side, from, to, missing, read) => {
      const { store, run, exit } = await created();
      // Every snapshot read, logged before it yields: a compare that read both
      // versions concurrently would log `to` even when `from` is missing.
      const reads: Array<readonly [string, bigint]> = [];
      const chain = defineVersionChain("posts", {
        ...store,
        getVersion: (id, version) =>
          Effect.gen(function* () {
            reads.push([id, version]);
            yield* Effect.yieldNow;
            return yield* store.getVersion(id, version);
          }),
      });
      await run(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
      reads.length = 0;
      const error = Option.getOrUndefined(
        Exit.findErrorOption(await exit(chain.compare(ID, from, to))),
      );
      expect(error).toBeInstanceOf(VersionNotFound);
      expect(error).toMatchObject({ type: "posts", id: ID, version: missing });
      expect(reads).toStrictEqual(read.map((version) => [ID, version]));
      expect(store.rows()).toHaveLength(2);
    },
  );

  it("fails VersionNotFound for an unknown node, and for a version a partial chain cannot rebuild", async () => {
    const { store, chain, run, exit } = await created();
    await run(chain.update({ id: ID, patch: { title: "Second" }, actorId: ACTOR }));
    expect(tagOf(await exit(chain.compare("unknown", 0n, 0n)))).toStrictEqual(
      Option.some("VersionNotFound"),
    );
    store.dropState(ID, 1n);
    const partial = Option.getOrUndefined(
      Exit.findErrorOption(await exit(chain.compare(ID, 0n, 1n))),
    );
    expect(partial).toMatchObject({ _tag: "VersionNotFound", version: 1n });
    const partialFrom = Option.getOrUndefined(
      Exit.findErrorOption(await exit(chain.compare(ID, 1n, 0n))),
    );
    expect(partialFrom).toMatchObject({ _tag: "VersionNotFound", version: 1n });
    expect(store.rows()).toHaveLength(2);
  });
});

describe("beforeAppend — the kernel's hook layer over the port (pulpit#45, pulpit#246)", () => {
  const hookedChain = (
    hook: (event: ChainAppendEvent) => Effect.Effect<ChainPatch, "refused">,
    port: (store: InMemoryVersionChain) => VersionChain<never, never> = (store) => store,
  ) => {
    const store = makeInMemoryVersionChain("posts");
    const events: Array<ChainAppendEvent> = [];
    const chain = defineVersionChain("posts", port(store), {
      beforeAppend: (event) =>
        Effect.suspend(() => {
          events.push(event);
          return hook(event);
        }),
    });
    return { store, chain, events };
  };

  it("shows each write its action, prior head and patch, and stores the hook's patch", async () => {
    const { store, chain, events } = hookedChain((event) =>
      Effect.succeed(
        event.action === "delete" ? event.patch : { ...event.patch, stamped: event.action },
      ),
    );
    const { id } = await Effect.runPromise(
      chain.create({ id: Option.some(ID), state: { title: "a" }, actorId: ACTOR }),
    );
    await Effect.runPromise(chain.update({ id, patch: { title: "b" }, actorId: ACTOR }));
    await Effect.runPromise(chain.delete(id, ACTOR));
    await Effect.runPromise(chain.restore({ id, patch: {}, actorId: ACTOR }));
    await Effect.runPromise(chain.restoreVersion(id, 0n, ACTOR));
    expect(
      events.map((event) => [
        event.action,
        Option.map(event.prior, (prior) => prior.version),
        event.patch,
      ]),
    ).toEqual([
      ["create", Option.none(), { title: "a" }],
      ["update", Option.some(0n), { title: "b" }],
      ["delete", Option.some(1n), {}],
      ["restore", Option.some(2n), {}],
      ["restoreVersion", Option.some(3n), { title: "a", stamped: "create" }],
    ]);
    expect(store.rows().map((row) => [row.action, row.state])).toEqual([
      ["create", { title: "a", stamped: "create" }],
      ["update", { title: "b", stamped: "update" }],
      ["delete", { title: "b", stamped: "update" }],
      ["update", { title: "b", stamped: "restore" }],
      ["update", { title: "a", stamped: "restoreVersion" }],
    ]);
  });

  it("a hooked create that names no id mints a UUID before the hook, which is shown it", async () => {
    const { store, chain, events } = hookedChain((event) => Effect.succeed(event.patch));
    const { id } = await Effect.runPromise(
      chain.create({ id: Option.none(), state: { title: "a" }, actorId: ACTOR }),
    );
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(events.map((event) => event.id)).toEqual([id]);
    expect(store.rows().map((row) => row.id)).toEqual([id]);
  });

  it("an unchanged restoreVersion is the port's own restoreVersion", async () => {
    const calls: Array<string> = [];
    const { store, chain } = hookedChain(
      (event) => Effect.succeed(event.patch),
      (port) => ({
        ...port,
        restoreVersion: (id, version, actorId, precondition) =>
          Effect.suspend(() => {
            calls.push("restoreVersion");
            return port.restoreVersion(id, version, actorId, precondition);
          }),
        restore: (input) =>
          Effect.suspend(() => {
            calls.push("restore");
            return port.restore(input);
          }),
      }),
    );
    await Effect.runPromise(
      chain.create({ id: Option.some(ID), state: { title: "a" }, actorId: ACTOR }),
    );
    await Effect.runPromise(chain.update({ id: ID, patch: { title: "b" }, actorId: ACTOR }));
    await Effect.runPromise(chain.restoreVersion(ID, 0n, ACTOR));
    expect(calls).toEqual(["restoreVersion"]);
    expect(store.rows().at(-1)?.state).toEqual({ title: "a" });
  });

  it("an unchanged restoreVersion of a localised version is the port's own, locale level and all", async () => {
    const calls: Array<string> = [];
    const store = makeInMemoryVersionChain("posts");
    const chain = defineVersionChain(
      "posts",
      {
        ...store,
        restoreVersion: (id, version, actorId, precondition) =>
          Effect.suspend(() => {
            calls.push("restoreVersion");
            return store.restoreVersion(id, version, actorId, precondition);
          }),
      },
      {
        beforeAppend: (event) => Effect.succeed(event.patch),
        beforeAppendLocales: (event) => Effect.succeed(event.locales ?? {}),
      },
    );
    await Effect.runPromise(
      chain.create({
        id: Option.some(ID),
        state: { title: "a" },
        locales: { en: { name: "A" } },
        actorId: ACTOR,
      }),
    );
    await Effect.runPromise(
      chain.update({
        id: ID,
        patch: { title: "b" },
        locales: { en: { name: "B" } },
        actorId: ACTOR,
      }),
    );
    await Effect.runPromise(chain.restoreVersion(ID, 0n, ACTOR));
    expect(calls).toEqual(["restoreVersion"]);
    expect(store.rows().at(-1)?.locales).toEqual({ en: { name: "A" } });
  });

  it("a restoreVersion the hook changes is appended through restore, with the restored locale level", async () => {
    const locales = (event: ChainAppendEvent) => Effect.succeed(event.locales ?? {});
    const store = makeInMemoryVersionChain("posts");
    const chain = defineVersionChain("posts", store, {
      beforeAppend: (event) =>
        Effect.succeed(
          event.action === "restoreVersion" ? { ...event.patch, restored: true } : event.patch,
        ),
      beforeAppendLocales: locales,
    });
    await Effect.runPromise(
      chain.create({
        id: Option.some(ID),
        state: { title: "a" },
        locales: { en: { name: "A" } },
        actorId: ACTOR,
      }),
    );
    await Effect.runPromise(
      chain.update({
        id: ID,
        patch: { title: "b" },
        locales: { fr: { name: "B" } },
        actorId: ACTOR,
      }),
    );
    await Effect.runPromise(chain.restoreVersion(ID, 0n, ACTOR));
    const restored = store.rows().at(-1);
    expect(restored?.state).toEqual({ title: "a", restored: true });
    expect(restored?.locales).toEqual({ en: { name: "A" } });
  });

  it("a hook that changes a delete's patch is a defect, and nothing is written", async () => {
    const { store, chain } = hookedChain((event) =>
      Effect.succeed({ ...event.patch, stamped: event.action }),
    );
    await Effect.runPromise(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR }));
    const result = await Effect.runPromiseExit(chain.delete(ID, ACTOR));
    expect(Exit.hasDies(result)).toBe(true);
    expect(store.rows()).toHaveLength(1);
  });

  it("the append is pinned to the head the hook saw: a writer in between makes it StaleVersion", async () => {
    const store = makeInMemoryVersionChain("posts");
    let interleave = true;
    const chain = defineVersionChain("posts", store, {
      beforeAppend: (event) =>
        Effect.gen(function* () {
          if (interleave && event.action === "update") {
            interleave = false;
            yield* store.update({ id: event.id, patch: { title: "interloper" }, actorId: ACTOR });
          }
          return event.patch;
        }),
    });
    await Effect.runPromise(
      chain.create({ id: Option.some(ID), state: { title: "a" }, actorId: ACTOR }),
    );
    const result = await Effect.runPromiseExit(
      chain.update({ id: ID, patch: { title: "mine" }, actorId: ACTOR }),
    );
    expect(
      Exit.isFailure(result) &&
        Option.exists(Exit.findErrorOption(result), Schema.is(StaleVersion)),
    ).toBe(true);
    expect(store.rows().map((row) => row.state["title"])).toEqual(["a", "interloper"]);
  });

  it("a refusing hook appends nothing, and the caller's expected version is still checked", async () => {
    const { store, chain } = hookedChain((event) =>
      event.action === "update" ? Effect.fail("refused") : Effect.succeed(event.patch),
    );
    await Effect.runPromise(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR }));
    const refused = await Effect.runPromiseExit(
      chain.update({ id: ID, patch: {}, actorId: ACTOR }),
    );
    expect(Exit.isFailure(refused) && Exit.findErrorOption(refused)).toEqual(
      Option.some("refused"),
    );
    const stale = await Effect.runPromiseExit(chain.delete(ID, ACTOR, { expectedVersion: 5n }));
    expect(
      Exit.isFailure(stale) && Option.exists(Exit.findErrorOption(stale), Schema.is(StaleVersion)),
    ).toBe(true);
    expect(store.rows()).toHaveLength(1);
  });

  it("an update over a missing or tombstoned node is NodeNotFound before any hook runs", async () => {
    const { store, chain, events } = hookedChain((event) => Effect.succeed(event.patch));
    const missing = await Effect.runPromiseExit(
      chain.update({ id: ID, patch: {}, actorId: ACTOR }),
    );
    expect(
      Exit.isFailure(missing) &&
        Option.map(Exit.findErrorOption(missing), (error) =>
          P.isString(error) ? error : error._tag,
        ),
    ).toEqual(Option.some("NodeNotFound"));
    await Effect.runPromise(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR }));
    await Effect.runPromise(store.delete(ID, ACTOR));
    events.length = 0;
    const tombstoned = await Effect.runPromiseExit(
      chain.update({ id: ID, patch: {}, actorId: ACTOR }),
    );
    expect(Exit.isFailure(tombstoned)).toBe(true);
    expect(events).toEqual([]);
    const alreadyDeleted = await Effect.runPromise(chain.delete(ID, ACTOR));
    expect(alreadyDeleted.alreadyDeleted).toBe(true);
    expect(events).toEqual([]);
  });

  it("a head with no reconstructable state is a defect for a hooked write", async () => {
    const { store, chain } = hookedChain((event) => Effect.succeed(event.patch));
    await Effect.runPromise(chain.create({ id: Option.some(ID), state: {}, actorId: ACTOR }));
    store.dropState(ID, 0n);
    expect(
      Exit.hasDies(
        await Effect.runPromiseExit(chain.update({ id: ID, patch: {}, actorId: ACTOR })),
      ),
    ).toBe(true);
  });
});

// ── The port's conformance suite, against the in-memory chain ─────────

versionChainConformance(
  {
    type: "posts",
    make: async () => {
      const chain = makeInMemoryVersionChain("posts");
      return { chain, dropState: chain.dropState, raceNextAppend: chain.raceNextAppend };
    },
    run: (effect) => Effect.runPromiseExit(effect),
  },
  { describe, it, expect },
);
