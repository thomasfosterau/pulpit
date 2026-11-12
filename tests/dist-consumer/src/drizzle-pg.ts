/**
 * A consumer's view of `@thomasfosterau/pulpit-drizzle-pg` through its
 * EMITTED declarations (`paths` in tsconfig.check.json points the name at
 * `dist/*.d.ts`), as `wordpress.ts` is for the WordPress adapter. Each export
 * is asserted EXACTLY (`Equals`, two-way) against a tree built the way an
 * application builds one, because a one-way check passes `any`. Never
 * executed; type-checked only.
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import * as DrizzlePg from "@thomasfosterau/pulpit-drizzle-pg";
import {
  makeVersionChains,
  type ChainQueryError,
  type VersionChains,
  type VersionChainTables,
} from "@thomasfosterau/pulpit-drizzle-pg/version-chain";
import type { VersionChain } from "@thomasfosterau/pulpit/version-chain";
import type { ListFilter } from "@thomasfosterau/pulpit/filter";
import type {
  LeafRow,
  LeafStore,
  ListOrder,
  LiveView,
  PublicationStore,
} from "@thomasfosterau/pulpit/subtype";
import {
  makePublications,
  type Publications,
  type PublishGated,
} from "@thomasfosterau/pulpit-drizzle-pg/publication";
import {
  makeLeafStores,
  makeNodeOwnerTable,
  OWNER_COLUMN,
  type LeafStores,
  type NodeOwnerTable,
} from "@thomasfosterau/pulpit-drizzle-pg/leaf-store";
import {
  distinctKey,
  renderListFilter,
  renderListOrder,
  type FilterColumn,
  type FilterColumns,
} from "@thomasfosterau/pulpit-drizzle-pg/filter";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  makePathStore,
  makePathTable,
  type PathTable,
} from "@thomasfosterau/pulpit-drizzle-pg/paths";
import type { PathStore } from "@thomasfosterau/pulpit/paths";
import {
  makeDocumentStore,
  makeDocumentTable,
  type DocumentTable,
} from "@thomasfosterau/pulpit-drizzle-pg/documents";
import type { DocumentStore } from "@thomasfosterau/pulpit/documents";
import type { SearchBranch } from "@thomasfosterau/pulpit/search";
import type { CloseValidity, EdgeRow, EdgeStore } from "@thomasfosterau/pulpit/edges";
import {
  makeEdgeStore,
  makeEdgeTable,
  type EdgeStoreEnd,
} from "@thomasfosterau/pulpit-drizzle-pg/edges";
import type { ProposalStore } from "@thomasfosterau/pulpit/proposals";
import type { ExternalIdStore } from "@thomasfosterau/pulpit/reference-import";
import {
  makeExternalIdStore,
  makeExternalIdTable,
  type ExternalIdTable,
} from "@thomasfosterau/pulpit-drizzle-pg/external-ids";
import {
  makeProposalStore,
  makeProposalTable,
  type ProposalTable,
} from "@thomasfosterau/pulpit-drizzle-pg/proposals";
import {
  fullTextRank,
  makeSearchBranch,
  type SearchBranchOptions,
  type SearchRank,
} from "@thomasfosterau/pulpit-drizzle-pg/search";
import type * as Option from "effect/Option";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { pgSchema, text, type PgView } from "drizzle-orm/pg-core";
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

export type _Root = Assert<
  Equals<
    keyof typeof DrizzlePg,
    | "VersionChain"
    | "LeafStore"
    | "Filter"
    | "Publication"
    | "Documents"
    | "Paths"
    | "Search"
    | "Edges"
    | "Proposals"
    | "ExternalIds"
  >
>;
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
  root: { pointers: ["live"] },
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

// ── ./leaf-store ─────────────────────────────────────────────────────────

const schema = pgSchema("content");
const owners = makeNodeOwnerTable({ schema, identity: tables.root.identity });
const treeViews = makeTreeViews(tree, tables, { schema, pointers: { live: ["post"] } });
const stores = makeLeafStores({
  tree,
  tables,
  views: treeViews,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});

export type _Owners = Assert<Equals<typeof owners, NodeOwnerTable>>;
export type _OwnerColumn = Assert<Equals<typeof OWNER_COLUMN, "ownerId">>;
export type _Stores = Assert<
  Equals<typeof stores, LeafStores<"post" | "page", EffectDrizzleQueryError, Key>>
>;
export type _Store = Assert<
  Equals<(typeof stores)["post"], LeafStore<LeafRow, SQLWrapper, EffectDrizzleQueryError, Key>>
>;

// A localised leaf's store reads its keyed view (`makeTreeViews`' `keyed`).
export type _KeyedViews = Assert<
  Equals<
    Required<Parameters<typeof makeLeafStores>[0]["views"]>["keyed"],
    { readonly [leaf: string]: PgView }
  >
>;

// ── ./filter ─────────────────────────────────────────────────────────────

export type _Render = Assert<
  Equals<
    typeof renderListFilter,
    (filter: ListFilter<SQLWrapper>, columns: FilterColumns) => Option.Option<SQL>
  >
>;
export type _RenderOrder = Assert<
  Equals<
    typeof renderListOrder,
    (
      orderBy: ReadonlyArray<ListOrder>,
      columns: FilterColumns,
      id: FilterColumn,
    ) => ReadonlyArray<SQL>
  >
>;
export type _DistinctKey = Assert<
  Equals<typeof distinctKey, (column: FilterColumn) => Option.Option<SQL>>
>;

// ── ./publication ────────────────────────────────────────────────────────

const publications = makePublications({
  views: treeViews,
  pointer: "live",
  log: tables.pointers.live,
  live: treeViews.pointers.live.leaves,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});

// A localised gated leaf names its keyed head and pointer views (pulpit#343).
export type _PublicationsKeyed = Assert<
  Equals<
    Required<Parameters<typeof makePublications>[0]>["keyed"],
    {
      readonly views: { readonly [leaf: string]: PgView };
      readonly live: { readonly [leaf: string]: PgView };
    }
  >
>;
export type _Publications = Assert<
  Equals<typeof publications, Publications<"post", EffectDrizzleQueryError, Key>>
>;
export type _PublishGated = Assert<
  Equals<
    PublishGated<EffectDrizzleQueryError, Key>,
    {
      readonly facts: PublicationStore<EffectDrizzleQueryError, Key>;
      readonly live: LiveView<LeafRow, SQLWrapper, EffectDrizzleQueryError, Key>;
      readonly leaves: LeafStore<LeafRow, SQLWrapper, EffectDrizzleQueryError, Key>;
      readonly searchBranch: (
        options: SearchBranchOptions,
      ) => SearchBranch<SQLWrapper, EffectDrizzleQueryError, Key>;
    }
  >
>;

// ── ./documents ──────────────────────────────────────────────────────────

const blocks = makeDocumentTable({ schema, name: "block_documents" });
const Block = Schema.Struct({ type: Schema.String });
const blockStore = makeDocumentStore({
  table: blocks,
  document: Block,
  CurrentTransaction: database.CurrentTransaction,
});

export type _DocumentTable = Assert<Equals<typeof blocks, DocumentTable>>;
export type _DocumentStore = Assert<
  Equals<typeof blockStore, DocumentStore<typeof Block.Type, EffectDrizzleQueryError, Key>>
>;

// ── ./paths ──────────────────────────────────────────────────────────────

const pagePaths = makePathTable({ schema, name: "page_paths", identity: tables.root.identity });
const pathStore = makePathStore({
  table: pagePaths,
  CurrentTransaction: database.CurrentTransaction,
});

export type _PathTable = Assert<Equals<typeof pagePaths, PathTable>>;
export type _PathStore = Assert<Equals<typeof pathStore, PathStore<EffectDrizzleQueryError, Key>>>;

// ── ./search ─────────────────────────────────────────────────────────────

const textBranch = makeSearchBranch({
  view: treeViews.leaves.post,
  owners,
  name: "text",
  rank: fullTextRank({ vector: () => sql`to_tsvector('simple', '')` }),
  CurrentTransaction: database.CurrentTransaction,
});

export type _SearchBranch = Assert<
  Equals<typeof textBranch, SearchBranch<SQLWrapper, EffectDrizzleQueryError, Key>>
>;
export type _SearchRank = Assert<
  Equals<
    SearchRank,
    (
      columns: FilterColumns,
      query: string,
    ) => Option.Option<{ readonly matches: SQL; readonly score: SQL }>
  >
>;
export type _SearchBranchOptions = Assert<
  Equals<
    SearchBranchOptions,
    { readonly name: string; readonly weight?: number; readonly rank: SearchRank }
  >
>;

// ── ./edges ──────────────────────────────────────────────────────────────

const related = makeEdgeTable({
  schema,
  name: "related",
  identity: tables.root.identity,
  ends: { fromId: "from_id", toId: "to_id" },
  columns: { role: text("role") },
  uniqueKey: ["fromId", "toId", "role"],
});
const edgeStore = makeEdgeStore({
  table: related,
  ends: {
    from: { column: "fromId", view: treeViews.leaves.post },
    to: { column: "toId", view: treeViews.leaves.post },
  },
  uniqueKey: ["fromId", "toId", "role"],
  identity: tables.root.identity,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});

export type _EdgeStore = Assert<
  Equals<
    typeof edgeStore,
    EdgeStore<EdgeRow, SQLWrapper, EffectDrizzleQueryError, Key> & {
      readonly closeValidity: CloseValidity<EffectDrizzleQueryError, Key>;
    }
  >
>;
export type _EdgeStoreEnd = Assert<
  Equals<EdgeStoreEnd, { readonly column: string; readonly view: PgView }>
>;

// ── ./proposals ──────────────────────────────────────────────────────────

const proposalTable = makeProposalTable({ schema, root: tables.root });
const proposalStore = makeProposalStore({
  table: proposalTable,
  root: tables.root,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});

export type _ProposalTable = Assert<Equals<typeof proposalTable, ProposalTable>>;
export type _ProposalStore = Assert<
  Equals<typeof proposalStore, ProposalStore<EffectDrizzleQueryError, Key>>
>;

// ── ./external-ids ───────────────────────────────────────────────────────

const externalIdTable = makeExternalIdTable({ schema, identity: tables.root.identity });
const externalIdStore = makeExternalIdStore({
  table: externalIdTable,
  CurrentTransaction: database.CurrentTransaction,
});

export type _ExternalIdTable = Assert<Equals<typeof externalIdTable, ExternalIdTable>>;
export type _ExternalIdStore = Assert<
  Equals<typeof externalIdStore, ExternalIdStore<EffectDrizzleQueryError, Key>>
>;
