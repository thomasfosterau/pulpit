/**
 * The one-row count the stores' counted statements answer (`SELECT
 * count(*)::int AS n …`), decoded: a defect when the row is malformed, zero
 * when there is none.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })));

/** The count a counted statement's rows hold, or zero for no row. */
export const countOf = (rows: ReadonlyArray<unknown>): Effect.Effect<number> =>
  Effect.map(Effect.orDie(decodeCount(rows)), (counted) =>
    Option.match(Arr.head(counted), { onNone: () => 0, onSome: ({ n }) => n }),
  );
