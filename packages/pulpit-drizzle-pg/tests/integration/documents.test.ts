/**
 * The document store against PostgreSQL, checked against the kernel's
 * `makeInMemoryDocumentStore` (whose hash is `canonicalText`'s, pinned to
 * Postgres): every document hashes to the same `DocumentHash` in both, a
 * repeated or reordered document writes nothing (`DOC-001`), and the reads
 * return what was stored.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { makeInMemoryDocumentStore } from "@thomasfosterau/pulpit/testing";
import { count, getTableName, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeDocumentStore } from "../../src/documents.ts";
import { documents } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitDocumentsDatabase" });
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

const store = makeDocumentStore({ table: documents, document: Schema.Json, CurrentTransaction });
const memory = makeInMemoryDocumentStore<Schema.Json>();

const samples: ReadonlyArray<readonly [string, Schema.Json]> = [
  ["an empty object", {}],
  ["null", null],
  ["a string with every escape", 'quote " slash \\ newline \n tab \t bell \u0007 é 😀'],
  ["keys ordered shorter-first, then bytewise", { bb: 1, a: 2, ab: 3, b: 4, é: 5, z: 6 }],
  ["numbers", { int: 1, neg: -0.5, big: 1e21, small: 1e-7, frac: 0.1 }],
  ["nested", { type: "doc", content: [{ type: "p", text: "Hi" }, [true, false, null]] }],
  ["an escaped key", { 'k"\n': "v" }],
];

beforeAll(() =>
  run(
    Effect.flatMap(CurrentTransaction, (tx) =>
      tx.execute(sql.raw(`TRUNCATE pulpit_test.${getTableName(documents)}`)),
    ),
  ),
);

describe("DocumentStore over PostgreSQL", () => {
  it.each(samples)("%s hashes as the kernel's canonical text does", async (_name, document) => {
    const fromSql = await run(store.put(document));
    const fromMemory = await Effect.runPromise(memory.put(document));
    expect(fromSql).toEqual(fromMemory);
    expect(await run(store.get(fromSql.hash))).toEqual(Option.some(document));
  });

  it("never rewrites a stored row: a repeat, or a reordering, writes nothing (DOC-001)", async () => {
    const first = await run(store.put({ a: 1, b: [1, 2] }));
    const again = await run(store.put({ b: [1, 2], a: 1 }));
    expect(again).toEqual({ hash: first.hash, inserted: false });
    const rows = await run(
      Effect.flatMap(CurrentTransaction, (tx) => tx.select({ n: count() }).from(documents)),
    );
    expect(Arr.map(rows, (row) => row.n)).toEqual([samples.length + 1]);
  });

  it("getMany reads every stored hash once, skipping unknown and malformed ones", async () => {
    const hashes = await run(
      Effect.forEach(
        samples,
        ([, document]) => Effect.map(store.put(document), (put) => put.hash),
        {
          concurrency: 1,
        },
      ),
    );
    const found = await run(store.getMany([...hashes, "0".repeat(64), "not-a-hash"]));
    expect(HashMap.size(found)).toBe(samples.length);
    expect(HashMap.get(found, hashes[3] ?? "")).toEqual(Option.some(samples[3]?.[1]));
    expect(await run(store.get("not-a-hash"))).toEqual(Option.none());
    expect(HashMap.size(await run(store.getMany([])))).toBe(0);
  });
});
