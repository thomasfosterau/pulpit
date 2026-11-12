/**
 * The kernel's `versionChainConformance` against PostgreSQL: the `notes`
 * leaf's `VersionChain` port from `makeVersionChains`, over the fixture tree's
 * real tables. Each case starts from truncated tables, and each operation
 * runs (and commits) in a transaction of its own, so the suite's
 * two-concurrent-writers case races two real transactions on the root
 * version table's `(id, version)` key.
 *
 * The harness's faults are real rows: `dropState` deletes the leaf level's
 * version row (a partial chain), and `raceNextAppend` arms the setup's race
 * switch, so the next identity or root version insert for the node fails
 * with the unique violation a concurrent writer would raise.
 */

import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import { versionChainConformance } from "@thomasfosterau/pulpit/testing";
import { and, eq, getTableName, sql } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeVersionChains } from "../../src/version-chain.ts";
import { tables, tree } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitIntegrationDatabase" });
const { CurrentTransaction, transact } = database;

// The URL the global setup provisioned. Four connections, so the
// concurrent-writers case runs two transactions at once.
const client = Layer.unwrap(
  Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
    pgClientFromUrl({ url, maxConnections: 4 }),
  ),
);
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(client),
    // An unreachable database fails every case loudly, as a defect.
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const chains = makeVersionChains({ tree, tables, CurrentTransaction });

/** Run `effect` in a committed transaction of its own; a failed connection or commit is a defect. */
const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromiseExit(
    transact(effect).pipe(
      Effect.catchIf(
        (error) => P.isTagged(error, "SqlError"),
        (error) => Effect.die(error),
      ),
    ),
  );

/** Run a statement to completion, failing the case on any error. */
const exec = (effect: Effect.Effect<unknown, unknown, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromise(Effect.asVoid(transact(effect)));

const truncate = () =>
  exec(
    Effect.flatMap(CurrentTransaction, (tx) =>
      tx.execute(
        sql.raw(
          `TRUNCATE pulpit_test.${getTableName(tables.root.identity)}, pulpit_test.race CASCADE`,
        ),
      ),
    ),
  );

versionChainConformance(
  {
    type: "notes",
    make: async () => {
      await truncate();
      return {
        chain: chains.notes,
        dropState: (id, version) =>
          exec(
            Effect.flatMap(CurrentTransaction, (tx) =>
              tx
                .delete(tables.levels.notes.version)
                .where(
                  and(
                    eq(tables.levels.notes.version.id, id),
                    eq(tables.levels.notes.version.version, version),
                  ),
                ),
            ),
          ),
        raceNextAppend: (id) =>
          exec(
            Effect.flatMap(CurrentTransaction, (tx) =>
              tx.execute(sql`INSERT INTO pulpit_test.race (id) VALUES (${id})`),
            ),
          ),
      };
    },
    run,
  },
  { describe, it, expect },
);

describe("makeVersionChains over PostgreSQL — beyond the conformance suite", () => {
  const ID = "00000000-0000-4000-8000-0000000000a1";
  const actorId = Option.some("u-editor");
  const value = async <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
    runtime.runPromise(transact(effect));

  it("records actorId and proposedBy on the root version row", async () => {
    await truncate();
    await value(chains.notes.create({ id: Option.some(ID), state: { title: "A" }, actorId }));
    await value(
      chains.notes.update({
        id: ID,
        patch: { title: "B" },
        actorId,
        proposedBy: Option.some("u-contributor"),
      }),
    );
    const rows = await value(
      Effect.flatMap(CurrentTransaction, (tx) =>
        tx
          .select({
            version: tables.root.version.version,
            actor: tables.root.version.actor,
            proposedBy: tables.root.version.proposedBy,
          })
          .from(tables.root.version)
          .where(eq(tables.root.version.id, ID))
          .orderBy(tables.root.version.version),
      ),
    );
    expect(rows).toEqual([
      { version: 0n, actor: "u-editor", proposedBy: null },
      { version: 1n, actor: "u-editor", proposedBy: "u-contributor" },
    ]);
  });

  it("purge is scoped to the leaf: another leaf's node with the id survives", async () => {
    await truncate();
    await value(chains.links.create({ id: Option.some(ID), state: { href: "/x" }, actorId }));
    await value(chains.notes.purge(ID));
    expect(Option.isSome(await value(chains.links.head(ID)))).toBe(true);
    await value(chains.links.purge(ID));
    expect(await value(chains.links.head(ID))).toEqual(Option.none());
  });

  it("a leaf's port never reads another leaf's node", async () => {
    await truncate();
    await value(chains.links.create({ id: Option.some(ID), state: { href: "/x" }, actorId }));
    expect(await value(chains.notes.head(ID))).toEqual(Option.none());
    const exit = await run(chains.notes.update({ id: ID, patch: {}, actorId }));
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("NodeNotFound");
  });
});
