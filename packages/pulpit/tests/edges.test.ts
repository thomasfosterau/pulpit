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
 *   is restored, except from the view-deleted rung), the declared
 *   cardinality limits (counting only readable edges with live ends),
 *   what a create discloses (nothing about a
 *   hidden edge), and a reference end's followers arm agreeing
 *   with the endpoint leaf's own `get`.
 *
 * @module tests/edges
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
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
} from "../src/Edges.ts";
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
} from "../src/Filter.ts";
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
} from "../src/Subtype.ts";
import { audienceSeam } from "../src/Audience.ts";
import type { ColumnValue, VersionAction } from "../src/VersionChain.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryMembershipStore,
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
  showValue,
  textOf,
} from "./fixtures.ts";

const errorOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return Exit.findErrorOption(yield* Effect.exit(effect));
  });
const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return Option.map(yield* errorOf(effect), (error) => error._tag);
  });

const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();

/**
 * gardeneria's axes with the two read rungs split: a moderator sees
 * tombstones but not `private` rows or drafts, which only an admin sees. The
 * view-deleted rung's reading of a tombstoned end is visible only
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
  const listed = (who: Viewer, where: Parameters<typeof ops.list>[0]["where"] = always) =>
    Effect.gen(function* () {
      const page = yield* actAs(who, ops.list({ limit: 1000, offset: 0, where }));
      return { ids: page.rows.map((row) => row.id), total: page.total };
    });
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

  it.effect("refuses an anonymous and a plain user's assertion, and admits a contributor's", () =>
    Effect.gen(function* () {
      const { ops, actAs } = corpus();
      const input = { subjectId: "s1", partId: "p1" };
      expect(yield* tagOf(actAs(anonymous, ops.create(input)))).toEqual(
        Option.some("Unauthorized"),
      );
      expect(yield* tagOf(actAs(as(member), ops.create(input)))).toEqual(Option.some("Forbidden"));
      const created = yield* actAs(as(contributor), ops.create(input));
      expect(created.created).toBe(true);
    }),
  );

  it.effect("round-trips the id through get and delete, and the delete is hard", () =>
    Effect.gen(function* () {
      const { edges, subjects, ops, actAs } = corpus();
      const { id } = yield* actAs(
        as(contributor),
        ops.create({ subjectId: "s1", partId: "p1", note: "mature" }),
      );
      const read = yield* actAs(anonymous, ops.get(id));
      expect(read).toMatchObject({ id, subjectId: "s1", partId: "p1", note: "mature" });

      expect(yield* actAs(as(contributor), ops.delete(id))).toEqual({ id });
      expect(yield* tagOf(actAs(anonymous, ops.get(id)))).toEqual(Option.some("EdgeNotFound"));
      // No tombstone: the row is gone, and the node it joined is untouched.
      expect(edges.rows()).toEqual([]);
      expect(Option.isSome(yield* subjects.get("s1"))).toBe(true);
      expect(yield* tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(
        Option.some("EdgeNotFound"),
      );
    }),
  );

  it.effect("makes a re-assertion idempotent rather than a failure", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = corpus({ onConflict: "ignore" }, ["subjectId", "partId"]);
      const input = { subjectId: "s1", partId: "p1" };
      const first = yield* actAs(as(contributor), ops.create(input));
      const second = yield* actAs(as(contributor), ops.create(input));
      expect(second).toEqual({ id: first.id, created: false });
      expect(yield* listed(anonymous, eq("subjectId", "s1"))).toEqual({
        ids: [first.id],
        total: 1,
      });
    }),
  );

  it.effect(
    "refuses a re-assertion below the gate with the gate's answer, never the stored edge",
    () =>
      Effect.gen(function* () {
        const { ops, actAs } = corpus({ onConflict: "ignore" }, ["subjectId", "partId"]);
        const input = { subjectId: "s1", partId: "p1" };
        yield* actAs(as(contributor), ops.create(input));
        // The collision resolves only past the gate, so it never hands an id to a
        // caller who may not write (and an "ignore" re-assertion is still a write).
        expect(yield* tagOf(actAs(anonymous, ops.create(input)))).toEqual(
          Option.some("Unauthorized"),
        );
        expect(yield* tagOf(actAs(as(member), ops.create(input)))).toEqual(
          Option.some("Forbidden"),
        );
      }),
  );

  it.effect("refuses a duplicate when the family resolves no conflict", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = corpus({}, ["subjectId", "partId"]);
      const input = { subjectId: "s1", partId: "p1" };
      yield* actAs(as(contributor), ops.create(input));
      expect(yield* tagOf(actAs(as(contributor), ops.create(input)))).toEqual(
        Option.some("EdgeConflict"),
      );
      expect(edges.rows()).toHaveLength(1);
    }),
  );

  it.effect("reads an assertion from either end", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = corpus();
      const { id } = yield* actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" }));
      yield* actAs(as(contributor), ops.create({ subjectId: "s2", partId: "p2" }));
      expect((yield* listed(anonymous, eq("subjectId", "s1"))).ids).toEqual([id]);
      expect((yield* listed(anonymous, eq("partId", "p1"))).ids).toEqual([id]);
    }),
  );

  it.effect("lists in creation order with the unpaged total, the page clamped to the cap", () =>
    Effect.gen(function* () {
      const { ops, actAs, seen } = corpus();
      const pairs = [
        ["s1", "p1"],
        ["s1", "p2"],
        ["s2", "p1"],
        ["s2", "p3"],
      ] as const;
      const ids = yield* actAs(
        as(contributor),
        Effect.forEach(pairs, ([subjectId, partId]) => ops.create({ subjectId, partId }), {
          concurrency: 1,
        }),
      );
      const page = yield* actAs(anonymous, ops.list({ limit: 2, offset: 1, where: always }));
      expect(page.rows.map((row) => row.id)).toEqual([ids[1]?.id, ids[2]?.id]);
      expect(page.total).toBe(4);
      const huge = yield* actAs(anonymous, ops.list({ limit: 1e9, offset: -5, where: always }));
      expect(huge.rows.map((row) => row.id)).toEqual(ids.map((written) => written.id));
      yield* actAs(anonymous, ops.list({ limit: 0, offset: 1.5, where: always }));
      // The store is asked for at most the cap, whatever the request says
      // (SEC-INPUT-003): four rows alone can't tell a clamped limit from none.
      expect(seen.windows()).toEqual([
        { limit: 2, offset: 1 },
        { limit: MAX_PAGE_LIMIT, offset: 0 },
        { limit: 1, offset: 1 },
      ]);
    }),
  );

  it.effect("reports a total of 0 for a page past the end, as the store's window column does", () =>
    Effect.gen(function* () {
      const { ops, actAs } = corpus();
      yield* actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" }));
      expect(yield* actAs(anonymous, ops.list({ limit: 10, offset: 5, where: always }))).toEqual({
        rows: [],
        total: 0,
      });
    }),
  );
});

// ── Ported: CMS rows on the moderator rung ────────────────────────────

describe("ported: CMS rows on the moderator rung (gardeneria's page collections and slugs)", () => {
  const moderatorGate = rungGate((policy) => policy.canModerate);

  it.effect("a family with no ends is a plain bounded row family, written at the gate's rung", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = family({ ends: {}, writeGate: moderatorGate });
      const input = { name: "Guides" };
      expect(yield* tagOf(actAs(anonymous, ops.create(input)))).toEqual(
        Option.some("Unauthorized"),
      );
      expect(yield* tagOf(actAs(as(contributor), ops.create(input)))).toEqual(
        Option.some("Forbidden"),
      );
      const { id } = yield* actAs(as(moderator), ops.create(input));
      expect(yield* actAs(anonymous, ops.get(id))).toMatchObject({ name: "Guides" });
      expect(yield* listed(anonymous)).toEqual({ ids: [id], total: 1 });
      expect(yield* tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(
        Option.some("Forbidden"),
      );
    }),
  );

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

  it.effect("resolves a second alias on the same path to the stored row, NULLs equal", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = slugs();
      const first = yield* actAs(
        as(moderator),
        ops.create({ pageId: "page-1", path: "shared-alias" }),
      );
      const again = yield* actAs(
        as(moderator),
        ops.create({ pageId: "page-2", path: "shared-alias" }),
      );
      expect(again).toEqual({ id: first.id, created: false });
      expect(edges.rows()).toHaveLength(1);
      expect(edges.rows()[0]?.["pageId"]).toBe("page-1");
    }),
  );

  it.effect(
    "resolves a collision only to a readable edge whose every end is live: not a retired page's alias, even for the view-deleted rung",
    () =>
      Effect.gen(function* () {
        const { pages, ops, actAs } = slugs(splitPolicy);
        const retired = yield* actAs(
          as(moderator),
          ops.create({ pageId: "page-1", path: "retired" }),
        );
        // The page the stored alias points at is tombstoned. The view-deleted
        // rung reads its alias but can't link to a tombstone, so the
        // collision doesn't resolve to it.
        pages.put(node("page-1", { visibility: "public" }, "delete"));
        expect(yield* actAs(as(moderator), ops.get(retired.id))).toMatchObject({
          pageId: "page-1",
        });
        expect(
          yield* errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "retired" }))),
        ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
      }),
  );

  it.effect("never resolves a collision to an edge the viewer cannot read", () =>
    Effect.gen(function* () {
      const { pages, ops, actAs } = slugs(splitPolicy);
      yield* actAs(as(admin), ops.create({ pageId: "page-1", path: "hidden" }));
      // A private page is hidden from a moderator below the view-private rung
      // (splitPolicy), tombstoned or not: the collision must not hand back its
      // alias's id, and answers as any unresolved collision does.
      pages.put(node("page-1", { visibility: "private" }, "delete"));
      expect(
        yield* errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "hidden" }))),
      ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
    }),
  );
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
      const id = textOf(edge["observationId"]);
      return requireWriter(
        ownedAccess(),
        viewer,
        policy,
        { type: "observations", id },
        Effect.map(
          observations.get(id),
          Option.flatMap((row) => Option.liftPredicate(row["ownerId"], P.isString)),
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

  it.effect("lets the observation's owner record a disorder they did not author", () =>
    Effect.gen(function* () {
      const { ops, actAs } = observationsAndDisorders();
      const { id } = yield* actAs(
        as(member),
        ops.create({ observationId: "o-public", disorderId: "mildew", severity: "high" }),
      );
      expect(yield* actAs(as(member), ops.get(id))).toMatchObject({ severity: "high" });
    }),
  );

  it.effect("refuses a stranger's write with NotFound, never Forbidden", () =>
    Effect.gen(function* () {
      const { ops, actAs } = observationsAndDisorders();
      // The contributor rung is not enough here, and a 403 would confirm the
      // private observation exists (SEC-AUTH-ENUM-001).
      expect(
        yield* errorOf(
          actAs(as(contributor), ops.create({ observationId: "o-private", disorderId: "mildew" })),
        ),
      ).toEqual(
        Option.some(
          expect.objectContaining({ _tag: "NodeNotFound", type: "observations", id: "o-private" }),
        ),
      );
    }),
  );

  it.effect("refuses a stranger's retraction of a link they can see", () =>
    Effect.gen(function* () {
      const { ops, actAs } = observationsAndDisorders();
      const { id } = yield* actAs(
        as(member),
        ops.create({ observationId: "o-public", disorderId: "mildew" }),
      );
      expect(yield* actAs(as(otherMember), ops.get(id))).toMatchObject({ id });
      expect(yield* tagOf(actAs(as(otherMember), ops.delete(id)))).toEqual(
        Option.some("Forbidden"),
      );
      expect(yield* tagOf(actAs(as(moderator), ops.delete(id)))).toEqual(Option.none());
    }),
  );

  it.effect("hides a private observation's links from a stranger's read and list alike", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = observationsAndDisorders();
      const { id } = yield* actAs(
        as(member),
        ops.create({ observationId: "o-private", disorderId: "mildew" }),
      );
      expect(yield* tagOf(actAs(as(otherMember), ops.get(id)))).toEqual(
        Option.some("EdgeNotFound"),
      );
      // Scoped by the disorder — the corpus-facing question — and still nothing, total included.
      expect(yield* listed(as(otherMember), eq("disorderId", "mildew"))).toEqual({
        ids: [],
        total: 0,
      });
      expect(yield* listed(as(member), eq("disorderId", "mildew"))).toEqual({
        ids: [id],
        total: 1,
      });
    }),
  );

  it.effect("makes re-asserting the same pair idempotent, never overwriting the qualifier", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = observationsAndDisorders();
      const pair = { observationId: "o-public", disorderId: "mildew" };
      const first = yield* actAs(as(member), ops.create({ ...pair, severity: "low" }));
      const second = yield* actAs(as(member), ops.create({ ...pair, severity: "high" }));
      expect(second).toEqual({ id: first.id, created: false });
      expect(yield* actAs(as(member), ops.get(first.id))).toMatchObject({ severity: "low" });
      expect((yield* listed(as(member), eq("observationId", "o-public"))).total).toBe(1);
    }),
  );

  it.effect("records several disorders against one observation", () =>
    Effect.gen(function* () {
      const { ops, actAs, listed } = observationsAndDisorders();
      yield* actAs(as(member), ops.create({ observationId: "o-public", disorderId: "mildew" }));
      yield* actAs(as(member), ops.create({ observationId: "o-public", disorderId: "chlorosis" }));
      expect((yield* listed(as(otherMember), eq("observationId", "o-public"))).total).toBe(2);
    }),
  );

  it.effect("retracts a link as a hard delete, leaving the disorder alone", () =>
    Effect.gen(function* () {
      const { disorders, edges, ops, actAs } = observationsAndDisorders();
      const { id } = yield* actAs(
        as(member),
        ops.create({ observationId: "o-public", disorderId: "mildew" }),
      );
      yield* actAs(as(member), ops.delete(id));
      expect(yield* tagOf(actAs(as(member), ops.get(id)))).toEqual(Option.some("EdgeNotFound"));
      expect(edges.rows()).toEqual([]);
      expect(Option.isSome(yield* disorders.get("mildew"))).toBe(true);
    }),
  );
});

// ── EDGE-001: endpoint visibility ─────────────────────────────────────

/** The joined row a store's list filters: the edge, plus the node's columns under the end's alias. */
const joinedRow = (alias: string, column: string, row: LeafRow): FilterRow => ({
  id: "edge",
  createdAt: NOW,
  [column]: row.id,
  ...R.mapKeys(row, (key): string => endpointColumn(alias, key)),
});

