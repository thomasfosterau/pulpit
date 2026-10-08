/**
 * **The edge operations factory** — a relation between nodes as its own
 * family: a bounded list, a read by id, an idempotent create and a hard
 * delete, gated by the visibility of the nodes the edge joins.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/edge-ops.ts`
 * (`defineEdgeOpsE`), which exists because hand-rolled edge families drift,
 * and the ninth family's viewer gate or `LIMIT` gets forgotten. Its
 * hand-rolled owned-child family (`disorders.ts`, the observation → disorder
 * edge) is the spec for the endpoint gates. A `#NNN` here names a gardeneria
 * issue.
 *
 * ## What an edge is
 *
 * An edge is a plain row in its own table: an id, a `createdAt`, one column
 * per **end** holding the id of the node at that end, and any qualifier
 * columns of the family's own. It is **not** a node: it has no version chain,
 * so the chain invariants (`VERSION-CHAIN-001/002`) do not govern it. A delete
 * is a hard `DELETE`, and there is no update: correcting an edge is deleting
 * it and asserting the right one. A family declares zero, one or two (or
 * more) ends; with none, it is a plain bounded row family (gardeneria's
 * `page_collections`).
 *
 * ## The invariants
 *
 * - **An edge is readable only if the viewer can read every end**
 *   (`EDGE-001`). Each end's node is checked against its own leaf's access
 *   declaration, as that leaf's list filter reads it (pulpit#73 tracks
 *   where the subtype's own `get` still reads it more loosely). `get` answers a
 *   hidden edge as {@link EdgeNotFound} and `list` omits it, never `Forbidden`
 *   (`SEC-AUTH-ENUM-001`); a related list (the edges at one node) is a `list`
 *   filtered on that end, so it omits every edge whose other end is hidden.
 * - **The list filter and the per-edge predicate never disagree.**
 *   {@link endpointFilter} renders the same facts {@link canViewEndpoint}
 *   reads, over the ends' joined views; `tests/edges.test.ts` checks every
 *   endpoint state × viewer.
 * - **A tombstoned end hides its edges** from every viewer, the view-deleted
 *   rung included. Nothing is deleted: restoring the node (the explicit
 *   `restore`, `VERSION-CHAIN-006`) brings its edges back as they were.
 * - **A create names only nodes the viewer can read.** An end naming a
 *   missing, hidden or tombstoned node fails `NodeNotFound`, so a create
 *   cannot confirm a node exists.
 * - **Cardinality is declared, and a create past it fails**
 *   ({@link EdgeCardinalityExceeded}). An end's `maxEdges` bounds how many
 *   edges may share one node at that end. Every stored edge at the node
 *   counts, hidden ones included: an edge hidden now comes back when its
 *   other end does, so it must not leave room to overshoot the limit. A
 *   re-assertion of a stored edge resolves before the count, so it stays
 *   idempotent at a full node. Two consequences, both documented rather than
 *   designed away (see {@link EdgeEnd.maxEdges}): a writer learns how many
 *   hidden edges a node it can read holds, and a tombstoned partner keeps
 *   its slot until it is restored (pulpit#77).
 * - **A write discloses only past its gate.** A create runs in the order
 *   ends → write gate → unique-key collision → cardinality count, so only a
 *   caller the gate admits learns anything from {@link EdgeConflict} or
 *   {@link EdgeCardinalityExceeded} (README → `./edges`).
 * - **Every list is bounded** (`SEC-INPUT-003`): a page is capped at
 *   `MAX_PAGE_LIMIT`.
 *
 * ## The seam
 *
 * The edges are read and written through an {@link EdgeStore} the
 * application supplies (a Drizzle store over the edge table, joining each
 * end's current-version view; see the package README → Seams). Each end
 * reads its nodes through an {@link EndpointView}, which a `./subtype`
 * `LeafStore` already satisfies.
 *
 * @copyright Thomas Foster
 * @module pulpit/edges
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Visibility } from "./content.ts";
import { and, eq, or, type ListFilter } from "./filter.ts";
import {
  canViewOwned,
  Forbidden,
  MAX_PAGE_LIMIT,
  ownedListFilter,
  readScopeFor,
  referencePrivacyFilter,
  Unauthorized,
  type AccessPolicy,
  type FollowerSeam,
  type LeafAccess,
  type LeafRow,
  type OwnedFacts,
  type Page,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";
import { NodeNotFound, type ColumnValue } from "./version-chain.ts";

const isVisibility = Schema.is(Visibility);

// ── Errors ────────────────────────────────────────────────────────────

/**
 * No edge with this id that the viewer may read: missing, or hidden because
 * an end is (`SEC-AUTH-ENUM-001`, `EDGE-001`). The wire's 404.
 *
 * @since 0.1.0
 */
