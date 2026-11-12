/**
 * @copyright Thomas Foster
 *
 * The owner table the kernel's owned leaves stamp (`core.node_owner` in the
 * applications), pulpit's vocabulary, which `../leaf-store.ts` publishes and
 * every leaf-shaped seam joins in as `ownerId`.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { AnyRelations } from "drizzle-orm";
import { index, text, uuid, type AnyPgColumn, type PgSchema } from "drizzle-orm/pg-core";
import type * as Effect from "effect/Effect";
import type { VersionChainTables } from "../version-chain.ts";

/**
 * The key the owner joins in under.
 *
 * @since 0.0.0
 */
export const OWNER_COLUMN = "ownerId";

/**
 * The owner table: `node_id` → the identity row (cascading), `owner_id`.
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
 * {@link makeNodeOwnerTable}'s table.
 *
 * @since 0.0.0
 */
export type NodeOwnerTable = ReturnType<typeof makeNodeOwnerTable>;

/**
 * The driver's query error, as the application's `CurrentTransaction` raises it.
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