const evaluationContext = {
  now: NOW,
  contains: (set: Following, value: ColumnValue) => P.isString(value) && HashSet.has(set, value),
};

/** For one end and one viewer: each row's [id, listed, readable] — the two readings side by side. */
const readings = (
  end: EdgeEnd<never, never>,
  viewer: Viewer,
  rows: ReadonlyArray<LeafRow>,
  followers: FollowerSeam<Following, never> = follows,
  policy: AccessPolicy = gardeneriaPolicy,
) =>
  Effect.forEach(
    rows,
    (row) =>
      Effect.map(canViewEndpoint(end, viewer, policy, followers, Option.some(row)), (readable) => ({
        id: row.id,
        listed: evaluate(
          endpointFilter({ end }, viewer, policy, followers),
          joinedRow("end", end.column, row),
          evaluationContext,
        ),
        readable,
      })),
    { concurrency: 1 },
  );

const actions: ReadonlyArray<VersionAction> = ["create", "update", "delete"];

/** The two booleans, `null`, a stringly `"false"`, and no key at all. */
const drafts: ReadonlyArray<ColumnValue | typeof ABSENT> = [false, true, null, "false", ABSENT];

/** A draft for a row id: a string quoted, so `"false"` never collides with `false`. */
const showDraft = (draft: ColumnValue | typeof ABSENT): string =>
  draft === ABSENT ? "absent" : P.isString(draft) ? `"${draft}"` : showValue(draft);

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

  it.effect.each(viewersByPolicy)("an owned end, for %s", ([_name, viewer, policy]) =>
    Effect.gen(function* () {
      const seen = yield* readings(
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
    }),
  );

  const referenceRows = Arr.flatMap(actions, (action) =>
    Arr.map(["public", "followers", "private", "unknown", null], (visibility) =>
      node(`${action}-${String(visibility)}`, { visibility }, action),
    ),
  );

  it.effect.each(viewersByPolicy)(
    "a reference end, with and without a visibility column, for %s",
    ([_name, viewer, policy]) =>
      Effect.gen(function* () {
        const withAxis = yield* readings(
          referenceEnd("subjectId", makeInMemoryNodes(["visibility"])),
          viewer,
          referenceRows,
          follows,
          policy,
        );
        const withoutAxis = yield* readings(
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
      }),
  );

  describe("a reference end whose leaf declares a followers column", () => {
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
            `${action}-${String(visibility)}-${curatorId === ABSENT ? "absent" : P.isString(curatorId) ? `"${curatorId}"` : showValue(curatorId)}`,
            curatorId === ABSENT ? { visibility } : { visibility, curatorId },
            action,
          ),
        ),
      ),
    );
    const curatedEnd = (
      columns: ReadonlyArray<string>,
      followersOfColumn?: string,
    ): EdgeEnd<never, never> => ({
      column: "termId",
      type: "terms",
      access:
        followersOfColumn === undefined
          ? { kind: "reference" }
          : { kind: "reference", followersOfColumn },
      nodes: makeInMemoryNodes(columns),
    });
    const variants = [
      ["declaring a column the view carries", ["visibility", "curatorId"], "curatorId"],
      ["declaring a column the view lacks", ["visibility"], "curatorId"],
      ["declaring none", ["visibility", "curatorId"], undefined],
      ["over a view without a visibility column", ["curatorId"], "curatorId"],
    ] as const;

    it.effect.each(
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
    )("$variant, for $name", ({ columns, column, viewer, policy }) =>
      Effect.gen(function* () {
        asked.length = 0;
        const seen = yield* readings(
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
        expect(asked.filter((ownerId) => !P.isString(ownerId))).toEqual([]);
      }),
    );

    it.effect(
      "is not vacuous: the named account and its follower read its followers rows, and nobody else below the rung does",
      () =>
        Effect.gen(function* () {
          const end = curatedEnd(["visibility", "curatorId"], "curatorId");
          const live = curatedRows.filter((row) => row.action !== "delete");
          const shown = (viewer: Viewer) =>
            Effect.gen(function* () {
              return (yield* readings(end, viewer, live, recording)).filter(
                (reading) => reading.readable,
              );
            });
          const publicIds = live
            .filter((row) => row["visibility"] === "public")
            .map((row) => row.id);
          expect((yield* shown(as(follower))).map(({ id }) => id)).toEqual(
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
            yield* Effect.forEach(
              named,
              (account) =>
                Effect.gen(function* () {
                  return (yield* shown(as(account))).map(({ id }) => id);
                }),
              { concurrency: "unbounded" },
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
            yield* Effect.forEach(
              strangers,
              (viewer) =>
                Effect.gen(function* () {
                  return (yield* shown(viewer)).map(({ id }) => id);
                }),
              { concurrency: "unbounded" },
            ),
          ).toEqual(strangers.map(() => publicIds));
          expect(yield* shown(as(moderator))).toHaveLength(live.length);
          asked.length = 0;
          yield* readings(end, as(follower), live, recording);
          // Once per live `followers` row with a string curator (a `create` and an `update` head each).
          expect(Arr.dedupe(asked).toSorted()).toEqual(
            [member.id, otherMember.id, "null"].toSorted(),
          );
        }),
    );

    it.effect("a declared column the view lacks opens no followers row, fail closed", () =>
      Effect.gen(function* () {
        const seen = yield* readings(
          curatedEnd(["visibility"], "curatorId"),
          as(follower),
          curatedRows,
        );
        expect(
          seen.filter(({ listed, readable }) => listed || readable).map(({ id }) => id),
        ).toEqual(
          curatedRows
            .filter((row) => row.action !== "delete" && row["visibility"] === "public")
            .map((row) => row.id),
        );
      }),
    );

    it.effect("reads as the endpoint leaf's own get does, over the subtype factory's stores", () =>
      Effect.gen(function* () {
        const seam = makeInMemoryFollowers([[follower.id, [member.id]]]);
        let viewer: Viewer = anonymous;
        const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
          Effect.suspend(() => {
            viewer = who;
            return effect;
          });
        const chain = makeInMemoryVersionChain("terms");
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
        const ids = yield* Effect.forEach(
          Arr.flatMap(["public", "followers", "private"], (visibility) =>
            Arr.map([member.id, otherMember.id, null], (curatorId) => ({ visibility, curatorId })),
          ),
          (state) =>
            Effect.map(
              actAs(as(admin), terms.create({ id: Option.none(), state })),
              ({ id }) => id,
            ),
          { concurrency: 1 },
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
        const answers = yield* Effect.forEach(
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
        );
        expect(answers.map(({ name, byEndpoint }) => ({ name, answers: byEndpoint }))).toEqual(
          answers.map(({ name, byGet }) => ({ name, answers: byGet })),
        );
        // Not vacuous: rows are visibility (public, followers, private) × curator
        // (member, otherMember, NULL). The follower reads the followed account's
        // followers row; the named account its own, never its private one.
        expect(yield* readBy(as(follower))).toEqual([
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
        expect(yield* readBy(as(otherMember))).toEqual([
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
        expect(yield* readBy(anonymous)).toEqual([
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
      }),
    );
  });

  // One case per declared column, so dropping any leg of the shared
  // declared-column check (owner, visibility, draft) fails here.
  it.effect.each([
    ["an owner", ["visibility", "draft"]],
    ["a visibility", ["ownerId", "draft"]],
    ["a draft", ["ownerId", "visibility"]],
  ] as const)(
    "an owned declaration naming %s column the view lacks hides every edge, from the rung too",
    ([_missing, viewColumns]) =>
      Effect.gen(function* () {
        const seen = yield* readings(
          ownedEnd("entryId", makeInMemoryNodes(viewColumns)),
          as(admin),
          ownedRows,
        );
        expect(seen.every(({ listed, readable }) => !listed && !readable)).toBe(true);
      }),
  );

  describe("an owner column holding no string is no owner", () => {
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
            `${visibility}-${String(draft)}-${ownerId === ABSENT ? "absent" : String(ownerId)}`,
            ownerId === ABSENT ? { visibility, draft } : { ownerId, visibility, draft },
          ),
        ),
      ),
    );
    const open = unowned
      .filter((row) => row["visibility"] === "public" && row["draft"] === false)
      .map((row) => row.id);

    it.effect.each([
      ...accounts.map(
        (account) => [`an account whose id is "${account.id}"`, as(account)] as const,
      ),
      ...viewers.filter(([, viewer]) => !Option.exists(viewer, gardeneriaPolicy.canViewPrivate)),
    ])("matches no viewer and asks no follower, for %s", ([_name, viewer]) =>
      Effect.gen(function* () {
        asked.length = 0;
        const seen = yield* readings(ownedEnd("entryId", ownedNodes), viewer, unowned, fans);
        expect(seen.map(({ id, listed }) => [id, listed])).toEqual(
          seen.map(({ id, readable }) => [id, readable]),
        );
        expect(seen.filter((reading) => reading.readable).map((reading) => reading.id)).toEqual(
          open,
        );
        expect(asked).toEqual([]);
      }),
    );

    it.effect("still shows every live row to the view-private rung", () =>
      Effect.gen(function* () {
        const seen = yield* readings(ownedEnd("entryId", ownedNodes), as(moderator), unowned, fans);
        expect(seen.every(({ listed, readable }) => listed && readable)).toBe(true);
      }),
    );

    it.effect('is not vacuous: an owner column holding the string "null" is that account\'s', () =>
      Effect.gen(function* () {
        asked.length = 0;
        const owned = [
          node("private-draft", { ownerId: "null", visibility: "private", draft: true }),
          node("followers", { ownerId: "null", visibility: "followers", draft: false }),
        ];
        const end = ownedEnd("entryId", ownedNodes);
        const shown = (id: string) =>
          Effect.gen(function* () {
            return (yield* readings(end, as({ id, role: "user" }), owned, fans)).map(
              ({ listed, readable }) => [listed, readable],
            );
          });
        expect(yield* shown("null")).toEqual([
          [true, true],
          [true, true],
        ]);
        expect(yield* shown("undefined")).toEqual([
          [false, false],
          [true, true],
        ]);
        expect(asked).toContain("null");
      }),
    );
  });

  describe("a tombstoned node, by rung", () => {
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

    it.effect.each(
      viewers.filter(([, viewer]) => !Option.exists(viewer, splitPolicy.canViewDeleted)),
    )("is unreadable below the view-deleted rung, for %s", ([_name, viewer]) =>
      Effect.gen(function* () {
        const seen = yield* readings(end, viewer, tombstones, follows, splitPolicy);
        expect(seen.every(({ listed, readable }) => !listed && !readable)).toBe(true);
      }),
    );

    it.effect.each([
      ["a moderator (view-deleted only)", as(moderator)],
      ["an admin (both read rungs)", as(admin)],
    ] as const)("reads as the live row would, by its access rule, for %s", ([_name, viewer]) =>
      Effect.gen(function* () {
        const seen = yield* readings(end, viewer, tombstones, follows, splitPolicy);
        const live = yield* readings(end, viewer, tombstones.map(revived), follows, splitPolicy);
        expect(seen.map(({ listed, readable }) => [listed, readable])).toEqual(
          live.map(({ readable }) => [readable, readable]),
        );
        // Not vacuous: below the view-private rung, a private tombstone stays hidden.
        expect(seen.some(({ readable }) => readable)).toBe(true);
        expect(seen.some(({ readable }) => !readable)).toBe(
          !Option.exists(viewer, splitPolicy.canViewPrivate),
        );
      }),
    );

    it.effect("a missing node is unreadable even to both rungs", () =>
      Effect.gen(function* () {
        expect(
          yield* canViewEndpoint(end, as(admin), gardeneriaPolicy, follows, Option.none()),
        ).toBe(false);
      }),
    );
  });
});

describe("EDGE-001: an edge is readable only if every end is", () => {
  /**
   * A reference leaf (public, private, tombstoned) and an owned leaf (one
   * node per visibility state, a draft, a tombstone, another owner's private
   * row), with one edge seeded between every pair, bypassing `create`.
   */
  const everyPair = () =>
    Effect.gen(function* () {
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
      yield* Effect.forEach(
        Arr.flatMap(subjectIds, (subjectId) =>
          Arr.map(entryIds, (entryId) => ({ subjectId, entryId })),
        ),
        (values) => links.edges.insert(values),
        { concurrency: 1 },
      );
      /** The pair an edge joins, as `subject/entry`. */
      const pairOf = (id: string) => {
        const row = links.edges.rows().find((candidate) => candidate.id === id);
        return row === undefined ? "none" : `${textOf(row["subjectId"])}/${textOf(row["entryId"])}`;
      };
      return { ends, subjects, entries, pairOf, ...links };
    });

  it.effect.each(viewers)(
    "list, get and the predicate agree on every pair, for %s",
    ([_name, viewer]) =>
      Effect.gen(function* () {
        const { ends, subjects, entries, edges, ops, actAs, listed } = yield* everyPair();
        const readable = yield* Effect.filter(
          edges.rows(),
          (row) =>
            Effect.map(
              Effect.all(
                [
                  Effect.flatMap(subjects.get(textOf(row["subjectId"])), (found) =>
                    canViewEndpoint(ends.subject, viewer, gardeneriaPolicy, follows, found),
                  ),
                  Effect.flatMap(entries.get(textOf(row["entryId"])), (found) =>
                    canViewEndpoint(ends.entry, viewer, gardeneriaPolicy, follows, found),
                  ),
                ],
                { concurrency: 1 },
              ),
              ([subject, entry]) => subject && entry,
            ),
          { concurrency: 1 },
        );
        const got = yield* Effect.filter(
          edges.rows(),
          (row) => Effect.map(Effect.exit(actAs(viewer, ops.get(row.id))), Exit.isSuccess),
          { concurrency: 1 },
        );
        const page = yield* listed(viewer);
        expect(page.ids).toEqual(readable.map((row) => row.id));
        expect(got.map((row) => row.id)).toEqual(page.ids);
        expect(page.total).toBe(page.ids.length);
      }),
  );

  it.effect("states the matrix outright for the anonymous, a follower and the rung", () =>
    Effect.gen(function* () {
      const { pairOf, listed } = yield* everyPair();
      const pairs = (viewer: Viewer) =>
        Effect.gen(function* () {
          return Arr.sort((yield* listed(viewer)).ids.map(pairOf), Order.String);
        });
      expect(yield* pairs(anonymous)).toEqual(["s-public/e-public"]);
      expect(yield* pairs(as(follower))).toEqual(["s-public/e-followers", "s-public/e-public"]);
      expect(yield* pairs(as(member))).toEqual([
        "s-public/e-draft",
        "s-public/e-followers",
        "s-public/e-private",
        "s-public/e-public",
      ]);
      // The rung (both read rungs, under gardeneria's policy) sees private
      // nodes and tombstoned ones on both ends.
      expect(yield* pairs(as(moderator))).toEqual(
        Arr.flatMap(["s-gone", "s-private", "s-public"], (subject) =>
          Arr.map(
            ["e-draft", "e-followers", "e-gone", "e-other", "e-private", "e-public"],
            (entry) => `${subject}/${entry}`,
          ),
        ),
      );
    }),
  );

  it.effect("a related list omits the edges whose other end is hidden (SEC-AUTH-ENUM-001)", () =>
    Effect.gen(function* () {
      const { pairOf, listed } = yield* everyPair();
      const related = (viewer: Viewer, subjectId: string) =>
        Effect.gen(function* () {
          const page = yield* listed(viewer, eq("subjectId", subjectId));
          return { pairs: Arr.sort(page.ids.map(pairOf), Order.String), total: page.total };
        });
      // `e-other` is the stranger's own here, so a contributor asks: a stranger to every entry.
      expect(yield* related(as(contributor), "s-public")).toEqual({
        pairs: ["s-public/e-public"],
        total: 1,
      });
      expect(yield* related(as(follower), "s-public")).toEqual({
        pairs: ["s-public/e-followers", "s-public/e-public"],
        total: 2,
      });
      // A hidden node's related list is indistinguishable from an empty one.
      expect(yield* related(as(contributor), "s-private")).toEqual({ pairs: [], total: 0 });
    }),
  );

  it.effect("a family filter may name an end's node column", () =>
    Effect.gen(function* () {
      const { pairOf, listed } = yield* everyPair();
      const page = yield* listed(
        as(member),
        eq(endpointColumn("entry", "visibility"), "followers"),
      );
      expect(page.ids.map(pairOf)).toEqual(["s-public/e-followers"]);
    }),
  );

  it.effect("a create naming a hidden node is NodeNotFound, before the gate can answer 403", () =>
    Effect.gen(function* () {
      const { ops, actAs } = yield* everyPair();
      const create = (viewer: Viewer, subjectId: string, entryId: string) =>
        errorOf(actAs(viewer, ops.create({ subjectId, entryId })));
      // A member is below the corpus rung, so a readable pair is Forbidden …
      expect(yield* create(as(member), "s-public", "e-public")).toEqual(
        Option.some(expect.objectContaining({ _tag: "Forbidden" })),
      );
      // … and a hidden or tombstoned node is NotFound, naming that node.
      expect(yield* create(as(member), "s-private", "e-public")).toEqual(
        Option.some(
          expect.objectContaining({ _tag: "NodeNotFound", type: "subjects", id: "s-private" }),
        ),
      );
      expect(yield* create(as(contributor), "s-public", "e-gone")).toEqual(
        Option.some(
          expect.objectContaining({ _tag: "NodeNotFound", type: "entries", id: "e-gone" }),
        ),
      );
      expect(yield* create(anonymous, "s-public", "e-other")).toEqual(
        Option.some(expect.objectContaining({ _tag: "NodeNotFound", type: "entries" })),
      );
      expect(yield* create(as(contributor), "s-public", "missing")).toEqual(
        Option.some(
          expect.objectContaining({ _tag: "NodeNotFound", type: "entries", id: "missing" }),
        ),
      );
      // An end the values leave out names no node.
      expect(yield* errorOf(actAs(as(contributor), ops.create({ subjectId: "s-public" })))).toEqual(
        Option.some(expect.objectContaining({ _tag: "NodeNotFound", type: "entries" })),
      );
    }),
  );

  it.effect("a delete of an edge with a hidden end is EdgeNotFound, even for a writer", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs, pairOf } = yield* everyPair();
      const hidden = edges.rows().find((row) => pairOf(row.id) === "s-public/e-other");
      expect(yield* tagOf(actAs(as(contributor), ops.delete(String(hidden?.id))))).toEqual(
        Option.some("EdgeNotFound"),
      );
      expect(edges.rows()).toHaveLength(18);
    }),
  );
});

