/**
 * @copyright Thomas Foster
 *
 * The kernel's `ReportStore` (docs/seams.md → `ReportStore`, pulpit#59) on
 * PostgreSQL (pulpit#360): member reports against a tree's nodes, the
 * moderation queue `./moderation`'s `defineReports` files into and resolves
 * from. One report table, its target referencing the identity row and
 * cascading, so purging a node takes its reports with it. Reads join the
 * identity table for the target's leaf type. `lock` takes the row alone
 * `FOR UPDATE`, so two resolutions of one report serialise, and every call
 * runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import {
  ReportStatus,
  type ReportResolution,
  type ReportRow,
  type ReportStore,
} from "@thomasfosterau/pulpit/moderation";
import { and, desc, eq, sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { renderListFilter, type FilterColumns } from "./filter.ts";
import { countOf } from "./internal/count.ts";
import { isNodeId } from "./internal/node-id.ts";
import type { StoreQueryError } from "./internal/owners.ts";
import { mintUuid, selectRows } from "./internal/query.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build the report table (`name`, `report` by default) over a tree's
 * identity table: `target_node_id` references the identity row, cascading,
 * so purging a node takes its reports with it. `status` is CHECKed to the
 * kernel's three statuses, and a second CHECK holds `resolved_at` and
 * `resolved_by` `NULL` exactly on an open row. `filed_at` defaults to
 * `now()`; `reporter_id`, `target_node_id` and the open rows (newest first,
 * the queue's order) are indexed.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeReportTable } from "@thomasfosterau/pulpit-drizzle-pg/reports";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   post: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("core");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const reports = makeReportTable({ schema, identity: tables.root.identity });
 * strictEqual(getTableName(reports), "report");
 * ```
 *
 * @since 0.0.0
 */
export const makeReportTable = (options: {
  readonly schema: PgSchema;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly name?: string;
}) => {
  const name = options.name ?? "report";
  return options.schema.table(
    name,
    {
      id: uuid("id").primaryKey(),
      targetId: uuid("target_node_id")
        .notNull()
        .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
      reporterId: text("reporter_id").notNull(),
      reason: text("reason").notNull(),
      details: text("details"),
      status: text("status").notNull(),
      filedAt: timestamp("filed_at", { withTimezone: true }).notNull().defaultNow(),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
      resolvedBy: text("resolved_by"),
      resolutionNote: text("resolution_note"),
    },
    (table) => [
      check(`${name}_status`, sql`${table.status} IN ('open', 'resolved', 'dismissed')`),
      check(
        `${name}_resolution`,
        sql`(${table.status} = 'open') = (${table.resolvedAt} IS NULL) AND (${table.status} = 'open') = (${table.resolvedBy} IS NULL)`,
      ),
      index(`${name}_reporter`).on(table.reporterId),
      index(`${name}_target`).on(table.targetId),
      index(`${name}_open`)
        .on(table.filedAt.desc(), table.id.desc())
        .where(sql`${table.status} = 'open'`),
    ],
  );
};

/**
 * The report table: {@link makeReportTable}'s.
 *
 * @since 0.0.0
 */
export type ReportTable = ReturnType<typeof makeReportTable>;

/** A stored row as a read selects it: the database's `NULL`s, before they become options. */
const StoredRow = Schema.Struct({
  id: Schema.String,
  targetId: Schema.String,
  targetType: Schema.String,
  reporterId: Schema.String,
  reason: Schema.String,
  details: Schema.NullOr(Schema.String),
  status: ReportStatus,
  filedAt: Schema.Date,
  resolvedAt: Schema.NullOr(Schema.Date),
  resolvedBy: Schema.NullOr(Schema.String),
  resolutionNote: Schema.NullOr(Schema.String),
});
const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

/** A decoded stored row as the kernel's `ReportRow`. */
const toRow = (row: typeof StoredRow.Type): ReportRow => ({
  id: row.id,
  targetId: row.targetId,
  targetType: row.targetType,
  reporterId: row.reporterId,
  reason: row.reason,
  details: Option.fromNullishOr(row.details),
  status: row.status,
  filedAt: row.filedAt,
  resolvedAt: Option.fromNullishOr(row.resolvedAt),
  resolvedBy: Option.fromNullishOr(row.resolvedBy),
  resolutionNote: Option.fromNullishOr(row.resolutionNote),
});

/** Selected rows as the kernel's `ReportRow`s; a row outside the contract is a defect. */
const toRows = (rows: ReadonlyArray<object>): Effect.Effect<ReadonlyArray<ReportRow>> =>
  Effect.map(Effect.orDie(decodeStored(rows)), Arr.map(toRow));

/**
 * Bind the kernel's `ReportStore` to the report table, in the caller's
 * `CurrentTransaction`. `identity` is the tree's identity table
 * (`tables.root.identity`), joined for each report's `targetType`.
 *
 * - `mintId` is `gen_random_uuid()`; `insert` writes the row as given.
 * - `get(id)` is the row joined to the identity table; `lock(id)` is the
 *   same row `FOR UPDATE OF` the report alone, so two resolutions serialise.
 * - `close(id, resolution)` updates the row only while it is `open`.
 * - `list` renders `where` over `id`, `reporterId`, `targetId`,
 *   `targetType` and `status`, newest first (`filed_at DESC, id DESC`),
 *   with the unpaged total off `count(*) OVER ()`; a page past the end
 *   counts the matching rows again instead.
 * - `eraseReporter` touches at most `limit` of the rows the account filed or
 *   resolved (`ORDER BY id`), in one statement: it deletes the ones it filed
 *   and rewrites `resolved_by` to `replacement` on the rest (the two are
 *   disjoint), and answers how many rows changed.
 *
 * An id that is no canonical UUID names no report.
 *
 * @since 0.0.0
 */
