/**
 * @copyright Thomas Foster
 *
 * The kernel's `ProposalStore` (docs/seams.md → `ProposalStore`, pulpit#55)
 * on PostgreSQL (pulpit#355): one proposal table of suggested edits against
 * a tree's nodes. Reads join the identity table for the target's leaf type
 * and the owner table for its owner, and read the target's head version as
 * a correlated scalar subquery on the root version table (one indexed
 * lookup per row). `lock` takes the row alone `FOR UPDATE`, so two
 * decisions on one proposal serialise, and every write runs in the
 * caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import {
  ProposalStatus,
  type ProposalListing,
  type ProposalRow,
  type ProposalStore,
} from "@thomasfosterau/pulpit/proposals";
import { and, desc, eq, sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
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
import { isNodeId } from "./internal/node-id.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * The tree's root tables a proposal table references: the identity table
 * (its `id` and the leaf `type`) and the root version table (its `id` and
 * `version`), as `makeTreeTables` builds them (`tables.root`).
 *
 * @since 0.0.0
 */
export type ProposalRoot = VersionChainTables["root"] & {
  readonly version: VersionChainTables["root"]["version"] & {
    readonly id: AnyPgColumn;
    readonly version: AnyPgColumn;
  };
};

/**
 * Build the proposal table (`name`, `proposal` by default) over a tree's
 * root tables: `target_node_id` references the identity row and
 * `(target_node_id, applied_version)` the root version an accepted proposal
 * produced, both cascading, so purging a node takes its proposals with it.
 * `state` is CHECKed to the kernel's four statuses, `submitted_at` defaults
 * to `now()`, and `author_id`, `target_node_id` and the pending rows are
 * indexed.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeProposalTable } from "@thomasfosterau/pulpit-drizzle-pg/proposals";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   post: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("core");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const proposals = makeProposalTable({ schema, root: tables.root });
 * strictEqual(getTableName(proposals), "proposal");
 * ```
 *
 * @since 0.0.0
 */
export const makeProposalTable = (options: {
  readonly schema: PgSchema;
  readonly root: ProposalRoot;
  readonly name?: string;
}) => {
  const name = options.name ?? "proposal";
  return options.schema.table(
    name,
    {
      id: uuid("id").primaryKey(),
      targetId: uuid("target_node_id")
        .notNull()
        .references((): AnyPgColumn => options.root.identity.id, { onDelete: "cascade" }),
      authorId: text("author_id").notNull(),
      patch: jsonb("patch").notNull(),
      locales: jsonb("locales"),
      rationale: text("rationale"),
      baseVersion: bigint("base_version", { mode: "bigint" }).notNull(),
      status: text("state").notNull(),
      submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
      decidedBy: text("decided_by"),
      decisionNote: text("decision_note"),
      appliedVersion: bigint("applied_version", { mode: "bigint" }),
    },
    (table) => [
      check(
        `${name}_state`,
        sql`${table.status} IN ('pending', 'accepted', 'rejected', 'withdrawn')`,
      ),
      foreignKey({
        name: `${name}_applied_version_fk`,
        columns: [table.targetId, table.appliedVersion],
        foreignColumns: [options.root.version.id, options.root.version.version],
      }).onDelete("cascade"),
      index(`${name}_author`).on(table.authorId),
      index(`${name}_target`).on(table.targetId),
      index(`${name}_pending`)
        .on(table.targetId)
        .where(sql`${table.status} = 'pending'`),
    ],
  );
};

/**
 * The proposal table: {@link makeProposalTable}'s.
 *
 * @since 0.0.0
 */
export type ProposalTable = ReturnType<typeof makeProposalTable>;

/**
 * A JSON value's text, bound as a `jsonb` parameter: through the text, not
 * Drizzle's `jsonb` encoder, which writes a JSON `null` as SQL `NULL`.
 */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const asJsonb = (value: Schema.Json) =>
  Effect.map(Effect.orDie(jsonText(value)), (encoded): SQL => sql`(${encoded})::jsonb`);

/** A stored row as a read selects it: the database's `NULL`s, before they become options. */
const StoredRow = Schema.Struct({
  id: Schema.String,
  targetId: Schema.String,
  targetType: Schema.String,
  authorId: Schema.String,
  patch: Schema.Json,
  locales: Schema.NullOr(Schema.Json),
  rationale: Schema.NullOr(Schema.String),
  baseVersion: Schema.BigInt,
  status: ProposalStatus,
  submittedAt: Schema.Date,
  decidedAt: Schema.NullOr(Schema.Date),
  decidedBy: Schema.NullOr(Schema.String),
  decisionNote: Schema.NullOr(Schema.String),
  appliedVersion: Schema.NullOr(Schema.BigInt),
});
const decodeStored = Schema.decodeUnknownEffect(StoredRow);
const decodeHead = Schema.decodeUnknownEffect(Schema.NullOr(Schema.BigIntFromString));