export class EdgeNotFound extends Schema.TaggedError<EdgeNotFound>()("EdgeNotFound", {
  type: Schema.String,
  id: Schema.String,
}) {}

/**
 * A create collided with a stored edge on the family's unique key, and the
 * family's conflict policy does not resolve it: `onConflict: "fail"`, or the
 * edge it collided with is one the viewer may not read. The wire's 409. It
 * carries no id, so it never names a hidden edge.
 *
 * @since 0.1.0
 */
export class EdgeConflict extends Schema.TaggedError<EdgeConflict>()("EdgeConflict", {
  type: Schema.String,
}) {}

/**
 * A create would put more edges at one node than its end's declared
 * `maxEdges` allows. The wire's 409.
 *
 * @since 0.1.0
 */
export class EdgeCardinalityExceeded extends Schema.TaggedError<EdgeCardinalityExceeded>()(
  "EdgeCardinalityExceeded",
  {
    /** The edge family's wire type. */
    type: Schema.String,
    /** The end (its alias in the declaration) whose limit was reached. */
    end: Schema.String,
    /** The node at that end that already holds `max` edges. */
    nodeId: Schema.String,
    /** The declared limit. */
    max: Schema.Int,
  },
) {}

/**
 * An edge family declared against the rules: an end's alias contains a `.`,
 * or its `maxEdges` is not a positive safe integer. Thrown by
 * {@link defineEdgeOps} when the family is declared, never an Effect failure,
 * like `RegistryDeclarationError`: a malformed family must stop its module
 * loading rather than fail open (a `NaN` limit admits every create) or
 * refuse every create (a limit of `0`).
 *
 * @since 0.1.0
 */
export class EdgeDeclarationError extends Schema.TaggedError<EdgeDeclarationError>()(
  "EdgeDeclarationError",
  { message: Schema.String },
) {}

// ── The ends ──────────────────────────────────────────────────────────

/**
 * An end's view of its nodes: the endpoint leaf's current-version view
 * column set and its read by id. A `./subtype` `LeafStore` satisfies it, so
 * an end usually passes the endpoint leaf's own store.
 *
 * @since 0.1.0
 */
export interface EndpointView<E, R> {
  /** The endpoint view's column names; an owned declaration naming a column outside it hides every edge. */
  readonly columns: ReadonlySet<string>;
  /** One node of the current-version view by id, or none. Applies no visibility policy. */
  readonly get: (id: string) => Effect.Effect<Option.Option<LeafRow>, E, R>;
}

/**
 * One end of an edge family: the edge column holding the node id, and how
 * that node is read and gated.
 *
 * @since 0.1.0
 */
