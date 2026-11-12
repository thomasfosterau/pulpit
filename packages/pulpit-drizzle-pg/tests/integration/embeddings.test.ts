/**
 * The embedding store against PostgreSQL (pulpit#357), checked against the
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
import type { DocumentHash } from "@thomasfosterau/pulpit/documents";
import { makeInMemoryEmbeddingStore } from "@thomasfosterau/pulpit/testing";
import { getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeDocumentStore } from "../../src/documents.ts";
import { makeEmbeddingStore } from "../../src/embeddings.ts";
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
  runtime.runPromise(transact(effect));

const docs = makeDocumentStore({
  table: documents,
  document: Schema.Struct({ text: Schema.String }),
  CurrentTransaction,
});
const store = makeEmbeddingStore({ tables: embeddings, documents, CurrentTransaction });
const memory = makeInMemoryEmbeddingStore();

let hashes: ReadonlyArray<DocumentHash> = [];

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(sql.raw(`TRUNCATE pulpit_test.${getTableName(documents)} CASCADE`));
    }),
  );
  hashes = await run(
    Effect.forEach(
      ["alpha", "beta", "gamma"],
      (text) => Effect.map(docs.put({ text }), ({ hash }) => hash),
      { concurrency: 1 },
    ),
  );
});

/** Run one call against both stores: the SQL one in a transaction of its own, so each `queued_at` is later than the last. */
const both = async <A, E>(
  fromSql: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>,
  fromMemory: Effect.Effect<A>,
) => ({ sql: await run(fromSql), memory: await Effect.runPromise(fromMemory) });

const enqueueBoth = (hash: string) => both(store.enqueue(hash), memory.enqueue(hash));
const pendingBoth = (limit: number) => both(store.pending(limit), memory.pending(limit));

describe("EmbeddingStore over PostgreSQL agrees with the in-memory store", () => {
  it("enqueue is idempotent, and pending is the queue oldest first, at most limit", async () => {
    const [a = "", b = "", c = ""] = hashes;
    await Arr.reduce([a, b, a, c], Promise.resolve(), (previous, hash) =>
      previous.then(() => enqueueBoth(hash)).then(() => undefined),
    );
    const pending = await pendingBoth(10);
    expect(pending.sql).toEqual(pending.memory);
    expect(pending.sql).toEqual([a, b, c]);
    const two = await pendingBoth(2);
    expect(two.sql).toEqual(two.memory);
    expect(two.sql).toEqual([a, b]);
  });

  it("write stores the vectors and dequeues them; a written document is never queued again", async () => {
    const [a = "", b = ""] = hashes;
    const written = [{ hash: a, vector: [0.5, -1, 2e-3] }];
    await both(store.write(written), memory.write(written));
    await enqueueBoth(a);
    const pending = await pendingBoth(10);
    expect(pending.sql).toEqual(pending.memory);
    const stored = await run(
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
  });

  it("discard dequeues; the queue then agrees again", async () => {
    const [, b = ""] = hashes;
    await both(store.discard([b]), memory.discard([b]));
    const pending = await pendingBoth(10);
    expect(pending.sql).toEqual(pending.memory);
  });
});

describe("the sweep (beyond the in-memory fake)", () => {
  it("pending hands out a stored document with no vector and no queue row, after the queue", async () => {
    const [, b = "", c = ""] = hashes;
    // c is queued, b was discarded, and d is stored but never enqueued.
    const { hash: d } = await run(docs.put({ text: "delta" }));
    expect(await run(store.pending(10))).toEqual([c, d]);
    await run(store.discard([d]));
    expect(await run(store.pending(10))).toEqual([c]);
    // Enqueued anew, a discarded document is pending again.
    await run(store.enqueue(b));
    expect(await run(store.pending(10))).toEqual([c, b]);
    expect(await run(store.pending(0))).toEqual([]);
  });

  it("purging the document takes its queue row and vector (the foreign keys cascade)", async () => {
    const [a = "", , c = ""] = hashes;
    await run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(
          sql`DELETE FROM ${documents} WHERE ${documents.hashId} IN (decode(${a}, 'hex'), decode(${c}, 'hex'))`,
        );
      }),
    );
    expect(await run(store.pending(10))).not.toContain(c);
    const vectors = await run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        return yield* tx.select({ hash: embeddings.vectors.hashId }).from(embeddings.vectors);
      }),
    );
    expect(vectors).toEqual([]);
  });
});
