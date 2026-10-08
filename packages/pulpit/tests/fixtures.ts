/**
 * Shared test helpers: the one wire question every projection case asks,
 * and the sentinel for a column a seeded row omits.
 *
 * @module tests/fixtures
 */

import * as Schema from "effect/Schema";

/**
 * A fixture value as a test hands it to a decoder: JSON, plus the `Date`
 * instances a decoded (`Type`-side) attribute fixture carries.
 */
export type Fixture =
  | Schema.Json
  | Date
  | ReadonlyArray<Fixture>
  // oxlint-disable-next-line effect/prefer-option-over-null -- a fixture must be able to state an explicit `undefined` key: that is the "not supplied" input the create projections are tested against
  | { readonly [key: string]: Fixture | undefined };

/** Whether `value` decodes under `schema`. */
export const decodes = (schema: Schema.Top, value: Fixture): boolean =>
  // SAFETY: the fixture schemas are all service-free, which `Schema.Top` cannot
  // say; the widening is the only way to hand one to the decoder generically.
  Schema.decodeUnknownExit(schema as never)(value)._tag === "Success";

/**
 * A column a seeded row omits, so the row carries no such key (`ColumnValue`
 * has no `undefined`): the "absent" case beside `null` and the typed values.
 */
export const ABSENT: unique symbol = Symbol("absent");