describe("EDGE-001: a tombstoned end hides its edges below the view-deleted rung, and a restore brings them back", () => {
  it.effect("over the subtype factory's own stores", () =>
    Effect.gen(function* () {
      const noFollowers = nobodyFollows<Following>(HashSet.empty());
      let viewer: Viewer = anonymous;
      const currentViewer = Effect.sync(() => viewer);
      const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          viewer = who;
          return effect;
        });
      const subjectChain = makeInMemoryVersionChain("subjects");
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
      const entryChain = makeInMemoryVersionChain("entries");
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
      const visibleTo = (who: Viewer) =>
        Effect.gen(function* () {
          return (yield* actAs(who, ops.list({ limit: 10, offset: 0, where: always }))).rows.map(
            (row) => row.id,
          );
        });

      const subject = yield* actAs(
        as(contributor),
        subjectOps.create({ id: Option.none(), state: { visibility: "public" } }),
      );
      const entry = yield* actAs(
        as(member),
        entryOps.create({ id: Option.none(), state: { visibility: "public", draft: false } }),
      );
      const { id } = yield* actAs(
        as(contributor),
        ops.create({ subjectId: subject.id, entryId: entry.id }),
      );
      expect(yield* visibleTo(anonymous)).toEqual([id]);

      yield* actAs(as(member), entryOps.delete(entry.id));
      // Hidden from everyone below the view-deleted rung …
      const below = [anonymous, as(member), as(contributor)];
      expect(yield* Effect.forEach(below, visibleTo, { concurrency: "unbounded" })).toEqual(
        below.map(() => []),
      );
      const reads = yield* Effect.forEach(below, (who) => tagOf(actAs(who, ops.get(id))), {
        concurrency: "unbounded",
      });
      expect(reads).toEqual(below.map(() => Option.some("EdgeNotFound")));
      expect(yield* tagOf(actAs(as(contributor), ops.delete(id)))).toEqual(
        Option.some("EdgeNotFound"),
      );
      // … and read by the rung, which reads the tombstone itself.
      const rung = [as(moderator), as(admin)];
      expect(yield* Effect.forEach(rung, visibleTo, { concurrency: "unbounded" })).toEqual(
        rung.map(() => [id]),
      );
      yield* actAs(as(moderator), entryOps.get(entry.id));
      // A create can't name the tombstone, whoever asks.
      expect(
        yield* Effect.forEach(
          [as(contributor), as(moderator)],
          (who) => tagOf(actAs(who, ops.create({ subjectId: subject.id, entryId: entry.id }))),
          { concurrency: "unbounded" },
        ),
      ).toEqual([Option.some("NodeNotFound"), Option.some("NodeNotFound")]);
      // Hidden, not deleted.
      expect(edges.rows().map((row) => row.id)).toEqual([id]);

      yield* actAs(as(member), entryOps.restore({ id: entry.id, patch: {} }));
      expect(yield* visibleTo(anonymous)).toEqual([id]);
      expect(yield* actAs(anonymous, ops.get(id))).toMatchObject({ id, entryId: entry.id });
    }),
  );
});

