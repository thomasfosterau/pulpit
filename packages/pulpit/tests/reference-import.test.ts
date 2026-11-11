/**
 * External reference import (pulpit#209) over the in-memory chain, leaf and
 * external-id stores: the declaration checks, the upsert (create, update,
 * no-op), each merge mode, a pre-attached id, the per-authority uniqueness,
 * the batch summary and every conflict reason, after preferenceflow's
 * `packages/jobs/src/apply/write.ts` behaviour.
 *
 * @module tests/reference-import
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import {
  defineReferenceImport,
  MAX_IMPORT_BATCH,
  ReferenceImportDeclarationError,
  type ImportBatch,
  type MergeMode,
} from "../src/reference-import.ts";
import {
  defineSubtype,
  ownedAccess,
  WriteRejected,
  type BeforeWriteHook,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryExternalIdStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "../src/testing.ts";
import { contributor, gardeneriaPolicy, member, NOW } from "./fixtures.ts";

const bot: ViewerAccount = { id: "u-bot", role: "contributor" };

const FIELDS = {
  name: "overwrite",
  abbreviation: "coalesce",
  colour: "curated-wins",
} satisfies Readonly<Record<string, MergeMode>>;

/** A reference `parties` leaf, its import, and the request viewer a test steers. */
const world = (options: { readonly hooks?: ReadonlyArray<BeforeWriteHook<never, never>> } = {}) => {
  let viewer: Viewer = Option.some(contributor);
  const chain = makeInMemoryVersionChain("parties");
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["name", "abbreviation", "colour", "notes"],
    now: NOW,
  });
  const leaf = {
    type: "parties",
    access: { kind: "reference" } as const,
    chain,
    leaves,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
    hooks: Effect.succeed({ before: options.hooks ?? [], after: [] }),
  };
  const ids = makeInMemoryExternalIdStore();
  const imports = defineReferenceImport({
    leaf,
    ids,
    authorities: ["aec", "wikidata"],
    actor: bot,
    fields: FIELDS,
  });
  const ops = defineSubtype(leaf);
  return {
    chain,
    ids,
    imports,
    ops,
    as: (account: Viewer) => {
      viewer = account;
    },
    row: (id: string) => Effect.runSync(leaves.get(id)),
  };
};

