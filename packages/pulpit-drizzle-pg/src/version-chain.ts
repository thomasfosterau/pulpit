/**
 * @copyright Thomas Foster
 *
 * The kernel's `VersionChain` port (pulpit#246) over effect-drizzle-ext
 * `-pg/chain` (pulpit#247): one port per leaf of an application's tree,
 * written straight over the tables `makeTreeTables` derives from it.
 *
 * Every operation but `purge` is `-pg/chain`'s own, so every invariant of the
 * kernel's `./version-chain` (append-only, never an upsert, no resurrection
 * by a plain update, no partial restore, bounded history, and the
 * expected-version precondition checked against the head the append
 * extends) is held by the chain; this module maps the kernel's inputs onto
 * it and its tagged errors one to one onto the kernel's. `purge` deletes the
 * node's identity row, which cascades through every level of its chain
 * (effect-drizzle-ext#145): the erasure's one write (`VERSION-CHAIN-001/002`'s
 * documented exception). No operation opens a transaction: each requires the
 * application's `CurrentTransaction`, as the kernel's `R`.
 *
 * @since 0.0.0
 */

import {
  makeVersionChain,
  type ChainTables,
  type ChainTree,
} from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { VersionChain } from "@thomasfosterau/pulpit/version-chain";
import { and, eq, getTableColumns, type AnyRelations } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { fromLeafChain, type ErasedLeafChain } from "./internal/leaf-chain.ts";

/**
 * The query failure a `-pg/chain` leaf chain reports: the driver's own
 * error (drizzle's `EffectDrizzleQueryError`).
 *
 * @since 0.0.0
 */
export type ChainQueryError<C> = C extends {
  readonly head: (id: string) => Effect.Effect<unknown, infer E, unknown>;
}
  ? E
  : never;

/**
 * Every leaf's kernel {@link VersionChain} port, keyed by leaf name, as
 * {@link makeVersionChains} returns them: `E` the driver's query error, `I`
 * the application's `CurrentTransaction` key.
 *
 * @since 0.0.0
 */
export type VersionChains<Leaf extends string, E, I> = {
  readonly [K in Leaf]: VersionChain<E, I>;
};

/**
 * The tables {@link makeVersionChains} reads: `makeTreeTables`' output, whose
 * identity table carries the `id` and leaf `type` columns `purge` deletes by.
 *
 * @since 0.0.0
 */
export interface VersionChainTables extends ChainTables {
  readonly root: ChainTables["root"] & {
    readonly identity: ChainTables["root"]["identity"] & {
      readonly id: AnyPgColumn;
      readonly type: AnyPgColumn;
    };
  };
}

/**
 * Bind the kernel's `VersionChain` port to every leaf of a tree: `-pg/chain`'s
 * `makeVersionChain` over the same `{ tree, tables, CurrentTransaction }`,
 * each leaf's chain mapped onto the port.
 *
 * - `create` / `update` / `restore` / `delete` / `restoreVersion` /
 *   `getVersion` / `history` / `head` are the chain's, with its errors mapped
 *   one to one (`NodeAlreadyExists`, `NodeNotFound`, `VersionNotFound`,
 *   `StaleVersion`, `VersionConflict`; `BrokenChain` stays a defect). State
 *   is keyed by Drizzle field key across the leaf's whole path, and a key
 *   that names no column of it is not stored.
 * - `actorId` is the root version row's actor; `locales` the leaf's keyed
 *   level (`keyed: { name: "locale", … }` in the tree), which `getVersion`
 *   returns as `locales`, omitting the key for a version that carries none.
 * - `proposedBy` is the root version row's `proposedBy` extra: declare it in
 *   `makeTreeTables`' `root.versionColumns` to accept proposals. An update
 *   that carries one over a tree without that column dies, rather than
 *   dropping the contributor.
 * - `purge(id)` deletes the node's identity row, scoped to the leaf, which
 *   cascades through every level of its chain; a no-op for an unknown id or
 *   another leaf's node.
 *
 * Throws effect-drizzle-ext's `DerivationError` at module load when the
 * tables were not built from the tree (`-pg/chain`'s own check).
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
 * import { makeVersionChains } from "@thomasfosterau/pulpit-drizzle-pg/version-chain";
 * import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
 * import { pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Option from "effect/Option";
 * import * as Schema from "effect/Schema";
 *
 * const title = dbColumn(Schema.NullOr(Schema.String), { column: "title", pg: "text", notNull: false });
 * const tree = defineTree({ post: { leaf: { title } } });
 * const tables = makeTreeTables(tree, {
 *   schema: pgSchema("content"),
 *   builders: { text: (column: string) => text(column) },
 *   root: { versionColumns: { proposedBy: text("proposed_by") } },
 * });
 * const { CurrentTransaction, transact } = makePgDatabase({ relations: {}, key: "Database" });
 *
 * const chains = makeVersionChains({ tree, tables, CurrentTransaction });
 * const posts = defineVersionChain("post", chains.post);
 *
 * // An Effect requiring the database; run it with the application's layer.
 * const created = transact(
 *   posts.create({ id: Option.none(), state: { title: "Hello" }, actorId: Option.none() }),
 * );
 * deepStrictEqual(Object.keys(chains), ["post"]);
 * deepStrictEqual(typeof created, "object");
 * ```
 *
 * @since 0.0.0
 */
export const makeVersionChains = <
  S,
  T extends VersionChainTables,
  I,
  Relations extends AnyRelations,
>(config: {
  readonly tree: ChainTree<S>;
  readonly tables: T;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}) => {
  const chains = makeVersionChain(config);
  type Chains = typeof chains;
  type E = ChainQueryError<Chains[keyof Chains]>;
  const { CurrentTransaction, tables } = config;
  const identity = tables.root.identity;
  const recordsProposedBy = R.has(getTableColumns(tables.root.version), "proposedBy");

  const purge = (leaf: string) =>
    Effect.fn(`${leaf}.purge`)(function* (id: string) {
      const tx = yield* CurrentTransaction;
      yield* tx.delete(identity).where(and(eq(identity.id, id), eq(identity.type, leaf)));
    });

  // SAFETY: the kernel's state is untyped by design (a leaf's `Resource`
  // schema validates it above the port), so each typed leaf chain is read as
  // its erased form: the same runtime operations, over the same field keys
  // (`ErasedLeafChain`); only the per-leaf precision is dropped.
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any -- the seam above: each leaf's typed operations take its own state, the erased ones the kernel's `ChainState`, so the two share no overlap TypeScript can check (effect-drizzle-ext's `makeVersionChain` crosses the same seam the other way)
  const erased = chains as unknown as Readonly<Record<string, ErasedLeafChain<E, I>>>;
  const ports = R.map(erased, (chain, leaf) =>
    fromLeafChain(chain, { type: leaf, purge: purge(leaf), recordsProposedBy }),
  );
  // SAFETY: `ports` has exactly `chains`' keys, the tree's leaves.
  return ports as VersionChains<keyof Chains & string, E, I>;
};
