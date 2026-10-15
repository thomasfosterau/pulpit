/**
 * Shared test helpers: the one wire question every projection case asks,
 * the sentinel for a column a seeded row omits, the fixed clock, the apps'
 * role axes and the accounts the access suites read as. The seams' in-memory
 * fakes are the package's own `./testing` (`src/testing.ts`).
 *
 * @module tests/fixtures
 */

import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { AccessPolicy, ViewerAccount } from "../src/subtype.ts";

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

/** A fixed clock for the publication predicates and the in-memory stores' `now`. */
export const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-09-18T00:00:00.000Z"));

/** gardeneria's ladder, compared the one way it allows: fail closed on an unknown role. */
const LADDER = ["user", "contributor", "moderator", "admin"] as const;
const rank = (role: string) => LADDER.findIndex((rung) => rung === role);
const atLeast = (min: (typeof LADDER)[number]) => (account: ViewerAccount) =>
  rank(account.role) >= 0 && rank(account.role) >= rank(min);

/** gardeneria's axes: moderator+ sees private and deleted rows and moderates; contributor+ writes the corpus. */
export const gardeneriaPolicy: AccessPolicy = {
  canViewPrivate: atLeast("moderator"),
  canViewDeleted: atLeast("moderator"),
  canModerate: atLeast("moderator"),
  canWriteCorpus: atLeast("contributor"),
};

/** website's axes: admin alone sees private and deleted rows. */
export const websitePolicy: AccessPolicy = {
  canViewPrivate: atLeast("admin"),
  canViewDeleted: atLeast("admin"),
  canModerate: atLeast("admin"),
  canWriteCorpus: atLeast("contributor"),
};

export const member: ViewerAccount = { id: "u-member", role: "user" };
export const otherMember: ViewerAccount = { id: "u-other", role: "user" };
export const follower: ViewerAccount = { id: "u-follower", role: "user" };
export const contributor: ViewerAccount = { id: "u-contributor", role: "contributor" };
export const moderator: ViewerAccount = { id: "u-moderator", role: "moderator" };
export const admin: ViewerAccount = { id: "u-admin", role: "admin" };
