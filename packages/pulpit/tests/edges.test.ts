/**
 * The edge operations factory against the in-memory seams.
 *
 * - Ported from gardeneria's edge families (`defineEdgeOpsE` and the
 *   integration tests of its callers): `anatomy-chemistry.test.ts` (the
 *   corpus-write gate, the get / delete round trip, idempotent re-assertion,
 *   reading an assertion from either end), `blogs-pages-albums.test.ts` (the
 *   moderator `writeGate`, a collision on a unique key that does not cover the
 *   end resolving to the stored row) and `disorders.test.ts` (the owned-child
 *   edge: its gate inherited from the owned end, a stranger refused as
 *   `NotFound`, read and list hidden alike, several edges at one node, a hard
 *   delete that leaves the node alone).
 * - pulpit's policy on top: the endpoint-visibility matrix (`EDGE-001`: the
 *   list filter never disagrees with the per-endpoint predicate, for every
 *   endpoint state × viewer, and `list` ≡ `get` end to end over two ends),
 *   the endpoint lifecycle (a tombstoned end hides its edges until the node
 *   is restored, except from the view-deleted rung, pulpit#93), the declared
 *   cardinality limits (counting only readable edges with live ends,
 *   pulpit#77 / pulpit#93), what a create discloses (nothing about a
 *   hidden edge, pulpit#93), and a reference end's followers arm agreeing
 *   with the endpoint leaf's own `get` (pulpit#92).
 *
 * @module tests/edges
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import {
  canViewEndpoint,
  defineEdgeOps,
  EdgeDeclarationError,
  endpointColumn,
  endpointFilter,
  rungGate,
  type EdgeDefinition,
  type EdgeEnd,
  type EdgeRow,
  type EdgeValues,
  type EdgeWriteGate,
} from "../src/edges.ts";
import {
  always,
  and,
  anyOf,
  eq,
  evaluate,
  type FilterRow,
  gt,
  gte,
  isIn,
  isNull,
  type ListFilter,
  lt,
  lte,
  MAX_SET_VALUES,
  ne,
  never,
  noneOf,
  notPublished,
  or,
  published,
} from "../src/filter.ts";
import { renameColumns } from "../src/internal/filter-columns.ts";
import {
  defineSubtype,
  MAX_PAGE_LIMIT,
  nobodyFollows,
  ownedAccess,
  requireWriter,
  type AccessPolicy,
  type FollowerSeam,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type { ColumnValue, VersionAction } from "../src/version-chain.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryNodes,
  type InMemoryEdgeStore,
  type InMemoryFollowing as Following,
  type InMemoryNodes,
} from "../src/testing.ts";
import {
  ABSENT,
  admin,
  contributor,
  follower,
  gardeneriaPolicy,
  member,
  moderator,
  NOW,
  otherMember,
} from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const errorOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<Option.Option<E>> =>
  Exit.findErrorOption(await Effect.runPromiseExit(effect));
const tagOf = async <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Option.map(await errorOf(effect), (error) => error._tag);

const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();

/**
 * gardeneria's axes with the two read rungs split: a moderator sees
 * tombstones but not `private` rows or drafts, which only an admin sees. The
 * view-deleted rung's reading of a tombstoned end (pulpit#93) is visible only
 * when the rungs differ.
 */
const splitPolicy: AccessPolicy = {
  ...gardeneriaPolicy,
  canViewPrivate: (account) => account.role === "admin",
};

/** A write's answer without its minted id: what a caller can compare across two worlds. */
const answerOf = <E extends { readonly _tag: string }>(
  effect: Effect.Effect<{ readonly created: boolean }, E>,
) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.match(exit, {
      onSuccess: (written) => ({ created: written.created }),
      onFailure: () =>
        Option.match(Exit.findErrorOption(exit), {
          onNone: () => ({ defect: true }),
          onSome: (error) => ({ ...error, _tag: error._tag }),
        }),
    }),
  );

/** `follower` follows `member`; nobody else follows anybody. */
const follows: FollowerSeam<Following, never> = {
  isFollower: (followerId, ownerId) =>
    Effect.succeed(followerId === follower.id && ownerId === member.id),
  following: (followerId) =>
    followerId === follower.id ? HashSet.make(member.id) : HashSet.empty(),
};

const viewers: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", anonymous],
  ["the owner", as(member)],
  ["a follower", as(follower)],
  ["a stranger", as(otherMember)],
  ["a contributor", as(contributor)],
  ["a moderator", as(moderator)],
];

/** A node's current-version row. */
const node = (
  id: string,
  columns: { readonly [column: string]: ColumnValue },
  action: VersionAction = "create",
): LeafRow => ({ ...columns, id, version: 0n, action });

/** An end over a reference leaf. */
const referenceEnd = (column: string, nodes: InMemoryNodes): EdgeEnd<never, never> => ({
  column,
  type: "subjects",
  access: { kind: "reference" },
  nodes,
});

/** An end over an owned leaf with the draft axis. */
const ownedEnd = (column: string, nodes: InMemoryNodes): EdgeEnd<never, never> => ({
  column,
  type: "entries",
  access: ownedAccess({ draft: true }),
  nodes,
});

type Definition = EdgeDefinition<EdgeValues, EdgeRow, EdgeRow, Following, never, never>;

/**
 * The in-memory store, recording what the operations ask of it: each list's
 * page window, and each cardinality count's `column:nodeId` (the node a SQL
 * store locks), in call order.
 */
const recorded = (store: InMemoryEdgeStore) => {
  let windows: ReadonlyArray<{ readonly limit: number; readonly offset: number }> = [];
  let counted: ReadonlyArray<string> = [];
  const edges: InMemoryEdgeStore = {
    ...store,
    list: (query) =>
      Effect.suspend(() => {
        windows = [...windows, { limit: query.limit, offset: query.offset }];
        return store.list(query);
      }),
    countAt: (query) =>
      Effect.suspend(() => {
        counted = [...counted, `${query.column}:${query.nodeId}`];
        return store.countAt(query);
      }),
  };
  return { edges, seen: { windows: () => windows, counted: () => counted } };
};

/** One edge family over the in-memory store; the create input is the edge's column values. */
const family = (
  declaration: Pick<Definition, "ends" | "onConflict" | "writeGate">,
  uniqueKey: ReadonlyArray<string> = [],
  policy: AccessPolicy = gardeneriaPolicy,
) => {
  const { edges, seen } = recorded(
    makeInMemoryEdgeStore({ ends: declaration.ends, uniqueKey, now: NOW }),
  );
  let viewer: Viewer = anonymous;
  const ops = defineEdgeOps({
    ...declaration,
    type: "links",
    edges,
    viewer: Effect.sync(() => viewer),
    policy,
    followers: follows,
    values: (input: EdgeValues) => input,
    toResource: (row: EdgeRow) => row,
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const listed = async (who: Viewer, where: Parameters<typeof ops.list>[0]["where"] = always) => {
    const page = await run(actAs(who, ops.list({ limit: 1000, offset: 0, where })));
    return { ids: page.rows.map((row) => row.id), total: page.total };
  };
  return { edges, seen, ops, actAs, listed };
};

/** Two reference leaves, `s1` / `s2` and `p1` / `p2` / `p3`, all public. */
const twoReferenceLeaves = () => {
  const subjects = makeInMemoryNodes(["visibility"]);
  const parts = makeInMemoryNodes(["visibility"]);
  subjects.put(node("s1", { visibility: "public" }));
  subjects.put(node("s2", { visibility: "public" }));
  parts.put(node("p1", { visibility: "public" }));
  parts.put(node("p2", { visibility: "public" }));
  parts.put(node("p3", { visibility: "public" }));
  return { subjects, parts };
};

// ── Ported: an edge between two reference leaves ──────────────────────

describe("ported: an edge joining two reference leaves (gardeneria's anatomy / chemistry)", () => {
  const corpus = (declaration: Pick<Definition, "onConflict"> = {}, uniqueKey: string[] = []) => {
    const { subjects, parts } = twoReferenceLeaves();
    const links = family(
      {
        ...declaration,
        ends: {
          subject: referenceEnd("subjectId", subjects),
          part: referenceEnd("partId", parts),
        },
      },
      uniqueKey,
    );
    return { subjects, parts, ...links };
  };

  it("refuses an anonymous and a plain user's assertion, and admits a contributor's", async () => {
    const { ops, actAs } = corpus();
    const input = { subjectId: "s1", partId: "p1" };
    expect(await tagOf(actAs(anonymous, ops.create(input)))).toEqual(Option.some("Unauthorized"));
    expect(await tagOf(actAs(as(member), ops.create(input)))).toEqual(Option.some("Forbidden"));
    const created = await run(actAs(as(contributor), ops.create(input)));
    expect(created.created).toBe(true);
  });

  it("round-trips the id through get and delete, and the delete is hard", async () => {
    const { edges, subjects, ops, actAs } = corpus();
    const { id } = await run(
      actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1", note: "mature" })),
    );
    const read = await run(actAs(anonymous, ops.get(id)));
    expect(read).toMatchObject({ id, subjectId: "s1", partId: "p1", note: "mature" });

    expect(await run(actAs(as(contributor), ops.delete(id)))).toEqual({ id });
    expect(await tagOf(actAs(anonymous, ops.get(id)))).toEqual(Option.some("EdgeNotFound"));
    // No tombstone: the row is gone, and the node it joined is untouched.
    expect(edges.rows()).toEqual([]);
    expect(Option.isSome(await run(subjects.get("s1")))).toBe(true);
    expect(await tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(
      Option.some("EdgeNotFound"),
    );
  });

  it("makes a re-assertion idempotent rather than a failure", async () => {
    const { ops, actAs, listed } = corpus({ onConflict: "ignore" }, ["subjectId", "partId"]);
    const input = { subjectId: "s1", partId: "p1" };
    const first = await run(actAs(as(contributor), ops.create(input)));
    const second = await run(actAs(as(contributor), ops.create(input)));
    expect(second).toEqual({ id: first.id, created: false });
    expect(await listed(anonymous, eq("subjectId", "s1"))).toEqual({ ids: [first.id], total: 1 });
  });

  it("refuses a re-assertion below the gate with the gate's answer, never the stored edge", async () => {
    const { ops, actAs } = corpus({ onConflict: "ignore" }, ["subjectId", "partId"]);
    const input = { subjectId: "s1", partId: "p1" };
    await run(actAs(as(contributor), ops.create(input)));
    // The collision resolves only past the gate, so it never hands an id to a
    // caller who may not write (and an "ignore" re-assertion is still a write).
    expect(await tagOf(actAs(anonymous, ops.create(input)))).toEqual(Option.some("Unauthorized"));
    expect(await tagOf(actAs(as(member), ops.create(input)))).toEqual(Option.some("Forbidden"));
  });

  it("refuses a duplicate when the family resolves no conflict", async () => {
    const { edges, ops, actAs } = corpus({}, ["subjectId", "partId"]);
    const input = { subjectId: "s1", partId: "p1" };
    await run(actAs(as(contributor), ops.create(input)));
    expect(await tagOf(actAs(as(contributor), ops.create(input)))).toEqual(
      Option.some("EdgeConflict"),
    );
    expect(edges.rows()).toHaveLength(1);
  });

  it("reads an assertion from either end", async () => {
    const { ops, actAs, listed } = corpus();
    const { id } = await run(actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" })));
    await run(actAs(as(contributor), ops.create({ subjectId: "s2", partId: "p2" })));
    expect((await listed(anonymous, eq("subjectId", "s1"))).ids).toEqual([id]);
    expect((await listed(anonymous, eq("partId", "p1"))).ids).toEqual([id]);
  });

  it("lists in creation order with the unpaged total, the page clamped to the cap", async () => {
    const { ops, actAs, seen } = corpus();
    const pairs = [
      ["s1", "p1"],
      ["s1", "p2"],
      ["s2", "p1"],
      ["s2", "p3"],
    ] as const;
    const ids = await run(
      actAs(
        as(contributor),
        Effect.forEach(pairs, ([subjectId, partId]) => ops.create({ subjectId, partId }), {
          concurrency: 1,
        }),
      ),
    );
    const page = await run(actAs(anonymous, ops.list({ limit: 2, offset: 1, where: always })));
    expect(page.rows.map((row) => row.id)).toEqual([ids[1]?.id, ids[2]?.id]);
    expect(page.total).toBe(4);
    const huge = await run(actAs(anonymous, ops.list({ limit: 1e9, offset: -5, where: always })));
    expect(huge.rows.map((row) => row.id)).toEqual(ids.map((written) => written.id));
    await run(actAs(anonymous, ops.list({ limit: 0, offset: 1.5, where: always })));
    // The store is asked for at most the cap, whatever the request says
    // (SEC-INPUT-003): four rows alone can't tell a clamped limit from none.
    expect(seen.windows()).toEqual([
      { limit: 2, offset: 1 },
      { limit: MAX_PAGE_LIMIT, offset: 0 },
      { limit: 1, offset: 1 },
    ]);
  });

  it("reports a total of 0 for a page past the end, as the store's window column does", async () => {
    const { ops, actAs } = corpus();
    await run(actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" })));
    expect(await run(actAs(anonymous, ops.list({ limit: 10, offset: 5, where: always })))).toEqual({
      rows: [],
      total: 0,
    });
  });
});

// ── Ported: CMS rows on the moderator rung ────────────────────────────

describe("ported: CMS rows on the moderator rung (gardeneria's page collections and slugs)", () => {
  const moderatorGate = rungGate((policy) => policy.canModerate);

  it("a family with no ends is a plain bounded row family, written at the gate's rung", async () => {
    const { ops, actAs, listed } = family({ ends: {}, writeGate: moderatorGate });
    const input = { name: "Guides" };
    expect(await tagOf(actAs(anonymous, ops.create(input)))).toEqual(Option.some("Unauthorized"));
    expect(await tagOf(actAs(as(contributor), ops.create(input)))).toEqual(
      Option.some("Forbidden"),
    );
    const { id } = await run(actAs(as(moderator), ops.create(input)));
    expect(await run(actAs(anonymous, ops.get(id)))).toMatchObject({ name: "Guides" });
    expect(await listed(anonymous)).toEqual({ ids: [id], total: 1 });
    expect(await tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(Option.some("Forbidden"));
  });

  const slugs = (policy: AccessPolicy = gardeneriaPolicy) => {
    const pages = makeInMemoryNodes(["visibility"]);
    pages.put(node("page-1", { visibility: "public" }));
    pages.put(node("page-2", { visibility: "public" }));
    const links = family(
      {
        ends: {
          page: { column: "pageId", type: "pages", access: { kind: "reference" }, nodes: pages },
        },
        writeGate: moderatorGate,
        onConflict: "ignore",
      },
      // The unique variant does not cover the page: a path is claimed once.
      ["path", "collectionId"],
      policy,
    );
    return { pages, ...links };
  };

  it("resolves a second alias on the same path to the stored row, NULLs equal", async () => {
    const { edges, ops, actAs } = slugs();
    const first = await run(
      actAs(as(moderator), ops.create({ pageId: "page-1", path: "shared-alias" })),
    );
    const again = await run(
      actAs(as(moderator), ops.create({ pageId: "page-2", path: "shared-alias" })),
    );
    expect(again).toEqual({ id: first.id, created: false });
    expect(edges.rows()).toHaveLength(1);
    expect(edges.rows()[0]?.["pageId"]).toBe("page-1");
  });

  it("resolves a collision only to a readable edge whose every end is live: not a retired page's alias, even for the view-deleted rung", async () => {
    const { pages, ops, actAs } = slugs(splitPolicy);
    const retired = await run(
      actAs(as(moderator), ops.create({ pageId: "page-1", path: "retired" })),
    );
    // The page the stored alias points at is tombstoned. The view-deleted
    // rung reads its alias (pulpit#93) but can't link to a tombstone, so the
    // collision doesn't resolve to it (owner decision on pulpit#93).
    pages.put(node("page-1", { visibility: "public" }, "delete"));
    expect(await run(actAs(as(moderator), ops.get(retired.id)))).toMatchObject({
      pageId: "page-1",
    });
    expect(
      await errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "retired" }))),
    ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
  });

  it("never resolves a collision to an edge the viewer cannot read", async () => {
    const { pages, ops, actAs } = slugs(splitPolicy);
    await run(actAs(as(admin), ops.create({ pageId: "page-1", path: "hidden" })));
    // A private page is hidden from a moderator below the view-private rung
    // (splitPolicy), tombstoned or not: the collision must not hand back its
    // alias's id, and answers as any unresolved collision does.
    pages.put(node("page-1", { visibility: "private" }, "delete"));
    expect(
      await errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "hidden" }))),
    ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
  });
});

