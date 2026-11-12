/**
 * @copyright Thomas Foster
 *
 * The kernel's `LeafStore` (README → Seams → `LeafStore`) over the
 * fail-closed current-version views effect-drizzle-ext's `makeTreeViews`
 * derives from a tree (pulpit#247), plus the owner table the kernel's owned
 * leaves stamp (`core.node_owner` in the applications), which is pulpit's
 * vocabulary and so lives here, not in effect-drizzle-ext.
 *
 * Each row is the leaf view's row (`id`, the head's `version` and `action`,
 * the identity extras, every level's columns, `timestamp`, `createdAt`) with
 * the node's owner LEFT JOINed in as `ownerId`. `list` renders the kernel's
 * `ListFilter` and list order (`./filter`) and returns the unpaged total as
 * a window column; `distinct` reads one column's distinct string values
 * over the same rows. Every read and write runs in the caller's ambient
 * `CurrentTransaction`, as the version chain does: no store opens a
 * connection or a transaction of its own.
 *
 * @since 0.0.0
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { ChainTree } from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import type { LeafRow, LeafStore } from "@thomasfosterau/pulpit/subtype";
import { VersionAction } from "@thomasfosterau/pulpit/version-chain";
import {
  and,
  eq,
  getTableColumns,
  getViewSelectedFields,
  is,
  isNotNull,
  SQL,
  sql,
  type AnyRelations,
  type SQLWrapper,
} from "drizzle-orm";
import {
  index,
  text,
  uuid,
  type AnyPgColumn,
  type PgSchema,
  PgColumn,
  type PgTable,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  distinctKey,
  renderListFilter,
  renderListOrder,
  type FilterColumn,
  type FilterColumns,
} from "./filter.ts";
import { isNodeId } from "./internal/node-id.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * The owner column a leaf store joins in, under the key the kernel's
 * `ownedAccess` reads (`ownerColumn: "ownerId"`).
 *
 * @since 0.0.0
 */
export const OWNER_COLUMN = "ownerId";

/**
 * Build the owner table (`node_owner` unless `name` says otherwise): one row
 * per owned node, `node_id` its primary key and a foreign key to the
 * identity table that cascades on delete (so `purge` takes it too), and
 * `owner_id` the owning account, indexed for the owner arm of a list.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeNodeOwnerTable } from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const schema = pgSchema("core");
 * const title = dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false });
 * const tree = defineTree({ post: { leaf: { title } } });
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * strictEqual(getTableName(makeNodeOwnerTable({ schema, identity: tables.root.identity })), "node_owner");
 * ```
 *
 * @since 0.0.0
 */
export const makeNodeOwnerTable = (options: {
  readonly schema: PgSchema;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly name?: string;
}) => {
  const name = options.name ?? "node_owner";
  return options.schema.table(
    name,
    {
      nodeId: uuid("node_id")
        .primaryKey()
        .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
      ownerId: text("owner_id").notNull(),
    },
    (table) => [index(`${name}_owner_id_idx`).on(table.ownerId)],
  );
};

/**
 * The owner table a leaf store reads and stamps: {@link makeNodeOwnerTable}'s.
 *
 * @since 0.0.0
 */
export type NodeOwnerTable = ReturnType<typeof makeNodeOwnerTable>;

/**
 * The query failure a leaf store reports: the driver's own error, as the
 * application's `CurrentTransaction` raises it.
 *
 * @since 0.0.0
 */
export type StoreQueryError<Relations extends AnyRelations> =
  PgTransaction<Relations> extends {
    readonly select: () => { readonly from: (table: never) => infer Q };
  }
    ? Q extends Effect.Effect<unknown, infer E, unknown>
      ? E
      : never
    : never;

/**
 * Every leaf's {@link LeafStore}, keyed by leaf name: rows are the kernel's
 * `LeafRow`, `Following` a SQL subquery (`SQLWrapper`).
 *
 * @since 0.0.0
 */
export type LeafStores<Leaf extends string, E, I> = {
  readonly [K in Leaf]: LeafStore<LeafRow, SQLWrapper, E, I>;
};

/** The view's own columns, by field key, referenced through the view (so a query reads the view's). */
const viewColumns = (view: PgView): FilterColumns =>
  Arr.reduce(
    R.toEntries(getViewSelectedFields(view)),
    R.empty<string, FilterColumn>(),
    (acc, [key, field]) =>
      is(field, PgColumn) || is(field, SQL.Aliased) ? { ...acc, [key]: field } : acc,
  );

/** The keys one level of a path contributes to its view: its version columns past `(id, version)`. */
const levelKeys = (table: PgTable): ReadonlyArray<string> =>
  Arr.filter(R.keys(getTableColumns(table)), (key) => key !== "id" && key !== "version");