describe("EDGE-001 by rung × end state: the view-deleted rung reads an edge whose only hidden end is tombstoned", () => {
  /** The subject end's states; the part end is always a live public node. */
  const states = {
    live: node("s-live", { visibility: "public" }),
    "live and private": node("s-private", { visibility: "private" }),
    tombstoned: node("s-gone", { visibility: "public" }, "delete"),
    "tombstoned and private": node("s-gone-private", { visibility: "private" }, "delete"),
  };
  type State = keyof typeof states;

  /** One edge from each subject state to `p1`, seeded past `create`, under the split policy. */
  const world = () =>
    Effect.gen(function* () {
      const subjects = makeInMemoryNodes(["visibility"]);
      const parts = makeInMemoryNodes(["visibility"]);
      R.values(states).forEach((row) => subjects.put(row));
      parts.put(node("p1", { visibility: "public" }));
      const links = family(
        {
          ends: {
            subject: referenceEnd("subjectId", subjects),
            part: referenceEnd("partId", parts),
          },
        },
        [],
        splitPolicy,
      );
      yield* Effect.forEach(
        R.values(states),
        (row) => links.edges.insert({ subjectId: row.id, partId: "p1" }),
        { concurrency: 1 },
      );
      const idOf = (state: State) =>
        String(links.edges.rows().find((row) => row["subjectId"] === states[state].id)?.id);
      return { ...links, idOf };
    });

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
    Arr.map(R.keys(states), (state) => [rung, state, viewer, reads.includes(state)] as const),
  );

  it.effect.each(cases)("%s, an edge whose subject is %s", ([_rung, state, viewer, readable]) =>
    Effect.gen(function* () {
      const { edges, ops, actAs, listed, idOf } = yield* world();
      const id = idOf(state);
      expect((yield* listed(viewer)).ids.includes(id)).toBe(readable);
      expect((yield* listed(viewer, eq("partId", "p1"))).ids.includes(id)).toBe(readable);
      expect(Exit.isSuccess(yield* Effect.exit(actAs(viewer, ops.get(id))))).toBe(readable);
      expect(yield* tagOf(actAs(viewer, ops.delete(id)))).toEqual(
        readable ? Option.none() : Option.some("EdgeNotFound"),
      );
      expect(edges.rows().some((row) => row.id === id)).toBe(!readable);
    }),
  );

  it.effect("a create naming a tombstoned node is NodeNotFound to the rung that reads it", () =>
    Effect.gen(function* () {
      const { ops, actAs } = yield* world();
      expect(
        yield* errorOf(actAs(as(admin), ops.create({ subjectId: "s-gone", partId: "p1" }))),
      ).toEqual(
        Option.some(
          expect.objectContaining({ _tag: "NodeNotFound", type: "subjects", id: "s-gone" }),
        ),
      );
    }),
  );
});

