/**
 * @copyright Thomas Foster
 *
 * The kernel's erasure seams on PostgreSQL (pulpit#361): the `PurgeStore`
 * `./purge`'s `definePurge` runs (docs/seams.md → `PurgeStore`), over the
 * version tables whose columns carry document and content hashes, the
 * document tables and the rows the other seams keep for a node; and the
 * `AccountErasureStore` `./erasure`'s `defineAccountErasure` runs
 * (docs/seams.md → `AccountErasureStore`), over the owner table and the
 * tree's root version table, which it only reads. Erasure is the only path
 * that deletes a version row, a document or bytes (`VERSION-CHAIN-001/002`,
 * `DOC-001`): the version rows themselves go through the leaf's
 * `VersionChain.purge`, and nothing else may call this module's deletes.
 * Every call runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { ContentHash } from "@thomasfosterau/pulpit/blobs";
import { DocumentHash } from "@thomasfosterau/pulpit/documents";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import type { AccountErasureStore } from "@thomasfosterau/pulpit/erasure";
import type { ErasedReferences, PurgeStore } from "@thomasfosterau/pulpit/purge";
import { and, asc, eq, getTableColumns, sql, type AnyRelations, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type { DocumentTable } from "./documents.ts";
import { isNodeId } from "./internal/node-id.ts";
import type { NodeOwnerTable, StoreQueryError } from "./internal/owners.ts";
import type { VersionChainTables } from "./version-chain.ts";

/**
 * One `text` column of a version table that may carry a hash (a
 * `DocumentHash` or a `ContentHash`, as hex), with its table and the
 * table's node-id column.
 *
 * @since 0.0.0
 */
export interface HashColumn {
  readonly table: PgTable;
  readonly id: AnyPgColumn;
  readonly column: AnyPgColumn;
}

/**
 * The documents a purge may delete: the document tables, and every version
 * column that may reference one. Both are non-empty, so a store can never
 * hold a document table without a column whose references keep its
 * documents (the guard would be empty, and a referenced document deleted).
 *
 * @since 0.0.0
 */
export interface DocumentReferences {
  readonly tables: Arr.NonEmptyReadonlyArray<DocumentTable>;
  readonly references: Arr.NonEmptyReadonlyArray<HashColumn>;
}

/**
 * One table of rows another seam keeps for a node, by its node-id column:
 * what `eraseNode` deletes beside what the identity row's cascade takes.
 *
 * @since 0.0.0
 */
export interface NodeDependent {
  readonly table: PgTable;
  readonly id: AnyPgColumn;
}

const decodeHashes = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ hash: Schema.String })),
);

/** The `(VALUES …)` relation of `values`, one `text` column named `hash`. */
const valuesOf = (values: Arr.NonEmptyReadonlyArray<string>): SQL =>
  sql`(VALUES ${sql.join(
    Arr.map(values, (value) => sql`(${value}::text)`),
    sql`, `,
  )}) AS candidate(hash)`;

/** `NOT EXISTS` a row of any of `references` holding `hash`: never empty, so it never reads as `TRUE`. */
const unreferenced = (references: Arr.NonEmptyReadonlyArray<HashColumn>, hash: SQL): SQL =>
  sql.join(
    Arr.map(
      references,
      ({ table, column }) => sql`NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ${hash})`,
    ),
    sql` AND `,
  );

/** Refuse, at module load, a list the types require to be non-empty but a cast emptied. */
const nonEmpty = <A>(list: ReadonlyArray<A>, what: string): Arr.NonEmptyReadonlyArray<A> => {
  if (Arr.isReadonlyArrayNonEmpty(list)) return list;
  throw new DerivationError({
    message: `makePurgeStore: ${what} is empty. A purge must never delete what it cannot prove unreferenced; declare at least one, or omit the option.`,
  });
};

/**
 * Bind the kernel's `PurgeStore`, in the caller's `CurrentTransaction`:
 *
 * - `documents` is the document tables an unreferenced hash is deleted
 *   from, with every version column that may reference one
 *   ({@link DocumentReferences}, both non-empty);
 * - `blobs` is every version column that may carry a `ContentHash`;
 * - `dependents` is every table of rows the other seams keep for a node
 *   that the identity row's `ON DELETE CASCADE` does not take (the stores
 *   here all cascade, so it is the application's own tables).
 *
 * It fails closed. The types require a document table to come with a
 * reference column, and the constructor throws effect-drizzle-ext's
 * `DerivationError` at module load when a cast empties either list (or
 * `blobs`). Omitting `documents` deletes no document, and omitting `blobs`
 * reports no blob unreferenced, since neither can be proven.
 *
 * `eraseNode(id)` reads the hashes the node's version rows carry, each once,
 * then deletes its `dependents` rows; the version rows and the identity row
 * are the leaf's `VersionChain.purge`'s, which `definePurge` calls next.
 * `deleteUnreferencedDocuments` is one `DELETE … WHERE hash IN (…) AND NOT
 * EXISTS (…) RETURNING` per document table, and `unreferencedBlobs` one read
 * over the candidates. An id that is no canonical UUID, or a string that is
 * no hash, names nothing.
 *
 * @since 0.0.0
 */
