/**
 * @copyright Thomas Foster
 *
 * The kernel's live pointer (README → Seams → `PublicationStore` and
 * `LiveView`, pulpit#46) over a tree's pointer level (pulpit#247):
 * effect-drizzle-ext's append-only `${pointer}_pointer` log and the leaf
 * views `makeTreeViews` resolves at its effective fact. One publish-gated
 * leaf gets three seams, the kernel's `PublicationDeclaration` and its
 * gated `store`:
 *
 * - `facts`, the `PublicationStore` over the log: `record`, `effective` (the
 *   latest-recorded fact whose `at` has arrived, at `now()`), `facts` and
 *   `scheduled` (#325);
 * - `live`, the `LiveView`: the row at the effective fact's version, with
 *   that version, the head's `action`, `draft = false` and the fact's `at`
 *   as `publishedAt`; `list` / `distinct` read the head row for a node
 *   matching `headFor` and the live row for every other;
 * - `leaves`, the gated current-version `LeafStore`: the head rows with
 *   `draft` computed as "no live row", a stored draft column ignored.
 *
 * The rows are read through the same row sources, filter and order as
 * `./leaf-store`, in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { PointerTable } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import type { ListFilter } from "@thomasfosterau/pulpit/filter";
import type { SearchBranch } from "@thomasfosterau/pulpit/search";
import type {
  LeafRow,
  LeafStore,
  LiveView,
  PublicationFact,
  PublicationStore,
} from "@thomasfosterau/pulpit/subtype";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  sql,
  type AnyRelations,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder, unionAll, type PgView } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import type { FilterColumns } from "./filter.ts";
import { renderListFilter } from "./filter.ts";
import type { SearchBranchOptions } from "./search.ts";
import { isNodeId } from "./internal/node-id.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import {
  readsOver,
  ownedSelection,
  searchOver,
  sourceOf,
  storeOver,
  viewId,
  type RowSource,
} from "./internal/rows.ts";

/**
 * One publish-gated leaf's seams: the publication log, the live view and
 * the gated current-version store (`defineSubtype`'s `store`, beside
 * `publication: { live, facts }`).
 *
 * @since 0.0.0
 */
export interface PublishGated<E, I> {
  readonly facts: PublicationStore<E, I>;
  readonly live: LiveView<LeafRow, SQLWrapper, E, I>;
  readonly leaves: LeafStore<LeafRow, SQLWrapper, E, I>;
  /**
   * A `SearchBranch` over the rows `live.list` reads for `headFor` (per
   * node, its head when it matches `headFor`, else its live row), ranked in
   * the same statement as the scope (`./search`'s `makeSearchBranch`
   * contract). Build it with the `headFor` the leaf's `list` would pass for
   * the viewer (`never` for a reader, the viewer's own heads for an owner);
   * a viewer on a head-reading rung searches the head store with
   * `makeSearchBranch` over the leaf view.
   */
  readonly searchBranch: (
    options: SearchBranchOptions,
  ) => (headFor: ListFilter<SQLWrapper>) => SearchBranch<SQLWrapper, E, I>;
}

/**
 * Every publish-gated leaf's seams, keyed by leaf name.
 *
 * @since 0.0.0
 */
export type Publications<Leaf extends string, E, I> = {
  readonly [K in Leaf]: PublishGated<E, I>;
};

/** The key a live row's publication stamp takes (the kernel's `publishedAt`). */
const PUBLISHED_AT = "publishedAt";

