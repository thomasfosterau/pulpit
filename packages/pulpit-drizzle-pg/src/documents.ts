/**
 * @copyright Thomas Foster
 *
 * The kernel's content-addressed `DocumentStore` (README → Seams →
 * `DocumentStore`, pulpit#53) on PostgreSQL (pulpit#247): one table per
 * document family, the document as `jsonb`, keyed by the hash the database
 * generates to the kernel's contract, `digest(document::text,
 * 'sha256')` (pgcrypto's immutable `text` overload, so a generated column
 * may use it). A stored row is never rewritten (`DOC-001`): `put` is
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, and a document already
 * stored, or equal to one under the canonical text, returns its hash with
 * `inserted: false`. A first insert's side effects (an embedding job) are
 * the kernel's `onDocumentInsert`, composed over this store.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { DocumentHash, type DocumentStore } from "@thomasfosterau/pulpit/documents";
import { sql, type AnyRelations, type SQL } from "drizzle-orm";
import { bytea, jsonb, type PgSchema } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StoreQueryError } from "./leaf-store.ts";

/**
 * Build one document family's table (`name`): `hash` the generated
 * SHA-256 of the document's canonical text, its primary key, and
 * `document` the document. The database needs pgcrypto (`CREATE
 * EXTENSION pgcrypto`) for `digest`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makeDocumentTable } from "@thomasfosterau/pulpit-drizzle-pg/documents";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema } from "drizzle-orm/pg-core";
 *
 * const blocks = makeDocumentTable({ schema: pgSchema("core"), name: "block_documents" });
 * strictEqual(getTableName(blocks), "block_documents");
 * ```
 *
 * @since 0.0.0
 */
export const makeDocumentTable = (options: { readonly schema: PgSchema; readonly name: string }) =>
  options.schema.table(options.name, {
    hashId: bytea("hash")
      .primaryKey()
      .generatedAlwaysAs(sql`digest(document::text, 'sha256')`),
    document: jsonb("document").notNull(),
  });

/**
 * One document family's table: {@link makeDocumentTable}'s.
 *
 * @since 0.0.0
 */
export type DocumentTable = ReturnType<typeof makeDocumentTable>;

/** A stored hash as the kernel's `DocumentHash`: 64 lowercase hex characters. */
const hashText = (table: DocumentTable) => sql<string>`encode(${table.hashId}, 'hex')`;

/** A `DocumentHash` as the `bytea` key it names. */
const hashKey = (hash: string): SQL => sql`decode(${hash}, 'hex')`;

const isDocumentHash = Schema.is(DocumentHash);

/**
 * A document's JSON text, bound as a `jsonb` parameter. Through the text,
 * not Drizzle's `jsonb` encoder, which writes a JSON `null` document as SQL
 * `NULL`.
 */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const asJsonb = (text: string): SQL => sql`(${text})::jsonb`;

/**
 * Bind the kernel's `DocumentStore` to one family's table, in the caller's
 * `CurrentTransaction`. `document` is the family's schema: every document
 * read back is checked against it, and one that fails is a defect (a row
 * written outside this store).
 *
 * - `put` inserts an unseen document (`ON CONFLICT DO NOTHING RETURNING`)
 *   and answers `{ hash, inserted }`; a seen one writes nothing and
 *   answers the hash Postgres derives for it, `inserted: false`.
 * - `get` / `getMany` read by `hash`; `getMany` is one `IN (…)` read.
 *   A string that is no `DocumentHash` names no document.
 *
 * @since 0.0.0
 */
export const makeDocumentStore = <
  Document extends Schema.Json,
  I,
  Relations extends AnyRelations,
>(config: {
  readonly table: DocumentTable;
  readonly document: Schema.Codec<Document>;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): DocumentStore<Document, StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  /** A stored document, checked against the family's schema; one that fails is a defect. */
  const decodeDocument = Schema.decodeUnknownEffect(Schema.toType(config.document));

  return {
    put: (document) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const text = yield* Effect.orDie(jsonText(document));
        const inserted = yield* tx
          .insert(table)
          .values({ document: asJsonb(text) })
          .onConflictDoNothing()
          .returning({ hash: hashText(table) });
        return yield* Option.match(Arr.head(inserted), {
          onSome: ({ hash }) => Effect.succeed({ hash, inserted: true }),
          onNone: () =>
            Effect.gen(function* () {
              const rows = yield* executeRows<{ readonly hash: string }>(
                tx,
                sql`SELECT encode(digest(${asJsonb(text)}::text, 'sha256'), 'hex') AS hash`,
              );
              const hash = yield* Effect.orDie(
                Effect.fromOption(Option.map(Arr.head(rows), (row) => row.hash)),
              );
              return { hash, inserted: false };
            }),
        });
      }),
    get: (hash) =>
      isDocumentHash(hash)
        ? Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* tx
              .select({ document: table.document })
              .from(table)
              .where(sql`${table.hashId} = ${hashKey(hash)}`)
              .limit(1);
            return yield* Effect.transposeOption(
              Option.map(Arr.head(rows), (row) => Effect.orDie(decodeDocument(row.document))),
            );
          })
        : Effect.succeedNone,
    getMany: (hashes) => {
      const valid = Arr.dedupe(Arr.filter(hashes, isDocumentHash));
      if (!Arr.isReadonlyArrayNonEmpty(valid)) return Effect.succeed(HashMap.empty());
      return Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ hash: hashText(table), document: table.document })
          .from(table)
          .where(sql`${table.hashId} IN (${sql.join(Arr.map(valid, hashKey), sql`, `)})`)
          .limit(valid.length);
        const documents = yield* Effect.forEach(
          rows,
          (row) =>
            Effect.map(
              Effect.orDie(decodeDocument(row.document)),
              (document) => [row.hash, document] as const,
            ),
          { concurrency: 1 },
        );
        return HashMap.fromIterable(documents);
      });
    },
  };
};
