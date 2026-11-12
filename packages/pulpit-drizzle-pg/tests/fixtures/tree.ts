/**
 * The fixture tree the unit and integration suites share: one branch with a
 * plain leaf (`notes`: the columns the kernel's `versionChainConformance`
 * writes, and a keyed `locale` level) and a sibling leaf (`links`) whose
 * nodes a `notes` port must never touch. Its tables live in the `pulpit_test`
 * schema, and the root version table records `proposedBy`.
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import { pgSchema, text } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";

const nullableText = (column: string) =>
  dbColumn(Schema.NullOr(Schema.String), { column, pg: "text", notNull: false });

export const tree = defineTree({
  entry: { columns: { title: nullableText("title") } },
  notes: {
    parent: "entry",
    leaf: { body: nullableText("body"), summary: nullableText("summary") },
    keyed: { name: "locale", columns: { heading: nullableText("heading") } },
  },
  links: { parent: "entry", leaf: { href: nullableText("href") } },
});

export const schema = pgSchema("pulpit_test");

export const tables = makeTreeTables(tree, {
  schema,
  builders: { text: (column: string) => text(column) },
  root: { versionColumns: { proposedBy: text("proposed_by") } },
});

/** The same tree without the `proposedBy` extra. */
export const plainTables = makeTreeTables(tree, {
  schema: pgSchema("pulpit_plain"),
  builders: { text: (column: string) => text(column) },
});

export const database = makePgDatabase({ relations: {}, key: "PulpitTestDatabase" });

/**
 * Every table of `tables` by name, plus their schema: the module shape
 * drizzle-kit's `generateDrizzleJson` reads (the integration setup's DDL).
 */
export const fixtureSchema = {
  schema,
  identity: tables.root.identity,
  rootVersion: tables.root.version,
  entryStable: tables.levels.entry.stable,
  entryVersion: tables.levels.entry.version,
  notesStable: tables.levels.notes.stable,
  notesVersion: tables.levels.notes.version,
  notesLocale: tables.keyed.notes,
  linksStable: tables.levels.links.stable,
  linksVersion: tables.levels.links.version,
};
