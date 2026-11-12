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
import { isNodeId } from "./internal/node-id.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import {
  localisedPage,
  localisedStoreOver,
  readsOver,
  ownedSelection,
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
 * - A leaf in `keyed` (its keyed head view and the pointer's keyed view,
 *   pulpit#343) reads one row per locale: `live.list` / `distinct` the
 *   locale rows of the version each node is read at (its head when its
 *   shared head matches `headFor`, else its live version), and
 *   `live.listLocalised` each node's most preferred carried locale of them;
 *   `leaves` is the localised store over the keyed heads. `live.get` /
 *   `getMany` read the shared live row.
 *
 * Every id that is no canonical UUID names no node. Throws
 * effect-drizzle-ext's `DerivationError` at module load for a view without
 * an `id` column, and for a leaf keyed on one side only.
 *
 * @since 0.0.0
 */
export const makePublications = <Leaf extends string, I, Relations extends AnyRelations>(config: {
  readonly views: { readonly leaves: { readonly [leaf: string]: PgView } };
  readonly pointer: string;
  readonly log: PointerTable;
  readonly live: { readonly [K in Leaf]: PgView };
  /**
   * A localised leaf's keyed views: `views` its keyed head views
   * (`views.keyed`) and `live` the pointer's (`views.pointers[pointer].keyed`).
   * A leaf in both reads one row per locale (pulpit#343).
   */
  readonly keyed?: {
    readonly views: { readonly [leaf: string]: PgView };
    readonly live: { readonly [leaf: string]: PgView };
  };
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): Publications<Leaf, StoreQueryError<Relations>, I> => {
  const { log, owners, CurrentTransaction } = config;
  const qb = new QueryBuilder();

  const gatedOf = (leaf: string, liveView: PgView): PublishGated<StoreQueryError<Relations>, I> => {
    const headView = Option.getOrElse(R.get(config.views.leaves, leaf), () => {
      throw new DerivationError({ message: `makePublications: "${leaf}" has no leaf view` });
    });
    const liveId = viewId(leaf, liveView);
    const pointerAt = `${config.pointer}At`;

    /** The gated head selection over `view`: the owner, `draft` as "no live row". */
    const headSelection = (view: PgView): FilterColumns => {
      const own = ownedSelection(view, owners, {
        draft:
          sql<boolean>`NOT EXISTS (SELECT 1 FROM ${liveView} WHERE ${liveId} = ${viewId(leaf, view)})`.as(
            "draft",
          ),
      });
      return R.has(own, PUBLISHED_AT)
        ? own
        : { ...own, [PUBLISHED_AT]: sql`NULL::timestamptz`.as("published_at") };
    };

    /**
     * A head view and the pointer view resolved at the same leaf (the shared
     * pair, or the keyed pair of a localised leaf), as gated head rows and
     * live rows whose keys line up for a union.
     */
    const sourcesOver = (head: PgView, pointed: PgView) => {
      const keys = R.keys(headSelection(head));
      const pointedFields = ownedSelection(pointed, owners);
      const pointerAtField = Option.getOrElse(R.get(pointedFields, pointerAt), () => {
        throw new DerivationError({
          message: `makePublications: leaf "${leaf}"'s pointer view has no ${pointerAt} column; is "${config.pointer}" its pointer?`,
        });
      });
      const heads = (name: string): RowSource => {
        const relation = qb
          .select(headSelection(head))
          .from(head)
          .leftJoin(owners, eq(owners.nodeId, sql`${viewId(leaf, head)}`))
          .as(name);
        return sourceOf(relation, keys, leaf);
      };
      /** The live rows: the pointed row, `draft = false`, the fact's `at` as `publishedAt`. */
      const lives = (name: string): RowSource => {
        const fields: FilterColumns = {
          ...R.remove(pointedFields, pointerAt),
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
          .from(pointed)
          .leftJoin(owners, eq(owners.nodeId, sql`${viewId(leaf, pointed)}`))
          .as(name);
        return sourceOf(relation, keys, leaf);
      };
      return { keys, heads, lives };
    };

    const shared = sourcesOver(headView, liveView);

    /** A predicate over a source, `true` for `always`. */
    const predicate = (filter: ListFilter<SQLWrapper>, source: RowSource): SQL =>
      Option.getOrElse(renderListFilter(filter, source.columns), () => sql`true`);

    /**
     * Per node, the rows of `over` (the shared pair, or the keyed pair: one
     * row per locale) at its head when its shared head matches `headFor`,
     * else at its live version, else none. `headFor` is always read off the
     * shared head, as the kernel's `LiveView` reads it.
     */
    const chosenOver =
      (over: ReturnType<typeof sourcesOver>, name: string) =>
      (headFor: ListFilter<SQLWrapper>): RowSource => {
        const head = over.heads(`${name}_head`);
        const live = over.lives(`${name}_live`);
        const match = shared.heads(`${name}_match`);
        const matching = qb
          .select({ id: match.id })
          .from(match.relation)
          .where(predicate(headFor, match));
        const relation = unionAll(
          qb
            .select(head.columns)
            .from(head.relation)
            .where(sql`${head.id} IN (${matching})`),
          qb
            .select(live.columns)
            .from(live.relation)
            .where(sql`${live.id} NOT IN (${matching})`),
        ).as(name);
        return sourceOf(relation, over.keys, leaf);
      };
    const chosen = chosenOver(shared, `${leaf}_chosen`);

    const reads = readsOver(leaf, CurrentTransaction);
    const liveRows = shared.lives(`${leaf}_live`);
    const sharedHeads = shared.heads(`${leaf}_rows`);

    /** A localised leaf's keyed pair: its keyed head view and the pointer's keyed view. */
    const keyed = Option.zipWith(
      R.get(config.keyed?.views ?? {}, leaf),
      R.get(config.keyed?.live ?? {}, leaf),
      (head, pointed) => sourcesOver(head, pointed),
    );
    if (
      Option.isSome(R.get(config.keyed?.views ?? {}, leaf)) !==
      Option.isSome(R.get(config.keyed?.live ?? {}, leaf))
    ) {
      throw new DerivationError({
        message: `makePublications: leaf "${leaf}" has a keyed view on one side only; pass both \`views.keyed\` and the pointer's \`keyed\` views`,
      });
    }

    return Option.match(keyed, {
      onNone: () => ({
        facts: factsStore(log, CurrentTransaction),
        live: {
          ...reads.byId(liveRows),
          list: (query) => reads.page(chosen(query.headFor), query),
          distinct: (query) => reads.distinct(chosen(query.headFor), query),
          // An unkeyed leaf has no locale rows to choose among.
          listLocalised: () => Effect.succeed({ rows: [], total: 0 }),
        },
        leaves: storeOver(leaf, sharedHeads, owners, CurrentTransaction),
      }),
      onSome: (pair) => {
        const chosenKeyed = chosenOver(pair, `${leaf}_chosen_keyed`);
        return {
          facts: factsStore(log, CurrentTransaction),
          // `get` / `getMany` read the shared live row; the lists read one row per locale.
          live: {
            ...reads.byId(liveRows),
            list: (query) => reads.page(chosenKeyed(query.headFor), query),
            distinct: (query) => reads.distinct(chosenKeyed(query.headFor), query),
            listLocalised: (query) =>
              localisedPage(leaf, chosenKeyed(query.headFor), query, CurrentTransaction),
          },
          leaves: localisedStoreOver(
            leaf,
            sharedHeads,
            pair.heads(`${leaf}_locale_rows`),
            owners,
            CurrentTransaction,
          ),
        };
      },
    });
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
