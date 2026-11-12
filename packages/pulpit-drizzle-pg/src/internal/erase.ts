/**
 * The bounded erasure batch the account-keyed stores share (pulpit#207,
 * `PERF-DB-001`): delete at most `limit` of a table's rows matching
 * `where`, chosen by key order, in one statement, and count them. `./erasure`
 * calls a store's `eraseAccount` again until it deletes fewer than `limit`.
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import { sql, type AnyRelations, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeErased = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ erased: Schema.Int })),
);

/**
 * Delete at most `limit` of `table`'s rows matching `where`, the first by
 * `key` (the primary key's columns), and answer how many went; none for a
 * limit below one.
 */
export const eraseBatch = <Relations extends AnyRelations>(
  tx: PgTransaction<Relations>,
  batch: {
    readonly table: PgTable;
    readonly key: ReadonlyArray<AnyPgColumn>;
    readonly where: SQL;
    readonly limit: number;
  },
) =>
  batch.limit < 1
    ? Effect.succeed(0)
    : Effect.gen(function* () {
        const { table, where } = batch;
        const columns = sql.join([...batch.key], sql`, `);
        const rows = yield* executeRows<{ readonly erased: number }>(
          tx,
          sql`WITH gone AS (
            DELETE FROM ${table}
            WHERE (${columns}) IN (
              SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${columns} LIMIT ${Math.trunc(batch.limit)}
            )
            RETURNING 1
          )
          SELECT count(*)::int AS erased FROM gone`,
        );
        const counted = yield* Effect.orDie(decodeErased(rows));
        return Option.match(Arr.head(counted), { onNone: () => 0, onSome: ({ erased }) => erased });
      });