// ── Ported: an owned-child edge ───────────────────────────────────────

describe("ported: an owned-child edge whose gate is its owned end's (gardeneria's disorders)", () => {
  const observationsAndDisorders = () => {
    const observations = makeInMemoryNodes(["ownerId", "visibility"]);
    const disorders = makeInMemoryNodes([]);
    observations.put(node("o-public", { ownerId: member.id, visibility: "public" }));
    observations.put(node("o-private", { ownerId: member.id, visibility: "private" }));
    disorders.put(node("mildew", {}));
    disorders.put(node("chlorosis", {}));
    /** The observation's owner, or moderator+ (gardeneria's `requireObservationWriterE`). */
    const observationWriter: EdgeWriteGate<never, never> = ({ viewer, policy, edge }) => {
      const id = String(edge["observationId"]);
      return requireWriter(
        ownedAccess(),
        viewer,
        policy,
        { type: "observations", id },
        Effect.map(
          observations.get(id),
          Option.flatMap((row) => Option.liftPredicate(row["ownerId"], Predicate.isString)),
        ),
      );
    };
    const links = family(
      {
        ends: {
          observation: {
            column: "observationId",
            type: "observations",
            access: ownedAccess(),
            nodes: observations,
          },
          disorder: {
            column: "disorderId",
            type: "disorders",
            access: { kind: "reference" },
            nodes: disorders,
          },
        },
        writeGate: observationWriter,
        onConflict: "ignore",
      },
      ["observationId", "disorderId"],
    );
    return { disorders, ...links };
  };

  it("lets the observation's owner record a disorder they did not author", async () => {
    const { ops, actAs } = observationsAndDisorders();
    const { id } = await run(
      actAs(
        as(member),
        ops.create({ observationId: "o-public", disorderId: "mildew", severity: "high" }),
      ),
    );
    expect(await run(actAs(as(member), ops.get(id)))).toMatchObject({ severity: "high" });
  });

  it("refuses a stranger's write with NotFound, never Forbidden", async () => {
    const { ops, actAs } = observationsAndDisorders();
    // The contributor rung is not enough here, and a 403 would confirm the
    // private observation exists (SEC-AUTH-ENUM-001).
    expect(
      await errorOf(
        actAs(as(contributor), ops.create({ observationId: "o-private", disorderId: "mildew" })),
      ),
    ).toEqual(
      Option.some(
        expect.objectContaining({ _tag: "NodeNotFound", type: "observations", id: "o-private" }),
      ),
    );
  });

  it("refuses a stranger's retraction of a link they can see", async () => {
    const { ops, actAs } = observationsAndDisorders();
    const { id } = await run(
      actAs(as(member), ops.create({ observationId: "o-public", disorderId: "mildew" })),
    );
    expect(await run(actAs(as(otherMember), ops.get(id)))).toMatchObject({ id });
    expect(await tagOf(actAs(as(otherMember), ops.delete(id)))).toEqual(Option.some("Forbidden"));
    expect(await tagOf(actAs(as(moderator), ops.delete(id)))).toEqual(Option.none());
  });

  it("hides a private observation's links from a stranger's read and list alike", async () => {
    const { ops, actAs, listed } = observationsAndDisorders();
    const { id } = await run(
      actAs(as(member), ops.create({ observationId: "o-private", disorderId: "mildew" })),
    );
    expect(await tagOf(actAs(as(otherMember), ops.get(id)))).toEqual(Option.some("EdgeNotFound"));
    // Scoped by the disorder — the corpus-facing question — and still nothing, total included.
    expect(await listed(as(otherMember), eq("disorderId", "mildew"))).toEqual({
      ids: [],
      total: 0,
    });
    expect(await listed(as(member), eq("disorderId", "mildew"))).toEqual({ ids: [id], total: 1 });
  });

  it("makes re-asserting the same pair idempotent, never overwriting the qualifier", async () => {
    const { ops, actAs, listed } = observationsAndDisorders();
    const pair = { observationId: "o-public", disorderId: "mildew" };
    const first = await run(actAs(as(member), ops.create({ ...pair, severity: "low" })));
    const second = await run(actAs(as(member), ops.create({ ...pair, severity: "high" })));
    expect(second).toEqual({ id: first.id, created: false });
    expect(await run(actAs(as(member), ops.get(first.id)))).toMatchObject({ severity: "low" });
    expect((await listed(as(member), eq("observationId", "o-public"))).total).toBe(1);
  });

  it("records several disorders against one observation", async () => {
    const { ops, actAs, listed } = observationsAndDisorders();
    await run(actAs(as(member), ops.create({ observationId: "o-public", disorderId: "mildew" })));
    await run(
      actAs(as(member), ops.create({ observationId: "o-public", disorderId: "chlorosis" })),
    );
    expect((await listed(as(otherMember), eq("observationId", "o-public"))).total).toBe(2);
  });

  it("retracts a link as a hard delete, leaving the disorder alone", async () => {
    const { disorders, edges, ops, actAs } = observationsAndDisorders();
    const { id } = await run(
      actAs(as(member), ops.create({ observationId: "o-public", disorderId: "mildew" })),
    );
    await run(actAs(as(member), ops.delete(id)));
    expect(await tagOf(actAs(as(member), ops.get(id)))).toEqual(Option.some("EdgeNotFound"));
    expect(edges.rows()).toEqual([]);
    expect(Option.isSome(await run(disorders.get("mildew")))).toBe(true);
  });
});

// ── EDGE-001: endpoint visibility ─────────────────────────────────────

/** The joined row a store's list filters: the edge, plus the node's columns under the end's alias. */
const joinedRow = (alias: string, column: string, row: LeafRow): FilterRow => ({
  id: "edge",
  createdAt: NOW,
  [column]: row.id,
  ...Record.mapKeys(row, (key): string => endpointColumn(alias, key)),
});

const evaluationContext = {
  now: NOW,
  contains: (set: Following, value: ColumnValue) =>
    Predicate.isString(value) && HashSet.has(set, value),
};

/** For one end and one viewer: each row's [id, listed, readable] — the two readings side by side. */
const readings = (
  end: EdgeEnd<never, never>,
  viewer: Viewer,
  rows: ReadonlyArray<LeafRow>,
  followers: FollowerSeam<Following, never> = follows,
  policy: AccessPolicy = gardeneriaPolicy,
) =>
  run(
    Effect.forEach(
      rows,
      (row) =>
        Effect.map(
          canViewEndpoint(end, viewer, policy, followers, Option.some(row)),
          (readable) => ({
            id: row.id,
            listed: evaluate(
              endpointFilter({ end }, viewer, policy, followers),
              joinedRow("end", end.column, row),
              evaluationContext,
            ),
            readable,
          }),
        ),
      { concurrency: 1 },
    ),
  );

const actions: ReadonlyArray<VersionAction> = ["create", "update", "delete"];

/** The two booleans, `null`, a stringly `"false"`, and no key at all. */
const drafts: ReadonlyArray<ColumnValue | typeof ABSENT> = [false, true, null, "false", ABSENT];

/** A draft for a row id: a string quoted, so `"false"` never collides with `false`. */
const showDraft = (draft: ColumnValue | typeof ABSENT): string =>
  draft === ABSENT ? "absent" : Predicate.isString(draft) ? `"${draft}"` : String(draft);

