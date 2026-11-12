/**
 * The fixture tree the unit and integration suites share: one branch with a
 * plain leaf (`notes`: the columns the kernel's `versionChainConformance`
 * writes, and a keyed `locale` level), a sibling leaf (`links`) whose nodes
 * a `notes` port must never touch, and an owned leaf (`posts`: the owned
 * access axes and one column of every orderable type, for the leaf store's
 * filter and order). Its tables live in the `pulpit_test` schema, the
 * identity table carries a `slug` extra, and the root version table records
 * `proposedBy`.
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import { makeDocumentTable } from "@thomasfosterau/pulpit-drizzle-pg/documents";
import { makeNodeOwnerTable } from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
import { boolean, doublePrecision, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";

const nullableText = (column: string) =>
  dbColumn(Schema.NullOr(Schema.String), { column, pg: "text", notNull: false });

const column = <S extends Schema.Top>(schema: S, name: string, pg: string) =>
  dbColumn(Schema.NullOr(schema), { column: name, pg, notNull: false });

export const tree = defineTree({
  entry: { columns: { title: nullableText("title") } },
  notes: {
    parent: "entry",
    leaf: { body: nullableText("body"), summary: nullableText("summary") },
    keyed: { name: "locale", columns: { heading: nullableText("heading") } },
  },
  links: { parent: "entry", leaf: { href: nullableText("href") } },
  posts: {
    parent: "entry",
    leaf: {
      visibility: nullableText("visibility"),
      draft: column(Schema.Boolean, "draft", "boolean"),
      groupId: nullableText("group_id"),
      rank: column(Schema.Finite, "rank", "integer"),
      score: column(Schema.Finite, "score", "double"),
      publishedAt: column(Schema.Date, "published_at", "timestamptz"),
    },
  },
});

/** The column builders the fixture's `pg` kinds name. */
export const builders = {
  text: (name: string) => text(name),
  boolean: (name: string) => boolean(name),
  integer: (name: string) => integer(name),
  double: (name: string) => doublePrecision(name),
  timestamptz: (name: string) => timestamp(name, { withTimezone: true }),
};

export const schema = pgSchema("pulpit_test");

export const tables = makeTreeTables(tree, {
  schema,
  builders,
  root: {
    identityColumns: { slug: text("slug") },
    versionColumns: { proposedBy: text("proposed_by") },
  },
});

export const views = makeTreeViews(tree, tables, { schema });

/** A document family's table, keyed by the generated hash. */
export const documents = makeDocumentTable({ schema, name: "block_documents" });

/** The owner table the leaf stores read and stamp. */
export const owners = makeNodeOwnerTable({ schema, identity: tables.root.identity });

/** The same tree without the `proposedBy` extra. */
export const plainTables = makeTreeTables(tree, {
  schema: pgSchema("pulpit_plain"),
  builders,
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
  postsStable: tables.levels.posts.stable,
  postsVersion: tables.levels.posts.version,
  owners,
  documents,
  notesView: views.leaves.notes,
  linksView: views.leaves.links,
  postsView: views.leaves.posts,
  notesLocaleView: views.keyed.notes,
};
