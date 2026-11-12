/**
 * @copyright Thomas Foster
 *
 * The kernel's `ReactionStore` (docs/seams.md → `ReactionStore`,
 * pulpit#196) on PostgreSQL (pulpit#363): one account's reaction to one
 * node per row, keyed `(node_id, account_id)`, the node reference
 * cascading. Every call runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { ReactionRow, ReactionStore } from "@thomasfosterau/pulpit/reactions";
import { and, asc, desc, eq, inArray, sql, type AnyRelations } from "drizzle-orm";
import {
  index,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isNodeId } from "./internal/node-id.ts";
import type { StoreQueryError } from "./internal/owners.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build the reaction table (`name`, `reaction` by default): `node_id`
 * (referencing the identity row, cascading), `account_id` (`text`;
 * referencing `accounts`, cascading, when given: the application's account
 * key, a `text` column), `kind` and `reacted_at` (`DEFAULT now()`), primary
 * key `(node_id, account_id)`, indexed on `(account_id, reacted_at DESC)`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeReactionTable } from "@thomasfosterau/pulpit-drizzle-pg/reactions";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   post: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("social");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const reactions = makeReactionTable({ schema, identity: tables.root.identity });
 * strictEqual(getTableName(reactions), "reaction");
 * ```
 *
 * @since 0.0.0
 */
export const makeReactionTable = (options: {
  readonly schema: PgSchema;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly accounts?: AnyPgColumn;
  readonly name?: string;
}) => {
  const name = options.name ?? "reaction";
  const { accounts } = options;
  const account = text("account_id").notNull();
  return options.schema.table(
    name,
    {
      nodeId: uuid("node_id")
        .notNull()
        .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
      accountId:
        accounts === undefined
          ? account
          : account.references((): AnyPgColumn => accounts, { onDelete: "cascade" }),
      kind: text("kind").notNull(),
      reactedAt: timestamp("reacted_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({ name: `${name}_pkey`, columns: [table.nodeId, table.accountId] }),
      index(`${name}_account`).on(table.accountId, table.reactedAt.desc()),
    ],
  );
};

/**
 * The reaction table: {@link makeReactionTable}'s.
 *
 * @since 0.0.0
 */
export type ReactionTable = ReturnType<typeof makeReactionTable>;

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      nodeId: Schema.String,
      accountId: Schema.String,
      kind: Schema.String,
      reactedAt: Schema.Date,
    }),
  ),
);
const decodeCounts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ nodeId: Schema.String, kind: Schema.String, count: Schema.Int })),
);
const decodeKinds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ kind: Schema.String })),
);
const decodeErased = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ erased: Schema.Int })),
);

/**
 * Bind the kernel's `ReactionStore` to the reaction table, in the caller's
 * `CurrentTransaction`.
 *
 * - `upsert(row)` is one statement: a CTE reads the replaced kind `FOR
 *   UPDATE`, beside `INSERT … ON CONFLICT (node_id, account_id) DO UPDATE
 *   SET kind = EXCLUDED.kind, reacted_at = EXCLUDED.reacted_at`.
 * - `delete` is `DELETE … RETURNING`; `tally(nodeIds)` one `GROUP BY
 *   node_id, kind` read; `byAccount` one page `ORDER BY reacted_at DESC,
 *   node_id`.
 * - `eraseAccount(accountId, limit)` deletes at most `limit` of the
 *   account's rows (`ORDER BY node_id`) and counts them (`PERF-DB-001`).
 *
 * A node id that is no canonical UUID names no node: `upsert` writes
 * nothing and answers none, `delete` answers `false`, and `tally` leaves it
 * out. A limit below one reads and deletes nothing.
 *
 * @since 0.0.0
 */
export const makeReactionStore = <I, Relations extends AnyRelations>(config: {
  readonly table: ReactionTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): ReactionStore<StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  const nodeText = sql<string>`${table.nodeId}::text`.as("node_id");
  return {
    upsert: (row) =>
      !isNodeId(row.nodeId)
        ? Effect.succeedNone
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const replaced = yield* executeRows<{ readonly kind: string }>(
              tx,
              sql`WITH replaced AS (
                SELECT ${table.kind} AS kind FROM ${table}
                WHERE ${table.nodeId} = ${row.nodeId}::uuid AND ${table.accountId} = ${row.accountId}
                FOR UPDATE
              ),
              written AS (
                INSERT INTO ${table} (node_id, account_id, kind, reacted_at)
                VALUES (${row.nodeId}::uuid, ${row.accountId}, ${row.kind}, ${row.reactedAt.toISOString()}::timestamptz)
                ON CONFLICT (node_id, account_id)
                DO UPDATE SET kind = EXCLUDED.kind, reacted_at = EXCLUDED.reacted_at
              )
              SELECT kind FROM replaced`,
            );
            const kinds = yield* Effect.orDie(decodeKinds(replaced));
            return Option.map(Arr.head(kinds), ({ kind }) => kind);
          }),
    delete: (nodeId, accountId) =>
      !isNodeId(nodeId)
        ? Effect.succeed(false)
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const gone = yield* tx
              .delete(table)
              .where(and(eq(table.nodeId, nodeId), eq(table.accountId, accountId)))
              .returning({ kind: table.kind });
            return Arr.isReadonlyArrayNonEmpty(gone);
          }),
    tally: (nodeIds) => {
      const named = Arr.dedupe(Arr.filter(nodeIds, isNodeId));
      if (!Arr.isReadonlyArrayNonEmpty(named)) {
        return Effect.succeed(HashMap.empty<string, { readonly [kind: string]: number }>());
      }
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ nodeId: nodeText, kind: table.kind, count: sql<number>`count(*)::int` })
          .from(table)
          .where(inArray(table.nodeId, [...named]))
          .groupBy(table.nodeId, table.kind);
        const counts = yield* Effect.orDie(decodeCounts(rows));
        return Arr.reduce(
          counts,
          HashMap.empty<string, { readonly [kind: string]: number }>(),
          (acc, { nodeId, kind, count }) =>
            HashMap.set(acc, nodeId, {
              ...Option.getOrElse(HashMap.get(acc, nodeId), () => ({})),
              [kind]: count,
            }),
        );
      });
    },
    byAccount: ({ accountId, limit, offset }) =>
      limit < 1
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({
                nodeId: nodeText,
                accountId: table.accountId,
                kind: table.kind,
                reactedAt: table.reactedAt,
              })
              .from(table)
              .where(eq(table.accountId, accountId))
              .orderBy(desc(table.reactedAt), asc(table.nodeId))
              .limit(Math.trunc(limit))
              .offset(Math.max(0, Math.trunc(offset)));
            const decoded: ReadonlyArray<ReactionRow> = yield* Effect.orDie(decodeRows(rows));
            return decoded;
          }),
    eraseAccount: (accountId, limit) =>
      limit < 1
        ? Effect.succeed(0)
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* executeRows<{ readonly erased: number }>(
              tx,
              sql`WITH gone AS (
                DELETE FROM ${table}
                WHERE (node_id, account_id) IN (
                  SELECT node_id, account_id FROM ${table}
                  WHERE ${table.accountId} = ${accountId}
                  ORDER BY node_id
                  LIMIT ${Math.trunc(limit)}
                )
                RETURNING 1
              )
              SELECT count(*)::int AS erased FROM gone`,
            );
            const counted = yield* Effect.orDie(decodeErased(rows));
            return Option.match(Arr.head(counted), {
              onNone: () => 0,
              onSome: ({ erased }) => erased,
            });
          }),
  };
};