export const makePurgeStore = <I, Relations extends AnyRelations>(config: {
  readonly documents?: DocumentReferences;
  readonly blobs?: Arr.NonEmptyReadonlyArray<HashColumn>;
  readonly dependents?: ReadonlyArray<NodeDependent>;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): PurgeStore<StoreQueryError<Relations>, I> => {
  const { CurrentTransaction } = config;
  const documentConfig = Option.map(Option.fromNullishOr(config.documents), (declared) => ({
    tables: nonEmpty(declared.tables, "documents.tables"),
    references: nonEmpty(declared.references, "documents.references"),
  }));
  const blobConfig = Option.map(Option.fromNullishOr(config.blobs), (declared) =>
    nonEmpty(declared, "blobs"),
  );
  const documentColumns: ReadonlyArray<HashColumn> = Option.match(documentConfig, {
    onNone: () => [],
    onSome: ({ references }) => references,
  });
  const blobColumns: ReadonlyArray<HashColumn> = Option.getOrElse(blobConfig, () => []);
  const dependents = config.dependents ?? [];
  const isDocumentHash = Schema.is(DocumentHash);
  const isContentHash = Schema.is(ContentHash);

  /** The distinct values `columns` hold across the node's rows. */
  const carried = (
    tx: PgTransaction<Relations>,
    id: string,
    columns: ReadonlyArray<HashColumn>,
  ) => {
    const arms = Arr.map(
      columns,
      ({ table, id: nodeId, column }) =>
        sql`SELECT ${column}::text AS hash FROM ${table} WHERE ${nodeId} = ${id}::uuid AND ${column} IS NOT NULL`,
    );
    if (!Arr.isReadonlyArrayNonEmpty(arms)) return Effect.succeed<ReadonlyArray<string>>([]);
    return Effect.gen(function* () {
      const rows = yield* executeRows<{ readonly hash: string }>(
        tx,
        sql`SELECT DISTINCT hash FROM (${sql.join(arms, sql` UNION ALL `)}) carried ORDER BY hash`,
      );
      const decoded = yield* Effect.orDie(decodeHashes(rows));
      return Arr.map(decoded, ({ hash }) => hash);
    });
  };

  return {
    eraseNode: (id) =>
      !isNodeId(id)
        ? Effect.succeed<ErasedReferences>({ documents: [], blobs: [] })
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const documents = Arr.filter(yield* carried(tx, id, documentColumns), isDocumentHash);
            const blobs = Arr.filter(yield* carried(tx, id, blobColumns), isContentHash);
            yield* Effect.forEach(
              dependents,
              (dependent) =>
                tx.execute(sql`DELETE FROM ${dependent.table} WHERE ${dependent.id} = ${id}::uuid`),
              { concurrency: 1, discard: true },
            );
            return { documents, blobs };
          }),
    deleteUnreferencedDocuments: (hashes) => {
      const named = Arr.dedupe(Arr.filter(hashes, isDocumentHash));
      if (!Arr.isReadonlyArrayNonEmpty(named) || Option.isNone(documentConfig)) {
        return Effect.succeed([]);
      }
      const { tables, references } = documentConfig.value;
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const deleted = yield* Effect.forEach(
          tables,
          (table) =>
            Effect.flatMap(
              executeRows<{ readonly hash: string }>(
                tx,
                sql`DELETE FROM ${table}
                  WHERE ${table.hashId} IN (${sql.join(
                    Arr.map(named, (hash) => sql`decode(${hash}, 'hex')`),
                    sql`, `,
                  )})
                  AND ${unreferenced(references, sql`encode(${table.hashId}, 'hex')`)}
                  RETURNING encode(${table.hashId}, 'hex') AS hash`,
              ),
              (rows) => Effect.orDie(decodeHashes(rows)),
            ),
          { concurrency: 1 },
        );
        return Arr.filter(
          Arr.dedupe(Arr.map(Arr.flatten(deleted), ({ hash }) => hash)),
          isDocumentHash,
        );
      });
    },
    unreferencedBlobs: (hashes) => {
      const named = Arr.dedupe(Arr.filter(hashes, isContentHash));
      if (!Arr.isReadonlyArrayNonEmpty(named) || Option.isNone(blobConfig)) {
        return Effect.succeed([]);
      }
      const references = blobConfig.value;
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* executeRows<{ readonly hash: string }>(
          tx,
          sql`SELECT candidate.hash FROM ${valuesOf(named)}
            WHERE ${unreferenced(references, sql`candidate.hash`)}
            ORDER BY candidate.hash`,
        );
        const decoded = yield* Effect.orDie(decodeHashes(rows));
        return Arr.filter(
          Arr.map(decoded, ({ hash }) => hash),
          isContentHash,
        );
      });
    },
  };
};