describe("what a create discloses: nothing that tells a hidden edge from a readable one, or from none", () => {
  /**
   * `s1` with `hidden` stored edges to private parts, which a contributor
   * can't read and a moderator can, and room for `maxEdges` on its end.
   */
  const slotWorld = (maxEdges: number, hidden: number) =>
    Effect.gen(function* () {
      const { subjects, parts } = twoReferenceLeaves();
      const secret = Arr.makeBy(hidden, (index) => `h${String(index + 1)}`);
      secret.forEach((id) => parts.put(node(id, { visibility: "private" })));
      const links = family({
        ends: {
          subject: { ...referenceEnd("subjectId", subjects), maxEdges },
          part: referenceEnd("partId", parts),
        },
      });
      yield* Effect.forEach(secret, (partId) => links.edges.insert({ subjectId: "s1", partId }), {
        concurrency: 1,
      });
      return links;
    });
  /** A caller's answers to three creates at `s1`, in order. */
  const answers = (links: Effect.Success<ReturnType<typeof slotWorld>>, viewer: Viewer) =>
    Effect.forEach(
      ["p1", "p2", "p3"],
      (partId) => answerOf(links.actAs(viewer, links.ops.create({ subjectId: "s1", partId }))),
      { concurrency: 1 },
    );

  it.effect.each([1, 2])(
    "at maxEdges %i, a contributor's creates answer alike whether the node holds 0, 1 or 2 hidden edges",
    (maxEdges) =>
      Effect.gen(function* () {
        const worlds = yield* Effect.forEach(
          [0, 1, 2],
          (hidden) =>
            Effect.gen(function* () {
              return yield* answers(yield* slotWorld(maxEdges, hidden), as(contributor));
            }),
          { concurrency: "unbounded" },
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
      }),
  );

  it.effect("a caller who can read every edge is held to the limit over all of them", () =>
    Effect.gen(function* () {
      const links = yield* slotWorld(2, 2);
      expect((yield* answers(links, as(moderator)))[0]).toMatchObject({
        _tag: "EdgeCardinalityExceeded",
      });
      // The contributor, who can't read the two, is not: the documented trade-off.
      expect((yield* answers(links, as(contributor))).slice(0, 2)).toEqual([
        { created: true },
        { created: true },
      ]);
      expect(links.edges.rows()).toHaveLength(4);
    }),
  );

  /**
   * A family keyed on `path` alone (it leaves the page out), whose page end
   * holds one edge: an edge on `page-other` already holds the path `taken`,
   * that page `colliding` (readable or hidden from a contributor), and with
   * `full` the target page already holds its one edge.
   */
  const keyWorld = (
    colliding: "public" | "private",
    onConflict: "fail" | "ignore",
    full: boolean,
  ) =>
    Effect.gen(function* () {
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
      yield* links.edges.insert({ pageId: "page-other", path: "taken" });
      if (full) yield* links.edges.insert({ pageId: "page-target", path: "own" });
      return yield* answerOf(
        links.actAs(as(contributor), links.ops.create({ pageId: "page-target", path: "taken" })),
      );
    });
  const conflict = { _tag: "EdgeConflict", type: "links" };

  it.effect.each([
    ["below the limit", false],
    ["at the limit", true],
  ] as const)(
    "a collision with a hidden edge answers as one with a readable edge, %s",
    ([_where, full]) =>
      Effect.gen(function* () {
        const hidden = yield* keyWorld("private", "fail", full);
        expect(hidden).toEqual(yield* keyWorld("public", "fail", full));
        expect(hidden).toEqual(conflict);
        // Under `ignore` the hidden collision is the same unresolved answer;
        // a readable one resolves to an edge the caller could already read.
        expect(yield* keyWorld("private", "ignore", full)).toEqual(conflict);
        expect(yield* keyWorld("public", "ignore", full)).toEqual({ created: false });
      }),
  );
});

// ── Cardinality ───────────────────────────────────────────────────────

describe("cardinality: an end's maxEdges is declared and enforced", () => {
  /** `end` with `maxEdges: max`; absent, the end is unbounded. */
  const limitedTo = (end: EdgeEnd<never, never>, max?: number): EdgeEnd<never, never> =>
    max === undefined ? end : { ...end, maxEdges: max };
  const bounded = (
    limits: {
      readonly subject?: number;
      readonly part?: number;
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
            subject: limitedTo(referenceEnd("subjectId", subjects), limits.subject),
            part: limitedTo(referenceEnd("partId", parts), limits.part),
          },
        },
        ["subjectId", "partId"],
      ),
    };
  };
  const link = (links: ReturnType<typeof bounded>, subjectId: string, partId: string) =>
    links.actAs(as(contributor), links.ops.create({ subjectId, partId }));

  it.effect(
    "refuses a create past one node's limit, writing nothing, and bounds each node apart",
    () =>
      Effect.gen(function* () {
        const links = bounded({ subject: 2 });
        yield* link(links, "s1", "p1");
        yield* link(links, "s1", "p2");
        expect(yield* errorOf(link(links, "s1", "p3"))).toEqual(
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
        expect(yield* tagOf(link(links, "s2", "p3"))).toEqual(Option.none());
      }),
  );

  it.effect("bounds each end on its own (EmDash's per-parent and per-child limits)", () =>
    Effect.gen(function* () {
      const links = bounded({ subject: 3, part: 1 });
      yield* link(links, "s1", "p1");
      expect(yield* errorOf(link(links, "s2", "p1"))).toEqual(
        Option.some(expect.objectContaining({ end: "part", nodeId: "p1", max: 1 })),
      );
      expect(yield* tagOf(link(links, "s1", "p2"))).toEqual(Option.none());
    }),
  );

  it.effect("an absent limit is no limit", () =>
    Effect.gen(function* () {
      const links = bounded({});
      yield* link(links, "s1", "p1");
      yield* link(links, "s1", "p2");
      yield* link(links, "s1", "p3");
      expect(links.edges.rows()).toHaveLength(3);
    }),
  );

  it.effect("a re-assertion at a full end stays idempotent", () =>
    Effect.gen(function* () {
      const links = bounded({ subject: 1 }, { onConflict: "ignore" });
      const first = yield* link(links, "s1", "p1");
      expect(yield* link(links, "s1", "p1")).toEqual({ id: first.id, created: false });
      expect(yield* tagOf(link(links, "s1", "p2"))).toEqual(Option.some("EdgeCardinalityExceeded"));
    }),
  );

  it.effect("a delete frees the slot", () =>
    Effect.gen(function* () {
      const links = bounded({ subject: 1 });
      const { id } = yield* link(links, "s1", "p1");
      yield* links.actAs(as(contributor), links.ops.delete(id));
      expect(yield* tagOf(link(links, "s1", "p2"))).toEqual(Option.none());
    }),
  );

  it.effect(
    "counts only edges whose other end is live, so a tombstoned partner frees its slot",
    () =>
      Effect.gen(function* () {
        const links = bounded({ subject: 1 });
        const { id } = yield* link(links, "s1", "p1");
        expect(yield* tagOf(link(links, "s1", "p2"))).toEqual(
          Option.some("EdgeCardinalityExceeded"),
        );
        links.parts.put(node("p1", { visibility: "public" }, "delete"));
        // The edge to the tombstoned p1 stays stored, but no longer counts, for
        // the view-deleted rung that can still read it as for anyone else.
        expect(
          yield* tagOf(
            links.actAs(as(moderator), links.ops.create({ subjectId: "s1", partId: "p2" })),
          ),
        ).toEqual(Option.none());
        expect(links.edges.rows().map((row) => row.id)).toContain(id);
      }),
  );

  it.effect("a restore may bring a node past its limit; the next create still refuses", () =>
    Effect.gen(function* () {
      const links = bounded({ subject: 1 });
      const stale = yield* link(links, "s1", "p1");
      links.parts.put(node("p1", { visibility: "public" }, "delete"));
      const fresh = yield* link(links, "s1", "p2");
      // Restoring p1 brings its edge back without a check: s1 now holds two.
      links.parts.put(node("p1", { visibility: "public" }, "update"));
      expect(yield* links.listed(anonymous, eq("subjectId", "s1"))).toEqual({
        ids: [stale.id, fresh.id],
        total: 2,
      });
      expect(yield* errorOf(link(links, "s1", "p3"))).toEqual(
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
      yield* links.actAs(as(contributor), links.ops.delete(stale.id));
      expect(yield* tagOf(link(links, "s1", "p3"))).toEqual(Option.some("EdgeCardinalityExceeded"));
      yield* links.actAs(as(contributor), links.ops.delete(fresh.id));
      expect(yield* tagOf(link(links, "s1", "p3"))).toEqual(Option.none());
    }),
  );

  it.effect(
    "counts a self-referential family's bounded ends in ascending node id, the order a store locks them",
    () =>
      Effect.gen(function* () {
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
        yield* actAs(as(contributor), ops.create({ fromId: "n2", toId: "n1" }));
        yield* actAs(as(contributor), ops.create({ fromId: "n1", toId: "n2" }));
        expect(seen.counted()).toEqual(["toId:n1", "fromId:n2", "fromId:n1", "toId:n2"]);
      }),
  );
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

  it.effect("resolves to the winner's edge under `ignore`", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = racing("ignore");
      edges.raceNextInsert({ subjectId: "s1", partId: "p1" });
      const written = yield* actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" }));
      expect(written).toEqual({ id: edges.rows()[0]?.id, created: false });
      expect(edges.rows()).toHaveLength(1);
    }),
  );

  it.effect("fails EdgeConflict under `fail`", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = racing("fail");
      edges.raceNextInsert({ subjectId: "s1", partId: "p1" });
      expect(
        yield* tagOf(actAs(as(contributor), ops.create({ subjectId: "s1", partId: "p1" }))),
      ).toEqual(Option.some("EdgeConflict"));
    }),
  );

  it.effect("never resolves a race to a winner the viewer cannot read", () =>
    Effect.gen(function* () {
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
        yield* errorOf(actAs(as(contributor), ops.create({ pageId: "page-2", path: "retired" }))),
      ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
      expect(edges.rows().map((row) => row["pageId"])).toEqual(["page-1"]);
    }),
  );

  it.effect(
    "never resolves a race to a winner with a tombstoned end, even for the view-deleted rung",
    () =>
      Effect.gen(function* () {
        // The view-deleted rung reads the winner, whose page is tombstoned, but
        // can't link to it, so the race answers as an unresolved collision.
        const pages = makeInMemoryNodes(["visibility"]);
        pages.put(node("page-1", { visibility: "public" }, "delete"));
        pages.put(node("page-2", { visibility: "public" }));
        const { edges, ops, actAs } = family(
          {
            ends: {
              page: {
                column: "pageId",
                type: "pages",
                access: { kind: "reference" },
                nodes: pages,
              },
            },
            onConflict: "ignore",
          },
          ["path"],
          splitPolicy,
        );
        edges.raceNextInsert({ pageId: "page-1", path: "retired" });
        expect(
          yield* errorOf(actAs(as(moderator), ops.create({ pageId: "page-2", path: "retired" }))),
        ).toEqual(Option.some(expect.objectContaining({ _tag: "EdgeConflict", type: "links" })));
        const [winner] = edges.rows();
        expect(winner?.["pageId"]).toBe("page-1");
        expect(yield* actAs(as(moderator), ops.get(winner?.id ?? ""))).toMatchObject({
          pageId: "page-1",
        });
      }),
  );
});