describe("EDGE-001: the endpoint filter never disagrees with the endpoint predicate", () => {
  const ownedRows = Arr.flatMap(actions, (action) =>
    Arr.flatMap(["public", "followers", "private", "unknown", null], (visibility) =>
      Arr.flatMap(drafts, (draft) =>
        Arr.map([member.id, otherMember.id, null], (ownerId) =>
          node(
            `${action}-${String(visibility)}-${showDraft(draft)}-${String(ownerId)}`,
            draft === ABSENT ? { ownerId, visibility } : { ownerId, visibility, draft },
            action,
          ),
        ),
      ),
    ),
  );
  const ownedNodes = makeInMemoryNodes(["ownerId", "visibility", "draft"]);

  /** Every viewer (and the admin) under each policy: the split one tells the two read rungs apart. */
  const viewersByPolicy = Arr.flatMap(
    [
      ["gardeneria's policy", gardeneriaPolicy],
      ["the split policy", splitPolicy],
    ] as const,
    ([policyName, policy]) =>
      Arr.map(
        [...viewers, ["an admin", as(admin)] as const],
        ([name, viewer]) => [`${name}, under ${policyName}`, viewer, policy] as const,
      ),
  );

  /** Whether the viewer holds both read rungs, and so reads every row of a declared view. */
  const seesEverything = (viewer: Viewer, policy: AccessPolicy) =>
    Option.exists(viewer, policy.canViewPrivate) && Option.exists(viewer, policy.canViewDeleted);

  it.each(viewersByPolicy)("an owned end, for %s", async (_name, viewer, policy) => {
    const seen = await readings(
      ownedEnd("entryId", ownedNodes),
      viewer,
      ownedRows,
      follows,
      policy,
    );
    expect(seen.map(({ id, listed }) => [id, listed])).toEqual(
      seen.map(({ id, readable }) => [id, readable]),
    );
    // Not vacuous: some rows are readable, and some are not unless the
    // viewer holds both read rungs.
    expect(seen.some((reading) => reading.readable)).toBe(true);
    expect(seen.some((reading) => !reading.readable)).toBe(!seesEverything(viewer, policy));
  });

  const referenceRows = Arr.flatMap(actions, (action) =>
    Arr.map(["public", "followers", "private", "unknown", null], (visibility) =>
      node(`${action}-${String(visibility)}`, { visibility }, action),
    ),
  );

  it.each(viewersByPolicy)(
    "a reference end, with and without a visibility column, for %s",
    async (_name, viewer, policy) => {
      const withAxis = await readings(
        referenceEnd("subjectId", makeInMemoryNodes(["visibility"])),
        viewer,
        referenceRows,
        follows,
        policy,
      );
      const withoutAxis = await readings(
        referenceEnd("subjectId", makeInMemoryNodes([])),
        viewer,
        referenceRows,
        follows,
        policy,
      );
      expect(
        [withAxis, withoutAxis].map((seen) => seen.map(({ id, listed }) => [id, listed])),
      ).toEqual(
        [withAxis, withoutAxis].map((seen) => seen.map(({ id, readable }) => [id, readable])),
      );
      // A view with no visibility axis hides only the tombstones, and those
      // only below the view-deleted rung.
      expect(withoutAxis.filter((reading) => reading.readable)).toHaveLength(
        referenceRows.filter(
          (row) => row.action !== "delete" || Option.exists(viewer, policy.canViewDeleted),
        ).length,
      );
    },
  );

  describe("a reference end whose leaf declares a followers column (pulpit#92)", () => {
    /** The seam's questions, recorded: a non-string column value must never reach it. */
    const asked: Array<string> = [];
    const recording: FollowerSeam<Following, never> = {
      isFollower: (followerId, ownerId) =>
        Effect.sync(() => {
          asked.push(ownerId);
          return followerId === follower.id && ownerId === member.id;
        }),
      following: follows.following,
    };
    const curators: ReadonlyArray<ColumnValue | typeof ABSENT> = [
      member.id,
      otherMember.id,
      null,
      ABSENT,
      42,
      // What `String` makes of a `NULL`: a string, so it is an account id like any other.
      "null",
    ];
    const curatedRows = Arr.flatMap(actions, (action) =>
      Arr.flatMap(["public", "followers", "private", "unknown", null], (visibility) =>
        Arr.map(curators, (curatorId) =>
          node(
            `${action}-${String(visibility)}-${curatorId === ABSENT ? "absent" : Predicate.isString(curatorId) ? `"${curatorId}"` : String(curatorId)}`,
            curatorId === ABSENT ? { visibility } : { visibility, curatorId },
            action,
          ),
        ),
      ),
    );
    const curatedEnd = (
      columns: ReadonlyArray<string>,
      // oxlint-disable-next-line effect/prefer-option-over-null -- the declaration's own optional field (AGENTS.md → Conventions)
      followersOfColumn?: string | undefined,
    ): EdgeEnd<never, never> => ({
      column: "termId",
      type: "terms",
      access: { kind: "reference", followersOfColumn },
      nodes: makeInMemoryNodes(columns),
    });
    const variants = [
      ["declaring a column the view carries", ["visibility", "curatorId"], "curatorId"],
      ["declaring a column the view lacks", ["visibility"], "curatorId"],
      ["declaring none", ["visibility", "curatorId"], undefined],
      ["over a view without a visibility column", ["curatorId"], "curatorId"],
    ] as const;

    it.each(
      Arr.flatMap(variants, ([variant, columns, column]) =>
        Arr.map(viewersByPolicy, ([name, viewer, policy]) => ({
          variant,
          columns,
          column,
          name,
          viewer,
          policy,
        })),
      ),
    )("$variant, for $name", async ({ columns, column, viewer, policy }) => {
      asked.length = 0;
      const seen = await readings(
        curatedEnd(columns, column),
        viewer,
        curatedRows,
        recording,
        policy,
      );
      expect(seen.map(({ id, listed }) => [id, listed])).toEqual(
        seen.map(({ id, readable }) => [id, readable]),
      );
      // The seam is asked only about a string, and only for a `followers` row.
      expect(asked.filter((ownerId) => !Predicate.isString(ownerId))).toEqual([]);
    });

    it("is not vacuous: the named account and its follower read its followers rows, and nobody else below the rung does", async () => {
      const end = curatedEnd(["visibility", "curatorId"], "curatorId");
      const live = curatedRows.filter((row) => row.action !== "delete");
      const shown = async (viewer: Viewer) =>
        (await readings(end, viewer, live, recording)).filter((reading) => reading.readable);
      const publicIds = live.filter((row) => row["visibility"] === "public").map((row) => row.id);
      expect((await shown(as(follower))).map(({ id }) => id)).toEqual(
        live
          .filter(
            (row) =>
              row["visibility"] === "public" ||
              (row["visibility"] === "followers" && row["curatorId"] === member.id),
          )
          .map((row) => row.id),
      );
      // Each account the column names reads its own followers rows, never its private ones.
      const named = [member, otherMember];
      expect(
        await Promise.all(
          named.map(async (account) => (await shown(as(account))).map(({ id }) => id)),
        ),
      ).toEqual(
        named.map((account) =>
          live
            .filter(
              (row) =>
                row["visibility"] === "public" ||
                (row["visibility"] === "followers" && row["curatorId"] === account.id),
            )
            .map((row) => row.id),
        ),
      );
      const strangers = [anonymous, as(contributor)];
      expect(
        await Promise.all(
          strangers.map(async (viewer) => (await shown(viewer)).map(({ id }) => id)),
        ),
      ).toEqual(strangers.map(() => publicIds));
      expect(await shown(as(moderator))).toHaveLength(live.length);
      asked.length = 0;
      await readings(end, as(follower), live, recording);
      // Once per live `followers` row with a string curator (a `create` and an `update` head each).
      expect(Arr.dedupe(asked).toSorted()).toEqual([member.id, otherMember.id, "null"].toSorted());
    });

    it("a declared column the view lacks opens no followers row, fail closed", async () => {
      const seen = await readings(
        curatedEnd(["visibility"], "curatorId"),
        as(follower),
        curatedRows,
      );
      expect(seen.filter(({ listed, readable }) => listed || readable).map(({ id }) => id)).toEqual(
        curatedRows
          .filter((row) => row.action !== "delete" && row["visibility"] === "public")
          .map((row) => row.id),
      );
    });

    it("reads as the endpoint leaf's own get does, over the subtype factory's stores", async () => {
      const seam = makeInMemoryFollowers([[follower.id, [member.id]]]);
      let viewer: Viewer = anonymous;
      const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          viewer = who;
          return effect;
        });
      const chain = makeInMemoryChainStore();
      const leaves = makeInMemoryLeafStore(chain, {
        columns: ["visibility", "curatorId"],
        now: NOW,
      });
      const terms = defineSubtype({
        type: "terms",
        access: { kind: "reference", followersOfColumn: "curatorId" },
        chain,
        leaves,
        viewer: Effect.sync(() => viewer),
        policy: gardeneriaPolicy,
        followers: seam,
        toResource: (row: LeafRow) => row,
      });
      const end: EdgeEnd<never, never> = {
        column: "termId",
        type: "terms",
        access: terms.access,
        nodes: leaves,
      };
      const ids = await run(
        Effect.forEach(
          Arr.flatMap(["public", "followers", "private"], (visibility) =>
            Arr.map([member.id, otherMember.id, null], (curatorId) => ({ visibility, curatorId })),
          ),
          (state) =>
            Effect.map(
              actAs(as(admin), terms.create({ id: Option.none(), state })),
              ({ id }) => id,
            ),
          { concurrency: 1 },
        ),
      );
      /** Each node as the viewer's `get` answers it: whether it reads. */
      const readBy = (who: Viewer) =>
        Effect.forEach(
          ids,
          (id) => Effect.map(Effect.exit(actAs(who, terms.get(id))), Exit.isSuccess),
          { concurrency: 1 },
        );
      /** Each node as the endpoint predicate answers it. */
      const endpointBy = (who: Viewer) =>
        Effect.forEach(
          ids,
          (id) =>
            Effect.flatMap(leaves.get(id), (row) =>
              canViewEndpoint(end, who, gardeneriaPolicy, seam, row),
            ),
          { concurrency: 1 },
        );
      const everyone = [...viewers, ["an admin", as(admin)] as const];
      const answers = await run(
        Effect.forEach(
          everyone,
          ([name, who]) =>
            Effect.map(
              Effect.all([readBy(who), endpointBy(who)], { concurrency: 1 }),
              ([byGet, byEndpoint]) => ({
                name,
                byGet,
                byEndpoint,
              }),
            ),
          { concurrency: 1 },
        ),
      );
      expect(answers.map(({ name, byEndpoint }) => ({ name, answers: byEndpoint }))).toEqual(
        answers.map(({ name, byGet }) => ({ name, answers: byGet })),
      );
      // Not vacuous: rows are visibility (public, followers, private) × curator
      // (member, otherMember, NULL). The follower reads the followed account's
      // followers row; the named account its own, never its private one.
      expect(await run(readBy(as(follower)))).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(await run(readBy(as(otherMember)))).toEqual([
        true,
        true,
        true,
        false,
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(await run(readBy(anonymous))).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    });
  });

  // One case per declared column, so dropping any leg of the shared
  // declared-column check (owner, visibility, draft) fails here (pulpit#79).
  it.each([
    ["an owner", ["visibility", "draft"]],
    ["a visibility", ["ownerId", "draft"]],
    ["a draft", ["ownerId", "visibility"]],
  ] as const)(
    "an owned declaration naming %s column the view lacks hides every edge, from the rung too",
    async (_missing, viewColumns) => {
      const seen = await readings(
        ownedEnd("entryId", makeInMemoryNodes(viewColumns)),
        as(admin),
        ownedRows,
      );
      expect(seen.every(({ listed, readable }) => !listed && !readable)).toBe(true);
    },
  );

  describe("an owner column holding no string is no owner (pulpit#85)", () => {
    /** Accounts whose ids are what `String` makes of a `NULL`, an absent key and `42`. */
    const strings = ["null", "undefined", "42"];
    const accounts = strings.map((id): ViewerAccount => ({ id, role: "user" }));
    /** A seam under which each of them follows all of those ids, recording what it is asked. */
    const asked: Array<string> = [];
    const fans: FollowerSeam<Following, never> = {
      isFollower: (followerId, ownerId) =>
        Effect.sync(() => {
          asked.push(ownerId);
          return strings.includes(followerId) && strings.includes(ownerId);
        }),
      following: (followerId) =>
        strings.includes(followerId) ? HashSet.fromIterable(strings) : HashSet.empty(),
    };
    const unowned = Arr.flatMap([null, ABSENT, 42] as const, (ownerId) =>
      Arr.flatMap(["public", "followers", "private"], (visibility) =>
        Arr.map([false, true], (draft) =>
          node(
            `${String(visibility)}-${String(draft)}-${ownerId === ABSENT ? "absent" : String(ownerId)}`,
            ownerId === ABSENT ? { visibility, draft } : { ownerId, visibility, draft },
          ),
        ),
      ),
    );
    const open = unowned
      .filter((row) => row["visibility"] === "public" && row["draft"] === false)
      .map((row) => row.id);

    it.each([
      ...accounts.map(
        (account) => [`an account whose id is "${account.id}"`, as(account)] as const,
      ),
      ...viewers.filter(([, viewer]) => !Option.exists(viewer, gardeneriaPolicy.canViewPrivate)),
    ])("matches no viewer and asks no follower, for %s", async (_name, viewer) => {
      asked.length = 0;
      const seen = await readings(ownedEnd("entryId", ownedNodes), viewer, unowned, fans);
      expect(seen.map(({ id, listed }) => [id, listed])).toEqual(
        seen.map(({ id, readable }) => [id, readable]),
      );
      expect(seen.filter((reading) => reading.readable).map((reading) => reading.id)).toEqual(open);
      expect(asked).toEqual([]);
    });

    it("still shows every live row to the view-private rung", async () => {
      const seen = await readings(ownedEnd("entryId", ownedNodes), as(moderator), unowned, fans);
      expect(seen.every(({ listed, readable }) => listed && readable)).toBe(true);
    });

    it('is not vacuous: an owner column holding the string "null" is that account\'s', async () => {
      asked.length = 0;
      const owned = [
        node("private-draft", { ownerId: "null", visibility: "private", draft: true }),
        node("followers", { ownerId: "null", visibility: "followers", draft: false }),
      ];
      const end = ownedEnd("entryId", ownedNodes);
      const shown = async (id: string) =>
        (await readings(end, as({ id, role: "user" }), owned, fans)).map(({ listed, readable }) => [
          listed,
          readable,
        ]);
      expect(await shown("null")).toEqual([
        [true, true],
        [true, true],
      ]);
      expect(await shown("undefined")).toEqual([
        [false, false],
        [true, true],
      ]);
      expect(asked).toContain("null");
    });
  });

  describe("a tombstoned node, by rung (pulpit#93)", () => {
    const tombstones = [
      ...ownedRows.filter((row) => row.action === "delete"),
      // A tombstone the view-private rung alone would hide: another owner's private draft.
      node(
        "delete-other-private",
        { ownerId: otherMember.id, visibility: "private", draft: true },
        "delete",
      ),
    ];
    /** The same row, live: what a tombstone reads as to the view-deleted rung. */
    const revived = (row: LeafRow): LeafRow => ({ ...row, action: "update" });
    const end = ownedEnd("entryId", ownedNodes);

    it.each(viewers.filter(([, viewer]) => !Option.exists(viewer, splitPolicy.canViewDeleted)))(
      "is unreadable below the view-deleted rung, for %s",
      async (_name, viewer) => {
        const seen = await readings(end, viewer, tombstones, follows, splitPolicy);
        expect(seen.every(({ listed, readable }) => !listed && !readable)).toBe(true);
      },
    );

    it.each([
      ["a moderator (view-deleted only)", as(moderator)],
      ["an admin (both read rungs)", as(admin)],
    ] as const)(
      "reads as the live row would, by its access rule, for %s",
      async (_name, viewer) => {
        const seen = await readings(end, viewer, tombstones, follows, splitPolicy);
        const live = await readings(end, viewer, tombstones.map(revived), follows, splitPolicy);
        expect(seen.map(({ listed, readable }) => [listed, readable])).toEqual(
          live.map(({ readable }) => [readable, readable]),
        );
        // Not vacuous: below the view-private rung, a private tombstone stays hidden.
        expect(seen.some(({ readable }) => readable)).toBe(true);
        expect(seen.some(({ readable }) => !readable)).toBe(
          !Option.exists(viewer, splitPolicy.canViewPrivate),
        );
      },
    );

    it("a missing node is unreadable even to both rungs", async () => {
      expect(
        await run(canViewEndpoint(end, as(admin), gardeneriaPolicy, follows, Option.none())),
      ).toBe(false);
    });
  });
});

