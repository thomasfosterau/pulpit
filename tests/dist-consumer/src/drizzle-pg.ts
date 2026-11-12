/**
 * A consumer's view of `@thomasfosterau/pulpit-drizzle-pg` through its
 * EMITTED declarations (`paths` in tsconfig.check.json points the name at
 * `dist/*.d.ts`), as `wordpress.ts` is for the WordPress adapter. Each export
 * is asserted EXACTLY (`Equals`, two-way) against a tree built the way an
 * application builds one, because a one-way check passes `any`. Never
 * executed; type-checked only.
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import * as DrizzlePg from "@thomasfosterau/pulpit-drizzle-pg";
import {
  makeVersionChains,
  type ChainQueryError,
  type VersionChains,
  type VersionChainTables,
} from "@thomasfosterau/pulpit-drizzle-pg/version-chain";
import type { VersionChain } from "@thomasfosterau/pulpit/version-chain";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { pgSchema, text } from "drizzle-orm/pg-core";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>(value: X) => X extends A ? 1 : 2) extends <X>(value: X) => X extends B ? 1 : 2
    ? true
    : false;
/** Whether `A` is assignable to `B`. */
type Satisfies<A, B> = [A] extends [B] ? true : false;

// ── the root barrel ──────────────────────────────────────────────────────

export type _Root = Assert<Equals<keyof typeof DrizzlePg, "VersionChain">>;
export type _RootChains = Assert<
  Equals<typeof DrizzlePg.VersionChain.makeVersionChains, typeof makeVersionChains>
>;

// ── ./version-chain ──────────────────────────────────────────────────────

const tree = defineTree({
  post: {
    leaf: {
      title: dbColumn(Schema.NullOr(Schema.String), {
        column: "title",
        pg: "text",
        notNull: false,
      }),
    },
  },
  page: {
    leaf: {
      slug: dbColumn(Schema.NullOr(Schema.String), { column: "slug", pg: "text", notNull: false }),
    },
  },
});
const tables = makeTreeTables(tree, {
  schema: pgSchema("content"),
  builders: { text: (column: string) => text(column) },
});
const database = makePgDatabase({ relations: {}, key: "Database" });
const chains = makeVersionChains({ tree, tables, CurrentTransaction: database.CurrentTransaction });

type Key = typeof database.CurrentTransaction.Identifier;

export type _Tables = Assert<Satisfies<typeof tables, VersionChainTables>>;
export type _Chains = Assert<
  Equals<typeof chains, VersionChains<"post" | "page", EffectDrizzleQueryError, Key>>
>;
export type _Port = Assert<
  Equals<(typeof chains)["post"], VersionChain<EffectDrizzleQueryError, Key>>
>;
export type _QueryError = Assert<
  Equals<
    ChainQueryError<{
      readonly head: (id: string) => Effect.Effect<unknown, EffectDrizzleQueryError, Key>;
    }>,
    EffectDrizzleQueryError
  >
>;
export type _VersionChains = Assert<
  Equals<VersionChains<"a", never, never>, { readonly a: VersionChain<never, never> }>
>;
