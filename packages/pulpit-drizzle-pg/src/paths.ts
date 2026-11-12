/**
 * @copyright Thomas Foster
 *
 * The kernel's `PathStore` (README → Seams → `PathStore`, pulpit#57) on
 * PostgreSQL (pulpit#247): a path table per routable namespace, `(path
 * PRIMARY KEY, node_id, canonical)`, with at most one canonical row per
 * node held by a partial unique index on `node_id WHERE canonical`. It runs
 * in the caller's `CurrentTransaction` and applies no policy; `routable`
 * (`./paths` in the kernel) keeps a node's claim in step with its writes
 * and gates resolution.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { PathTaken, type PathStore } from "@thomasfosterau/pulpit/paths";
import { and, eq, ne, sql, type AnyRelations } from "drizzle-orm";
import {
  boolean,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isNodeId } from "./internal/node-id.ts";
import type { StoreQueryError } from "./leaf-store.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build one routable namespace's path table (`name`): `path` its primary
 * key, `node_id` a foreign key to the identity row (cascading, so `purge`
 * takes the node's paths too), `canonical` whether the row is the node's
 * canonical path or an alias, and a partial unique index holding at most
 * one canonical row per node.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makePathTable } from "@thomasfosterau/pulpit-drizzle-pg/paths";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const schema = pgSchema("core");
 * const slug = dbColumn(Schema.NullOr(Schema.String), { column: "slug", pg: "text", notNull: false });
 * const tree = defineTree({ page: { leaf: { slug } } });
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const paths = makePathTable({ schema, name: "page_paths", identity: tables.root.identity });
 * strictEqual(getTableName(paths), "page_paths");
 * ```
 *
 * @since 0.0.0
 */
export const makePathTable = (options: {
  readonly schema: PgSchema;
  readonly name: string;
  readonly identity: VersionChainTables["root"]["identity"];
}) =>
  options.schema.table(
    options.name,
    {
      path: text("path").primaryKey(),
      nodeId: uuid("node_id")
        .notNull()
        .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
      canonical: boolean("canonical").notNull(),
    },
    (table) => [
      uniqueIndex(`${options.name}_one_canonical`)
        .on(table.nodeId)
        .where(sql`${table.canonical}`),
    ],
  );

/**
 * One routable namespace's path table: {@link makePathTable}'s.
 *
 * @since 0.0.0
 */
export type PathTable = ReturnType<typeof makePathTable>;

/**
 * Bind the kernel's `PathStore` to one path table, in the caller's
 * `CurrentTransaction`.
 *
 * - `lookup(path)` is the row by key; `canonicalOf(id)` the node's canonical
 *   row.
 * - `claim(id, path)` first checks the row at `path` under `FOR UPDATE`, and
 *   fails `PathTaken` when another node holds it canonically, before
 *   writing anything. It then turns the node's previous canonical row into
 *   an alias and upserts `path` as its canonical row, replacing an alias at
 *   `path`, whoever's. The upsert is guarded too (`ON CONFLICT … DO UPDATE …
 *   WHERE NOT canonical OR node_id = $id`), so a concurrent claim that took
 *   the path after the check fails `PathTaken` here instead of overwriting
 *   it; the caller's transaction then rolls back the alias it made, as
 *   `routable` rolls back the append.
 * - `release(id)` deletes the node's canonical row and keeps its aliases.
 *
 * An id that is no canonical UUID holds no path.
 *
 * @since 0.0.0
 */
export const makePathStore = <I, Relations extends AnyRelations>(config: {
  readonly table: PathTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): PathStore<StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  return {
    lookup: (path) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ nodeId: table.nodeId, canonical: table.canonical })
          .from(table)
          .where(eq(table.path, path))
          .limit(1);
        return Arr.head(rows);
      }),
    canonicalOf: (nodeId) =>
      isNodeId(nodeId)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ path: table.path })
              .from(table)
              .where(and(eq(table.nodeId, nodeId), eq(table.canonical, true)))
              .limit(1);
            return Option.map(Arr.head(rows), (row) => row.path);
          })
        : Effect.succeedNone,
    claim: (nodeId, path) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        // The uniqueness pre-check, before any write: another node's
        // canonical row at `path` refuses the claim.
        const held = yield* tx
          .select({ nodeId: table.nodeId, canonical: table.canonical })
          .from(table)
          .where(eq(table.path, path))
          .for("update");
        yield* Arr.some(held, (row) => row.canonical && row.nodeId !== nodeId)
          ? Effect.fail(new PathTaken({ path }))
          : Effect.void;
        // The node's previous canonical path becomes its alias.
        yield* tx
          .update(table)
          .set({ canonical: false })
          .where(and(eq(table.nodeId, nodeId), eq(table.canonical, true), ne(table.path, path)));
        // `path` becomes the node's canonical row, over an alias at it but
        // never over another node's canonical row (a claim that raced the
        // check).
        const claimed = yield* tx
          .insert(table)
          .values({ path, nodeId, canonical: true })
          .onConflictDoUpdate({
            target: table.path,
            set: { nodeId, canonical: true },
            setWhere: sql`(NOT ${table.canonical} OR ${table.nodeId} = ${nodeId})`,
          })
          .returning({ path: table.path });
        yield* Arr.isReadonlyArrayNonEmpty(claimed)
          ? Effect.void
          : Effect.fail(new PathTaken({ path }));
      }),
    release: (nodeId) =>
      isNodeId(nodeId)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.delete(table).where(and(eq(table.nodeId, nodeId), eq(table.canonical, true)));
          })
        : Effect.void,
  };
};