const batch = (
  // oxlint-disable-next-line effect/prefer-option-over-null -- a feed record's values are a tri-state `ChainPatch`: `null` clears, an absent or `undefined` key says nothing
  records: ReadonlyArray<readonly [string, Readonly<Record<string, string | null | undefined>>]>,
  authority = "aec",
): ImportBatch => ({
  authority,
  records: Arr.map(records, ([externalId, values]) => ({ externalId, values })),
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Exit.match(Effect.runSyncExit(effect), {
    onSuccess: () => "succeeded",
    onFailure: (cause) => String(cause),
  });

/** The external id's node, as linked. */
const nodeOf = (ids: ReturnType<typeof world>["ids"], externalId: string): string =>
  Option.match(
    Arr.findFirst(ids.links(), (link) => link.externalId === externalId),
    { onNone: () => "unlinked", onSome: (link) => link.nodeId },
  );

describe("defineReferenceImport's declaration", () => {
  const chain = makeInMemoryVersionChain("parties");
  const base = {
    type: "parties",
    access: { kind: "reference" } as const,
    chain,
    leaves: makeInMemoryLeafStore(chain, { columns: ["name"], now: NOW }),
    viewer: Effect.succeed(Option.none<ViewerAccount>()),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
  };
  const declare =
    (overrides: {
      readonly leaf?:
        | typeof base
        | (Omit<typeof base, "access"> & { readonly access: ReturnType<typeof ownedAccess> });
      readonly actor?: ViewerAccount;
      readonly authorities?: ReadonlyArray<string>;
      readonly fields?: Readonly<Record<string, MergeMode>>;
    }) =>
    () =>
      defineReferenceImport({
        leaf: overrides.leaf ?? base,
        ids: makeInMemoryExternalIdStore(),
        authorities: overrides.authorities ?? ["aec"],
        actor: overrides.actor ?? bot,
        fields: overrides.fields ?? { name: "overwrite" },
      });

  it.each([
    { label: "an owned leaf", input: { leaf: { ...base, access: ownedAccess() } } },
    { label: "an actor below the corpus-write rung", input: { actor: member } },
    { label: "no authority", input: { authorities: [] } },
    { label: "a repeated authority", input: { authorities: ["aec", "aec"] } },
    { label: "no field", input: { fields: {} } },
    { label: "a field the view lacks", input: { fields: { colour: "overwrite" } } },
    { label: "a view-owned column", input: { fields: { version: "overwrite" } } },
  ] as const)("throws for $label", ({ input }) => {
    expect(declare(input)).toThrow(ReferenceImportDeclarationError);
  });

  it("accepts a well-formed declaration", () => {
    expect(declare({})).not.toThrow();
  });
});

describe("the upsert", () => {
  it("creates a node as the actor and links it, then appends nothing for identical data", () => {
    const { chain, ids, imports, row } = world();
    const feed = batch([["36", { name: "Greens", abbreviation: "GRN" }]]);
    const first = run(imports.run(feed));
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0, conflicts: [] });
    const id = nodeOf(ids, "36");
    expect(first.written).toEqual([{ externalId: "36", id, version: 0n, action: "created" }]);
    expect(Arr.map(chain.rows(), (version) => version.actorId)).toEqual([Option.some(bot.id)]);
    expect(row(id)).toEqual(
      Option.some(expect.objectContaining({ name: "Greens", abbreviation: "GRN" })),
    );

    const again = run(imports.run(feed));
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, written: [] });
    expect(chain.rows()).toHaveLength(1);
  });

  it("updates only what changed, against the head it read, and ignores undeclared keys", () => {
    const { chain, ids, imports, row } = world();
    run(imports.run(batch([["36", { name: "Greens", abbreviation: "GRN" }]])));
    const id = nodeOf(ids, "36");
    const second = run(imports.run(batch([["36", { name: "The Greens", notes: "not declared" }]])));
    expect(second).toMatchObject({ updated: 1, unchanged: 0 });
    expect(Arr.map(chain.rows(), (version) => version.state)).toEqual([
      { name: "Greens", abbreviation: "GRN" },
      { name: "The Greens", abbreviation: "GRN" },
    ]);
    expect(Option.map(row(id), (party) => party["notes"])).toEqual(Option.some(undefined));
  });

  it("overwrite replaces and clears; coalesce keeps the node's value on null; an absent key carries", () => {
    const { ids, imports, row } = world();
    run(imports.run(batch([["36", { name: "Greens", abbreviation: "GRN" }]])));
    const id = nodeOf(ids, "36");
    run(imports.run(batch([["36", { name: null, abbreviation: null }]])));
    expect(row(id)).toEqual(
      Option.some(expect.objectContaining({ name: null, abbreviation: "GRN" })),
    );
    run(imports.run(batch([["36", { abbreviation: "AG" }]])));
    expect(row(id)).toEqual(
      Option.some(expect.objectContaining({ name: null, abbreviation: "AG" })),
    );
  });

  it("curated-wins keeps a value someone else wrote since the last import, and follows the feed otherwise", () => {
    const { ids, imports, ops, row } = world();
    run(imports.run(batch([["36", { name: "Greens", colour: "green" }]])));
    const id = nodeOf(ids, "36");
    // The feed changes the colour, nobody curated it: the feed wins.
    run(imports.run(batch([["36", { colour: "lime" }]])));
    expect(Option.map(row(id), (party) => party["colour"])).toEqual(Option.some("lime"));
    // A curator edits it; the next import keeps the curator's value.
    run(ops.update({ id, patch: { colour: "#10a020" } }));
    const after = run(imports.run(batch([["36", { colour: "olive", name: "The Greens" }]])));
    expect(after.updated).toBe(1);
    expect(row(id)).toEqual(
      Option.some(expect.objectContaining({ colour: "#10a020", name: "The Greens" })),
    );
  });
});

describe("a pre-attached id", () => {
  it("links a curated node, which the next import updates instead of duplicating", () => {
    const { chain, imports, ops, row } = world();
    const { id } = run(
      ops.create({ id: Option.none(), state: { name: "Curated Greens", colour: "#10a020" } }),
    );
    expect(run(imports.attach({ authority: "aec", externalId: "36", id }))).toEqual({
      changed: true,
    });
    expect(run(imports.attach({ authority: "aec", externalId: "36", id }))).toEqual({
      changed: false,
    });
    const summary = run(
      imports.run(batch([["36", { name: "Greens", abbreviation: "GRN", colour: "green" }]])),
    );
    expect(summary).toMatchObject({ created: 0, updated: 1 });
    // No baseline yet: the curated colour is kept, the empty abbreviation filled,
    // and `overwrite` takes the name.
    expect(row(id)).toEqual(
      Option.some(
        expect.objectContaining({ name: "Greens", abbreviation: "GRN", colour: "#10a020" }),
      ),
    );
    expect(Arr.dedupe(Arr.map(chain.rows(), (version) => version.id))).toEqual([id]);
  });

  it("is gated like a write to the node, and an id names one node per authority", () => {
    const { imports, ops, as } = world();
    const first = run(ops.create({ id: Option.none(), state: { name: "One" } })).id;
    const second = run(ops.create({ id: Option.none(), state: { name: "Two" } })).id;
    run(imports.attach({ authority: "aec", externalId: "1", id: first }));
    expect(failure(imports.attach({ authority: "aec", externalId: "1", id: second }))).toContain(
      "ExternalIdTaken",
    );
    expect(failure(imports.attach({ authority: "aec", externalId: "2", id: first }))).toContain(
      "ExternalIdTaken",
    );
    // Another authority may name the same node, and reuse the same id string.
    expect(run(imports.attach({ authority: "wikidata", externalId: "1", id: second }))).toEqual({
      changed: true,
    });
    expect(failure(imports.attach({ authority: "isbn", externalId: "1", id: first }))).toContain(
      "UnknownAuthority",
    );
    expect(failure(imports.attach({ authority: "aec", externalId: "3", id: "missing" }))).toContain(
      "NodeNotFound",
    );
    as(Option.some(member));
    expect(failure(imports.attach({ authority: "aec", externalId: "3", id: second }))).toContain(
      "Forbidden",
    );
    as(Option.none());
    expect(failure(imports.attach({ authority: "aec", externalId: "3", id: second }))).toContain(
      "Unauthorized",
    );
  });
});

