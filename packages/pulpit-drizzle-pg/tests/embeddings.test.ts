/**
 * The embedding store with no database (a canned transaction): the vector
 * literal of each kind, the tables each kind builds, the decode of
 * `pending`, and malformed hashes or an empty batch issuing no statement.
 * The statements themselves run against PostgreSQL (the `double
 * precision[]` kind) in `tests/integration/embeddings.test.ts`; pgvector's
 * form is pinned here, since CI's `postgres:17` has no pgvector.
 */

import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeEmbeddingStore, makeEmbeddingTables, vectorLiteral } from "../src/Embeddings.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, documents, embeddings, schema } from "./fixtures/tree.ts";

const dialect = new PgDialect();
const HASH = "a".repeat(64);

const store = makeEmbeddingStore({
  tables: embeddings,
  documents,
  CurrentTransaction: database.CurrentTransaction,
});

const runWith = <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => {
  const { tx, calls } = cannedTransaction(rows);
  return Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
    value,
    calls,
  }));
};

describe("vectorLiteral", () => {
  it("binds pgvector's text form, cast to vector", () => {
    const query = dialect.sqlToQuery(
      vectorLiteral({ kind: "pgvector", dimensions: 3 }, [0.5, -1, 2e-3]),
    );
    expect(query.sql).toBe("$1::vector");
    expect(query.params).toEqual(["[0.5,-1,0.002]"]);
  });

  it("binds an array literal, cast to float8[], and zeroes a non-finite component", () => {
    const query = dialect.sqlToQuery(vectorLiteral({ kind: "float8" }, [1, Number.NaN, Infinity]));
    expect(query.sql).toBe("$1::float8[]");
    expect(query.params).toEqual(["{1,0,0}"]);
  });
});

describe("makeEmbeddingTables", () => {
  it("names both tables after the family, with the vector column of its kind", () => {
    const pg = makeEmbeddingTables({
      schema,
      name: "block_embedding",
      documents,
      vector: { kind: "pgvector", dimensions: 3 },
    });
    expect(getTableName(pg.queue)).toBe("block_embedding_queue");
    expect(getTableName(pg.vectors)).toBe("block_embedding_vector");
    expect(pg.vectors.embedding.getSQLType()).toBe("vector(3)");
    expect(embeddings.vectors.embedding.getSQLType()).toBe("double precision");
    expect(embeddings.vectors.embedding.dimensions).toBe(1);
  });
});

describe("makeEmbeddingStore over canned rows", () => {
  it.effect("pending decodes the hashes, and reads nothing for a limit below one", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ hash: HASH }], store.pending(5))).value).toEqual([HASH]);
      const none = yield* runWith([{ hash: HASH }], store.pending(0));
      expect(none).toEqual({ value: [], calls: [] });
    }),
  );

  it.effect("a pending row that is no hash is a defect", () =>
    Effect.gen(function* () {
      const { tx } = cannedTransaction([{ hash: "nope" }]);
      const exit = yield* Effect.exit(
        Effect.provideService(store.pending(1), database.CurrentTransaction, tx),
      );
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
    }),
  );

  it.effect("enqueue, write and discard issue one statement each", () =>
    Effect.gen(function* () {
      expect((yield* runWith([], store.enqueue(HASH))).calls).toEqual(["execute"]);
      expect((yield* runWith([], store.write([{ hash: HASH, vector: [1] }]))).calls).toEqual([
        "execute",
      ]);
      expect((yield* runWith([], store.discard([HASH, HASH]))).calls).toEqual(["execute"]);
    }),
  );

  it.effect("a malformed hash or an empty batch issues no statement", () =>
    Effect.gen(function* () {
      expect((yield* runWith([], store.enqueue("nope"))).calls).toEqual([]);
      expect((yield* runWith([], store.write([{ hash: "nope", vector: [1] }]))).calls).toEqual([]);
      expect((yield* runWith([], store.write([]))).calls).toEqual([]);
      expect((yield* runWith([], store.discard(["nope"]))).calls).toEqual([]);
    }),
  );
});