export interface EdgeEnd<E, R> {
  /** The edge column holding this end's node id. */
  readonly column: string;
  /** The endpoint leaf's wire type: names the `NodeNotFound` a create naming a missing or hidden node fails with. */
  readonly type: string;
  /** The endpoint leaf's access declaration, the one its own `defineSubtype` takes. */
  readonly access: LeafAccess;
  /** The endpoint leaf's current-version view. */
  readonly nodes: EndpointView<E, R>;
  /**
   * The most edges one node at this end may hold: a positive safe integer,
   * or {@link defineEdgeOps} throws {@link EdgeDeclarationError}. Absent,
   * unlimited. A create that would exceed it fails
   * {@link EdgeCardinalityExceeded}.
   *
   * Every stored edge at the node counts, hidden ones included, which has
   * two consequences:
   *
   * - **Disclosure.** Suppose a node N is readable, its limit is `k`, and the
   *   caller can see `v` of its edges. A refusal tells a writer that N holds
   *   at least `k − v` edges it cannot read. A writer that creates `s` edges
   *   at N until one is refused, then deletes them, learns the exact hidden
   *   count `h = k − v − s`, and repeating the probe shows that count
   *   change over time. Only a caller past the write gate learns this.
   * - **A tombstoned partner holds its slot (pulpit#77).** An edge whose other
   *   end is tombstoned is hidden from everyone, the view-deleted rung
   *   included, so nobody can `delete` it, and it still counts. With
   *   `maxEdges: 1`, tombstoning the partner freezes the node until the
   *   partner is restored. This is a known limitation, and the choice of fix
   *   is the owner's.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such, so there is no value to model as an `Option`
  readonly maxEdges?: number | undefined;
}

/**
 * A family's ends, keyed by alias. The alias is how a list filter names an
 * end's node columns ({@link endpointColumn}), the name under which the store
 * joins that end's view, and the `end` an {@link EdgeCardinalityExceeded}
 * reports. An alias never contains a `.` ({@link defineEdgeOps} throws
 * {@link EdgeDeclarationError} on one), because `alias.column` must name one
 * end's column unambiguously.
 *
 * @since 0.1.0
 */
export type EdgeEnds<E, R> = { readonly [alias: string]: EdgeEnd<E, R> };

/**
 * The list-filter column naming `column` of the node at end `alias`:
 * `alias.column`. {@link endpointFilter} writes these, a family's own list
 * filter may too, and a store renders each against the view it joined under
 * that alias.
 *
 * @since 0.1.0
 */
export const endpointColumn = (alias: string, column: string): string => `${alias}.${column}`;

/** Every column of `filter` rewritten to name the node at end `alias`. */
const qualify = <Following>(alias: string, filter: ListFilter<Following>): ListFilter<Following> =>
  Match.value(filter).pipe(
    Match.discriminatorsExhaustive("kind")({
      always: (node): ListFilter<Following> => node,
      never: (node): ListFilter<Following> => node,
      eq: (node): ListFilter<Following> => ({
        ...node,
        column: endpointColumn(alias, node.column),
      }),
      ne: (node): ListFilter<Following> => ({
        ...node,
        column: endpointColumn(alias, node.column),
      }),
      in: (node): ListFilter<Following> => ({
        ...node,
        column: endpointColumn(alias, node.column),
      }),
      published: (node): ListFilter<Following> => ({
        ...node,
        column: endpointColumn(alias, node.column),
      }),
      notPublished: (node): ListFilter<Following> => ({
        ...node,
        column: endpointColumn(alias, node.column),
      }),
      and: (node): ListFilter<Following> => ({
        kind: "and",
        filters: node.filters.map((part) => qualify(alias, part)),
      }),
      or: (node): ListFilter<Following> => ({
        kind: "or",
        filters: node.filters.map((part) => qualify(alias, part)),
      }),
    }),
  );

type OwnedAccess = Extract<LeafAccess, { kind: "owned" }>;

/** Whether the endpoint view has every column the owned declaration names (`ownedListFilter`'s fail-closed check). */
const declaresColumns = (access: OwnedAccess, columns: ReadonlySet<string>): boolean =>
  [access.ownerColumn, access.visibilityColumn, ...Option.toArray(access.draftColumn)].every(
    (column) => columns.has(column),
  );

/**
 * The facts `canViewOwned` reads, off an endpoint row. A visibility outside
 * the enum reads as `private`, and a draft column holding anything but
 * `false` reads as a draft, so each agrees with the list filter's
 * `eq(…, "public")` / `eq(draft, false)` arms.
 */
const ownedFactsOf = (access: OwnedAccess, row: LeafRow): OwnedFacts => ({
  ownerId: String(row[access.ownerColumn]),
  visibility: Option.getOrElse(
    Option.liftPredicate(row[access.visibilityColumn], isVisibility),
    (): Visibility => "private",
  ),
  draft: Option.match(access.draftColumn, {
    onNone: () => false,
    onSome: (column) => row[column] !== false,
  }),
});

/** A live node: its head is a `create` or an `update`, never a tombstone. */
const isLive = (row: LeafRow): boolean => row.action === "create" || row.action === "update";

/**
 * Whether the viewer may read the node at one end (`EDGE-001`): it exists,
 * it is live (a tombstone hides it from everyone, the view-deleted rung
 * included), and its leaf's access admits the viewer. A reference node is
 * readable when its view has no `visibility` column, the viewer holds the
 * view-private rung, or it is `public`; an owned node through
 * `canViewOwned`. An owned declaration naming a column the view lacks reads
 * nothing. Never fails.
 *
 * @since 0.1.0
 */
export const canViewEndpoint = <E, R>(
  end: EdgeEnd<E, R>,
  viewer: Viewer,
  policy: AccessPolicy,
  followers: FollowerSeam<unknown, R>,
  node: Option.Option<LeafRow>,
): Effect.Effect<boolean, never, R> => {
  if (Option.isNone(node) || !isLive(node.value)) return Effect.succeed(false);
  const { access } = end;
  const { columns } = end.nodes;
  if (access.kind === "reference") {
    return Effect.succeed(
      !columns.has("visibility") ||
        Option.exists(viewer, policy.canViewPrivate) ||
        node.value["visibility"] === "public",
    );
  }
  if (!declaresColumns(access, columns)) return Effect.succeed(false);
  return canViewOwned(viewer, policy, followers, ownedFactsOf(access, node.value));
};

/**
 * The list arm of `EDGE-001`: for every end, its node is live and readable
 * by the viewer, over the columns {@link endpointColumn} names. The same
 * facts as {@link canViewEndpoint}, rendered as a `ListFilter` — the owned
 * arm is `ownedListFilter`, the reference arm `referencePrivacyFilter` — so
 * the two never disagree. A family with no ends gets `always`.
 *
 * @since 0.1.0
 */
export const endpointFilter = <Following, E, R>(
  ends: EdgeEnds<E, R>,
  viewer: Viewer,
  policy: AccessPolicy,
  followers: FollowerSeam<Following, unknown>,
): ListFilter<Following> => {
  const scope = readScopeFor(viewer, policy, followers);
  return and<Following>(
    ...Record.toEntries(ends).map(([alias, end]) =>
      qualify(
        alias,
        and<Following>(
          or<Following>(eq("action", "create"), eq("action", "update")),
          end.access.kind === "owned"
            ? ownedListFilter(end.access, end.nodes.columns, scope)
            : referencePrivacyFilter<Following>(viewer, policy, end.nodes.columns),
        ),
      ),
    ),
  );
};

// ── The write gate ────────────────────────────────────────────────────

/**
 * What a write gate is asked about: the viewer, the application's role axes,
 * and the edge being written (a create's column values, or a delete's stored
 * row).
 *
 * @since 0.1.0
 */
export interface EdgeWriteRequest {
  /** The request's viewer. */
  readonly viewer: Viewer;
  /** The application's role axes. */
  readonly policy: AccessPolicy;
  /** The edge's column values: the create's `values(input)`, or the stored row a delete removes. */
  readonly edge: EdgeValues;
}

/**
 * The gate `create` and `delete` run after the ends' visibility check. It
 * fails `Unauthorized` / `Forbidden`, or `NodeNotFound` when it reads an end
 * (an owned-child gate on a node with no owner), or with the store's `E`.
 *
 * @since 0.1.0
 */
export type EdgeWriteGate<E, R> = (
  request: EdgeWriteRequest,
) => Effect.Effect<unknown, Unauthorized | Forbidden | NodeNotFound | E, R>;

/**
 * A gate on one rung of the role axes: anonymous fails `Unauthorized`, a
 * signed-in viewer below the rung `Forbidden`. `rungGate((policy) =>
 * policy.canModerate)` is the moderator rung gardeneria's CMS edges take.
 *
 * @since 0.1.0
 */
export const rungGate =
  (rung: (policy: AccessPolicy) => (account: ViewerAccount) => boolean) =>
  (request: EdgeWriteRequest): Effect.Effect<ViewerAccount, Unauthorized | Forbidden> =>
    Option.match(request.viewer, {
      onNone: () => Effect.fail(new Unauthorized()),
      onSome: (account) =>
        rung(request.policy)(account) ? Effect.succeed(account) : Effect.fail(new Forbidden()),
    });

/**
 * The default write gate: the corpus-write rung. Right for an edge joining
 * reference rows, which is itself reference data.
 *
 * @since 0.1.0
 */
export const corpusWriteGate = rungGate((policy) => policy.canWriteCorpus);

// ── The store seam ────────────────────────────────────────────────────

/**
 * An edge's column values by name, as a create writes them.
 *
 * @since 0.1.0
 */
export type EdgeValues = { readonly [column: string]: ColumnValue };

/**
 * A stored edge: its id, its creation instant (the list's order), and its columns.
 *
 * @since 0.1.0
 */
export interface EdgeRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly [column: string]: ColumnValue;
}