describe("EDGE-001: an edge is readable only if every end is", () => {
  /**
   * A reference leaf (public, private, tombstoned) and an owned leaf (one
   * node per visibility state, a draft, a tombstone, another owner's private
   * row), with one edge seeded between every pair, bypassing `create`.
   */
  const everyPair = async () => {
    const subjects = makeInMemoryNodes(["visibility"]);
    subjects.put(node("s-public", { visibility: "public" }));
    subjects.put(node("s-private", { visibility: "private" }));
    subjects.put(node("s-gone", { visibility: "public" }, "delete"));
    const entries = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    const owned = (visibility: string, draft = false, ownerId = member.id) => ({
      ownerId,
      visibility,
      draft,
    });
    entries.put(node("e-public", owned("public")));
    entries.put(node("e-followers", owned("followers")));
    entries.put(node("e-private", owned("private")));
    entries.put(node("e-draft", owned("public", true)));
    entries.put(node("e-gone", owned("public"), "delete"));
    entries.put(node("e-other", owned("private", false, otherMember.id)));
    const ends = {
      subject: referenceEnd("subjectId", subjects),
      entry: ownedEnd("entryId", entries),
    };
    const links = family({ ends });
    const subjectIds = ["s-public", "s-private", "s-gone"];
    const entryIds = ["e-public", "e-followers", "e-private", "e-draft", "e-gone", "e-other"];
    await run(
      Effect.forEach(
        Arr.flatMap(subjectIds, (subjectId) =>
          Arr.map(entryIds, (entryId) => ({ subjectId, entryId })),
        ),
        (values) => links.edges.insert(values),
        { concurrency: 1 },
      ),
    );
    /** The pair an edge joins, as `subject/entry`. */
    const pairOf = (id: string) => {
      const row = links.edges.rows().find((candidate) => candidate.id === id);
      return `${String(row?.["subjectId"])}/${String(row?.["entryId"])}`;
    };
    return { ends, subjects, entries, pairOf, ...links };
  };

  it.each(viewers)(
    "list, get and the predicate agree on every pair, for %s",
    async (_name, viewer) => {
      const { ends, subjects, entries, edges, ops, actAs, listed } = await everyPair();
      const readable = await run(
        Effect.filter(
          edges.rows(),
          (row) =>
            Effect.map(
              Effect.all(
                [
                  Effect.flatMap(subjects.get(String(row["subjectId"])), (found) =>
                    canViewEndpoint(ends.subject, viewer, gardeneriaPolicy, follows, found),
                  ),
                  Effect.flatMap(entries.get(String(row["entryId"])), (found) =>
                    canViewEndpoint(ends.entry, viewer, gardeneriaPolicy, follows, found),
                  ),
                ],
                { concurrency: 1 },
              ),
              ([subject, entry]) => subject && entry,
            ),
          { concurrency: 1 },
        ),
      );
      const got = await run(
        Effect.filter(
          edges.rows(),
          (row) => Effect.map(Effect.exit(actAs(viewer, ops.get(row.id))), Exit.isSuccess),
          { concurrency: 1 },
        ),
      );
      const page = await listed(viewer);
      expect(page.ids).toEqual(readable.map((row) => row.id));
      expect(got.map((row) => row.id)).toEqual(page.ids);
      expect(page.total).toBe(page.ids.length);
    },
  );

  it("states the matrix outright for the anonymous, a follower and the rung", async () => {
    const { pairOf, listed } = await everyPair();
    const pairs = async (viewer: Viewer) =>
      Arr.sort((await listed(viewer)).ids.map(pairOf), Order.String);
    expect(await pairs(anonymous)).toEqual(["s-public/e-public"]);
    expect(await pairs(as(follower))).toEqual(["s-public/e-followers", "s-public/e-public"]);
    expect(await pairs(as(member))).toEqual([
      "s-public/e-draft",
      "s-public/e-followers",
      "s-public/e-private",
      "s-public/e-public",
    ]);
    // The rung (both read rungs, under gardeneria's policy) sees private
    // nodes and tombstoned ones on both ends (pulpit#93).
    expect(await pairs(as(moderator))).toEqual(
      Arr.flatMap(["s-gone", "s-private", "s-public"], (subject) =>
        Arr.map(
          ["e-draft", "e-followers", "e-gone", "e-other", "e-private", "e-public"],
          (entry) => `${subject}/${entry}`,
        ),
      ),
    );
  });

  it("a related list omits the edges whose other end is hidden (SEC-AUTH-ENUM-001)", async () => {
    const { pairOf, listed } = await everyPair();
    const related = async (viewer: Viewer, subjectId: string) => {
      const page = await listed(viewer, eq("subjectId", subjectId));
      return { pairs: Arr.sort(page.ids.map(pairOf), Order.String), total: page.total };
    };
    // `e-other` is the stranger's own here, so a contributor asks: a stranger to every entry.
    expect(await related(as(contributor), "s-public")).toEqual({
      pairs: ["s-public/e-public"],
      total: 1,
    });
    expect(await related(as(follower), "s-public")).toEqual({
      pairs: ["s-public/e-followers", "s-public/e-public"],
      total: 2,
    });
    // A hidden node's related list is indistinguishable from an empty one.
    expect(await related(as(contributor), "s-private")).toEqual({ pairs: [], total: 0 });
  });

  it("a family filter may name an end's node column", async () => {
    const { pairOf, listed } = await everyPair();
    const page = await listed(as(member), eq(endpointColumn("entry", "visibility"), "followers"));
    expect(page.ids.map(pairOf)).toEqual(["s-public/e-followers"]);
  });

  it("a create naming a hidden node is NodeNotFound, before the gate can answer 403", async () => {
    const { ops, actAs } = await everyPair();
    const create = (viewer: Viewer, subjectId: string, entryId: string) =>
      errorOf(actAs(viewer, ops.create({ subjectId, entryId })));
    // A member is below the corpus rung, so a readable pair is Forbidden …
    expect(await create(as(member), "s-public", "e-public")).toEqual(
      Option.some(expect.objectContaining({ _tag: "Forbidden" })),
    );
    // … and a hidden or tombstoned node is NotFound, naming that node.
    expect(await create(as(member), "s-private", "e-public")).toEqual(
      Option.some(
        expect.objectContaining({ _tag: "NodeNotFound", type: "subjects", id: "s-private" }),
      ),
    );
    expect(await create(as(contributor), "s-public", "e-gone")).toEqual(
      Option.some(expect.objectContaining({ _tag: "NodeNotFound", type: "entries", id: "e-gone" })),
    );
    expect(await create(anonymous, "s-public", "e-other")).toEqual(
      Option.some(expect.objectContaining({ _tag: "NodeNotFound", type: "entries" })),
    );
    expect(await create(as(contributor), "s-public", "missing")).toEqual(
      Option.some(
        expect.objectContaining({ _tag: "NodeNotFound", type: "entries", id: "missing" }),
      ),
    );
    // An end the values leave out names no node.
    expect(await errorOf(actAs(as(contributor), ops.create({ subjectId: "s-public" })))).toEqual(
      Option.some(expect.objectContaining({ _tag: "NodeNotFound", type: "entries" })),
    );
  });

  it("a delete of an edge with a hidden end is EdgeNotFound, even for a writer", async () => {
    const { edges, ops, actAs, pairOf } = await everyPair();
    const hidden = edges.rows().find((row) => pairOf(row.id) === "s-public/e-other");
    expect(await tagOf(actAs(as(contributor), ops.delete(String(hidden?.id))))).toEqual(
      Option.some("EdgeNotFound"),
    );
    expect(edges.rows()).toHaveLength(18);
  });
});