describe("qualifying a filter with an end's alias renames every node's column", () => {
  /** `./Edges`' `qualify`: what `endpointFilter` applies to each end's leaf filter. */
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

// ── Edge membership ──────────────────────────────────────

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
    ["split rungs", splitPolicy],
  ] as const;
  const cases = Arr.flatMap(policies, ([policyName, policy]) =>
    Arr.map([...viewers, ["an admin", as(admin)] as const], ([name, viewer]) => ({
      label: `${name}, ${policyName}`,
      policy,
      viewer,
    })),
  );

  it.effect.each(cases)("for $label", ({ policy, viewer }) =>
    Effect.gen(function* () {
      const { edges, ops, actAs, postRows, termRows, pairs } = taxonomy(policy);
      const ids = yield* Effect.forEach(
        pairs,
        (pair) => Effect.flatMap(edges.insert(pair), Effect.fromOption),
        {
          concurrency: 1,
        },
      );
      // One term at a time, and every term at once.
      const asked = [...termRows.map((term) => [term.id]), termRows.map((term) => term.id)];
      const answers = yield* actAs(
        viewer,
        Effect.forEach(
          asked,
          (termIds) =>
            Effect.gen(function* () {
              const filter = yield* ops.memberFilter("post", termIds);
              const listed = postRows.filter((post) =>
                evaluate(filter, post, {
                  now: NOW,
                  contains: (set: Following, value) => P.isString(value) && HashSet.has(set, value),
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
      );
      Arr.forEach(answers, ([listed, expected]) => expect(listed).toEqual(expected));
      // Not vacuous: every viewer reads `p-public` through `t-public`.
      expect(answers.some(([listed]) => listed.includes("p-public"))).toBe(true);
    }),
  );

  it.effect("a post reached only through a hidden edge is not a member", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs, postRows } = taxonomy();
      yield* edges.insert({ postId: "p-public", termId: "t-private" });
      yield* edges.insert({ postId: "p-private", termId: "t-public" });
      const members = (who: Viewer, termIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const filter = yield* actAs(who, ops.memberFilter("post", termIds));
          return postRows
            .filter((post) =>
              evaluate(filter, post, {
                now: NOW,
                contains: (set: Following, value) => P.isString(value) && HashSet.has(set, value),
              }),
            )
            .map((post) => post.id);
        });
      // The hidden term confirms nothing: its edge makes no member.
      expect(yield* members(anonymous, ["t-private", "t-public"])).toEqual([]);
      expect(yield* members(as(member), ["t-private", "t-public"])).toEqual(["p-private"]);
      expect(yield* members(as(admin), ["t-private", "t-public"])).toEqual([
        "p-public",
        "p-private",
      ]);
    }),
  );

  it.effect("a NULL or absent id is never a member", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = taxonomy();
      yield* edges.insert({ postId: "p-public", termId: "t-public" });
      const filter = yield* actAs(anonymous, ops.memberFilter("post", ["t-public"]));
      const context = {
        now: NOW,
        contains: () => true,
      };
      expect(evaluate(filter, { id: null }, context)).toBe(false);
      expect(evaluate(filter, {}, context)).toBe(false);
    }),
  );

  it.effect(
    "fails closed as never, without asking the store, for no ids, too many, or a misnamed end",
    () =>
      Effect.gen(function* () {
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
        expect(yield* pair.memberFilter("post", [])).toEqual(never);
        expect(yield* pair.memberFilter("post", tooMany)).toEqual(never);
        expect(yield* pair.memberFilter("nope", ["t-public"])).toEqual(never);
        // A family without exactly two ends has no "other" end.
        expect(yield* lone.memberFilter("post", ["t-public"])).toEqual(never);
        expect(asked).toBe(0);
        // Not vacuous: a well-formed request does ask.
        yield* pair.memberFilter("post", ["t-public"]);
        expect(asked).toBe(1);
      }),
  );

  /** Entries ordered by key, so two count maps compare as lists. */
  const byKey = Order.mapInput(Order.String, (entry: readonly [string, number]) => entry[0]);

  it.effect.each(cases)(
    "countBy for $label: each term's count is the edges the viewer can get",
    ({ policy, viewer }) =>
      Effect.gen(function* () {
        const { edges, ops, actAs, termRows, pairs } = taxonomy(policy);
        const ids = yield* Effect.forEach(
          pairs,
          (pair) => Effect.flatMap(edges.insert(pair), Effect.fromOption),
          {
            concurrency: 1,
          },
        );
        const termIds = termRows.map((term) => term.id);
        const [counts, expected] = yield* actAs(
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
        );
        expect(Arr.sort(Arr.fromIterable(HashMap.toEntries(counts)), byKey)).toEqual(
          Arr.sort(expected, byKey),
        );
        // Not vacuous: every viewer reads `p-public` through `t-public`.
        expect(Option.getOrElse(HashMap.get(counts, "t-public"), () => 0)).toBeGreaterThan(0);
      }),
  );

  it.effect("countBy narrows by the family's own predicate", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = taxonomy();
      yield* edges.insert({ postId: "p-public", termId: "t-public" });
      yield* edges.insert({ postId: "p-followers", termId: "t-public" });
      const counted = yield* actAs(
        as(admin),
        ops.countBy("term", ["t-public"], eq("postId", "p-public")),
      );
      expect(HashMap.get(counted, "t-public")).toEqual(Option.some(1));
    }),
  );

  it.effect("countBy reads the store once, and fails closed to 0 without asking it", () =>
    Effect.gen(function* () {
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
      yield* edges.insert({ postId: "p-public", termId: "t-public" });
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
      expect(HashMap.size(yield* ops.countBy("term", []))).toBe(0);
      const over = yield* ops.countBy("term", tooMany);
      expect(HashMap.size(over)).toBe(MAX_SET_VALUES + 1);
      expect(HashMap.every(over, (count) => count === 0)).toBe(true);
      expect(HashMap.get(yield* ops.countBy("nope", ["t-public"]), "t-public")).toEqual(
        Option.some(0),
      );
      expect(asked).toBe(0);
      // Not vacuous: a well-formed request asks once, for every id at once.
      const one = yield* ops.countBy("term", ["t-public", "t-none"]);
      expect(asked).toBe(1);
      expect(HashMap.get(one, "t-public")).toEqual(Option.some(1));
      expect(HashMap.get(one, "t-none")).toEqual(Option.some(0));
    }),
  );
});