describe("a batch", () => {
  it("counts every outcome, and a repeated id is a conflict against the earlier record", () => {
    const { imports } = world();
    run(
      imports.run(
        batch([
          ["1", { name: "One" }],
          ["2", { name: "Two" }],
        ]),
      ),
    );
    const summary = run(
      imports.run(
        batch([
          ["1", { name: "One" }],
          ["2", { name: "Deux" }],
          ["3", { name: "Three" }],
          ["3", { name: "Trois" }],
        ]),
      ),
    );
    expect(summary).toMatchObject({
      created: 1,
      updated: 1,
      unchanged: 1,
      conflicts: [{ externalId: "3", reason: "duplicate" }],
    });
  });

  it("keeps ids apart by authority", () => {
    const { ids, imports } = world();
    run(imports.run(batch([["36", { name: "AEC party" }]], "aec")));
    run(imports.run(batch([["36", { name: "Wikidata item" }]], "wikidata")));
    expect(Arr.map(ids.links(), (link) => link.authority)).toEqual(["aec", "wikidata"]);
    expect(ids.links()[0]?.nodeId).not.toBe(ids.links()[1]?.nodeId);
  });

  it("refuses an unknown authority and an oversized batch before reading anything", () => {
    const { chain, imports } = world();
    expect(failure(imports.run(batch([["1", { name: "One" }]], "isbn")))).toContain(
      "UnknownAuthority",
    );
    const oversized = batch(
      Arr.makeBy(MAX_IMPORT_BATCH + 1, (index) => [String(index), { name: "x" }] as const),
    );
    expect(failure(imports.run(oversized))).toContain("ImportBatchTooLarge");
    expect(chain.rows()).toEqual([]);
  });

  it("settles a concurrent edit, a tombstone and a hook's refusal as conflicts, and writes the rest", () => {
    const refuse: BeforeWriteHook<never, never> = {
      name: "refuse-rejected",
      run: (event) =>
        event.patch["name"] === "rejected"
          ? Effect.fail(
              new WriteRejected({
                type: event.type,
                id: event.id,
                action: event.action,
                reason: "no",
              }),
            )
          : Effect.succeed(event.patch),
    };
    const { chain, ids, imports, ops } = world({ hooks: [refuse] });
    run(
      imports.run(
        batch([
          ["raced", { name: "Raced" }],
          ["gone", { name: "Gone" }],
          ["fine", { name: "Fine" }],
        ]),
      ),
    );
    chain.raceNextAppend(nodeOf(ids, "raced"));
    run(ops.delete(nodeOf(ids, "gone")));
    const summary = run(
      imports.run(
        batch([
          ["raced", { name: "Raced again" }],
          ["gone", { name: "Gone again" }],
          ["fine", { name: "Fine again" }],
          ["new", { name: "rejected" }],
        ]),
      ),
    );
    expect(summary).toMatchObject({
      created: 0,
      updated: 1,
      conflicts: [
        { externalId: "raced", reason: "stale" },
        { externalId: "gone", reason: "deleted" },
        { externalId: "new", reason: "rejected" },
      ],
    });
  });

  it("completes a link whose create never landed, under the linked id", () => {
    const { ids, imports, row } = world();
    run(ids.link("aec", "36", "node-from-a-failed-create"));
    const summary = run(imports.run(batch([["36", { name: "Greens" }]])));
    expect(summary.created).toBe(1);
    expect(row("node-from-a-failed-create")).toEqual(
      Option.some(expect.objectContaining({ name: "Greens" })),
    );
  });

  it("reports a lost link race as taken, creating nothing", () => {
    const { chain, ids, imports } = world();
    const racing = {
      ...ids,
      lookup: () => Effect.succeed(run(ids.lookup("aec", []))),
      link: () => Effect.succeed("taken" as const),
    };
    const raced = defineReferenceImport({
      leaf: {
        type: "parties",
        access: { kind: "reference" },
        chain,
        leaves: makeInMemoryLeafStore(chain, { columns: ["name"], now: NOW }),
        viewer: Effect.succeedNone,
        policy: gardeneriaPolicy,
        followers: makeInMemoryFollowers([]),
        toResource: (party: LeafRow) => party,
      },
      ids: racing,
      authorities: ["aec"],
      actor: bot,
      fields: { name: "overwrite" },
    });
    expect(run(raced.run(batch([["36", { name: "Greens" }]]))).conflicts).toEqual([
      { externalId: "36", reason: "taken" },
    ]);
    expect(run(imports.run(batch([]))).written).toEqual([]);
    expect(chain.rows()).toEqual([]);
  });
});
