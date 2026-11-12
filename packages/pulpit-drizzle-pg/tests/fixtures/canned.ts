/**
 * A stand-in transaction for the stores' unit tests: every query builder
 * resolves to the rows it is given.
 */

import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";

/**
 * A stand-in transaction whose every query builder resolves to `rows`,
 * recording the builder calls: what the store does with the rows a query
 * returns (the window total, the owner, the decode check) needs no
 * database. The SQL each builds runs against PostgreSQL in the
 * integration suite.
 */
/** The application's transaction service, as the stores yield it. */
type Transaction = PgTransaction<typeof relations>;
const relations = {};

export const cannedTransaction = (rows: ReadonlyArray<object>) => {
  const calls: Array<string> = [];
  const query = Effect.succeed(rows);
  const builder = Object.assign(
    query,
    R.fromEntries(
      Arr.map(
        [
          "select",
          "selectDistinct",
          "selectDistinctOn",
          "from",
          "leftJoin",
          "where",
          "orderBy",
          "limit",
          "offset",
          "as",
          "insert",
          "values",
          "onConflictDoNothing",
          "onConflictDoUpdate",
          "for",
          "update",
          "set",
          "delete",
          "returning",
        ],
        (method) =>
          [
            method,
            () => {
              calls.push(method);
              return builder;
            },
          ] as const,
      ),
    ),
  );
  // SAFETY: the store only chains these builder methods and yields the
  // result, which is the canned rows; nothing else of the transaction is
  // read. `vite.config.ts` scopes the rules this stand-in needs.
  const tx = builder as unknown as Transaction;
  return { tx, calls };
};
