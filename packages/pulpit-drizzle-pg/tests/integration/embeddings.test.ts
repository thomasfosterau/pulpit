/**
 * The embedding store against PostgreSQL, checked against the
 * kernel's `makeInMemoryEmbeddingStore` over the same calls: an idempotent
 * `enqueue` (a document with a vector is never queued again), `pending`
 * oldest first, `write` storing each vector and dequeuing it in one
 * statement, and `discard` dequeuing. Beyond the fake, `pending` also hands
 * the sweep a stored document with no vector and no queue row, and a
 * discarded one never again until it is enqueued anew.
 *
 * The fixture stores vectors as `double precision[]`, so the suite needs no
 * extension (CI's `postgres:17` has no pgvector); the pgvector form's SQL is
 * checked in `tests/embeddings.test.ts`.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { DocumentHash } from "@thomasfosterau/pulpit/Documents";
import { makeInMemoryEmbeddingStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { beforeAll, it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import { makeDocumentStore } from "../../src/Documents.ts";
import { makeEmbeddingStore } from "../../src/Embeddings.ts";
import { documents, embeddings } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitEmbeddingDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 2 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  Effect.flatMap(runtime.contextEffect, (context) => Effect.provide(transact(effect), context));

const docs = makeDocumentStore({
  table: documents,
  document: Schema.Struct({ text: Schema.String }),
  CurrentTransaction,
});
const store = makeEmbeddingStore({ tables: embeddings, documents, CurrentTransaction });
const memory = makeInMemoryEmbeddingStore();

let hashes: ReadonlyArray<DocumentHash> = [];

beforeAll(() =>
  Effect.gen(function* () {
    yield* run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(sql.raw(`TRUNCATE pulpit_test.${getTableName(documents)} CASCADE`));
      }),
    );
    hashes = yield* run(
      Effect.forEach(
        ["alpha", "beta", "gamma"],
        (text) => Effect.map(docs.put({ text }), ({ hash }) => hash),
        { concurrency: 1 },
      ),
    );
  }),
);

/** Run one call against both stores: the SQL one in a transaction of its own, so each `queued_at` is later than the last. */
const both = <A, E>(
  fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
  fromMemory: Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    return { sql: yield* run(fromSql), memory: yield* fromMemory };
  });

const enqueueBoth = (hash: string) => both(store.enqueue(hash), memory.enqueue(hash));
const pendingBoth = (limit: number) => both(store.pending(limit), memory.pending(limit));

describe("EmbeddingStore over PostgreSQL agrees with the in-memory store", () => {
  it.live("enqueue is idempotent, and pending is the queue oldest first, at most limit", () =>
    Effect.gen(function* () {
      const [a = "", b = "", c = ""] = hashes;
      yield* Effect.forEach([a, b, a, c], enqueueBoth, { concurrency: 1, discard: true });
      const pending = yield* pendingBoth(10);
      expect(pending.sql).toEqual(pending.memory);
      expect(pending.sql).toEqual([a, b, c]);
      const two = yield* pendingBoth(2);
      expect(two.sql).toEqual(two.memory);
      expect(two.sql).toEqual([a, b]);
    }),
  );

  it.live(
    "write stores the vectors and dequeues them; a written document is never queued again",
    () =>
      Effect.gen(function* () {
        const [a = "", b = ""] = hashes;
        const written = [{ hash: a, vector: [0.5, -1, 2e-3] }];
        yield* both(store.write(written), memory.write(written));
        yield* enqueueBoth(a);
        const pending = yield* pendingBoth(10);
        expect(pending.sql).toEqual(pending.memory);
        const stored = yield* run(
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            return yield* tx
              .select({ embedding: embeddings.vectors.embedding })
              .from(embeddings.vectors);
          }),
        );
        expect(Arr.map(stored, (row) => row.embedding)).toEqual(
          Arr.map(HashMap.toValues(memory.vectors()), (v) => [...v]),
        );
        expect(pending.sql).not.toContain(a);
        expect(pending.sql).toContain(b);
      }),
  );

  it.live("discard dequeues; the queue then agrees again", () =>
    Effect.gen(function* () {
      const [, b = ""] = hashes;
      yield* both(store.discard([b]), memory.discard([b]));
      const pending = yield* pendingBoth(10);
      expect(pending.sql).toEqual(pending.memory);
    }),
  );
});

describe("the sweep (beyond the in-memory fake)", () => {
  it.live(
    "pending hands out a stored document with no vector and no queue row, after the queue",
    () =>
      Effect.gen(function* () {
        const [, b = "", c = ""] = hashes;
        // c is queued, b was discarded, and d is stored but never enqueued.
        const { hash: d } = yield* run(docs.put({ text: "delta" }));
        expect(yield* run(store.pending(10))).toEqual([c, d]);
        yield* run(store.discard([d]));
        expect(yield* run(store.pending(10))).toEqual([c]);
        // Enqueued anew, a discarded document is pending again.
        yield* run(store.enqueue(b));
        expect(yield* run(store.pending(10))).toEqual([c, b]);
        expect(yield* run(store.pending(0))).toEqual([]);
      }),
  );

  it.live("purging the document takes its queue row and vector (the foreign keys cascade)", () =>
    Effect.gen(function* () {
      const [a = "", , c = ""] = hashes;
      yield* run(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(
            sql`DELETE FROM ${documents} WHERE ${documents.hashId} IN (decode(${a}, 'hex'), decode(${c}, 'hex'))`,
          );
        }),
      );
      expect(yield* run(store.pending(10))).not.toContain(c);
      const vectors = yield* run(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          return yield* tx.select({ hash: embeddings.vectors.hashId }).from(embeddings.vectors);
        }),
      );
      expect(vectors).toEqual([]);
    }),
  );
});