/** A stored row as the kernel's `ProposalRow`; a row outside the contract is a defect. */
const toRow = (row: typeof StoredRow.Type): ProposalRow => ({
  id: row.id,
  targetId: row.targetId,
  targetType: row.targetType,
  authorId: row.authorId,
  patch: row.patch,
  locales: Option.fromNullishOr(row.locales),
  rationale: Option.fromNullishOr(row.rationale),
  baseVersion: row.baseVersion,
  status: row.status,
  submittedAt: row.submittedAt,
  decidedAt: Option.fromNullishOr(row.decidedAt),
  decidedBy: Option.fromNullishOr(row.decidedBy),
  decisionNote: Option.fromNullishOr(row.decisionNote),
  appliedVersion: Option.fromNullishOr(row.appliedVersion),
});

/**
 * Bind the kernel's `ProposalStore` to the proposal table, in the caller's
 * `CurrentTransaction`. `root` is the tree's root tables (`tables.root`),
 * `owners` the owner table the leaf stores stamp.
 *
 * - `mintId` is `gen_random_uuid()`; `insert` writes the row as given.
 * - `get(id)` is the row joined to the identity table for its
 *   `targetType`, with the target's head version as
 *   `(SELECT MAX(version) … WHERE id = target_node_id)`.
 * - `lock(id)` is the row `FOR UPDATE OF` the proposal alone.
 * - `close(id, decision)` updates the row only while it is `pending`.
 * - `list` renders `where` over `authorId`, `targetId`, `targetType`,
 *   `status` and `targetOwnerId` (the owner table, LEFT JOINed: `NULL` for
 *   none), newest first (`submitted_at DESC, id DESC`), with the unpaged
 *   total off `count(*) OVER ()`.
 * - `eraseAuthor` touches at most `limit` of the rows the account wrote or
 *   decided (`ORDER BY id`), in one statement: it deletes its non-`accepted`
 *   ones and rewrites `author_id` / `decided_by` to `replacement` on the
 *   rest, and answers how many rows changed.
 *
 * An id that is no canonical UUID names no proposal.
 *
 * @since 0.0.0
 */
