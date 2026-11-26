/**
 * Raw-SQL reads, decoded: `executeRows` with each row checked against the
 * schema the store's own statement promises. A row that fails it is a
 * defect (the store wrote the SQL that produced it), so its `SchemaError`
 * dies instead of widening every seam's error channel. A query failure
 * keeps its `EffectDrizzleQueryError`.
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/Query";
import { sql, type SQLWrapper } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The rows `query` reads, each decoded with `row`; a row that fails `row` is a defect. */
export const selectRows = <S extends Schema.Decoder<unknown>>(
  db: Parameters<typeof executeRows>[0],
  query: SQLWrapper | string,
  row: S,
) => Effect.catchTag(executeRows(db, query, row), "SchemaError", Effect.die);

/** A fresh row id, `gen_random_uuid()` as text: what a store's `mintId` answers. */
export const mintUuid = (db: Parameters<typeof executeRows>[0]) =>
  Effect.flatMap(
    selectRows(db, sql`SELECT gen_random_uuid()::text AS id`, Schema.Struct({ id: Schema.String })),
    (rows) => Effect.orDie(Effect.fromOption(Option.map(Arr.head(rows), (row) => row.id))),
  );
