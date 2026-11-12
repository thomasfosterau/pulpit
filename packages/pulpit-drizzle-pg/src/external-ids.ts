/**
 * @copyright Thomas Foster
 *
 * The kernel's `ExternalIdStore` (docs/seams.md → `ExternalIdStore`,
 * pulpit#209) on PostgreSQL (pulpit#359): the links `./reference-import`
 * keeps between an authority's identifiers (a Wikidata QID, a DOI, an ISBN)
 * and a tree's nodes, one table keyed `(authority, external_id)` with a
 * second unique key on `(authority, node_id)`, the node reference cascading.
 * Every call runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { MAX_SET_VALUES } from "@thomasfosterau/pulpit/filter";
import type { ExternalIdLink, ExternalIdStore } from "@thomasfosterau/pulpit/reference-import";
import { and, eq, inArray, sql, type AnyRelations } from "drizzle-orm";
import {
  jsonb,
  primaryKey,
  text,
  unique,
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
import type { StoreQueryError } from "./internal/owners.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * Build the external-identifier table (`name`, `external_id` by default):
 * `authority`, `external_id`, `node_id` (referencing the identity row,
 * cascading) and `baseline` (`jsonb`, nullable), primary key `(authority,
 * external_id)` and unique `(authority, node_id)`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makeExternalIdTable } from "@thomasfosterau/pulpit-drizzle-pg/external-ids";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   work: { leaf: { title: dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false }) } },
 * });
 * const schema = pgSchema("core");
 * const tables = makeTreeTables(tree, { schema, builders: { text: (c: string) => text(c) } });
 * const ids = makeExternalIdTable({ schema, identity: tables.root.identity });
 * strictEqual(getTableName(ids), "external_id");
 * ```
 *
 * @since 0.0.0
 */
export const makeExternalIdTable = (options: {
  readonly schema: PgSchema;
  readonly identity: VersionChainTables["root"]["identity"];
  readonly name?: string;
}) => {
  const name = options.name ?? "external_id";
  return options.schema.table(
    name,
    {
      authority: text("authority").notNull(),
      externalId: text("external_id").notNull(),
      nodeId: uuid("node_id")
        .notNull()
        .references((): AnyPgColumn => options.identity.id, { onDelete: "cascade" }),
      baseline: jsonb("baseline"),
    },
    (table) => [
      primaryKey({ name: `${name}_pkey`, columns: [table.authority, table.externalId] }),
      unique(`${name}_node`).on(table.authority, table.nodeId),
    ],
  );
};

/**
 * The external-identifier table: {@link makeExternalIdTable}'s.
 *
 * @since 0.0.0
 */
export type ExternalIdTable = ReturnType<typeof makeExternalIdTable>;

/** A baseline as it is stored: the declared fields' JSON values, by field. */
const Baseline = Schema.Record(Schema.String, Schema.Json);
const encodeBaseline = Schema.encodeUnknownEffect(Schema.fromJsonString(Baseline));
const StoredLink = Schema.Struct({
  authority: Schema.String,
  externalId: Schema.String,
  nodeId: Schema.String,
  baseline: Schema.NullOr(Baseline),
});
const decodeLink = Schema.decodeUnknownEffect(StoredLink);

/**
 * Bind the kernel's `ExternalIdStore` to the external-identifier table, in
 * the caller's `CurrentTransaction`.
 *
 * - `lookup(authority, ids)` is one `WHERE authority = $1 AND external_id IN
 *   (…)` read (none for no id, and at most `MAX_SET_VALUES` ids a call).
 * - `link(authority, id, node)` is `INSERT … ON CONFLICT DO NOTHING`:
 *   `"linked"` when written; otherwise `"present"` when the stored link for
 *   the id names this node, `"taken"` when either unique key belongs to
 *   another link.
 * - `recordBaseline` replaces the link's baseline (bound as its JSON text).
 *   A baseline is the declared fields' JSON values; one holding a `Date` or a
 *   `bigint` is a defect.
 *
 * @since 0.0.0
 */
export const makeExternalIdStore = <I, Relations extends AnyRelations>(config: {
  readonly table: ExternalIdTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): ExternalIdStore<StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  const fields = {
    authority: table.authority,
    externalId: table.externalId,
    nodeId: sql<string>`${table.nodeId}::text`.as("node_id"),
    baseline: table.baseline,
  };
  return {
    lookup: (authority, externalIds) => {
      const named = Arr.dedupe(externalIds);
      if (!Arr.isReadonlyArrayNonEmpty(named) || named.length > MAX_SET_VALUES) {
        return Effect.succeed(HashMap.empty<string, ExternalIdLink>());
      }
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select(fields)
          .from(table)
          .where(and(eq(table.authority, authority), inArray(table.externalId, [...named])));
        const links = yield* Effect.forEach(
          rows,
          (row) =>
            Effect.map(Effect.orDie(decodeLink(row)), (link): readonly [string, ExternalIdLink] => [
              link.externalId,
              {
                authority: link.authority,
                externalId: link.externalId,
                nodeId: link.nodeId,
                baseline: Option.fromNullishOr(link.baseline),
              },
            ]),
          { concurrency: 1 },
        );
        return HashMap.fromIterable(links);
      });
    },
    link: (authority, externalId, nodeId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const inserted = yield* tx
          .insert(table)
          .values({ authority, externalId, nodeId })
          .onConflictDoNothing()
          .returning({ authority: table.authority });
        if (Arr.isReadonlyArrayNonEmpty(inserted)) return "linked" as const;
        const stored = yield* tx
          .select({ nodeId: sql<string>`${table.nodeId}::text`.as("node_id") })
          .from(table)
          .where(and(eq(table.authority, authority), eq(table.externalId, externalId)))
          .limit(1);
        return Option.exists(Arr.head(stored), (row) => row.nodeId === nodeId)
          ? ("present" as const)
          : ("taken" as const);
      }),
    recordBaseline: (authority, externalId, baseline) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const encoded = yield* Effect.orDie(encodeBaseline(baseline));
        yield* tx
          .update(table)
          .set({ baseline: sql`(${encoded})::jsonb` })
          .where(and(eq(table.authority, authority), eq(table.externalId, externalId)));
      }),
  };
};