describe("EDGE-001: a tombstoned end hides its edges below the view-deleted rung, and a restore brings them back", () => {
  it("over the subtype factory's own stores", async () => {
    const noFollowers = nobodyFollows<Following>(HashSet.empty());
    let viewer: Viewer = anonymous;
    const currentViewer = Effect.sync(() => viewer);
    const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    const subjectChain = makeInMemoryChainStore();
    const subjectLeaves = makeInMemoryLeafStore(subjectChain, {
      columns: ["visibility"],
      now: NOW,
    });
    const subjectOps = defineSubtype({
      type: "subjects",
      access: { kind: "reference" },
      chain: subjectChain,
      leaves: subjectLeaves,
      viewer: currentViewer,
      policy: gardeneriaPolicy,
      followers: noFollowers,
      toResource: (row: LeafRow) => row,
    });
    const entryChain = makeInMemoryChainStore();
    const entryLeaves = makeInMemoryLeafStore(entryChain, {
      columns: ["visibility", "draft"],
      now: NOW,
    });
    const entryOps = defineSubtype({
      type: "entries",
      access: ownedAccess({ draft: true }),
      chain: entryChain,
      leaves: entryLeaves,
      viewer: currentViewer,
      policy: gardeneriaPolicy,
      followers: noFollowers,
      toResource: (row: LeafRow) => row,
    });
    const ends = {
      subject: {
        column: "subjectId",
        type: "subjects",
        access: subjectOps.access,
        nodes: subjectLeaves,
      },
      entry: { column: "entryId", type: "entries", access: entryOps.access, nodes: entryLeaves },
    };
    const edges = makeInMemoryEdgeStore({ ends, uniqueKey: [], now: NOW });
    const ops = defineEdgeOps({
      type: "links",
      ends,
      edges,
      viewer: currentViewer,
      policy: gardeneriaPolicy,
      followers: follows,
      values: (input: EdgeValues) => input,
      toResource: (row: EdgeRow) => row,
    });
    const visibleTo = async (who: Viewer) =>
      (await run(actAs(who, ops.list({ limit: 10, offset: 0, where: always })))).rows.map(
        (row) => row.id,
      );

    const subject = await run(
      actAs(
        as(contributor),
        subjectOps.create({ id: Option.none(), state: { visibility: "public" } }),
      ),
    );
    const entry = await run(
      actAs(
        as(member),
        entryOps.create({ id: Option.none(), state: { visibility: "public", draft: false } }),
      ),
    );
    const { id } = await run(
      actAs(as(contributor), ops.create({ subjectId: subject.id, entryId: entry.id })),
    );
    expect(await visibleTo(anonymous)).toEqual([id]);

    await run(actAs(as(member), entryOps.delete(entry.id)));
    // Hidden from everyone below the view-deleted rung …
    const below = [anonymous, as(member), as(contributor)];
    expect(await Promise.all(below.map(visibleTo))).toEqual(below.map(() => []));
    const reads = await Promise.all(below.map((who) => tagOf(actAs(who, ops.get(id)))));
    expect(reads).toEqual(below.map(() => Option.some("EdgeNotFound")));
    expect(await tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(
      Option.some("EdgeNotFound"),
    );
    // … and read by the rung, which reads the tombstone itself (pulpit#93).
    const rung = [as(moderator), as(admin)];
    expect(await Promise.all(rung.map(visibleTo))).toEqual(rung.map(() => [id]));
    await run(actAs(as(moderator), entryOps.get(entry.id)));
    // A create can't name the tombstone, whoever asks.
    expect(
      await Promise.all(
        [as(contributor), as(moderator)].map((who) =>
          tagOf(actAs(who, ops.create({ subjectId: subject.id, entryId: entry.id }))),
        ),
      ),
    ).toEqual([Option.some("NodeNotFound"), Option.some("NodeNotFound")]);
    // Hidden, not deleted.
    expect(edges.rows().map((row) => row.id)).toEqual([id]);

    await run(actAs(as(member), entryOps.restore({ id: entry.id, patch: {} })));
    expect(await visibleTo(anonymous)).toEqual([id]);
    expect(await run(actAs(anonymous, ops.get(id)))).toMatchObject({ id, entryId: entry.id });
  });
});

describe("EDGE-001 by rung × end state: the view-deleted rung reads an edge whose only hidden end is tombstoned (pulpit#93)", () => {
  /** The subject end's states; the part end is always a live public node. */
  const states = {
    live: node("s-live", { visibility: "public" }),
    "live and private": node("s-private", { visibility: "private" }),
    tombstoned: node("s-gone", { visibility: "public" }, "delete"),
    "tombstoned and private": node("s-gone-private", { visibility: "private" }, "delete"),
  };
  type State = keyof typeof states;

  /** One edge from each subject state to `p1`, seeded past `create`, under the split policy. */
  const world = async () => {
    const subjects = makeInMemoryNodes(["visibility"]);
    const parts = makeInMemoryNodes(["visibility"]);
    Record.values(states).forEach((row) => subjects.put(row));
    parts.put(node("p1", { visibility: "public" }));
    const links = family(
      {
        ends: { subject: referenceEnd("subjectId", subjects), part: referenceEnd("partId", parts) },
      },
      [],
      splitPolicy,
    );
    await run(
      Effect.forEach(
        Record.values(states),
        (row) => links.edges.insert({ subjectId: row.id, partId: "p1" }),
        { concurrency: 1 },
      ),
    );
    const idOf = (state: State) =>
      String(links.edges.rows().find((row) => row["subjectId"] === states[state].id)?.id);
    return { ...links, idOf };
  };

  /** Each rung (all past the corpus-write gate) and the subject states it reads. */
  const rungs: ReadonlyArray<readonly [string, Viewer, ReadonlyArray<State>]> = [
    ["a contributor (neither read rung)", as(contributor), ["live"]],
    ["a moderator (view-deleted only)", as(moderator), ["live", "tombstoned"]],
    [
      "an admin (both read rungs)",
      as(admin),
      ["live", "live and private", "tombstoned", "tombstoned and private"],
    ],
  ];
  const cases = Arr.flatMap(rungs, ([rung, viewer, reads]) =>
    Arr.map(Record.keys(states), (state) => [rung, state, viewer, reads.includes(state)] as const),
  );

  it.each(cases)("%s, an edge whose subject is %s", async (_rung, state, viewer, readable) => {
    const { edges, ops, actAs, listed, idOf } = await world();
    const id = idOf(state);
    expect((await listed(viewer)).ids.includes(id)).toBe(readable);
    expect((await listed(viewer, eq("partId", "p1"))).ids.includes(id)).toBe(readable);
    expect(Exit.isSuccess(await Effect.runPromiseExit(actAs(viewer, ops.get(id))))).toBe(readable);
    expect(await tagOf(actAs(viewer, ops.delete(id)))).toEqual(
      readable ? Option.none() : Option.some("EdgeNotFound"),
    );
    expect(edges.rows().some((row) => row.id === id)).toBe(!readable);
  });

  it("a create naming a tombstoned node is NodeNotFound to the rung that reads it", async () => {
    const { ops, actAs } = await world();
    expect(
      await errorOf(actAs(as(admin), ops.create({ subjectId: "s-gone", partId: "p1" }))),
    ).toEqual(
      Option.some(
        expect.objectContaining({ _tag: "NodeNotFound", type: "subjects", id: "s-gone" }),
      ),
    );
  });
});

describe("what a create discloses: nothing that tells a hidden edge from a readable one, or from none (pulpit#93)", () => {
  /**
   * `s1` with `hidden` stored edges to private parts, which a contributor
   * can't read and a moderator can, and room for `maxEdges` on its end.
   */
  const slotWorld = async (maxEdges: number, hidden: number) => {
    const { subjects, parts } = twoReferenceLeaves();
    const secret = Arr.makeBy(hidden, (index) => `h${String(index + 1)}`);
    secret.forEach((id) => parts.put(node(id, { visibility: "private" })));
    const links = family({
      ends: {
        subject: { ...referenceEnd("subjectId", subjects), maxEdges },
        part: referenceEnd("partId", parts),
      },
    });
    await run(
      Effect.forEach(secret, (partId) => links.edges.insert({ subjectId: "s1", partId }), {
        concurrency: 1,
      }),
    );
    return links;
  };
  /** A caller's answers to three creates at `s1`, in order. */
  const answers = (links: Awaited<ReturnType<typeof slotWorld>>, viewer: Viewer) =>
    run(
      Effect.forEach(
        ["p1", "p2", "p3"],
        (partId) => answerOf(links.actAs(viewer, links.ops.create({ subjectId: "s1", partId }))),
        { concurrency: 1 },
      ),
    );

  it.each([1, 2])(
    "at maxEdges %i, a contributor's creates answer alike whether the node holds 0, 1 or 2 hidden edges",
    async (maxEdges) => {
      const worlds = await Promise.all(
        [0, 1, 2].map(async (hidden) =>
          answers(await slotWorld(maxEdges, hidden), as(contributor)),
        ),
      );
      expect(worlds[1]).toEqual(worlds[0]);
      expect(worlds[2]).toEqual(worlds[0]);
      // Not vacuous: the limit refuses the create past it, by the edges the caller can read.
      expect(worlds[0]?.[maxEdges]).toEqual({
        _tag: "EdgeCardinalityExceeded",
        type: "links",
        end: "subject",
        nodeId: "s1",
        max: maxEdges,
      });
    },
  );

  it("a caller who can read every edge is held to the limit over all of them", async () => {
    const links = await slotWorld(2, 2);
    expect((await answers(links, as(moderator)))[0]).toMatchObject({
      _tag: "EdgeCardinalityExceeded",
    });
    // The contributor, who can't read the two, is not: the documented trade-off.
    expect((await answers(links, as(contributor))).slice(0, 2)).toEqual([
      { created: true },
      { created: true },
    ]);
    expect(links.edges.rows()).toHaveLength(4);
  });

  /**
   * A family keyed on `path` alone (it leaves the page out), whose page end
   * holds one edge: an edge on `page-other` already holds the path `taken`,
   * that page `colliding` (readable or hidden from a contributor), and with
   * `full` the target page already holds its one edge.
   */
  const keyWorld = async (
    colliding: "public" | "private",
    onConflict: "fail" | "ignore",
    full: boolean,
  ) => {
    const pages = makeInMemoryNodes(["visibility"]);
    pages.put(node("page-target", { visibility: "public" }));
    pages.put(node("page-other", { visibility: colliding }));
    const links = family(
      {
        ends: {
          page: {
            column: "pageId",
            type: "pages",
            access: { kind: "reference" },
            nodes: pages,
            maxEdges: 1,
          },
        },
        onConflict,
      },
      ["path"],
    );
    await run(links.edges.insert({ pageId: "page-other", path: "taken" }));
    if (full) await run(links.edges.insert({ pageId: "page-target", path: "own" }));
    return run(
      answerOf(
        links.actAs(as(contributor), links.ops.create({ pageId: "page-target", path: "taken" })),
      ),
    );
  };
  const conflict = { _tag: "EdgeConflict", type: "links" };

  it.each([
    ["below the limit", false],
    ["at the limit", true],
  ] as const)(
    "a collision with a hidden edge answers as one with a readable edge, %s",
    async (_where, full) => {
      const hidden = await keyWorld("private", "fail", full);
      expect(hidden).toEqual(await keyWorld("public", "fail", full));
      expect(hidden).toEqual(conflict);
      // Under `ignore` the hidden collision is the same unresolved answer;
      // a readable one resolves to an edge the caller could already read.
      expect(await keyWorld("private", "ignore", full)).toEqual(conflict);
      expect(await keyWorld("public", "ignore", full)).toEqual({ created: false });
    },
  );
});

// ── Cardinality ───────────────────────────────────────────────────────

describe("cardinality: an end's maxEdges is declared and enforced", () => {
  const bounded = (
    limits: {
      /* oxlint-disable effect/prefer-option-over-null -- the optional-field convention (AGENTS.md → Conventions), forwarded as-is to `maxEdges` */
      readonly subject?: number | undefined;
      readonly part?: number | undefined;
      /* oxlint-enable effect/prefer-option-over-null */
    },
    declaration: Pick<Definition, "onConflict"> = {},
  ) => {
    const { subjects, parts } = twoReferenceLeaves();
    return {
      parts,
      ...family(
        {
          ...declaration,
          ends: {
            subject: { ...referenceEnd("subjectId", subjects), maxEdges: limits.subject },
            part: { ...referenceEnd("partId", parts), maxEdges: limits.part },
          },
        },
        ["subjectId", "partId"],
      ),
    };
  };
  const link = (links: ReturnType<typeof bounded>, subjectId: string, partId: string) =>
    links.actAs(as(contributor), links.ops.create({ subjectId, partId }));

  it("refuses a create past one node's limit, writing nothing, and bounds each node apart", async () => {
    const links = bounded({ subject: 2 });
    await run(link(links, "s1", "p1"));
    await run(link(links, "s1", "p2"));
    expect(await errorOf(link(links, "s1", "p3"))).toEqual(
      Option.some(
        expect.objectContaining({
          _tag: "EdgeCardinalityExceeded",
          type: "links",
          end: "subject",
          nodeId: "s1",
          max: 2,
        }),
      ),
    );
    expect(links.edges.rows()).toHaveLength(2);
    // The limit is per node: another subject still has room.
    expect(await tagOf(link(links, "s2", "p3"))).toEqual(Option.none());
  });

  it("bounds each end on its own (EmDash's per-parent and per-child limits)", async () => {
    const links = bounded({ subject: 3, part: 1 });
    await run(link(links, "s1", "p1"));
    expect(await errorOf(link(links, "s2", "p1"))).toEqual(
      Option.some(expect.objectContaining({ end: "part", nodeId: "p1", max: 1 })),
    );
    expect(await tagOf(link(links, "s1", "p2"))).toEqual(Option.none());
  });

  it("an absent or explicitly undefined limit is no limit", async () => {
    const links = bounded({ subject: undefined });
    await run(link(links, "s1", "p1"));
    await run(link(links, "s1", "p2"));
    await run(link(links, "s1", "p3"));
    expect(links.edges.rows()).toHaveLength(3);
  });

  it("a re-assertion at a full end stays idempotent", async () => {
    const links = bounded({ subject: 1 }, { onConflict: "ignore" });
    const first = await run(link(links, "s1", "p1"));
    expect(await run(link(links, "s1", "p1"))).toEqual({ id: first.id, created: false });
    expect(await tagOf(link(links, "s1", "p2"))).toEqual(Option.some("EdgeCardinalityExceeded"));
  });

  it("a delete frees the slot", async () => {
    const links = bounded({ subject: 1 });
    const { id } = await run(link(links, "s1", "p1"));
    await run(links.actAs(as(contributor), links.ops.delete(id)));
    expect(await tagOf(link(links, "s1", "p2"))).toEqual(Option.none());
  });

  it("counts only edges whose other end is live, so a tombstoned partner frees its slot (pulpit#77)", async () => {
    const links = bounded({ subject: 1 });
    const { id } = await run(link(links, "s1", "p1"));
    expect(await tagOf(link(links, "s1", "p2"))).toEqual(Option.some("EdgeCardinalityExceeded"));
    links.parts.put(node("p1", { visibility: "public" }, "delete"));
    // The edge to the tombstoned p1 stays stored, but no longer counts, for
    // the view-deleted rung that can still read it as for anyone else.
    expect(
      await tagOf(links.actAs(as(moderator), links.ops.create({ subjectId: "s1", partId: "p2" }))),
    ).toEqual(Option.none());
    expect(links.edges.rows().map((row) => row.id)).toContain(id);
  });

  it("a restore may bring a node past its limit; the next create still refuses (pulpit#77)", async () => {
    const links = bounded({ subject: 1 });
    const stale = await run(link(links, "s1", "p1"));
    links.parts.put(node("p1", { visibility: "public" }, "delete"));
    const fresh = await run(link(links, "s1", "p2"));
    // Restoring p1 brings its edge back without a check: s1 now holds two.
    links.parts.put(node("p1", { visibility: "public" }, "update"));
    expect(await links.listed(anonymous, eq("subjectId", "s1"))).toEqual({
      ids: [stale.id, fresh.id],
      total: 2,
    });
    expect(await errorOf(link(links, "s1", "p3"))).toEqual(
      Option.some(
        expect.objectContaining({
          _tag: "EdgeCardinalityExceeded",
          end: "subject",
          nodeId: "s1",
          max: 1,
        }),
      ),
    );
    // One delete leaves s1 at its limit, still full; the second frees a slot.
    await run(links.actAs(as(contributor), links.ops.delete(stale.id)));
    expect(await tagOf(link(links, "s1", "p3"))).toEqual(Option.some("EdgeCardinalityExceeded"));
    await run(links.actAs(as(contributor), links.ops.delete(fresh.id)));
    expect(await tagOf(link(links, "s1", "p3"))).toEqual(Option.none());
  });

  it("counts a self-referential family's bounded ends in ascending node id, the order a store locks them", async () => {
    const nodes = makeInMemoryNodes(["visibility"]);
    nodes.put(node("n1", { visibility: "public" }));
    nodes.put(node("n2", { visibility: "public" }));
    const { ops, actAs, seen } = family({
      ends: {
        from: { ...referenceEnd("fromId", nodes), maxEdges: 2 },
        to: { ...referenceEnd("toId", nodes), maxEdges: 2 },
      },
    });
    // The pair both ways: declaration order would lock n2 then n1 for the
    // first and n1 then n2 for the second, and two such creates in parallel
    // would deadlock.
    await run(actAs(as(contributor), ops.create({ fromId: "n2", toId: "n1" })));
    await run(actAs(as(contributor), ops.create({ fromId: "n1", toId: "n2" })));
    expect(seen.counted()).toEqual(["toId:n1", "fromId:n2", "fromId:n1", "toId:n2"]);
  });
});

describe("a family declaration is checked when it is declared", () => {
  const withLimit = (maxEdges: number) => () =>
    family({
      ends: { subject: { ...referenceEnd("subjectId", makeInMemoryNodes([])), maxEdges } },
    });

  it.each([Number.NaN, 1.5, 0, -1, Number.POSITIVE_INFINITY, 2 ** 53])(
    "throws EdgeDeclarationError for maxEdges %s, rather than failing open or refusing every create",
    (maxEdges) => {
      expect(withLimit(maxEdges)).toThrow(EdgeDeclarationError);
      expect(withLimit(maxEdges)).toThrow(
        /'subject' declares maxEdges .*not a positive safe integer/,
      );
    },
  );

  it("accepts a positive safe integer", () => {
    expect(withLimit(1)).not.toThrow();
    expect(withLimit(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("throws EdgeDeclarationError for an end alias containing a '.'", () => {
    const nodes = makeInMemoryNodes([]);
    expect(() => family({ ends: { "note.term": referenceEnd("termId", nodes) } })).toThrow(
      EdgeDeclarationError,
    );
    expect(() => family({ ends: { "note.term": referenceEnd("termId", nodes) } })).toThrow(
      /alias 'note.term' contains a '.'/,
    );
  });
});

describe("a create racing another writer for the unique key", () => {
  const racing = (onConflict: "fail" | "ignore") => {
    const { subjects, parts } = twoReferenceLeaves();
    return family(
      {
        ends: { subject: referenceEnd("subjectId", subjects), part: referenceEnd("partId", parts) },
        onConflict,
      },
      ["subjectId", "partId"],
    );
  };

  it("resolves to the winner's edge under `ignore`", async () => {
    const { edges, ops, actAs } = racing("ignore");
    edges.raceNextInsert({ subjectId: "s1", partId: "p1" });
    const written = await run(
      actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" })),
    );
    expect(written).toEqual({ id: edges.rows()[0]?.id, created: false });
    expect(edges.rows()).toHaveLength(1);
  });

  it("fails EdgeConflict under `fail`", async () => {
    const { edges, ops, actAs } = racing("fail");
    edges.raceNextInsert({ subjectId: "s1", partId: "p1" });
    expect(
      await tagOf(actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" }))),
    ).toEqual(Option.some("EdgeConflict"));
  });

  it("never resolves a race to a winner the viewer cannot read", async () => {
    // The key leaves the page out, so the winner can join another page: one
    // tombstoned since, whose edge is hidden from everyone.
    const pages = makeInMemoryNodes([]);
    pages.put(node("page-1", {}, "delete"));
    pages.put(node("page-2", {}));
    const { edges, ops, actAs } = family(
      {
        ends: {
          page: { column: "pageId", type: "pages", access: { kind: "reference" }, nodes: pages },
        },
        onConflict: "ignore",
      },
      ["path"],
    );
    edges.raceNextInsert({ pageId: "page-1", path: "retired" });
    expect(
      await errorOf(actAs(as(contributor), ops.create({ pageId: "page-2", path: "retired" }))),
    ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
    expect(edges.rows().map((row) => row["pageId"])).toEqual(["page-1"]);
  });

  it("never resolves a race to a winner with a tombstoned end, even for the view-deleted rung", async () => {
    // The view-deleted rung reads the winner, whose page is tombstoned, but
    // can't link to it, so the race answers as an unresolved collision.
    const pages = makeInMemoryNodes(["visibility"]);
    pages.put(node("page-1", { visibility: "public" }, "delete"));
    pages.put(node("page-2", { visibility: "public" }));
    const { edges, ops, actAs } = family(
      {
        ends: {
          page: { column: "pageId", type: "pages", access: { kind: "reference" }, nodes: pages },
        },
        onConflict: "ignore",
      },
      ["path"],
      splitPolicy,
    );
    edges.raceNextInsert({ pageId: "page-1", path: "retired" });
    expect(
      await errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "retired" }))),
    ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
    const [winner] = edges.rows();
    expect(winner?.["pageId"]).toBe("page-1");
    expect(await run(actAs(as(moderator), ops.get(winner?.id ?? "")))).toMatchObject({
      pageId: "page-1",
    });
  });
});

describe("qualifying a filter with an end's alias renames every node's column", () => {
  /** `./edges`' `qualify`: what `endpointFilter` applies to each end's leaf filter. */
  const qualify = (alias: string, filter: ListFilter<Following>) =>
    renameColumns(filter, (column) => endpointColumn(alias, column));

  /** Every column a filter names, depth first. */
  const columnsOf = (filter: ListFilter<Following>): ReadonlyArray<string> =>
    filter.kind === "and" || filter.kind === "or"
      ? Arr.flatMap(filter.filters, columnsOf)
      : "column" in filter
        ? [filter.column]
        : [];

  const everyKind = and<Following>(
    eq("a", 1),
    ne("b", 1),
    isIn("c", HashSet.make("x")),
    or<Following>(gt("d", 1), gte("e", 1), lt("f", 1), lte("g", 1)),
    anyOf("h", ["x"]),
    noneOf("i", ["x"]),
    published("j"),
    notPublished("k"),
    isNull("l"),
  );

  it("renames the column of every node kind, the comparison and set arms included", () => {
    const columns = columnsOf(everyKind);
    expect(columns).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]);
    expect(columnsOf(qualify("end", everyKind))).toEqual(
      Arr.map(columns, (column) => endpointColumn("end", column)),
    );
  });

  it("an anyOf / noneOf / comparison reads the aliased column of the joined row, not the bare one", () => {
    const filters: ReadonlyArray<ListFilter<Following>> = [
      anyOf("slug", ["a"]),
      noneOf("slug", ["b"]),
      gte("rank", 2),
      lt("rank", 3),
    ];
    const joined: FilterRow = {
      [endpointColumn("end", "slug")]: "a",
      [endpointColumn("end", "rank")]: 2,
    };
    const bare: FilterRow = { slug: "a", rank: 2 };
    expect(
      Arr.map(filters, (filter) => [
        evaluate(qualify("end", filter), joined, evaluationContext),
        evaluate(qualify("end", filter), bare, evaluationContext),
      ]),
    ).toEqual(Arr.map(filters, () => [true, false]));
  });
});

// ── Edge membership (pulpit#113) ──────────────────────────────────────

describe("memberFilter and countBy: membership and counts never disagree with EDGE-001's per-edge predicate", () => {
  /** Posts (owned, with drafts) × terms (reference, with a followers column), every pair linked. */
  const taxonomy = (policy: AccessPolicy = gardeneriaPolicy) => {
    const posts = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    const terms = makeInMemoryNodes(["visibility", "curatorId"]);
    const postRows = [
      node("p-public", { ownerId: member.id, visibility: "public", draft: false }),
      node("p-private", { ownerId: member.id, visibility: "private", draft: false }),
      node("p-followers", { ownerId: member.id, visibility: "followers", draft: false }),
      node("p-draft", { ownerId: otherMember.id, visibility: "public", draft: true }),
      node("p-dead", { ownerId: member.id, visibility: "public", draft: false }, "delete"),
    ];
    const termRows = [
      node("t-public", { visibility: "public", curatorId: null }),
      node("t-private", { visibility: "private", curatorId: null }),
      node("t-followers", { visibility: "followers", curatorId: member.id }),
      node("t-dead", { visibility: "public", curatorId: null }, "delete"),
    ];
    Arr.forEach(postRows, posts.put);
    Arr.forEach(termRows, terms.put);
    const ends = {
      post: ownedEnd("postId", posts),
      term: {
        column: "termId",
        type: "terms",
        access: { kind: "reference", followersOfColumn: "curatorId" },
        nodes: terms,
      } satisfies EdgeEnd<never, never>,
    };
    const links = family({ ends }, [], policy);
    const pairs = Arr.flatMap(postRows, (post) =>
      Arr.map(termRows, (term) => ({ postId: post.id, termId: term.id })),
    );
    return { ...links, postRows, termRows, pairs };
  };

  const policies = [
    ["gardeneria's rungs", gardeneriaPolicy],
    ["split rungs (pulpit#93)", splitPolicy],
  ] as const;
  const cases = Arr.flatMap(policies, ([policyName, policy]) =>
    Arr.map([...viewers, ["an admin", as(admin)] as const], ([name, viewer]) => ({
      label: `${name}, ${policyName}`,
      policy,
      viewer,
    })),
  );

  it.each(cases)("for $label", async ({ policy, viewer }) => {
    const { edges, ops, actAs, postRows, termRows, pairs } = taxonomy(policy);
    const ids = await run(
      Effect.forEach(pairs, (pair) => Effect.flatMap(edges.insert(pair), Effect.fromOption), {
        concurrency: 1,
      }),
    );
    // One term at a time, and every term at once.
    const asked = [...termRows.map((term) => [term.id]), termRows.map((term) => term.id)];
    const answers = await run(
      actAs(
        viewer,
        Effect.forEach(
          asked,
          (termIds) =>
            Effect.gen(function* () {
              const filter = yield* ops.memberFilter("post", termIds);
              const listed = postRows.filter((post) =>
                evaluate(filter, post, {
                  now: NOW,
                  contains: (set: Following, value) =>
                    Predicate.isString(value) && HashSet.has(set, value),
                }),
              );
              // The per-edge reading: a post is a member when some edge to a
              // named term is one the viewer can `get` (EDGE-001).
              const readable = yield* Effect.filter(
                Arr.zip(pairs, ids),
                ([pair, id]) =>
                  termIds.includes(pair.termId)
                    ? Effect.map(Effect.exit(ops.get(id)), Exit.isSuccess)
                    : Effect.succeed(false),
                { concurrency: 1 },
              );
              const expected = Arr.dedupe(readable.map(([pair]) => pair.postId));
              return [listed.map((post) => post.id), expected] as const;
            }),
          { concurrency: 1 },
        ),
      ),
    );
    Arr.forEach(answers, ([listed, expected]) => expect(listed).toEqual(expected));
    // Not vacuous: every viewer reads `p-public` through `t-public`.
    expect(answers.some(([listed]) => listed.includes("p-public"))).toBe(true);
  });

  it("a post reached only through a hidden edge is not a member", async () => {
    const { edges, ops, actAs, postRows } = taxonomy();
    await run(edges.insert({ postId: "p-public", termId: "t-private" }));
    await run(edges.insert({ postId: "p-private", termId: "t-public" }));
    const members = async (who: Viewer, termIds: ReadonlyArray<string>) => {
      const filter = await run(actAs(who, ops.memberFilter("post", termIds)));
      return postRows
        .filter((post) =>
          evaluate(filter, post, {
            now: NOW,
            contains: (set: Following, value) =>
              Predicate.isString(value) && HashSet.has(set, value),
          }),
        )
        .map((post) => post.id);
    };
    // The hidden term confirms nothing: its edge makes no member.
    expect(await members(anonymous, ["t-private", "t-public"])).toEqual([]);
    expect(await members(as(member), ["t-private", "t-public"])).toEqual(["p-private"]);
    expect(await members(as(admin), ["t-private", "t-public"])).toEqual(["p-public", "p-private"]);
  });

  it("a NULL or absent id is never a member", async () => {
    const { edges, ops, actAs } = taxonomy();
    await run(edges.insert({ postId: "p-public", termId: "t-public" }));
    const filter = await run(actAs(anonymous, ops.memberFilter("post", ["t-public"])));
    const context = {
      now: NOW,
      contains: () => true,
    };
    expect(evaluate(filter, { id: null }, context)).toBe(false);
    expect(evaluate(filter, {}, context)).toBe(false);
  });

  it("fails closed as never, without asking the store, for no ids, too many, or a misnamed end", async () => {
    const { edges, postRows } = taxonomy();
    let asked = 0;
    const counting: InMemoryEdgeStore = {
      ...edges,
      members: (query) =>
        Effect.suspend(() => {
          asked += 1;
          return edges.members(query);
        }),
    };
    const posts = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    Arr.forEach(postRows, posts.put);
    const over = (
      ends: EdgeDefinition<EdgeValues, EdgeRow, EdgeRow, Following, never, never>["ends"],
    ) =>
      defineEdgeOps({
        type: "links",
        ends,
        edges: counting,
        viewer: Effect.succeed(anonymous),
        policy: gardeneriaPolicy,
        followers: follows,
        values: (input: EdgeValues) => input,
        toResource: (row: EdgeRow) => row,
      });
    const pair = over({ post: ownedEnd("postId", posts), term: referenceEnd("termId", posts) });
    const lone = over({ post: ownedEnd("postId", posts) });
    const tooMany = Arr.makeBy(MAX_SET_VALUES + 1, (i) => `t-${i}`);
    expect(await run(pair.memberFilter("post", []))).toEqual(never);
    expect(await run(pair.memberFilter("post", tooMany))).toEqual(never);
    expect(await run(pair.memberFilter("nope", ["t-public"]))).toEqual(never);
    // A family without exactly two ends has no "other" end.
    expect(await run(lone.memberFilter("post", ["t-public"]))).toEqual(never);
    expect(asked).toBe(0);
    // Not vacuous: a well-formed request does ask.
    await run(pair.memberFilter("post", ["t-public"]));
    expect(asked).toBe(1);
  });

  /** Entries ordered by key, so two count maps compare as lists. */
  const byKey = Order.mapInput(Order.String, (entry: readonly [string, number]) => entry[0]);

  it.each(cases)(
    "countBy for $label: each term's count is the edges the viewer can get",
    async ({ policy, viewer }) => {
      const { edges, ops, actAs, termRows, pairs } = taxonomy(policy);
      const ids = await run(
        Effect.forEach(pairs, (pair) => Effect.flatMap(edges.insert(pair), Effect.fromOption), {
          concurrency: 1,
        }),
      );
      const termIds = termRows.map((term) => term.id);
      const [counts, expected] = await run(
        actAs(
          viewer,
          Effect.gen(function* () {
            const counted = yield* ops.countBy("term", [...termIds, ...termIds]);
            const readable = yield* Effect.filter(
              Arr.zip(pairs, ids),
              ([, id]) => Effect.map(Effect.exit(ops.get(id)), Exit.isSuccess),
              { concurrency: 1 },
            );
            const perTerm = Arr.map(
              termIds,
              (termId) =>
                [termId, readable.filter(([pair]) => pair.termId === termId).length] as const,
            );
            return [counted, perTerm] as const;
          }),
        ),
      );
      expect(Arr.sort(Arr.fromIterable(HashMap.toEntries(counts)), byKey)).toEqual(
        Arr.sort(expected, byKey),
      );
      // Not vacuous: every viewer reads `p-public` through `t-public`.
      expect(Option.getOrElse(HashMap.get(counts, "t-public"), () => 0)).toBeGreaterThan(0);
    },
  );

  it("countBy narrows by the family's own predicate", async () => {
    const { edges, ops, actAs } = taxonomy();
    await run(edges.insert({ postId: "p-public", termId: "t-public" }));
    await run(edges.insert({ postId: "p-followers", termId: "t-public" }));
    const counted = await run(
      actAs(as(admin), ops.countBy("term", ["t-public"], eq("postId", "p-public"))),
    );
    expect(HashMap.get(counted, "t-public")).toEqual(Option.some(1));
  });

  it("countBy reads the store once, and fails closed to 0 without asking it", async () => {
    const { edges, postRows } = taxonomy();
    let asked = 0;
    const counting: InMemoryEdgeStore = {
      ...edges,
      countBy: (query) =>
        Effect.suspend(() => {
          asked += 1;
          return edges.countBy(query);
        }),
    };
    await run(edges.insert({ postId: "p-public", termId: "t-public" }));
    const posts = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    const terms = makeInMemoryNodes(["visibility"]);
    Arr.forEach(postRows, posts.put);
    terms.put(node("t-public", { visibility: "public" }));
    const ops = defineEdgeOps({
      type: "links",
      ends: { post: ownedEnd("postId", posts), term: referenceEnd("termId", terms) },
      edges: counting,
      viewer: Effect.succeed(anonymous),
      policy: gardeneriaPolicy,
      followers: follows,
      values: (input: EdgeValues) => input,
      toResource: (row: EdgeRow) => row,
    });
    const tooMany = Arr.makeBy(MAX_SET_VALUES + 1, (i) => `t-${i}`);
    expect(HashMap.size(await run(ops.countBy("term", [])))).toBe(0);
    const over = await run(ops.countBy("term", tooMany));
    expect(HashMap.size(over)).toBe(MAX_SET_VALUES + 1);
    expect(HashMap.every(over, (count) => count === 0)).toBe(true);
    expect(HashMap.get(await run(ops.countBy("nope", ["t-public"])), "t-public")).toEqual(
      Option.some(0),
    );
    expect(asked).toBe(0);
    // Not vacuous: a well-formed request asks once, for every id at once.
    const one = await run(ops.countBy("term", ["t-public", "t-none"]));
    expect(asked).toBe(1);
    expect(HashMap.get(one, "t-public")).toEqual(Option.some(1));
    expect(HashMap.get(one, "t-none")).toEqual(Option.some(0));
  });
});

describe("nonMemberFilter: the complement of memberFilter under EDGE-001 (pulpit#191)", () => {
  /** Posts (owned, with drafts) × terms (reference): a few chosen edges, so some posts are in no set. */
  const taxonomy = (policy: AccessPolicy = gardeneriaPolicy) => {
    const posts = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    const terms = makeInMemoryNodes(["visibility"]);
    const postRows = [
      node("p-public", { ownerId: member.id, visibility: "public", draft: false }),
      node("p-private", { ownerId: member.id, visibility: "private", draft: false }),
      node("p-followers", { ownerId: member.id, visibility: "followers", draft: false }),
      node("p-draft", { ownerId: otherMember.id, visibility: "public", draft: true }),
      node("p-alone", { ownerId: otherMember.id, visibility: "public", draft: false }),
      node("p-dead", { ownerId: member.id, visibility: "public", draft: false }, "delete"),
    ];
    const termRows = [
      node("t-public", { visibility: "public" }),
      node("t-private", { visibility: "private" }),
      node("t-dead", { visibility: "public" }, "delete"),
    ];
    Arr.forEach(postRows, posts.put);
    Arr.forEach(termRows, terms.put);
    const links = family(
      { ends: { post: ownedEnd("postId", posts), term: referenceEnd("termId", terms) } },
      [],
      policy,
    );
    const pairs = [
      { postId: "p-public", termId: "t-public" },
      { postId: "p-public", termId: "t-private" },
      { postId: "p-private", termId: "t-public" },
      { postId: "p-followers", termId: "t-private" },
      { postId: "p-draft", termId: "t-public" },
      { postId: "p-dead", termId: "t-public" },
      { postId: "p-alone", termId: "t-dead" },
    ];
    return { ...links, postRows, termRows, pairs };
  };

  const context = {
    now: NOW,
    contains: (set: Following, value: ColumnValue) =>
      Predicate.isString(value) && HashSet.has(set, value),
  };

  const policies = [
    ["gardeneria's rungs", gardeneriaPolicy],
    ["split rungs (pulpit#93)", splitPolicy],
  ] as const;
  const cases = Arr.flatMap(policies, ([policyName, policy]) =>
    Arr.map([...viewers, ["an admin", as(admin)] as const], ([name, viewer]) => ({
      label: `${name}, ${policyName}`,
      policy,
      viewer,
    })),
  );

  it.each(cases)(
    "partitions the rows with memberFilter, for $label",
    async ({ policy, viewer }) => {
      const { edges, ops, actAs, postRows, termRows, pairs } = taxonomy(policy);
      await run(Effect.forEach(pairs, edges.insert, { concurrency: 1, discard: true }));
      const asked = [...termRows.map((term) => [term.id]), termRows.map((term) => term.id)];
      const answers = await run(
        actAs(
          viewer,
          Effect.forEach(
            asked,
            (termIds) =>
              Effect.gen(function* () {
                const inSet = yield* ops.memberFilter("post", termIds);
                const outSet = yield* ops.nonMemberFilter("post", termIds);
                return postRows.map(
                  (post) =>
                    [evaluate(inSet, post, context), evaluate(outSet, post, context)] as const,
                );
              }),
            { concurrency: 1 },
          ),
        ),
      );
      // Every row is in exactly one of the two sets.
      Arr.forEach(answers, (rows) =>
        Arr.forEach(rows, ([inSet, outSet]) => expect(inSet).not.toBe(outSet)),
      );
    },
  );

  it("a post whose only edge to the named terms is hidden is not excluded", async () => {
    const { edges, ops, actAs, postRows } = taxonomy();
    await run(edges.insert({ postId: "p-public", termId: "t-private" }));
    await run(edges.insert({ postId: "p-private", termId: "t-public" }));
    const kept = async (who: Viewer, termIds: ReadonlyArray<string>) => {
      const filter = await run(actAs(who, ops.nonMemberFilter("post", termIds)));
      return postRows.filter((post) => evaluate(filter, post, context)).map((post) => post.id);
    };
    // Anonymous can't read t-private's edge nor p-private: nothing is excluded.
    expect(await kept(anonymous, ["t-private", "t-public"])).toEqual(
      postRows.map((post) => post.id),
    );
    // The owner reads p-private's edge to t-public, never t-private's.
    expect(await kept(as(member), ["t-private", "t-public"])).not.toContain("p-private");
    expect(await kept(as(member), ["t-private", "t-public"])).toContain("p-public");
    // An admin reads both edges.
    const admins = await kept(as(admin), ["t-private", "t-public"]);
    expect(admins).not.toContain("p-public");
    expect(admins).not.toContain("p-private");
  });

  it("a NULL or absent id is never excluded", async () => {
    const { edges, ops, actAs } = taxonomy();
    await run(edges.insert({ postId: "p-public", termId: "t-public" }));
    const filter = await run(actAs(anonymous, ops.nonMemberFilter("post", ["t-public"])));
    const everything = { now: NOW, contains: () => true };
    expect(evaluate(filter, { id: null }, everything)).toBe(true);
    expect(evaluate(filter, {}, everything)).toBe(true);
    expect(evaluate(filter, { id: "p-public" }, everything)).toBe(false);
  });

  it("fails closed as always, without asking the store, for no ids, too many, or a misnamed end", async () => {
    const { edges, postRows } = taxonomy();
    let asked = 0;
    const counting: InMemoryEdgeStore = {
      ...edges,
      members: (query) =>
        Effect.suspend(() => {
          asked += 1;
          return edges.members(query);
        }),
    };
    const posts = makeInMemoryNodes(["ownerId", "visibility", "draft"]);
    Arr.forEach(postRows, posts.put);
    const over = (
      ends: EdgeDefinition<EdgeValues, EdgeRow, EdgeRow, Following, never, never>["ends"],
    ) =>
      defineEdgeOps({
        type: "links",
        ends,
        edges: counting,
        viewer: Effect.succeed(anonymous),
        policy: gardeneriaPolicy,
        followers: follows,
        values: (input: EdgeValues) => input,
        toResource: (row: EdgeRow) => row,
      });
    const pair = over({ post: ownedEnd("postId", posts), term: referenceEnd("termId", posts) });
    const lone = over({ post: ownedEnd("postId", posts) });
    const tooMany = Arr.makeBy(MAX_SET_VALUES + 1, (i) => `t-${i}`);
    expect(await run(pair.nonMemberFilter("post", []))).toEqual(always);
    expect(await run(pair.nonMemberFilter("post", tooMany))).toEqual(always);
    expect(await run(pair.nonMemberFilter("nope", ["t-public"]))).toEqual(always);
    expect(await run(lone.nonMemberFilter("post", ["t-public"]))).toEqual(always);
    expect(asked).toBe(0);
    // Not vacuous: a well-formed request does ask.
    await run(pair.nonMemberFilter("post", ["t-public"]));
    expect(asked).toBe(1);
  });
});

describe("memberFilter through the member leaf's own list (pulpit#189)", () => {
  it.each(viewers)("lists the members %s may read, and only them", async (_, viewer) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, {
      columns: ["title", "visibility", "draft"],
      now: NOW,
    });
    let who: Viewer = as(member);
    const posts = defineSubtype({
      type: "entries",
      access: ownedAccess({ draft: true }),
      chain,
      leaves,
      viewer: Effect.sync(() => who),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row: LeafRow) => row.id,
    });
    const terms = makeInMemoryNodes(["visibility"]);
    terms.put(node("t-public", { visibility: "public" }));
    terms.put(node("t-private", { visibility: "private" }));
    const links = defineEdgeOps({
      type: "links",
      ends: {
        post: { ...ownedEnd("postId", makeInMemoryNodes([])), nodes: leaves },
        term: referenceEnd("termId", terms),
      },
      edges: makeInMemoryEdgeStore({
        ends: {
          post: { ...ownedEnd("postId", makeInMemoryNodes([])), nodes: leaves },
          term: referenceEnd("termId", terms),
        },
        uniqueKey: [],
        now: NOW,
      }),
      viewer: Effect.sync(() => who),
      policy: gardeneriaPolicy,
      followers: follows,
      values: (input: EdgeValues) => input,
      toResource: (row: EdgeRow) => row,
      writeGate: () => Effect.void,
    });
    const listed = await run(
      Effect.gen(function* () {
        const seeded = yield* Effect.forEach(
          [
            ["public", false, "t-public"],
            ["private", false, "t-public"],
            ["followers", false, "t-public"],
            ["public", true, "t-public"],
            ["public", false, "t-public"],
          ] as const,
          ([visibility, draft, termId]) =>
            Effect.gen(function* () {
              const { id } = yield* posts.create({
                id: Option.none(),
                state: { title: "t", visibility, draft },
              });
              yield* links.create({ postId: id, termId });
              return id;
            }),
          { concurrency: 1 },
        );
        who = viewer;
        // The member leaf's own list takes the edge family's filter (it type-checks: pulpit#189).
        const where = yield* links.memberFilter("post", ["t-public", "t-private"]);
        const page = yield* posts.list({ limit: 100, offset: 0, includeDeleted: false, where });
        // The per-edge reading: a post is a member when the viewer can read it and an edge to a named term.
        const readable = yield* Effect.filter(
          seeded,
          (id) =>
            Effect.gen(function* () {
              const shown = yield* Effect.exit(posts.get(id));
              const edges = yield* links.list({ limit: 100, offset: 0, where: eq("postId", id) });
              return Exit.isSuccess(shown) && Arr.isReadonlyArrayNonEmpty(edges.rows);
            }),
          { concurrency: 1 },
        );
        return [page.rows, readable] as const;
      }),
    );
    const [rows, readable] = listed;
    expect(Arr.sort(rows, Order.String)).toEqual(Arr.sort(readable, Order.String));
    expect(Arr.isReadonlyArrayNonEmpty(rows)).toBe(true);
  });

  it.each(viewers)(
    "memberFilter and nonMemberFilter partition the rows %s may read (pulpit#191)",
    async (_, viewer) => {
      const chain = makeInMemoryChainStore();
      const leaves = makeInMemoryLeafStore(chain, {
        columns: ["title", "visibility", "draft"],
        now: NOW,
      });
      // An admin seeds, so it can link to the private term too.
      let who: Viewer = as(admin);
      const posts = defineSubtype({
        type: "entries",
        access: ownedAccess({ draft: true }),
        chain,
        leaves,
        viewer: Effect.sync(() => who),
        policy: gardeneriaPolicy,
        followers: follows,
        toResource: (row: LeafRow) => row.id,
      });
      const terms = makeInMemoryNodes(["visibility"]);
      terms.put(node("t-public", { visibility: "public" }));
      terms.put(node("t-private", { visibility: "private" }));
      const ends = {
        post: { ...ownedEnd("postId", makeInMemoryNodes([])), nodes: leaves },
        term: referenceEnd("termId", terms),
      };
      const links = defineEdgeOps({
        type: "links",
        ends,
        edges: makeInMemoryEdgeStore({ ends, uniqueKey: [], now: NOW }),
        viewer: Effect.sync(() => who),
        policy: gardeneriaPolicy,
        followers: follows,
        values: (input: EdgeValues) => input,
        toResource: (row: EdgeRow) => row,
        writeGate: () => Effect.void,
      });
      const [inRows, outRows, allRows] = await run(
        Effect.gen(function* () {
          yield* Effect.forEach(
            [
              ["public", false, ["t-public"]],
              ["private", false, ["t-public"]],
              ["followers", false, ["t-private"]],
              ["public", true, ["t-public"]],
              ["public", false, ["t-private"]],
              ["public", false, []],
            ] as const,
            ([visibility, draft, termIds]) =>
              Effect.gen(function* () {
                const { id } = yield* posts.create({
                  id: Option.none(),
                  state: { title: "t", visibility, draft },
                });
                yield* Effect.forEach(termIds, (termId) => links.create({ postId: id, termId }), {
                  concurrency: 1,
                  discard: true,
                });
              }),
            { concurrency: 1, discard: true },
          );
          who = viewer;
          const named = ["t-public"];
          const page = (where: ListFilter<Following>) =>
            Effect.map(
              posts.list({ limit: 100, offset: 0, includeDeleted: false, where }),
              (listed) => Arr.sort(listed.rows, Order.String),
            );
          return [
            yield* page(yield* links.memberFilter("post", named)),
            yield* page(yield* links.nonMemberFilter("post", named)),
            yield* page(always),
          ] as const;
        }),
      );
      expect(Arr.sort([...inRows, ...outRows], Order.String)).toEqual(allRows);
      expect(Arr.intersection(inRows, outRows)).toEqual([]);
      // Not vacuous: every viewer reads the public post with no term, which is kept.
      expect(Arr.isReadonlyArrayNonEmpty(outRows)).toBe(true);
    },
  );
});
