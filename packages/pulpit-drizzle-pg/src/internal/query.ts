/**
 * Raw-SQL reads, decoded: `executeRows` with each row checked against the
 * schema the store's own statement promises. A row that fails it is a
 * defect (the store wrote the SQL that produced it), so its `SchemaError`
 * dies instead of widening every seam's error channel. A query failure
 * keeps its `EffectDrizzleQueryError`.
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { SQLWrapper } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/** The rows `query` reads, each decoded with `row`; a row that fails `row` is a defect. */
export const selectRows = <S extends Schema.Decoder<unknown>>(
  db: Parameters<typeof executeRows>[0],
  query: SQLWrapper | string,
  row: S,
) => Effect.catchTag(executeRows(db, query, row), "SchemaError", Effect.die);