export const makeReportStore = <I, Relations extends AnyRelations>(config: {
  readonly table: ReportTable;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): ReportStore<StoreQueryError<Relations>, I> => {
  const { table, identity, CurrentTransaction } = config;

  const fields = {
    id: sql<string>`${table.id}::text`.as("id"),
    targetId: sql<string>`${table.targetId}::text`.as("target_id"),
    targetType: identity.type,
    reporterId: table.reporterId,
    reason: table.reason,
    details: table.details,
    status: table.status,
    filedAt: table.filedAt,
    resolvedAt: table.resolvedAt,
    resolvedBy: table.resolvedBy,
    resolutionNote: table.resolutionNote,
  };
  /** The columns `list`'s filter reads. */
  const filterColumns: FilterColumns = {
    id: table.id,
    reporterId: table.reporterId,
    targetId: table.targetId,
    targetType: identity.type,
    status: table.status,
  };

  /** The rows matching `where`, counted (a page past the end reads no window total). */
  const counted = (where: Option.Option<SQL>) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .innerJoin(identity, eq(identity.id, table.targetId))
        .where(Option.getOrUndefined(where));
      return yield* countOf(rows);
    });

  /** The report at `id` (joined for its `targetType`), the row locked `FOR UPDATE` when `locked`. */
  const byId = (id: string, locked: boolean) =>
    isNodeId(id)
      ? Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          const query = tx
            .select(fields)
            .from(table)
            .innerJoin(identity, eq(identity.id, table.targetId))
            .where(eq(table.id, id))
            .limit(1);
          const rows = yield* locked ? query.for("update", { of: table }) : query;
          return Arr.head(yield* toRows(rows));
        })
      : Effect.succeedNone;

  /** Close the open rows `where` picks with `resolution`: the ids it closed. */
  const closeWhere = (where: SQL, resolution: ReportResolution) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return yield* tx
        .update(table)
        .set({
          status: resolution.status,
          resolvedAt: resolution.resolvedAt,
          resolvedBy: resolution.resolvedBy,
          resolutionNote: Option.getOrNull(resolution.resolutionNote),
        })
        .where(and(where, eq(table.status, "open")))
        .returning({ id: table.id });
    });

  return {
    mintId: Effect.flatMap(CurrentTransaction, mintUuid),
    insert: (row) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.insert(table).values({
          id: row.id,
          targetId: row.targetId,
          reporterId: row.reporterId,
          reason: row.reason,
          details: Option.getOrNull(row.details),
          status: row.status,
          filedAt: row.filedAt,
          resolvedAt: Option.getOrNull(row.resolvedAt),
          resolvedBy: Option.getOrNull(row.resolvedBy),
          resolutionNote: Option.getOrNull(row.resolutionNote),
        });
      }),
    get: (id) => byId(id, false),
    lock: (id) => byId(id, true),
    close: (id, resolution) =>
      isNodeId(id) ? Effect.asVoid(closeWhere(eq(table.id, id), resolution)) : Effect.void,
    closeOpen: (targetId, resolution) =>
      isNodeId(targetId)
        ? Effect.map(closeWhere(eq(table.targetId, targetId), resolution), Arr.length)
        : Effect.succeed(0),
    eraseReporter: ({ accountId, replacement, limit }) =>
      limit < 1
        ? Effect.succeed(0)
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            // The account's rows, at most `limit`: a report it filed goes, and
            // on every other one it resolved `resolved_by` is rewritten. The
            // two conditions are disjoint, so no row is both deleted and updated.
            const filed = sql`${table.reporterId} = ${accountId}`;
            const rows = yield* selectRows(
              tx,
              sql`WITH picked AS (
                SELECT ${table.id} AS id FROM ${table}
                WHERE ${filed} OR ${table.resolvedBy} = ${accountId}
                ORDER BY ${table.id}
                LIMIT ${Math.trunc(limit)}
                FOR UPDATE
              ), deleted AS (
                DELETE FROM ${table}
                WHERE ${table.id} IN (SELECT id FROM picked) AND ${filed}
                RETURNING 1
              ), updated AS (
                UPDATE ${table} SET resolved_by = ${replacement}
                WHERE ${table.id} IN (SELECT id FROM picked) AND NOT (${filed})
                RETURNING 1
              )
              SELECT ((SELECT count(*) FROM deleted) + (SELECT count(*) FROM updated))::int AS changed`,
              Schema.Struct({ changed: Schema.Int }),
            );
            return Option.getOrElse(
              Option.map(Arr.head(rows), (row) => row.changed),
              () => 0,
            );
          }),
    list: ({ where, limit, offset }) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rendered = renderListFilter(where, filterColumns);
        const rows = yield* tx
          .select({ ...fields, pageTotal: sql<number>`(count(*) over ())::int` })
          .from(table)
          .innerJoin(identity, eq(identity.id, table.targetId))
          .where(Option.getOrUndefined(rendered))
          .orderBy(desc(table.filedAt), desc(table.id))
          .limit(Math.max(0, Math.trunc(limit)))
          .offset(Math.max(0, Math.trunc(offset)));
        const reports = yield* toRows(Arr.map(rows, ({ pageTotal: _total, ...row }) => row));
        const total = yield* Option.match(Arr.head(rows), {
          onSome: (row) => Effect.succeed(row.pageTotal),
          onNone: () => (offset > 0 ? counted(rendered) : Effect.succeed(0)),
        });
        return { rows: reports, total };
      }),
  };
};