describe("nonMemberFilter: the complement of memberFilter under EDGE-001", () => {
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
    contains: (set: Following, value: ColumnValue) => P.isString(value) && HashSet.has(set, value),
  };

  const policies = [
    ["gardeneria's rungs", gardeneriaPolicy],
    ["split rungs", splitPolicy],
  ] as const;
  const cases = Arr.flatMap(policies, ([policyName, policy]) =>
    Arr.map([...viewers, ["an admin", as(admin)] as const], ([name, viewer]) => ({
      label: `${name}, ${policyName}`,
      policy,
      viewer,
    })),
  );

  it.effect.each(cases)("partitions the rows with memberFilter, for $label", ({ policy, viewer }) =>
    Effect.gen(function* () {
      const { edges, ops, actAs, postRows, termRows, pairs } = taxonomy(policy);
      yield* Effect.forEach(pairs, edges.insert, { concurrency: 1, discard: true });
      const asked = [...termRows.map((term) => [term.id]), termRows.map((term) => term.id)];
      const answers = yield* actAs(
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
      );
      // Every row is in exactly one of the two sets.
      Arr.forEach(answers, (rows) =>
        Arr.forEach(rows, ([inSet, outSet]) => expect(inSet).not.toBe(outSet)),
      );
    }),
  );

  it.effect("a post whose only edge to the named terms is hidden is not excluded", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs, postRows } = taxonomy();
      yield* edges.insert({ postId: "p-public", termId: "t-private" });
      yield* edges.insert({ postId: "p-private", termId: "t-public" });
      const kept = (who: Viewer, termIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const filter = yield* actAs(who, ops.nonMemberFilter("post", termIds));
          return postRows.filter((post) => evaluate(filter, post, context)).map((post) => post.id);
        });
      // Anonymous can't read t-private's edge nor p-private: nothing is excluded.
      expect(yield* kept(anonymous, ["t-private", "t-public"])).toEqual(
        postRows.map((post) => post.id),
      );
      // The owner reads p-private's edge to t-public, never t-private's.
      expect(yield* kept(as(member), ["t-private", "t-public"])).not.toContain("p-private");
      expect(yield* kept(as(member), ["t-private", "t-public"])).toContain("p-public");
      // An admin reads both edges.
      const admins = yield* kept(as(admin), ["t-private", "t-public"]);
      expect(admins).not.toContain("p-public");
      expect(admins).not.toContain("p-private");
    }),
  );

  it.effect("a NULL or absent id is never excluded", () =>
    Effect.gen(function* () {
      const { edges, ops, actAs } = taxonomy();
      yield* edges.insert({ postId: "p-public", termId: "t-public" });
      const filter = yield* actAs(anonymous, ops.nonMemberFilter("post", ["t-public"]));
      const everything = { now: NOW, contains: () => true };
      expect(evaluate(filter, { id: null }, everything)).toBe(true);
      expect(evaluate(filter, {}, everything)).toBe(true);
      expect(evaluate(filter, { id: "p-public" }, everything)).toBe(false);
    }),
  );

  it.effect(
    "fails closed as always, without asking the store, for no ids, too many, or a misnamed end",
    () =>
      Effect.gen(function* () {
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
        expect(yield* pair.nonMemberFilter("post", [])).toEqual(always);
        expect(yield* pair.nonMemberFilter("post", tooMany)).toEqual(always);
        expect(yield* pair.nonMemberFilter("nope", ["t-public"])).toEqual(always);
        expect(yield* lone.nonMemberFilter("post", ["t-public"])).toEqual(always);
        expect(asked).toBe(0);
        // Not vacuous: a well-formed request does ask.
        yield* pair.nonMemberFilter("post", ["t-public"]);
        expect(asked).toBe(1);
      }),
  );
});