/**
 * Bind the kernel's live pointer to every leaf of one pointer (`pointer`, a
 * name in `makeTreeTables`' `root.pointers`): `log` is
 * `tables.pointers[pointer]`, `live` the pointer's leaf views
 * (`views.pointers[pointer].leaves`), `views` the tree's views (its leaf
 * views are the heads), `owners` the owner table.
 *
 * - `facts.record` appends a fact (`version` `NULL` for an unpublish);
 *   `effective` is the latest by `seq` whose `at <= now()`; `facts` is the
 *   node's facts in record order; `scheduled` the pending schedules, one
 *   read.
 * - `live.get` / `getMany` read the live row; `list` / `distinct` read
 *   the `UNION ALL` of the head rows matching `headFor` and the live rows of
 *   every other node, under the filter, order and page `./leaf-store` reads
 *   with.
 * - `leaves` is the current-version store with `draft = NOT EXISTS (a live
 *   row)`, the stored draft column ignored.
 *
 * Every id that is no canonical UUID names no node. Throws
 * effect-drizzle-ext's `DerivationError` at module load for a view without
 * an `id` column.
 *
 * @since 0.0.0
 */
export const makePublications = <Leaf extends string, I, Relations extends AnyRelations>(config: {
  readonly views: { readonly leaves: { readonly [leaf: string]: PgView } };
  readonly pointer: string;
  readonly log: PointerTable;
  readonly live: { readonly [K in Leaf]: PgView };
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): Publications<Leaf, StoreQueryError<Relations>, I> => {
  const { log, owners, CurrentTransaction } = config;
  const qb = new QueryBuilder();

  const gatedOf = (leaf: string, liveView: PgView): PublishGated<StoreQueryError<Relations>, I> => {
    const headView = Option.getOrElse(R.get(config.views.leaves, leaf), () => {
      throw new DerivationError({ message: `makePublications: "${leaf}" has no leaf view` });
    });
    const headId = viewId(leaf, headView);
    const liveId = viewId(leaf, liveView);
    const liveFields = ownedSelection(liveView, owners);
    const pointerAt = `${config.pointer}At`;
    const pointerAtField = Option.getOrElse(R.get(liveFields, pointerAt), () => {
      throw new DerivationError({
        message: `makePublications: leaf "${leaf}"'s pointer view has no ${pointerAt} column; is "${config.pointer}" its pointer?`,
      });
    });

    /** The gated head selection: the head view, the owner, `draft` as "no live row". */
    const headSelection = (): FilterColumns => {
      const own = ownedSelection(headView, owners, {
        draft: sql<boolean>`NOT EXISTS (SELECT 1 FROM ${liveView} WHERE ${liveId} = ${headId})`.as(
          "draft",
        ),
      });
      return R.has(own, PUBLISHED_AT)
        ? own
        : { ...own, [PUBLISHED_AT]: sql`NULL::timestamptz`.as("published_at") };
    };
    const keys = R.keys(headSelection());

    /** The gated head rows, under `name`. */
    const heads = (name: string): RowSource => {
      const relation = qb
        .select(headSelection())
        .from(headView)
        .leftJoin(owners, eq(owners.nodeId, sql`${headId}`))
        .as(name);
      return sourceOf(relation, keys, leaf);
    };

    /** The live rows, under `name`: the pointed row, `draft = false`, the fact's `at` as `publishedAt`. */
    const lives = (name: string): RowSource => {
      const fields: FilterColumns = {
        ...R.remove(liveFields, pointerAt),
        draft: sql<boolean>`false`.as("draft"),
        [PUBLISHED_AT]: sql<Date>`${pointerAtField}`.as("published_at"),
      };
      // The same keys in the same order as the heads, so the two arms of a union line up.
      const ordered = R.fromEntries(
        Arr.flatMap(keys, (key) =>
          Option.toArray(Option.map(R.get(fields, key), (f) => [key, f] as const)),
        ),
      );
      const relation = qb
        .select(ordered)
        .from(liveView)
        .leftJoin(owners, eq(owners.nodeId, sql`${liveId}`))
        .as(name);
      return sourceOf(relation, keys, leaf);
    };

    /** A predicate over a source, `true` for `always`. */
    const predicate = (filter: ListFilter<SQLWrapper>, source: RowSource): SQL =>
      Option.getOrElse(renderListFilter(filter, source.columns), () => sql`true`);

    /** Per node, its head row when it matches `headFor`, else its live row, else none. */
    const chosen = (headFor: ListFilter<SQLWrapper>): RowSource => {
      const head = heads(`${leaf}_chosen_head`);
      const match = heads(`${leaf}_chosen_match`);
      const live = lives(`${leaf}_chosen_live`);
      const relation = unionAll(
        qb.select(head.columns).from(head.relation).where(predicate(headFor, head)),
        qb
          .select(live.columns)
          .from(live.relation)
          .where(
            sql`${live.id} NOT IN (${qb
              .select({ id: match.id })
              .from(match.relation)
              .where(predicate(headFor, match))})`,
          ),
      ).as(`${leaf}_chosen`);
      return sourceOf(relation, keys, leaf);
    };

    const reads = readsOver(leaf, CurrentTransaction);
    const liveRows = lives(`${leaf}_live`);

    const live: LiveView<LeafRow, SQLWrapper, StoreQueryError<Relations>, I> = {
      ...reads.byId(liveRows),
      list: (query) => reads.page(chosen(query.headFor), query),
      distinct: (query) => reads.distinct(chosen(query.headFor), query),
      // The localised live view reads the pointer's keyed view (pulpit#343).
      listLocalised: () => Effect.succeed({ rows: [], total: 0 }),
    };

    return {
      facts: factsStore(log, CurrentTransaction),
      live,
      leaves: storeOver(leaf, heads(`${leaf}_rows`), owners, CurrentTransaction),
      searchBranch: (options) => (headFor) =>
        searchOver(chosen(headFor), options, CurrentTransaction),
    };
  };

  return R.map(config.live, (view, leaf) => gatedOf(leaf, view));
};

/** A log row as the kernel's `PublicationFact`. */
const toFact = (
  row: Pick<PointerTable["$inferSelect"], "id" | "version" | "at" | "actor" | "recordedAt">,
): PublicationFact => ({
  id: row.id,
  version: Option.fromNullishOr(row.version),
  at: row.at,
  actorId: Option.fromNullishOr(row.actor),
  recordedAt: row.recordedAt,
});

/** The publication log over one pointer table, in the caller's transaction. */
const factsStore = <I, Relations extends AnyRelations>(
  log: PointerTable,
  CurrentTransaction: Context.Service<I, PgTransaction<Relations>>,
): PublicationStore<StoreQueryError<Relations>, I> => {
  const selection = {
    id: log.id,
    version: log.version,
    at: log.at,
    actor: log.actor,
    recordedAt: log.recordedAt,
  };
  return {
    record: (fact) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.insert(log).values({
          id: fact.id,
          version: Option.getOrNull(fact.version),
          at: fact.at,
          actor: Option.getOrNull(fact.actorId),
          recordedAt: fact.recordedAt,
        });
      }),
    effective: (id) =>
      isNodeId(id)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select(selection)
              .from(log)
              .where(and(eq(log.id, id), lte(log.at, sql`now()`)))
              .orderBy(desc(log.seq))
              .limit(1);
            return Option.map(Arr.head(rows), toFact);
          })
        : Effect.succeedNone,
    facts: (id, limit) =>
      isNodeId(id)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select(selection)
              .from(log)
              .where(eq(log.id, id))
              .orderBy(asc(log.seq))
              .limit(limit);
            return Arr.map(rows, toFact);
          })
        : Effect.succeed([]),
    scheduled: (ids) => {
      const valid = Arr.dedupe(Arr.filter(ids, isNodeId));
      if (!Arr.isReadonlyArrayNonEmpty(valid)) return Effect.succeed([]);
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const later = alias(log, "later_fact");
        const rows = yield* tx
          .selectDistinctOn([log.id], selection)
          .from(log)
          .where(
            and(
              inArray(log.id, [...valid]),
              sql`${log.version} IS NOT NULL`,
              gt(log.at, sql`now()`),
              sql`NOT EXISTS (${new QueryBuilder()
                .select({ one: sql`1` })
                .from(later)
                .where(and(eq(later.id, log.id), gt(later.seq, log.seq), lte(later.at, log.at)))})`,
            ),
          )
          .orderBy(log.id, desc(log.seq));
        return Arr.map(rows, toFact);
      });
    },
  };
};