/**
 * The persistence seam over one edge table. `E` is the store's own failure,
 * `R` its requirements (a Drizzle store's `CurrentTransaction`: like the
 * chain store, it never opens a transaction). Every method applies no policy.
 *
 * @since 0.1.0
 */
export interface EdgeStore<Row extends EdgeRow, Following, E, R> {
  /** One edge by id, or none (`LIMIT 1`). */
  readonly get: (id: string) => Effect.Effect<Option.Option<Row>, E, R>;
  /**
   * The page under `where`, with the unpaged total. Each end's
   * current-version view is INNER JOINed on `view.id = edge.<end column>`
   * under the end's alias, so `alias.column` names that view's column and a
   * bare column the edge table's; an edge whose end has no row in its view
   * is never listed. Ordered by `createdAt`, then `id` (a total order, so a
   * page cursor cannot skip or repeat a row, #1231). The total is a window
   * column (`count(*) OVER ()`): exact whenever the page has a row, and `0`
   * for an empty page, a page past the end included.
   */
  readonly list: (query: {
    readonly where: ListFilter<Following>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<Row>, E, R>;
  /**
   * How many stored edges hold `nodeId` in `column`, hidden ones included:
   * no join and no policy. Called inside the create's transaction, for the
   * cardinality check, once per bounded end in ascending `nodeId` order. A
   * SQL store locks the node first (`FOR NO KEY UPDATE`, under READ
   * COMMITTED), so two creates at one node serialise, and the sorted order
   * means two creates locking the same pair of nodes cannot deadlock
   * (README → Seams).
   */
  readonly countAt: (column: string, nodeId: string) => Effect.Effect<number, E, R>;
  /** The id of the stored edge `values` would collide with on the family's unique key, or none (always none without one). */
  readonly existing: (values: EdgeValues) => Effect.Effect<Option.Option<string>, E, R>;
  /** Insert the edge (`ON CONFLICT DO NOTHING RETURNING id`): its new id, or none when the unique key was taken. */
  readonly insert: (values: EdgeValues) => Effect.Effect<Option.Option<string>, E, R>;
  /** Hard-delete the edge; whether a row went. */
  readonly delete: (id: string) => Effect.Effect<boolean, E, R>;
}

// ── The factory ───────────────────────────────────────────────────────

/**
 * An edge family's declaration: its type and ends, its seams, its create
 * mapping, conflict policy and write gate, and its row → resource mapper.
 *
 * @since 0.1.0
 */
export interface EdgeDefinition<Create, Row extends EdgeRow, Resource, Following, E, R> {
  /** The family's JSON:API wire type: names spans and tags `EdgeNotFound`. */
  readonly type: string;
  /** The family's ends by alias; each node must be readable for its edge to be. */
  readonly ends: EdgeEnds<E, R>;
  /** The edge table. */
  readonly edges: EdgeStore<Row, Following, E, R>;
  /** The request's viewer (effect-auth's session context). */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /** The application's role axes. */
  readonly policy: AccessPolicy;
  /** The follower seam the owned ends read; `nobodyFollows` when the runtime provides none. */
  readonly followers: FollowerSeam<Following, R>;
  /** The edge's column values from the create input; each end's column must hold its node id. */
  readonly values: (input: Create) => EdgeValues;
  /** Shape a stored edge into the resource. */
  readonly toResource: (row: Row) => Resource;
  /**
   * A create colliding with a stored edge on the unique key: `"fail"`
   * ({@link EdgeConflict}, the default) or `"ignore"` (re-assertion is a
   * no-op returning the stored edge's id, when the viewer may read it).
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the optional-field convention (AGENTS.md → Conventions); absent is the default `"fail"`
  readonly onConflict?: "fail" | "ignore" | undefined;
  /** The write gate; {@link corpusWriteGate} when absent. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the optional-field convention (AGENTS.md → Conventions); absent is the default `corpusWriteGate`
  readonly writeGate?: EdgeWriteGate<E, R> | undefined;
}

/**
 * A list request: the bounded page cursor and the family's own predicate.
 *
 * @since 0.1.0
 */
export interface EdgeListRequest {
  readonly limit: number;
  readonly offset: number;
  /** The family's predicate over edge columns (and {@link endpointColumn}s), or `always`. */
  readonly where: ListFilter<never>;
}

/**
 * A create's outcome: the edge's id, and whether this call wrote it (`false`
 * when an `"ignore"` family resolved a re-assertion to the stored edge).
 *
 * @since 0.1.0
 */
export interface EdgeWrite {
  readonly id: string;
  readonly created: boolean;
}

/**
 * The operations {@link defineEdgeOps} produces for one edge family.
 *
 * @since 0.1.0
 */
export interface EdgeOps<Create, Resource, E, R> {
  /**
   * One page of the edges the viewer may read, with the unpaged total as the
   * store reports it (`EDGE-001`: an edge with a hidden or tombstoned end is
   * omitted). The limit is clamped to `MAX_PAGE_LIMIT` (`SEC-INPUT-003`).
   * Fails only with the store's `E`.
   */
  readonly list: (request: EdgeListRequest) => Effect.Effect<Page<Resource>, E, R>;
  /**
   * The edge as a resource. Fails `EdgeNotFound` when it is missing OR an
   * end is hidden from the viewer (`SEC-AUTH-ENUM-001`, `EDGE-001`).
   */
  readonly get: (id: string) => Effect.Effect<Resource, EdgeNotFound | E, R>;
  /**
   * Assert the edge. Fails `NodeNotFound` when an end names a node that is
   * missing, tombstoned or hidden from the viewer (checked before the gate,
   * so a 403 never confirms a node); the gate's `Unauthorized` / `Forbidden`
   * (or `NodeNotFound`); `EdgeConflict` on a unique-key collision the
   * conflict policy does not resolve; `EdgeCardinalityExceeded` when an end's
   * node already holds its `maxEdges`. The last two are answered only past
   * the gate, and each can disclose a hidden edge to that caller: a refusal
   * counts hidden edges ({@link EdgeEnd.maxEdges}), and when the unique key
   * leaves an end out, a collision says a hidden edge holds the key.
   */
  readonly create: (
    input: Create,
  ) => Effect.Effect<
    EdgeWrite,
    Unauthorized | Forbidden | NodeNotFound | EdgeConflict | EdgeCardinalityExceeded | E,
    R
  >;
  /**
   * Hard-delete the edge. Fails `EdgeNotFound` when it is missing or hidden
   * from the viewer (checked before the gate), then the gate's failures.
   */
  readonly delete: (
    id: string,
  ) => Effect.Effect<
    { readonly id: string },
    Unauthorized | Forbidden | NodeNotFound | EdgeNotFound | E,
    R
  >;
}

/** What is wrong with one end's declaration: an alias with a `.`, or a `maxEdges` that is not a positive safe integer. */
const declarationProblem = <E, R>([alias, end]: readonly [string, EdgeEnd<E, R>]) => {
  if (alias.includes(".")) {
    return Option.some(`the end alias '${alias}' contains a '.', which endpointColumn reserves`);
  }
  const max = end.maxEdges;
  if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) {
    return Option.some(
      `the end '${alias}' declares maxEdges ${String(max)}, not a positive safe integer`,
    );
  }
  return Option.none<string>();
};

/** Throw {@link EdgeDeclarationError} on the first malformed end. */
const validateEnds = <E, R>(type: string, ends: EdgeEnds<E, R>): void => {
  const problem = Arr.findFirst(Record.toEntries(ends), declarationProblem);
  if (Option.isSome(problem)) {
    throw new EdgeDeclarationError({ message: `${type}: ${problem.value}` });
  }
};

/** The request's page window: the limit clamped to `[1, MAX_PAGE_LIMIT]` (`SEC-INPUT-003`), the offset to `≥ 0`. */
const pageWindow = (request: EdgeListRequest) => ({
  limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
  offset: Math.max(0, Math.trunc(request.offset)),
});

/** The ends a create bounds, in the order their nodes are locked: ascending `nodeId`, so no two creates lock a pair in opposite orders. */
const byNodeId = Order.mapInput(Order.String, (at: { readonly nodeId: string }) => at.nodeId);

/**
 * Bind an edge family's operations. Every produced operation is traced as
 * `${type}.<operation>`; the writes run in the caller's transaction (the
 * boundary is the caller's, website #1883), and a create's cardinality
 * count and insert share it (README → Seams).
 *
 * Throws {@link EdgeDeclarationError}, when the family is declared, for an
 * end alias containing a `.` or a `maxEdges` that is not a positive safe
 * integer.
 *
 * @since 0.1.0
 */
export const defineEdgeOps = <Create, Row extends EdgeRow, Resource, Following, E, R>(
  definition: EdgeDefinition<Create, Row, Resource, Following, E, R>,
): EdgeOps<Create, Resource, E, R> => {
  const { type, ends, edges, policy, followers, toResource } = definition;
  validateEnds(type, ends);
  const endEntries = Record.toEntries(ends);
  const writeGate: EdgeWriteGate<E, R> = definition.writeGate ?? corpusWriteGate;
  const onConflict = definition.onConflict ?? "fail";

  /** The node `edge` names at `end`, if the viewer may read it; none for a missing or non-string id. */
  const readableNode = (end: EdgeEnd<E, R>, viewer: Viewer, edge: EdgeValues) => {
    const nodeId = edge[end.column];
    return Predicate.isString(nodeId)
      ? Effect.flatMap(end.nodes.get(nodeId), (node) =>
          Effect.map(canViewEndpoint(end, viewer, policy, followers, node), (readable) =>
            readable ? Option.some(nodeId) : Option.none(),
          ),
        )
      : Effect.succeed(Option.none<string>());
  };

  /** `EDGE-001` for one stored edge: every end's node is readable. */
  const edgeVisible = (viewer: Viewer, row: Row) =>
    Effect.map(
      Effect.forEach(endEntries, ([, end]) => readableNode(end, viewer, row), {
        concurrency: 1,
      }),
      Arr.every(Option.isSome),
    );

  /** The stored edge, if the viewer may read it. */
  const visibleEdge = (viewer: Viewer, id: string) =>
    Effect.flatMap(edges.get(id), (row) =>
      Option.isNone(row)
        ? Effect.succeed(row)
        : Effect.map(edgeVisible(viewer, row.value), (visible) =>
            visible ? row : Option.none<Row>(),
          ),
    );

  /** A unique-key collision, settled by the conflict policy: only ever a readable edge's id. */
  const resolveCollision = (viewer: Viewer, id: string) =>
    Effect.gen(function* () {
      if (onConflict === "fail") return yield* new EdgeConflict({ type });
      if (Option.isNone(yield* visibleEdge(viewer, id))) return yield* new EdgeConflict({ type });
      return { id, created: false };
    });

  /** An end's declared `maxEdges`, checked against the edges its node already holds. */
  const withinLimit = (at: {
    readonly alias: string;
    readonly end: EdgeEnd<E, R>;
    readonly nodeId: string;
  }) =>
    Option.match(Option.fromNullishOr(at.end.maxEdges), {
      onNone: () => Effect.void,
      onSome: (max) =>
        Effect.flatMap(edges.countAt(at.end.column, at.nodeId), (held) =>
          held >= max
            ? Effect.fail(
                new EdgeCardinalityExceeded({ type, end: at.alias, nodeId: at.nodeId, max }),
              )
            : Effect.void,
        ),
    });

  const list = Effect.fn(`${type}.list`)(function* (request: EdgeListRequest) {
    const viewer = yield* definition.viewer;
    const where = and<Following>(endpointFilter(ends, viewer, policy, followers), request.where);
    const { rows, total } = yield* edges.list({ where, ...pageWindow(request) });
    return { rows: Arr.map(rows, toResource), total };
  });

  const get = Effect.fn(`${type}.get`)(function* (id: string) {
    const row = yield* visibleEdge(yield* definition.viewer, id);
    // Hidden and missing are the same answer (SEC-AUTH-ENUM-001).
    if (Option.isNone(row)) return yield* new EdgeNotFound({ type, id });
    return toResource(row.value);
  });

  const create = Effect.fn(`${type}.create`)(function* (input: Create) {
    const viewer = yield* definition.viewer;
    const values = definition.values(input);
    // Every end first, before the gate: a node the viewer cannot read is
    // `NodeNotFound` whoever asks, so a gate's 403 never confirms it (#1306).
    const nodes = yield* Effect.forEach(
      endEntries,
      ([alias, end]) =>
        Effect.flatMap(readableNode(end, viewer, values), (node) =>
          Option.match(node, {
            onNone: () =>
              Effect.fail(new NodeNotFound({ type: end.type, id: String(values[end.column]) })),
            onSome: (nodeId) => Effect.succeed({ alias, end, nodeId }),
          }),
        ),
      { concurrency: 1 },
    );
    yield* writeGate({ viewer, policy, edge: values });
    // A re-assertion resolves before the cardinality check, so asserting an
    // edge that is already there stays idempotent at a full end.
    const collided = yield* edges.existing(values);
    if (Option.isSome(collided)) return yield* resolveCollision(viewer, collided.value);
    // Each bounded end's count locks its node (README → Seams), so the nodes
    // are visited in one global order: a self-referential family's two
    // bounded ends cannot deadlock two creates naming the pair both ways.
    yield* Effect.forEach(Arr.sort(nodes, byNodeId), withinLimit, {
      concurrency: 1,
      discard: true,
    });
    const inserted = yield* edges.insert(values);
    if (Option.isSome(inserted)) return { id: inserted.value, created: true };
    // A racing writer took the key between `existing` and the insert.
    const raced = yield* edges.existing(values);
    if (Option.isNone(raced)) return yield* new EdgeConflict({ type });
    return yield* resolveCollision(viewer, raced.value);
  });

  const remove = Effect.fn(`${type}.delete`)(function* (id: string) {
    const viewer = yield* definition.viewer;
    const row = yield* visibleEdge(viewer, id);
    if (Option.isNone(row)) return yield* new EdgeNotFound({ type, id });
    yield* writeGate({ viewer, policy, edge: row.value });
    // A hard DELETE: an edge has no version chain to append a tombstone to.
    if (!(yield* edges.delete(id))) return yield* new EdgeNotFound({ type, id });
    return { id };
  });

  return { list, get, create, delete: remove };
};
