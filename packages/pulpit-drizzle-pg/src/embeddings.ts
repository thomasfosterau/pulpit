/**
 * @copyright Thomas Foster
 *
 * The kernel's `EmbeddingStore` (docs/seams.md → `SearchBranch` and
 * `EmbeddingStore`, pulpit#204) on PostgreSQL (pulpit#357): the embedding
 * queue and the vectors of one document family (`./documents`). The
 * vectors live in a table of their own, keyed by the document's hash, so
 * the document table stays as `./documents` builds it. The vector column is
 * pgvector's `vector(n)` (what a vector `SearchBranch` ranks with `<=>`) or,
 * for a database without the extension, `double precision[]`. Every call
 * runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { DocumentHash } from "@thomasfosterau/pulpit/documents";
import type { EmbeddingStore } from "@thomasfosterau/pulpit/search";
import { sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  bytea,
  doublePrecision,
  index,
  timestamp,
  vector,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DocumentTable } from "./documents.ts";
import type { StoreQueryError } from "./internal/owners.ts";

/**
 * How a vector is stored: pgvector's `vector(dimensions)` (the extension
 * must be installed: `CREATE EXTENSION vector`), or `double precision[]`.
 *
 * @since 0.0.0
 */
export type VectorKind =
  | { readonly kind: "pgvector"; readonly dimensions: number }
  | { readonly kind: "float8" };

/**
 * Build one document family's embedding tables, both keyed by the
 * document's `hash` and referencing the document table (cascading):
 *
 * - `queue` (`${name}_queue`): `hash`, `queued_at` (`DEFAULT now()`) and
 *   `discarded_at` (nullable: a document `discard` gave up on, never handed
 *   out again until it is enqueued anew), indexed on `queued_at`;
 * - `vectors` (`${name}_vector`): `hash` and `embedding`, of `vector`'s kind.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makeDocumentTable } from "@thomasfosterau/pulpit-drizzle-pg/documents";
 * import { makeEmbeddingTables } from "@thomasfosterau/pulpit-drizzle-pg/embeddings";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema } from "drizzle-orm/pg-core";
 *
 * const schema = pgSchema("core");
 * const documents = makeDocumentTable({ schema, name: "block_documents" });
 * const embeddings = makeEmbeddingTables({
 *   schema,
 *   name: "block_embedding",
 *   documents,
 *   vector: { kind: "pgvector", dimensions: 1536 },
 * });
 * strictEqual(getTableName(embeddings.queue), "block_embedding_queue");
 * ```
 *
 * @since 0.0.0
 */
export const makeEmbeddingTables = (options: {
  readonly schema: PgSchema;
  readonly name: string;
  readonly documents: DocumentTable;
  readonly vector: VectorKind;
}) => {
  const hash = () =>
    bytea("hash")
      .primaryKey()
      .references((): AnyPgColumn => options.documents.hashId, { onDelete: "cascade" });
  return {
    vector: options.vector,
    queue: options.schema.table(
      `${options.name}_queue`,
      {
        hashId: hash(),
        queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
        discardedAt: timestamp("discarded_at", { withTimezone: true }),
      },
      (table) => [index(`${options.name}_queue_queued_at`).on(table.queuedAt)],
    ),
    vectors: options.schema.table(`${options.name}_vector`, {
      hashId: hash(),
      embedding:
        options.vector.kind === "pgvector"
          ? vector("embedding", { dimensions: options.vector.dimensions }).notNull()
          : doublePrecision("embedding").array().notNull(),
    }),
  };
};

/**
 * One document family's embedding tables: {@link makeEmbeddingTables}'s.
 *
 * @since 0.0.0
 */
export type EmbeddingTables = ReturnType<typeof makeEmbeddingTables>;

/** A `DocumentHash` as the `bytea` key it names. */
const hashKey = (hash: string): SQL => sql`decode(${hash}, 'hex')`;

const decodeHashes = Schema.decodeUnknownEffect(Schema.Array(DocumentHash));

/**
 * A vector as its SQL literal: `'[…]'::vector` for pgvector,
 * `'{…}'::float8[]` otherwise. Every component is a finite number, so the
 * literal holds nothing but digits, signs, points and exponents.
 *
 * @since 0.0.0
 */
export const vectorLiteral = (kind: VectorKind, values: ReadonlyArray<number>): SQL => {
  const body = Arr.map(values, (value) => (Number.isFinite(value) ? String(value) : "0")).join(",");
  return kind.kind === "pgvector" ? sql`${`[${body}]`}::vector` : sql`${`{${body}}`}::float8[]`;
};