/**
 * The root tables {@link makeAccountErasureStore} reads: `tables.root`, its
 * version table's `id`, `version`, `action` and `actor` columns, and
 * `proposedBy` when the tree declares it (`versionColumns: { proposedBy }`).
 *
 * @since 0.0.0
 */
export type ErasureRoot = VersionChainTables["root"] & {
  readonly version: VersionChainTables["root"]["version"] & {
    readonly id: AnyPgColumn;
    readonly version: AnyPgColumn;
    readonly action: AnyPgColumn;
    readonly actor: AnyPgColumn;
  };
};

/**
 * Bind the kernel's `AccountErasureStore` to the tree's root tables and the
 * owner table, in the caller's `CurrentTransaction`. It writes no version
 * row: every redaction goes through the family's `VersionChain`.
 *
 * - `ownedNodes` is `SELECT node_id … JOIN identity … WHERE owner_id = $1
 *   AND type = $2 ORDER BY node_id LIMIT $3`.
 * - `setOwner` upserts the owner row (`ON CONFLICT (node_id) DO UPDATE`), or
 *   deletes it for none.
 * - `unredactedNodes` is one grouped read over the root version table,
 *   restricted to the leaf's nodes whose head is no tombstone: `GROUP BY id
 *   HAVING MAX(version) FILTER (WHERE actor = $1 OR proposed_by = $1) >
 *   COALESCE(MAX(version) FILTER (WHERE actor IS NOT DISTINCT FROM
 *   $redactedAs AND proposed_by IS NULL), -1) ORDER BY id LIMIT $limit`
 *   (without a `proposedBy` column, the actor arms alone).
 *
 * A limit below one reads nothing; an id that is no canonical UUID names no
 * node.
 *
 * @since 0.0.0
 */
export const makeAccountErasureStore = <I, Relations extends AnyRelations>(config: {
  readonly root: ErasureRoot;
  readonly owners: NodeOwnerTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): AccountErasureStore<StoreQueryError<Relations>, I> => {
  const { root, owners, CurrentTransaction } = config;
  const { identity, version } = root;
  const proposedBy: Option.Option<AnyPgColumn> = R.get(getTableColumns(version), "proposedBy");
  const ids = (rows: ReadonlyArray<unknown>) =>
    Effect.map(Effect.orDie(decodeIds(rows)), (decoded) => Arr.map(decoded, ({ id }) => id));

  return {
    ownedNodes: ({ accountId, type, limit }) =>
      limit < 1
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ id: sql<string>`${owners.nodeId}::text`.as("id") })
              .from(owners)
              .innerJoin(identity, eq(identity.id, owners.nodeId))
              .where(and(eq(owners.ownerId, accountId), eq(identity.type, type)))
              .orderBy(asc(owners.nodeId))
              .limit(Math.trunc(limit));
            return yield* ids(rows);
          }),
    setOwner: ({ id, ownerId }) =>
      !isNodeId(id)
        ? Effect.void
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* Option.match(ownerId, {
              onNone: () => Effect.asVoid(tx.delete(owners).where(eq(owners.nodeId, id))),
              onSome: (owner) =>
                Effect.asVoid(
                  tx
                    .insert(owners)
                    .values({ nodeId: id, ownerId: owner })
                    .onConflictDoUpdate({ target: owners.nodeId, set: { ownerId: owner } }),
                ),
            });
          }),
    unredactedNodes: ({ accountId, type, redactedAs, limit }) =>
      limit < 1
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const marker = Option.getOrNull(redactedAs);
            const named = Option.match(proposedBy, {
              onNone: () => sql`${version.actor} = ${accountId}`,
              onSome: (column) =>
                sql`(${version.actor} = ${accountId} OR ${column} = ${accountId})`,
            });
            const redacting = Option.match(proposedBy, {
              onNone: () => sql`${version.actor} IS NOT DISTINCT FROM ${marker}::text`,
              onSome: (column) =>
                sql`${version.actor} IS NOT DISTINCT FROM ${marker}::text AND ${column} IS NULL`,
            });
            const rows = yield* executeRows<{ readonly id: string }>(
              tx,
              sql`SELECT ${version.id}::text AS id
                FROM ${version}
                JOIN ${identity} ON ${identity.id} = ${version.id}
                WHERE ${identity.type} = ${type}
                  AND NOT EXISTS (
                    SELECT 1 FROM ${version} AS head_row
                    WHERE head_row.id = ${version.id}
                      AND head_row.action = 'delete'
                      AND head_row.version = (SELECT MAX(latest.version) FROM ${version} AS latest WHERE latest.id = ${version.id})
                  )
                GROUP BY ${version.id}
                HAVING MAX(${version.version}) FILTER (WHERE ${named})
                  > COALESCE(MAX(${version.version}) FILTER (WHERE ${redacting}), -1)
                ORDER BY ${version.id}
                LIMIT ${Math.trunc(limit)}`,
            );
            return yield* ids(rows);
          }),
  };
};

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));