export const makeProposalStore = <I, Relations extends AnyRelations>(config: {
  readonly table: ProposalTable;
  readonly root: ProposalRoot;
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): ProposalStore<StoreQueryError<Relations>, I> => {
  const { table, root, owners, CurrentTransaction } = config;
  const identity = root.identity;

  const fields = {
    id: sql<string>`${table.id}::text`.as("id"),
    targetId: sql<string>`${table.targetId}::text`.as("target_id"),
    targetType: identity.type,
    authorId: table.authorId,
    patch: table.patch,
    locales: table.locales,
    rationale: table.rationale,
    baseVersion: table.baseVersion,
    status: table.status,
    submittedAt: table.submittedAt,
    decidedAt: table.decidedAt,
    decidedBy: table.decidedBy,
    decisionNote: table.decisionNote,
    appliedVersion: table.appliedVersion,
  };
  /** The target's head version, as text: one indexed lookup per row. */
  const headVersion =
    sql`(SELECT MAX(${root.version.version}) FROM ${root.version} WHERE ${root.version.id} = ${table.targetId})::text`.as(
      "target_version",
    );
  /** The columns `list`'s filter reads. */
  const filterColumns: FilterColumns = {
    authorId: table.authorId,
    targetId: table.targetId,
    targetType: identity.type,
    status: table.status,
    targetOwnerId: owners.ownerId,
  };

  const listingOf = ({ targetVersion, ...stored }: { readonly targetVersion: unknown }) =>
    Effect.zipWith(
      Effect.orDie(decodeStored(stored)),
      Effect.orDie(decodeHead(targetVersion)),
      (row, head): ProposalListing => ({
        row: toRow(row),
        targetVersion: Option.fromNullishOr(head),
      }),
    );

  return {
    mintId: Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* executeRows<{ readonly id: string }>(
        tx,
        sql`SELECT gen_random_uuid()::text AS id`,
      );
      return yield* Effect.orDie(Effect.fromOption(Option.map(Arr.head(rows), (row) => row.id)));
    }),
    insert: (row) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const patch = yield* asJsonb(row.patch);
        const locales = yield* Effect.transposeOption(Option.map(row.locales, asJsonb));
        yield* tx.insert(table).values({
          id: row.id,
          targetId: row.targetId,
          authorId: row.authorId,
          patch,
          locales: Option.getOrNull(locales),
          rationale: Option.getOrNull(row.rationale),
          baseVersion: row.baseVersion,
          status: row.status,
          submittedAt: row.submittedAt,
          decidedAt: Option.getOrNull(row.decidedAt),
          decidedBy: Option.getOrNull(row.decidedBy),
          decisionNote: Option.getOrNull(row.decisionNote),
          appliedVersion: Option.getOrNull(row.appliedVersion),
        });
      }),
    get: (id) =>
      isNodeId(id)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ ...fields, targetVersion: headVersion })
              .from(table)
              .innerJoin(identity, eq(identity.id, table.targetId))
              .where(eq(table.id, id))
              .limit(1);
            return yield* Effect.transposeOption(Option.map(Arr.head(rows), listingOf));
          })
        : Effect.succeedNone,
    lock: (id) =>
      isNodeId(id)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select(fields)
              .from(table)
              .innerJoin(identity, eq(identity.id, table.targetId))
              .where(eq(table.id, id))
              .limit(1)
              .for("update", { of: table });
            return yield* Effect.transposeOption(
              Option.map(Arr.head(rows), (row) =>
                Effect.map(Effect.orDie(decodeStored(row)), toRow),
              ),
            );
          })
        : Effect.succeedNone,
    close: (id, decision) =>
      isNodeId(id)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx
              .update(table)
              .set({
                status: decision.status,
                decidedAt: decision.decidedAt,
                decidedBy: decision.decidedBy,
                decisionNote: Option.getOrNull(decision.decisionNote),
                appliedVersion: Option.getOrNull(decision.appliedVersion),
              })
              .where(and(eq(table.id, id), eq(table.status, "pending")));
          })
        : Effect.void,
    eraseAuthor: ({ accountId, replacement, limit }) =>
      limit < 1
        ? Effect.succeed(0)
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            // The account's rows, at most `limit`; a row it wrote that is not
            // accepted goes, every other one is rewritten. The two conditions
            // are disjoint, so no row is both deleted and updated.
            const doomed = sql`${table.authorId} = ${accountId} AND ${table.status} <> 'accepted'`;
            const rows = yield* executeRows<{ readonly changed: number }>(
              tx,
              sql`WITH picked AS (
                SELECT ${table.id} AS id FROM ${table}
                WHERE ${table.authorId} = ${accountId} OR ${table.decidedBy} = ${accountId}
                ORDER BY ${table.id}
                LIMIT ${Math.trunc(limit)}
                FOR UPDATE
              ), deleted AS (
                DELETE FROM ${table}
                WHERE ${table.id} IN (SELECT id FROM picked) AND ${doomed}
                RETURNING 1
              ), updated AS (
                UPDATE ${table} SET
                  author_id = CASE WHEN ${table.authorId} = ${accountId} THEN ${replacement} ELSE ${table.authorId} END,
                  decided_by = CASE WHEN ${table.decidedBy} = ${accountId} THEN ${replacement} ELSE ${table.decidedBy} END
                WHERE ${table.id} IN (SELECT id FROM picked) AND NOT (${doomed})
                RETURNING 1
              )
              SELECT ((SELECT count(*) FROM deleted) + (SELECT count(*) FROM updated))::int AS changed`,
            );
            return Option.getOrElse(
              Option.map(Arr.head(rows), (row) => row.changed),
              () => 0,
            );
          }),
    list: ({ where, limit, offset }) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({
            ...fields,
            targetVersion: headVersion,
            pageTotal: sql<number>`(count(*) over ())::int`,
          })
          .from(table)
          .innerJoin(identity, eq(identity.id, table.targetId))
          .leftJoin(owners, eq(owners.nodeId, table.targetId))
          .where(Option.getOrUndefined(renderListFilter(where, filterColumns)))
          .orderBy(desc(table.submittedAt), desc(table.id))
          .limit(Math.max(0, limit))
          .offset(Math.max(0, offset));
        const listings = yield* Effect.forEach(
          rows,
          ({ pageTotal: _total, ...row }) => listingOf(row),
          { concurrency: 1 },
        );
        return {
          rows: listings,
          total: Option.getOrElse(
            Option.map(Arr.head(rows), (row) => row.pageTotal),
            () => 0,
          ),
        };
      }),
  };
};