/**
 * Bind the kernel's `EmbeddingStore` to one family's embedding tables, in
 * the caller's `CurrentTransaction`; `documents` is the family's document
 * table.
 *
 * - `enqueue(hash)` inserts the queue row unless the document already has a
 *   vector, and requeues a discarded one (`ON CONFLICT (hash) DO UPDATE …
 *   WHERE discarded_at IS NOT NULL`): idempotent.
 * - `pending(limit)` is one read: the queued, undiscarded hashes oldest
 *   first, then, for the sweep, stored documents with no vector and no queue
 *   row, by hash; at most `limit`.
 * - `write(vectors)` is one statement: it upserts each vector and deletes its
 *   queue row (a CTE).
 * - `discard(hashes)` marks each queue row discarded (inserting one for a
 *   swept document), so `pending` never hands it out again.
 *
 * A string that is no `DocumentHash` names no document.
 *
 * @since 0.0.0
 */
export const makeEmbeddingStore = <I, Relations extends AnyRelations>(config: {
  readonly tables: EmbeddingTables;
  readonly documents: DocumentTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): EmbeddingStore<StoreQueryError<Relations>, I> => {
  const { tables, documents, CurrentTransaction } = config;
  const { queue, vectors } = tables;
  const isHash = Schema.is(DocumentHash);
  const valid = (hashes: ReadonlyArray<string>) => Arr.dedupe(Arr.filter(hashes, isHash));
  const keys = (hashes: Arr.NonEmptyReadonlyArray<string>): SQL =>
    sql.join(Arr.map(hashes, hashKey), sql`, `);

  return {
    enqueue: (hash) =>
      isHash(hash)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.execute(
              sql`INSERT INTO ${queue} (hash)
                SELECT ${hashKey(hash)}
                WHERE NOT EXISTS (SELECT 1 FROM ${vectors} WHERE ${vectors.hashId} = ${hashKey(hash)})
                ON CONFLICT (hash) DO UPDATE SET queued_at = now(), discarded_at = NULL
                WHERE ${queue.discardedAt} IS NOT NULL`,
            );
          })
        : Effect.void,
    pending: (limit) =>
      limit < 1
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* executeRows<{ readonly hash: string }>(
              tx,
              sql`SELECT hash FROM (
                SELECT encode(${queue.hashId}, 'hex') AS hash, 0 AS arm, ${queue.queuedAt} AS at
                FROM ${queue} WHERE ${queue.discardedAt} IS NULL
                UNION ALL
                SELECT encode(${documents.hashId}, 'hex'), 1, NULL
                FROM ${documents}
                WHERE NOT EXISTS (SELECT 1 FROM ${vectors} WHERE ${vectors.hashId} = ${documents.hashId})
                  AND NOT EXISTS (SELECT 1 FROM ${queue} WHERE ${queue.hashId} = ${documents.hashId})
              ) pending
              ORDER BY arm, at, hash
              LIMIT ${Math.trunc(limit)}`,
            );
            return yield* Effect.orDie(decodeHashes(Arr.map(rows, (row) => row.hash)));
          }),
    write: (written) => {
      const rows = Arr.filter(written, ({ hash }) => isHash(hash));
      if (!Arr.isReadonlyArrayNonEmpty(rows)) return Effect.void;
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const values = sql.join(
          Arr.map(
            rows,
            ({ hash, vector: components }) =>
              sql`(${hashKey(hash)}, ${vectorLiteral(tables.vector, components)})`,
          ),
          sql`, `,
        );
        yield* tx.execute(
          sql`WITH written AS (
            INSERT INTO ${vectors} (hash, embedding) VALUES ${values}
            ON CONFLICT (hash) DO UPDATE SET embedding = EXCLUDED.embedding
            RETURNING hash
          )
          DELETE FROM ${queue} WHERE ${queue.hashId} IN (SELECT hash FROM written)`,
        );
      });
    },
    discard: (hashes) => {
      const named = valid(hashes);
      if (!Arr.isReadonlyArrayNonEmpty(named)) return Effect.void;
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql`INSERT INTO ${queue} (hash, discarded_at)
            SELECT ${documents.hashId}, now() FROM ${documents}
            WHERE ${documents.hashId} IN (${keys(named)})
            ON CONFLICT (hash) DO UPDATE SET discarded_at = now()`,
        );
      });
    },
  };
};