/**
 * The keys a leaf view's own projection supplies beside the path's columns
 * (the head, the tail, the joined owner), which no other source may reuse.
 */
const PROJECTED = ["id", "version", "action", "timestamp", "createdAt", OWNER_COLUMN] as const;

/**
 * The view merges its sources by key (`{ ...identityExtras, ...levels,
 * timestamp, createdAt }`), so two sources sharing a key would silently keep
 * the later one: an identity extra `slug` shadowed by a level's `slug`, or a
 * level column named `createdAt` shadowed by the birth timestamp (the trap
 * gardeneria hit in its hand-written current-version view). Refuse such a
 * tree at module load instead, naming both sources.
 */
const checkMerge = (
  leaf: string,
  sources: ReadonlyArray<readonly [source: string, keys: ReadonlyArray<string>]>,
): void => {
  Arr.reduce(sources, R.empty<string, string>(), (seen, [source, keys]) =>
    Arr.reduce(keys, seen, (acc, key) =>
      Option.match(R.get(acc, key), {
        onNone: () => ({ ...acc, [key]: source }),
        onSome: (earlier) => {
          throw new DerivationError({
            message: `makeLeafStores: leaf "${leaf}"'s view takes "${key}" from both ${earlier} and ${source}; the later would silently shadow the earlier. Rename one.`,
          });
        },
      }),
    ),
  );
};

/**
 * A leaf view's row as the kernel reads it: `id` a uuid string, `version`
 * the head's `bigint`, `action` the root version table's CHECKed text, and
 * every other column a `ColumnValue` (text, numbers, booleans, timestamps as
 * `Date`, JSON, `bigint`). Drizzle decodes each column through its own
 * type, so a row that fails this is a view outside the contract (a `bytea`
 * column, say): a defect.
 */
const isLeafRow = Schema.is(
  Schema.StructWithRest(
    Schema.Struct({ id: Schema.String, version: Schema.BigInt, action: VersionAction }),
    [Schema.Record(Schema.String, Schema.Union([Schema.Json, Schema.Date, Schema.BigInt]))],
  ),
);

/** The rows as the kernel's `LeafRow`s, or a defect naming the leaf. */
const asLeafRows = (leaf: string, rows: ReadonlyArray<unknown>) =>
  Arr.every(rows, isLeafRow)
    ? Effect.succeed<ReadonlyArray<LeafRow>>(rows)
    : Effect.die(
        new DerivationError({
          message: `makeLeafStores: leaf "${leaf}"'s view decoded a row outside the kernel's LeafRow (a column type ColumnValue cannot hold)`,
        }),
      );

/**
 * Bind the kernel's `LeafStore` to every leaf view of a tree:
 * `views.leaves` from `makeTreeViews(tree, tables, …)`, the owner table from
 * {@link makeNodeOwnerTable}, and the application's `CurrentTransaction`.
 *
 * - `columns` is the view's field keys plus `ownerId`.
 * - `get` / `getMany` are `id = $id` / `id IN (…)` reads with a `LIMIT`; an
 *   id that is no canonical UUID names no node (none, or omitted), never a
 *   query error.
 * - `list` renders its `ListFilter` (`renderListFilter`), orders by its
 *   checked `orderBy` then `id` (`renderListOrder`: `NULLS LAST` on every
 *   key, a string by code point), pages by `LIMIT` / `OFFSET`, and reads the
 *   unpaged total off `count(*) OVER ()` (so a page past the end reports
 *   `total: 0`).
 * - `distinct` reads one column's distinct non-`NULL` values over the rows
 *   `list` reads, by code point, with the distinct count; a column that
 *   decodes to no string has none.
 * - `ownerOf` / `stampOwner` read and insert the owner row.
 *
 * Throws effect-drizzle-ext's `DerivationError` at module load when a leaf
 * view would take one key from two sources (an identity extra and a level
 * column, or either and a projected column: `timestamp`, `createdAt`,
 * `ownerId`), which the view's merge would otherwise resolve silently.
 *
 * @since 0.0.0
 */
