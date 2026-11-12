/**
 * The integration suite's global setup: provisions a fresh PostgreSQL
 * database with `-pg/testing`'s `provisionTestDatabase` (an explicit
 * `DATABASE_URL_TEST`, else the local server the `PG*` variables name, else a
 * Testcontainers container), creates the fixture tree's tables from its
 * Drizzle schema with drizzle-kit's programmatic API (so the fixture has no
 * committed migrations to drift), and publishes the URL as
 * `DATABASE_URL_TEST` to the suites.
 *
 * Beside the tree's DDL it installs the conformance harness's race switch: a
 * `race` table whose row for a node makes that node's next identity or root
 * version insert raise the unique violation a concurrent writer would, with
 * the real constraint name, so `-pg/chain` reports it exactly as it reports a
 * lost race.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyMigrationList } from "@thomasfosterau/effect-drizzle-ext-pg/migrations";
import { provisionTestDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/testing";
import * as PgClient from "@effect/sql-pg/PgClient";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { getTableName } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { fixtureSchema, tables } from "../fixtures/tree.ts";

/** The fixture tree's DDL: drizzle-kit's diff from an empty database. */
const treeStatements = Effect.tryPromise(async () =>
  generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(fixtureSchema)),
);

const identity = `pulpit_test.${getTableName(tables.root.identity)}`;
const rootVersion = `pulpit_test.${getTableName(tables.root.version)}`;

/** The race switch (see the module doc). */
/** The follower and membership tables the leaf-store suite's seams read as subqueries. */
const seamStatements = [
  "CREATE TABLE pulpit_test.follows (follower_id text NOT NULL, owner_id text NOT NULL)",
  "CREATE TABLE pulpit_test.memberships (account_id text NOT NULL, group_id text NOT NULL)",
];

const raceStatements = [
  "CREATE TABLE pulpit_test.race (id uuid PRIMARY KEY)",
  `CREATE FUNCTION pulpit_test.race() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pulpit_test.race WHERE id = NEW.id) THEN
    RAISE unique_violation USING CONSTRAINT = TG_ARGV[0], MESSAGE = 'simulated concurrent writer';
  END IF;
  RETURN NEW;
END $$`,
  `CREATE TRIGGER race BEFORE INSERT ON ${identity} FOR EACH ROW EXECUTE FUNCTION pulpit_test.race('${getTableName(tables.root.identity)}_pkey')`,
  `CREATE TRIGGER race BEFORE INSERT ON ${rootVersion} FOR EACH ROW EXECUTE FUNCTION pulpit_test.race('${getTableName(tables.root.version)}_pkey')`,
];

export default async function setup() {
  const scope = Scope.makeUnsafe();
  const database = await Effect.runPromise(
    provisionTestDatabase({
      env: process.env,
      migrationsDir: import.meta.dirname,
      dbNamePrefix: "pulpit_drizzle_pg",
      image: "postgres:17",
      applyMigrations: (url) =>
        Effect.flatMap(treeStatements, (statements) =>
          applyMigrationList([
            { name: "fixture-tree", statements },
            { name: "race-switch", statements: raceStatements },
            { name: "seams", statements: seamStatements },
          ]),
        ).pipe(Effect.provide(PgClient.layer({ url, maxConnections: 1 }))),
    }).pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );
  process.env.DATABASE_URL_TEST = Redacted.value(database.url);
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}