describe("memberFilter through the member leaf's own list", () => {
  it.effect.each(viewers)("lists the members %s may read, and only them", ([_, viewer]) =>
    Effect.gen(function* () {
      const chain = makeInMemoryVersionChain("entries");
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
      const listed = yield* Effect.gen(function* () {
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
        // The member leaf's own list takes the edge family's filter (it type-checks:).
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
      });
      const [rows, readable] = listed;
      expect(Arr.sort(rows, Order.String)).toEqual(Arr.sort(readable, Order.String));
      expect(Arr.isReadonlyArrayNonEmpty(rows)).toBe(true);
    }),
  );

  it.effect.each(viewers)(
    "memberFilter and nonMemberFilter partition the rows %s may read",
    ([_, viewer]) =>
      Effect.gen(function* () {
        const chain = makeInMemoryVersionChain("entries");
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
        const [inRows, outRows, allRows] = yield* Effect.gen(function* () {
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
        });
        expect(Arr.sort([...inRows, ...outRows], Order.String)).toEqual(allRows);
        expect(Arr.intersection(inRows, outRows)).toEqual([]);
        // Not vacuous: every viewer reads the public post with no term, which is kept.
        expect(Arr.isReadonlyArrayNonEmpty(outRows)).toBe(true);
      }),
  );
});

describe("EDGE-001: a `group` end reads to its group's members, filter and predicate alike", () => {
  /** `follower` is a member of `g-1`; nobody belongs to anything else. */
  const audience: FollowerSeam<Following, never> = {
    ...follows,
    isMember: (accountId, groupId) =>
      Effect.succeed(accountId === follower.id && groupId === "g-1"),
    groups: (accountId) => (accountId === follower.id ? HashSet.make("g-1") : HashSet.empty()),
  };
  const groupIds: ReadonlyArray<ColumnValue | typeof ABSENT> = ["g-1", "g-2", null, 7, ABSENT];
  const showGroup = (groupId: ColumnValue | typeof ABSENT) =>
    groupId === ABSENT ? "absent" : showValue(groupId);
  const withGroup = (
    columns: { readonly [column: string]: ColumnValue },
    groupId: ColumnValue | typeof ABSENT,
  ) => (groupId === ABSENT ? columns : { ...columns, groupId });

  const ownedRows = Arr.flatMap(actions, (action) =>
    Arr.flatMap(["public", "group", "private"], (visibility) =>
      Arr.flatMap([false, true], (draft) =>
        Arr.flatMap(groupIds, (groupId) =>
          Arr.map([member.id, otherMember.id], (ownerId) =>
            node(
              `${action}-${visibility}-${String(draft)}-${showGroup(groupId)}-${ownerId}`,
              withGroup({ ownerId, visibility, draft }, groupId),
              action,
            ),
          ),
        ),
      ),
    ),
  );
  const ownedGroupEnd = (columns: ReadonlyArray<string>): EdgeEnd<never, never> => ({
    column: "entryId",
    type: "entries",
    access: ownedAccess({ draft: true, group: true }),
    nodes: makeInMemoryNodes(columns),
  });
  const referenceRows = Arr.flatMap(actions, (action) =>
    Arr.flatMap(["public", "group", "private"], (visibility) =>
      Arr.map(groupIds, (groupId) =>
        node(
          `${action}-${visibility}-${showGroup(groupId)}`,
          withGroup({ visibility }, groupId),
          action,
        ),
      ),
    ),
  );
  const referenceGroupEnd = (columns: ReadonlyArray<string>): EdgeEnd<never, never> => ({
    column: "subjectId",
    type: "subjects",
    access: { kind: "reference", groupColumn: "groupId" },
    nodes: makeInMemoryNodes(columns),
  });
  const everyone = [...viewers, ["an admin", as(admin)] as const];
  const cases = Arr.flatMap(
    [
      [
        "an owned end",
        () => ownedGroupEnd(["ownerId", "visibility", "draft", "groupId"]),
        ownedRows,
      ],
      ["a reference end", () => referenceGroupEnd(["visibility", "groupId"]), referenceRows],
    ] as const,
    ([kind, end, rows]) =>
      Arr.flatMap(
        [
          ["with the audience seam", audience],
          ["without it", follows],
        ] as const,
        ([seamName, seam]) =>
          Arr.map(everyone, ([name, viewer]) => ({
            label: `${kind}, ${seamName}, for ${name}`,
            end,
            rows,
            seam,
            viewer,
          })),
      ),
  );

  it.effect.each(cases)("$label", ({ end, rows, seam, viewer }) =>
    Effect.gen(function* () {
      const seen = yield* readings(end(), viewer, rows, seam);
      expect(seen.map(({ id, listed }) => [id, listed])).toEqual(
        seen.map(({ id, readable }) => [id, readable]),
      );
    }),
  );

  it.effect(
    "is not vacuous: the member reads exactly the live, published group rows of their group",
    () =>
      Effect.gen(function* () {
        const live = (row: LeafRow) => row.action !== "delete";
        const owned = yield* readings(
          ownedGroupEnd(["ownerId", "visibility", "draft", "groupId"]),
          as(follower),
          ownedRows,
          audience,
        );
        expect(owned.filter(({ readable }) => readable).map(({ id }) => id)).toEqual(
          ownedRows
            .filter(
              (row) =>
                live(row) &&
                row["draft"] === false &&
                (row["visibility"] === "public" ||
                  (row["visibility"] === "group" && row["groupId"] === "g-1")),
            )
            .map((row) => row.id),
        );
        const reference = yield* readings(
          referenceGroupEnd(["visibility", "groupId"]),
          as(follower),
          referenceRows,
          audience,
        );
        expect(reference.filter(({ readable }) => readable).map(({ id }) => id)).toEqual(
          referenceRows
            .filter(
              (row) =>
                live(row) &&
                (row["visibility"] === "public" ||
                  (row["visibility"] === "group" && row["groupId"] === "g-1")),
            )
            .map((row) => row.id),
        );
      }),
  );

  it.effect(
    "a declared group column the view lacks: an owned end reads nothing, a reference end only its public rows",
    () =>
      Effect.gen(function* () {
        const owned = yield* readings(
          ownedGroupEnd(["ownerId", "visibility", "draft"]),
          as(moderator),
          ownedRows,
          audience,
        );
        expect(owned.some(({ listed, readable }) => listed || readable)).toBe(false);
        const reference = yield* readings(
          referenceGroupEnd(["visibility"]),
          as(follower),
          referenceRows,
          audience,
        );
        expect(reference.filter(({ listed }) => listed).map(({ id }) => id)).toEqual(
          referenceRows
            .filter((row) => row.action !== "delete" && row["visibility"] === "public")
            .map((row) => row.id),
        );
      }),
  );
});

describe("EDGE-001: a pending group invitation opens no `group` end", () => {
  const memberships = makeInMemoryMembershipStore();
  const seam: FollowerSeam<Following, never> = { ...follows, ...audienceSeam(memberships) };
  const end: EdgeEnd<never, never> = {
    column: "entryId",
    type: "entries",
    access: ownedAccess({ draft: true, group: true }),
    nodes: makeInMemoryNodes(["ownerId", "visibility", "draft", "groupId"]),
  };
  const rows = [
    node(
      "shared",
      { ownerId: member.id, visibility: "group", draft: false, groupId: "g-1" },
      "create",
    ),
  ];
  const readsAs = () =>
    Effect.gen(function* () {
      return (yield* readings(end, as(follower), rows, seam)).map(({ listed, readable }) => [
        listed,
        readable,
      ]);
    });

  it.effect(
    "hidden while pending, open after accepting, hidden again after leaving or a revoke",
    () =>
      Effect.gen(function* () {
        yield* memberships.invite({
          groupId: "g-1",
          accountId: follower.id,
          role: "member",
          invitedBy: member.id,
          at: NOW,
        });
        expect(yield* readsAs()).toEqual([[false, false]]);
        yield* memberships.accept("g-1", follower.id, NOW);
        expect(yield* readsAs()).toEqual([[true, true]]);
        yield* memberships.remove("g-1", follower.id);
        expect(yield* readsAs()).toEqual([[false, false]]);
        yield* memberships.invite({
          groupId: "g-1",
          accountId: follower.id,
          role: "member",
          invitedBy: member.id,
          at: NOW,
        });
        yield* memberships.removeInvitation("g-1", follower.id);
        expect(yield* readsAs()).toEqual([[false, false]]);
      }),
  );
});