export const makeLeafStores = <S, Leaf extends string, I, Relations extends AnyRelations>(config: {
  readonly tree: ChainTree<S>;
  readonly tables: VersionChainTables;
  readonly views: { readonly leaves: { readonly [K in Leaf]: PgView } };
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): LeafStores<Leaf, StoreQueryError<Relations>, I> => {
  const { tree, tables, owners, CurrentTransaction } = config;
  const identityExtras = Arr.filter(
    R.keys(getTableColumns(tables.root.identity)),
    (key) => key !== "id" && key !== "type",
  );

  const storeOf = (
    leaf: string,
    view: PgView,
  ): LeafStore<LeafRow, SQLWrapper, StoreQueryError<Relations>, I> => {
    const path = Option.match(
      Arr.findFirst(tree.levels, (level) => level.name === leaf),
      {
        onNone: () => [leaf],
        onSome: (level) => [...level.ancestors, leaf],
      },
    );
    checkMerge(leaf, [
      ["the view's own projection", PROJECTED],
      ["the identity table", identityExtras],
      ...Arr.flatMap(path, (name) =>
        Arr.fromOption(
          Option.map(
            R.get(tables.levels, name),
            (level) => [`level "${name}"`, levelKeys(level.version)] as const,
          ),
        ),
      ),
    ]);
    const own = viewColumns(view);
    const id = Option.getOrElse(
      Option.filter(R.get(own, "id"), (field) => is(field, PgColumn)),
      () => {
        throw new DerivationError({
          message: `makeLeafStores: leaf "${leaf}"'s view has no id column`,
        });
      },
    );
    const columns: FilterColumns = { ...own, [OWNER_COLUMN]: owners.ownerId };

    /** The view's rows under `where`, the owner joined in, at most `limit`. */
    const rowsWhere = (where: SQL, limit: number) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select(columns)
          .from(view)
          .leftJoin(owners, eq(owners.nodeId, sql`${id}`))
          .where(where)
          .limit(limit);
        return yield* asLeafRows(leaf, rows);
      });

    return {
      // oxlint-disable-next-line effect/avoid-native-object-helpers -- the seam's column set is the native `ReadonlySet` `LeafStore.columns` names
      columns: new Set(R.keys(columns)),
      get: (nodeId) =>
        isNodeId(nodeId)
          ? Effect.map(rowsWhere(sql`${id} = ${nodeId}`, 1), Arr.head)
          : Effect.succeedNone,
      getMany: (ids) => {
        const valid = Arr.dedupe(Arr.filter(ids, isNodeId));
        return Arr.isReadonlyArrayNonEmpty(valid)
          ? rowsWhere(sql`${id} IN ${valid}`, valid.length)
          : Effect.succeed([]);
      },
      list: (query) =>
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          const rows = yield* tx
            .select({ ...columns, pageTotal: sql<number>`(count(*) over ())::int` })
            .from(view)
            .leftJoin(owners, eq(owners.nodeId, sql`${id}`))
            .where(Option.getOrUndefined(renderListFilter(query.where, columns)))
            .orderBy(...renderListOrder(query.orderBy, columns, id))
            .limit(query.limit)
            .offset(query.offset);
          return {
            rows: yield* asLeafRows(
              leaf,
              Arr.map(rows, ({ pageTotal: _total, ...row }) => row),
            ),
            total: Option.getOrElse(
              Option.map(Arr.head(rows), (row) => row.pageTotal),
              () => 0,
            ),
          };
        }),
      distinct: (query) =>
        Option.match(
          Option.flatMap(R.get(columns, query.column), (column) =>
            Option.map(distinctKey(column), (key) => ({ column, key })),
          ),
          {
            onNone: () => Effect.succeed({ rows: [], total: 0 }),
            onSome: ({ column, key }) =>
              Effect.gen(function* () {
                const tx = yield* CurrentTransaction;
                const values = tx
                  .selectDistinct({ value: sql<string>`${key}`.as("value") })
                  .from(view)
                  .leftJoin(owners, eq(owners.nodeId, sql`${id}`))
                  .where(
                    and(
                      Option.getOrUndefined(renderListFilter(query.where, columns)),
                      isNotNull(column),
                    ),
                  )
                  .as("distinct_values");
                const rows = yield* tx
                  .select({
                    value: values.value,
                    total: sql<number>`(count(*) over ())::int`,
                  })
                  .from(values)
                  .orderBy(values.value)
                  .limit(query.limit)
                  .offset(query.offset);
                return {
                  rows: Arr.map(rows, (row) => row.value),
                  total: Option.getOrElse(
                    Option.map(Arr.head(rows), (row) => row.total),
                    () => 0,
                  ),
                };
              }),
          },
        ),
      // A leaf view has no locale level (the localised store reads the keyed
      // view instead), so it carries no locale rows to choose among.
      listLocalised: () => Effect.succeed({ rows: [], total: 0 }),
      ownerOf: (nodeId) =>
        isNodeId(nodeId)
          ? Effect.gen(function* () {
              const tx = yield* CurrentTransaction;
              const rows = yield* tx
                .select({ ownerId: owners.ownerId })
                .from(owners)
                .where(eq(owners.nodeId, nodeId))
                .limit(1);
              return Option.map(Arr.head(rows), (row) => row.ownerId);
            })
          : Effect.succeedNone,
      stampOwner: (nodeId, ownerId) =>
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.insert(owners).values({ nodeId, ownerId });
        }),
    };
  };

  return R.map(config.views.leaves, (view, leaf) => storeOf(leaf, view));
};
