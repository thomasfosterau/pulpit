/**
 * @copyright Thomas Foster
 *
 * The kernel's `CollectionStore` (docs/seams.md → `CollectionStore`,
 * pulpit#193) on PostgreSQL (pulpit#358): one membership table per ordered
 * family (a list's items, a bibliography's entries, a menu's pages), keyed
 * `(parent_id, member_id)`, both referencing the tree's identity row and
 * cascading, with each member's `position`. Every call runs in the caller's
 * `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { CollectionEntry, CollectionStore } from "@thomasfosterau/pulpit/collections";
import { asc, eq, sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  uuid,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isNodeId } from "./internal/node-id.ts";
import type { StoreQueryError } from "./internal/owners.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build one ordered family's membership table, `name`: `parent_id` and
 * `member_id` (both referencing the identity row, cascading) and
 * `position` (`integer`), primary key `(parent_id, member_id)`, indexed on
 * `(parent_id, position)`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeCollectionTable } from "@thomasfosterau/pulpit-drizzle-pg/collections";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   item: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("core");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const items = makeCollectionTable({ schema, name: "list_item", identity: tables.root.identity });
 * strictEqual(getTableName(items), "list_item");
 * ```
 *
 * @since 0.0.0
 */
export const makeCollectionTable = (options: {
  readonly schema: PgSchema;
  readonly name: string;
  readonly identity: VersionChainTables["root"]["identity"];
}) => {
  const { name } = options;
  const node = (column: string) =>
    uuid(column)
      .notNull()
      .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" });
  return options.schema.table(
    name,
    {
      parentId: node("parent_id"),
      memberId: node("member_id"),
      position: integer("position").notNull(),
    },
    (table) => [
      primaryKey({ name: `${name}_pkey`, columns: [table.parentId, table.memberId] }),
      index(`${name}_position`).on(table.parentId, table.position),
    ],
  );
};

/**
 * One ordered family's membership table: {@link makeCollectionTable}'s.
 *
 * @since 0.0.0
 */
export type CollectionTable = ReturnType<typeof makeCollectionTable>;

const decodeEntries = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ memberId: Schema.String, position: Schema.Int })),
);

/**
 * Bind the kernel's `CollectionStore` to one family's membership table, in
 * the caller's `CurrentTransaction`.
 *
 * - `entries(parentId, limit)` is `ORDER BY position, member_id LIMIT
 *   $limit` (none for a limit below one).
 * - `replace(parentId, entries)` rewrites the parent's order in one
 *   statement: a CTE deletes the parent's rows whose member is not in
 *   `entries`, and the `INSERT` upserts the rest (`ON CONFLICT (parent_id,
 *   member_id) DO UPDATE SET position = EXCLUDED.position`). A `DELETE` of
 *   every row beside an `INSERT` of the same keys cannot share a statement:
 *   its sub-statements see one snapshot, so the insert would meet the rows
 *   the delete removes. A member named twice keeps its first entry; no
 *   entries is the `DELETE` alone.
 *
 * An id that is no canonical UUID names no node: a parent reads no entries
 * and takes no write, and a member is left out.
 *
 * @since 0.0.0
 */
export const makeCollectionStore = <I, Relations extends AnyRelations>(config: {
  readonly table: CollectionTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): CollectionStore<StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  const parentRows = (parentId: string): SQL => sql`${table.parentId} = ${parentId}::uuid`;
  return {
    entries: (parentId, limit) =>
      !isNodeId(parentId) || limit < 1
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({
                memberId: sql<string>`${table.memberId}::text`.as("member_id"),
                position: table.position,
              })
              .from(table)
              .where(eq(table.parentId, parentId))
              .orderBy(asc(table.position), asc(table.memberId))
              .limit(Math.trunc(limit));
            return yield* Effect.orDie(decodeEntries(rows));
          }),
    replace: (parentId, entries) => {
      if (!isNodeId(parentId)) return Effect.void;
      const kept = Arr.dedupeWith(
        Arr.filter(entries, (entry) => isNodeId(entry.memberId)),
        (left: CollectionEntry, right: CollectionEntry) => left.memberId === right.memberId,
      );
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        if (!Arr.isReadonlyArrayNonEmpty(kept)) {
          yield* tx.execute(sql`DELETE FROM ${table} WHERE ${parentRows(parentId)}`);
          return;
        }
        const incoming = sql.join(
          Arr.map(kept, ({ memberId, position }) => sql`(${memberId}::uuid, ${position}::integer)`),
          sql`, `,
        );
        yield* tx.execute(
          sql`WITH incoming (member_id, position) AS (VALUES ${incoming}),
          gone AS (
            DELETE FROM ${table}
            WHERE ${parentRows(parentId)}
              AND ${table.memberId} NOT IN (SELECT member_id FROM incoming)
          )
          INSERT INTO ${table} (parent_id, member_id, position)
          SELECT ${parentId}::uuid, member_id, position FROM incoming
          ON CONFLICT (parent_id, member_id) DO UPDATE SET position = EXCLUDED.position`,
        );
      });
    },
  };
};
