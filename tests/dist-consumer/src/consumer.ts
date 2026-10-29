/**
 * A consumer's view of the package: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package name at
 * `dist/*.d.ts`). Each block exercises the types a real consumer depends on,
 * so a declaration that degrades to `any` fails here rather than in an
 * application. Never executed; type-checked only.
 */

import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import {
  Blobs,
  Budgets,
  Comments,
  Content,
  Documents,
  Edges,
  Paths,
  Purge,
  Moderation,
  Search,
  Proposals,
  Registry,
  WorkingCopy,
} from "@thomasfosterau/pulpit";
import {
  ContentResource,
  contentVisibilityResourceFields,
  makeContentResource,
  ownedContentLeafResourceFields,
  ownerRef,
  Visibility,
} from "@thomasfosterau/pulpit/content";
import {
  flaggedMembers,
  parent,
  registryWireTypes,
  root,
  validateRegistry,
  type RegistryEntry,
} from "@thomasfosterau/pulpit/registry";
import {
  defineVersionChain,
  diffLocales,
  diffStates,
  type AttributeChange,
  type LocaleChange,
  type LocaleDiff,
  type LocaleStates,
  type ChainState,
  type ChainWrite,
  type NodeAlreadyExists,
  type NodeNotFound,
  type Precondition,
  type StaleVersion,
  type StateDiff,
  type VersionChainOps,
  type VersionChainStore,
  type VersionComparison,
  type VersionConflict,
  type VersionNotFound,
  type VersionSnapshot,
} from "@thomasfosterau/pulpit/version-chain";
import {
  always,
  and,
  anyOf,
  eq,
  evaluate,
  gt,
  gte,
  isIn,
  isNotIn,
  lt,
  lte,
  MAX_SET_VALUES,
  ne,
  never,
  noneOf,
  isNull,
  locale,
  LOCALE_COLUMN,
  notPublished,
  or,
  published,
  type Comparable,
  type EvaluationContext,
  type FilterRow,
  type ListFilter,
  type Scalar,
} from "@thomasfosterau/pulpit/filter";
import {
  defineSubtype,
  ownedAccess,
  referencePrivacyFilter,
  type InvalidListOrder,
  type LeafAccess,
  type LeafRow,
  type LeafStore,
  type ListOrder,
  type ListRequest,
  type Page,
  type SubtypeDeclarationError,
  type SubtypeDefinition,
  versionEtag,
  versionMeta,
  type VersionedResource,
  type VersionMeta,
  subtypeResourceHandlers,
  type SubtypeResourceHandlersConfig,
  defineSearchProjection,
  hydrateSearchHits,
  searchScopeFilter,
  type SearchField,
  type SearchProjection,
  type SearchWeight,
  readableOwners,
  type DistinctQuery,
  type OwnerSetTooLarge,
  type OwnersRequest,
} from "@thomasfosterau/pulpit/subtype";
import {
  duePublications,
  isPubliclyServeable,
  serveablePolicy,
} from "@thomasfosterau/pulpit/publication";
import {
  DocumentHash,
  documentRef,
  onDocumentInsert,
  type DocumentPut,
  type DocumentStore,
} from "@thomasfosterau/pulpit/documents";
import {
  defineEdgeOps,
  endpointColumn,
  rungGate,
  type EdgeCardinalityExceeded,
  type EdgeConflict,
  type EdgeDeclarationError,
  type EdgeNotFound,
  type EdgeRow,
  type EdgeValidity,
  type EdgeStore,
  type EdgeWrite,
  type EdgeWriteGate,
  type InvalidValidity,
  validAt,
} from "@thomasfosterau/pulpit/edges";
import type {
  AfterWriteEvent,
  BeforeWriteEvent,
  BeforeWriteHook,
  Forbidden,
  LifecycleHooks,
  Unauthorized,
  WriteRejected,
} from "@thomasfosterau/pulpit/subtype";
import type { ChainPatch, WriteAction } from "@thomasfosterau/pulpit/version-chain";

/** A compile-time assertion: `T` must be exactly `true`. */
import {
  classifyProposalConflict,
  defineProposals,
  type ProposalOps,
  type ProposalRow,
  type ProposalStatus,
} from "@thomasfosterau/pulpit/proposals";
import type { ColumnValue, VersionRow } from "@thomasfosterau/pulpit/version-chain";
import {
  defineModeration,
  gradeScores,
  moderationHook,
  type ModerationGrade,
  type ReportStatus,
} from "@thomasfosterau/pulpit/moderation";

import { defineFileWrites, fileUrl, type FileWrite } from "@thomasfosterau/pulpit/blobs";
import {
  PathNotFound,
  PathTaken,
  routable,
  type PathEntry,
  type PathStore,
  type Resolution,
  type RoutableOps,
} from "@thomasfosterau/pulpit/paths";

import type { PublicationFact, PublicationOps, SubtypeOps } from "@thomasfosterau/pulpit/subtype";
import { defineWorkingCopy } from "@thomasfosterau/pulpit/working-copy";
import { CommentDepthExceeded, defineComments } from "@thomasfosterau/pulpit/comments";
import { definePurge, type PurgeOps, type PurgeReport } from "@thomasfosterau/pulpit/purge";
import {
  embedPending,
  fuseRankings,
  hybridSearch,
  type EmbeddingBatch,
  type EmbeddingMismatch,
  type FusedHit,
  type SearchBranch,
} from "@thomasfosterau/pulpit/search";
import {
  bindBudget,
  budgetHook,
  countingCounter,
  isRateLimited,
  RATE_LIMITED,
  type BoundBudget,
  type BudgetCounter,
  type BudgetRequest,
} from "@thomasfosterau/pulpit/budgets";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// ── content ──────────────────────────────────────────────────────────────

export type _Visibility = Assert<Equals<Visibility, "public" | "followers" | "private">>;
export type _Barrel = Assert<Equals<typeof Content.Visibility, typeof Visibility>>;

const UserResource = Resource.make("users", { attributes: { name: Schema.String } });

export const Post = Resource.make("posts", {
  attributes: {
    ...ownedContentLeafResourceFields,
    ...contentVisibilityResourceFields,
    title: Schema.NonEmptyString,
  },
  relationships: { ...ownerRef(() => UserResource) },
});

// The resource object carries the axes as required, the tombstone as optional.
export type _PostAttributes = Assert<
  Equals<
    typeof Post.Type.attributes,
    {
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly deletedAt?: Date;
      readonly visibility: "public" | "followers" | "private";
      readonly draft: boolean;
      readonly title: string;
    }
  >
>;

// The create input has the axes optional (effect-jsonapi's `"optional"`
// presence: absent, or an explicit `undefined` meaning "not supplied") and
// none of the server-set fields. The `| undefined` members restate what the
// emitted declaration says; they are asserted, not chosen here.
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the upstream projection exactly, and effect-jsonapi's `"optional"` presence is `?: T | undefined` */
export type _PostCreate = Assert<
  Equals<
    typeof Post.createInput.Type,
    {
      readonly visibility?: "public" | "followers" | "private" | undefined;
      readonly draft?: boolean | undefined;
      readonly title: string;
    }
  >
>;
/* oxlint-enable effect/prefer-option-over-null */

// `owner` is a to-one linkage to the supplied family.
export type _Owner = Assert<Equals<typeof Post.relationships.owner.kind, "one">>;

const ContentId = Schema.String.pipe(Schema.brand("ContentId"));
export const Branded = makeContentResource(ContentId);
export type _BrandedId = Assert<Equals<typeof Branded.Id, typeof ContentId>>;
export type _DefaultId = Assert<Equals<typeof ContentResource.type, "content">>;

// ── registry ─────────────────────────────────────────────────────────────

const REGISTRY = [
  { key: "node", parent: root },
  { key: "content", parent: parent("node") },
  { key: "posts", parent: parent("content"), resource: Post, id: Post.Id, owned: true },
] as const satisfies readonly RegistryEntry[];

validateRegistry(REGISTRY);

export const owned = flaggedMembers(REGISTRY, "owned");
export type _Owned = Assert<Equals<typeof owned, readonly [typeof Post]>>;
export type _OwnedBarrel = Assert<
  Equals<ReturnType<typeof Registry.flaggedMembers<typeof REGISTRY, "owned">>, typeof owned>
>;

export const wire = registryWireTypes(REGISTRY, ["content"] as const);
export type _Wire = Assert<
  Equals<typeof wire.branches, { readonly content: ReadonlyArray<string> }>
>;
export type _WireRoutable = Assert<Equals<typeof wire.routable, ReadonlyArray<string>>>;

// ── version-chain ────────────────────────────────────────────────────────

class StoreFailure {
  readonly _tag = "StoreFailure";
}
interface Transaction {
  readonly _tag: "Transaction";
}
declare const store: VersionChainStore<StoreFailure, Transaction>;
export const chain = defineVersionChain("posts", store);
export type _Chain = Assert<Equals<typeof chain, VersionChainOps<StoreFailure, Transaction>>>;
export type _Create = Assert<
  Equals<
    ReturnType<typeof chain.create>,
    Effect.Effect<ChainWrite, StoreFailure | NodeAlreadyExists | VersionConflict, Transaction>
  >
>;
export type _Update = Assert<
  Equals<
    ReturnType<typeof chain.update>,
    Effect.Effect<
      ChainWrite,
      StoreFailure | NodeNotFound | StaleVersion | VersionConflict,
      Transaction
    >
  >
>;
export type _Precondition = Assert<
  // oxlint-disable-next-line effect/prefer-option-over-null -- asserts the emitted declaration keeps the workspace's `?: T | undefined` optional-field convention (AGENTS.md → Conventions)
  Equals<Precondition, { readonly expectedVersion?: bigint | undefined }>
>;
// The whole parameter list, read off a reference signature so the
// precondition is pinned as an optional trailing parameter.
export type _DeletePrecondition = Assert<
  Equals<
    Parameters<typeof chain.delete>,
    Parameters<(id: string, actorId: Option.Option<string>, precondition?: Precondition) => void>
  >
>;
export type _RestoreVersionPrecondition = Assert<
  Equals<
    Parameters<typeof chain.restoreVersion>,
    Parameters<
      (
        id: string,
        version: bigint,
        actorId: Option.Option<string>,
        precondition?: Precondition,
      ) => void
    >
  >
>;
export type _StaleVersionTag = Assert<Equals<StaleVersion["_tag"], "StaleVersion">>;
export type _StaleVersionExpected = Assert<Equals<StaleVersion["expected"], bigint>>;
export type _StaleVersion = Assert<Equals<StaleVersion["current"], bigint>>;
export type _DiffStates = Assert<
  Equals<typeof diffStates, (from: ChainState, to: ChainState) => StateDiff>
>;
export type _StateDiff = Assert<Equals<StateDiff, { readonly [column: string]: AttributeChange }>>;
export type _AttributeChangeTag = Assert<
  Equals<AttributeChange["_tag"], "added" | "removed" | "changed">
>;
export type _Compare = Assert<
  Equals<
    ReturnType<typeof chain.compare>,
    Effect.Effect<VersionComparison, StoreFailure | VersionNotFound, Transaction>
  >
>;
export type _CompareParameters = Assert<
  Equals<Parameters<typeof chain.compare>, [id: string, from: bigint, to: bigint]>
>;
export type _Comparison = Assert<
  Equals<
    VersionComparison,
    {
      readonly from: VersionSnapshot;
      readonly to: VersionSnapshot;
      readonly changes: StateDiff;
      readonly locales: LocaleDiff;
    }
  >
>;
export type _LocaleDiff = Assert<Equals<LocaleDiff, { readonly [locale: string]: LocaleChange }>>;
export type _LocaleChange = Assert<
  Equals<
    LocaleChange,
    | { readonly _tag: "added"; readonly after: ChainState }
    | { readonly _tag: "removed"; readonly before: ChainState }
    | { readonly _tag: "changed"; readonly changes: StateDiff }
  >
>;
export type _DiffLocales = Assert<
  Equals<typeof diffLocales, (from: LocaleStates, to: LocaleStates) => LocaleDiff>
>;

// ── filter + subtype ─────────────────────────────────────────────────────

interface Subquery {
  readonly _tag: "Subquery";
}
export const filter = and<Subquery>(eq("visibility", "public"));
export type _Filter = Assert<Equals<typeof filter, ListFilter<Subquery>>>;
// Each `filter` export is asserted on its own declared type, not only through a
// call: a call on a degraded (unbound, so error-typed) callee yields a result
// that `Equals` cannot tell from the real one (pulpit#139).
export type _Scalar = Assert<Equals<Scalar, string | number | boolean>>;
export type _Comparable = Assert<Equals<Comparable, string | number | Date>>;
export type _MaxSetValues = Assert<Equals<typeof MAX_SET_VALUES, 1000>>;
export type _FilterRow = Assert<Equals<FilterRow, { readonly [column: string]: ColumnValue }>>;
type Never = { readonly kind: "never" };
type Always = { readonly kind: "always" };
type Arm<Kind> = Extract<ListFilter<Subquery>, { readonly kind: Kind }>;
export type _ListFilterKind = Assert<
  Equals<
    ListFilter<Subquery>["kind"],
    | "always"
    | "never"
    | "eq"
    | "ne"
    | "in"
    | "notIn"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "anyOf"
    | "noneOf"
    | "isNull"
    | "published"
    | "notPublished"
    | "locale"
    | "and"
    | "or"
  >
>;
export type _ListFilterLocale = Assert<
  Equals<
    Arm<"locale">,
    {
      readonly kind: "locale";
      readonly column: string;
      readonly locales: ReadonlyArray<string>;
    }
  >
>;
export type _LocaleColumn = Assert<Equals<typeof LOCALE_COLUMN, "locale">>;
export const localeFilter: ListFilter<Subquery> = locale(["en"]);
export type _ListFilterEq = Assert<
  Equals<Arm<"eq">, { readonly kind: "eq"; readonly column: string; readonly value: Scalar }>
>;
export type _ListFilterNe = Assert<
  Equals<Arm<"ne">, { readonly kind: "ne"; readonly column: string; readonly value: Scalar }>
>;
export type _ListFilterGt = Assert<
  Equals<Arm<"gt">, { readonly kind: "gt"; readonly column: string; readonly value: Comparable }>
>;
export type _ListFilterGte = Assert<
  Equals<Arm<"gte">, { readonly kind: "gte"; readonly column: string; readonly value: Comparable }>
>;
export type _ListFilterLt = Assert<
  Equals<Arm<"lt">, { readonly kind: "lt"; readonly column: string; readonly value: Comparable }>
>;
export type _ListFilterLte = Assert<
  Equals<Arm<"lte">, { readonly kind: "lte"; readonly column: string; readonly value: Comparable }>
>;
export type _ListFilterAnyOf = Assert<
  Equals<
    Arm<"anyOf">,
    { readonly kind: "anyOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  >
>;
export type _ListFilterNoneOf = Assert<
  Equals<
    Arm<"noneOf">,
    { readonly kind: "noneOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  >
>;
export type _ListFilterIsNull = Assert<
  Equals<Arm<"isNull">, { readonly kind: "isNull"; readonly column: string }>
>;
export type _ListFilterPublished = Assert<
  Equals<Arm<"published">, { readonly kind: "published"; readonly column: string }>
>;
export type _ListFilterNotPublished = Assert<
  Equals<Arm<"notPublished">, { readonly kind: "notPublished"; readonly column: string }>
>;
export type _ListFilterIn = Assert<
  Equals<Arm<"in">, { readonly kind: "in"; readonly column: string; readonly set: Subquery }>
>;
export type _ListFilterNotIn = Assert<
  Equals<Arm<"notIn">, { readonly kind: "notIn"; readonly column: string; readonly set: Subquery }>
>;
export type _ListFilterAnd = Assert<
  Equals<
    Arm<"and">,
    { readonly kind: "and"; readonly filters: ReadonlyArray<ListFilter<Subquery>> }
  >
>;
export type _ListFilterOr = Assert<
  Equals<Arm<"or">, { readonly kind: "or"; readonly filters: ReadonlyArray<ListFilter<Subquery>> }>
>;
export type _Always = Assert<Equals<typeof always, Always>>;
export type _Never = Assert<Equals<typeof never, Never>>;
export type _Eq = Assert<
  Equals<
    typeof eq,
    (
      column: string,
      value: Scalar,
    ) => Never | { readonly kind: "eq"; readonly column: string; readonly value: Scalar }
  >
>;
export type _Ne = Assert<
  Equals<
    typeof ne,
    (
      column: string,
      value: Scalar,
    ) => Never | { readonly kind: "ne"; readonly column: string; readonly value: Scalar }
  >
>;
export type _Gt = Assert<
  Equals<
    typeof gt,
    (
      column: string,
      value: Comparable,
    ) => Never | { readonly kind: "gt"; readonly column: string; readonly value: Comparable }
  >
>;
export type _Gte = Assert<
  Equals<
    typeof gte,
    (
      column: string,
      value: Comparable,
    ) => Never | { readonly kind: "gte"; readonly column: string; readonly value: Comparable }
  >
>;
export type _Lt = Assert<
  Equals<
    typeof lt,
    (
      column: string,
      value: Comparable,
    ) => Never | { readonly kind: "lt"; readonly column: string; readonly value: Comparable }
  >
>;
export type _Lte = Assert<
  Equals<
    typeof lte,
    (
      column: string,
      value: Comparable,
    ) => Never | { readonly kind: "lte"; readonly column: string; readonly value: Comparable }
  >
>;
export type _AnyOf = Assert<
  Equals<
    typeof anyOf,
    (
      column: string,
      values: ReadonlyArray<Scalar>,
    ) =>
      | Never
      | { readonly kind: "anyOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  >
>;
export type _NoneOf = Assert<
  Equals<
    typeof noneOf,
    (
      column: string,
      values: ReadonlyArray<Scalar>,
    ) =>
      | Always
      | Never
      | { readonly kind: "noneOf"; readonly column: string; readonly values: ReadonlyArray<Scalar> }
  >
>;
export type _IsNull = Assert<
  Equals<typeof isNull, (column: string) => { readonly kind: "isNull"; readonly column: string }>
>;
export type _Published = Assert<
  Equals<
    typeof published,
    (column: string) => { readonly kind: "published"; readonly column: string }
  >
>;
export type _NotPublished = Assert<
  Equals<
    typeof notPublished,
    (column: string) => { readonly kind: "notPublished"; readonly column: string }
  >
>;
export type _IsIn = Assert<
  Equals<
    typeof isIn,
    <Following>(
      column: string,
      set: Following,
    ) => { readonly kind: "in"; readonly column: string; readonly set: Following }
  >
>;
export type _IsNotIn = Assert<
  Equals<
    typeof isNotIn,
    <Following>(
      column: string,
      set: Following,
    ) => { readonly kind: "notIn"; readonly column: string; readonly set: Following }
  >
>;
export type _And = Assert<
  Equals<
    typeof and,
    <Following>(...filters: ReadonlyArray<ListFilter<Following>>) => ListFilter<Following>
  >
>;
export type _Or = Assert<
  Equals<
    typeof or,
    <Following>(...filters: ReadonlyArray<ListFilter<Following>>) => ListFilter<Following>
  >
>;
export type _EvaluationContext = Assert<
  Equals<
    EvaluationContext<Subquery>,
    {
      readonly now: Date;
      readonly contains: (set: Subquery, value: ColumnValue) => boolean;
    }
  >
>;
export type _Evaluate = Assert<
  Equals<
    typeof evaluate,
    <Following>(
      filter: ListFilter<Following>,
      row: FilterRow,
      context: EvaluationContext<Following>,
    ) => boolean
  >
>;

declare const leaves: LeafStore<LeafRow, Subquery, StoreFailure, Transaction>;
/** The viewer seams both factories take: an anonymous viewer, no rung, nobody following. */
const anonymousSeams = {
  viewer: Effect.succeed(Option.none()),
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: () => false,
  },
  followers: {
    isFollower: () => Effect.succeed(false),
    following: (): Subquery => ({ _tag: "Subquery" }),
  },
};
interface PostDoc {
  readonly id: string;
}
export const posts = defineSubtype({
  type: "posts",
  access: ownedAccess({ draft: true }),
  chain: store,
  leaves,
  ...anonymousSeams,
  toResource: (row): PostDoc => ({ id: row.id }),
});
export type _Get = Assert<
  Equals<
    ReturnType<typeof posts.get>,
    Effect.Effect<PostDoc, NodeNotFound | StoreFailure, Transaction>
  >
>;
// Distinct readable owners (pulpit#186): per leaf, and the exact union across leaves.
export type _Owners = Assert<
  Equals<ReturnType<typeof posts.owners>, Effect.Effect<Page<string>, StoreFailure, Transaction>>
>;
export type _ReadableOwners = Assert<
  Equals<
    ReturnType<typeof readableOwners<StoreFailure, Transaction>>,
    Effect.Effect<Page<string>, OwnerSetTooLarge | StoreFailure, Transaction>
  >
>;
export type _LeafStoreDistinct = Assert<
  Equals<
    LeafStore<LeafRow, Subquery, StoreFailure, Transaction>["distinct"],
    (query: DistinctQuery<Subquery>) => Effect.Effect<Page<string>, StoreFailure, Transaction>
  >
>;
/* oxlint-disable effect/prefer-option-over-null -- the assertion spells the emitted optional field */
export type _OwnersRequest = Assert<
  Equals<
    OwnersRequest,
    {
      readonly limit: number;
      readonly offset: number;
      readonly includeDeleted: boolean;
      readonly among?: ReadonlyArray<string> | undefined;
    }
  >
>;
/* oxlint-enable effect/prefer-option-over-null */
// A list filter over the follower seam (pulpit#189): the member leaf's list takes memberFilter's output.
export type _ListRequestFollowing = Assert<
  Equals<ListRequest<Subquery>["where"], ListFilter<Subquery>>
>;
export type _SubtypeOpsListFollowing = Assert<
  Equals<
    Parameters<SubtypeOps<unknown, StoreFailure, Transaction, Subquery>["list"]>[0],
    ListRequest<Subquery>
  >
>;
// The gated compare (pulpit#82): the chain's comparison behind `getVersion`'s gate.
export type _SubtypeCompare = Assert<
  Equals<
    ReturnType<typeof posts.compare>,
    Effect.Effect<
      VersionComparison,
      Unauthorized | Forbidden | NodeNotFound | VersionNotFound | StoreFailure,
      Transaction
    >
  >
>;
// List ordering (pulpit#112): the request's optional order, the store's
// checked one, and `list`'s typed refusal of an undeclared column.
export type _ListOrder = Assert<
  Equals<ListOrder, { readonly column: string; readonly direction: "asc" | "desc" }>
>;
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the emitted optional field exactly, and the workspace's optional fields are `?: T | undefined` */
export type _ListRequestOrder = Assert<
  Equals<ListRequest["orderBy"], ReadonlyArray<ListOrder> | undefined>
>;
// The leaf's optional sortable allow-list (pulpit#112), and its declaration error.
export type _SubtypeSortable = Assert<
  Equals<
    SubtypeDefinition<LeafRow, unknown, never, never, never>["sortable"],
    ReadonlyArray<string> | undefined
  >
>;
// The head version on the wire (pulpit#65).
export type _LeafRowVersion = Assert<Equals<LeafRow["version"], bigint>>;
export type _VersionMeta = Assert<
  Equals<typeof versionMeta, (row: Pick<LeafRow, "version">) => VersionMeta>
>;
export type _VersionMetaFields = Assert<Equals<VersionMeta, { readonly version: string }>>;
export type _VersionEtag = Assert<
  Equals<typeof versionEtag, (resource: VersionedResource) => Option.Option<string>>
>;
export type _VersionedResource = Assert<
  Equals<VersionedResource, { readonly meta?: object | undefined }>
>;
// effect-jsonapi's ResourceHandlers over the handler record (pulpit#5).
export type _ResourceHandlerNames = Assert<
  Equals<
    keyof ReturnType<typeof subtypeResourceHandlers>,
    "list" | "get" | "create" | "update" | "delete"
  >
>;
interface PostQuery {
  readonly offset: number;
  readonly limit: number;
}
type PostHandlersConfig = SubtypeResourceHandlersConfig<
  PostQuery,
  { readonly title: string },
  { readonly id: string; readonly title?: string | undefined },
  undefined,
  never,
  never,
  never
>;
export type _ResourceHandlersListRequest = Assert<
  Equals<PostHandlersConfig["listRequest"], (query: PostQuery) => ListRequest>
>;
export type _ResourceHandlersSegment = Assert<Equals<PostHandlersConfig["segment"], string>>;
// Search (pulpit#54): the projection, the scope and the gated hydration.
export type _SearchWeight = Assert<Equals<SearchWeight, "A" | "B" | "C" | "D">>;
export type _SearchField = Assert<
  Equals<SearchField, { readonly column: string; readonly weight: SearchWeight }>
>;
export type _SearchProjection = Assert<
  Equals<
    SearchProjection,
    {
      readonly fields: ReadonlyArray<SearchField>;
      readonly languageColumn: Option.Option<string>;
    }
  >
>;
export type _DefineSearchProjection = Assert<
  Equals<ReturnType<typeof defineSearchProjection>, SearchProjection>
>;
export type _SearchScope = Assert<
  Equals<ReturnType<typeof searchScopeFilter<Subquery>>, ListFilter<Subquery>>
>;
export type _SearchScopeRequest = Assert<
  Equals<
    Parameters<typeof searchScopeFilter<Subquery>>[2],
    Pick<ListRequest<Subquery>, "includeDeleted" | "where">
  >
>;
export type _HydrateSearchHits = Assert<
  Equals<
    ReturnType<
      typeof hydrateSearchHits<{ readonly id: string }, PostDoc, StoreFailure, Transaction>
    >,
    Effect.Effect<
      ReadonlyArray<{ readonly hit: { readonly id: string }; readonly resource: PostDoc }>,
      StoreFailure,
      Transaction
    >
  >
>;
export type _SubtypeSearch = Assert<
  Equals<
    SubtypeDefinition<LeafRow, unknown, never, never, never>["search"],
    SearchProjection | undefined
  >
>;
/* oxlint-enable effect/prefer-option-over-null */
export type _SubtypeDeclarationError = Assert<
  Equals<SubtypeDeclarationError["_tag"], "SubtypeDeclarationError">
>;
export type _LeafStoreOrder = Assert<
  Equals<Parameters<(typeof leaves)["list"]>[0]["orderBy"], ReadonlyArray<ListOrder>>
>;
export type _SubtypeList = Assert<
  Equals<
    ReturnType<typeof posts.list>,
    Effect.Effect<Page<PostDoc>, InvalidListOrder | StoreFailure, Transaction>
  >
>;
export const ordered = posts.list({
  limit: 10,
  offset: 0,
  includeDeleted: false,
  where: eq("visibility", "public"),
  orderBy: [{ column: "title", direction: "desc" }],
});
// A caller forwarding its own `undefined` (`exactOptionalPropertyTypes`).
export const unordered = posts.list({
  limit: 10,
  offset: 0,
  includeDeleted: false,
  where: { kind: "always" },
  orderBy: undefined,
});
export type _SubtypeCompareParameters = Assert<
  Equals<Parameters<typeof posts.compare>, [id: string, from: bigint, to: bigint]>
>;

// A reference leaf's followers column (pulpit#92): an optional field, so
// the bare declaration still compiles, and the list arm takes it as an
// optional `Option`.
export const curatedTerms: LeafAccess = { kind: "reference", followersOfColumn: "curatorId" };
export const bareTerms: LeafAccess = { kind: "reference" };
// The moderated owned leaf (pulpit#154): the column is an `Option`, as the draft column is.
export const moderatedComments: Option.Option<string> = ownedAccess({
  moderation: true,
}).moderationColumn;
// A caller forwarding its own `undefined` (`exactOptionalPropertyTypes`).
export const forwardedTerms: LeafAccess = { kind: "reference", followersOfColumn: undefined };
const closedPolicy = {
  canViewPrivate: () => false,
  canViewDeleted: () => false,
  canModerate: () => false,
  canWriteCorpus: () => false,
};
// The three-argument form, from before pulpit#92, still type-checks.
export const bareFilter = referencePrivacyFilter<Subquery>(
  Option.none(),
  closedPolicy,
  leaves.columns,
);
export type _BareFilter = Assert<Equals<typeof bareFilter, ListFilter<Subquery>>>;
export const curatedFilter = referencePrivacyFilter(
  Option.none(),
  closedPolicy,
  leaves.columns,
  Option.some({
    access: { kind: "reference", followersOfColumn: "curatorId" },
    followers: {
      isFollower: () => Effect.succeed(false),
      following: (): Subquery => ({ _tag: "Subquery" }),
    },
  }),
);
export type _CuratedFilter = Assert<Equals<typeof curatedFilter, ListFilter<Subquery>>>;

// ── publication ──────────────────────────────────────────────────────────

export const hook = serveablePolicy({ owned: true });
export type _Hook = Assert<Equals<ReturnType<typeof hook>, boolean>>;
export type _HookInput = Assert<Equals<Parameters<typeof hook>, [resource: unknown]>>;
export type _Gate = Assert<Equals<ReturnType<typeof isPubliclyServeable>, boolean>>;

// ── documents ────────────────────────────────────────────────────────────

export type _Hash = Assert<Equals<DocumentHash, string>>;
export type _HashBarrel = Assert<Equals<typeof Documents.DocumentHash, typeof DocumentHash>>;

interface ProseDocument {
  readonly type: "doc";
}
declare const documents: DocumentStore<ProseDocument, StoreFailure, Transaction>;
export type _Put = Assert<
  Equals<ReturnType<typeof documents.put>, Effect.Effect<DocumentPut, StoreFailure, Transaction>>
>;
export type _PutResult = Assert<
  Equals<DocumentPut, { readonly hash: string; readonly inserted: boolean }>
>;
export type _OnInsert = Assert<
  Equals<
    ReturnType<typeof onDocumentInsert<ProseDocument, StoreFailure, Transaction>>,
    DocumentStore<ProseDocument, StoreFailure, Transaction>
  >
>;

// ── lifecycle hooks ──────────────────────────────────────────────────────

export type _WriteAction = Assert<
  Equals<
    WriteAction,
    "create" | "update" | "delete" | "restore" | "restoreVersion" | "publish" | "unpublish"
  >
>;
export type _BeforeRun = Assert<
  Equals<
    ReturnType<LifecycleHooks<string, StoreFailure, Transaction>["before"][number]["run"]>,
    Effect.Effect<ChainPatch, WriteRejected | StoreFailure, Transaction>
  >
>;
export type _BeforeEvent = Assert<
  Equals<
    Parameters<LifecycleHooks<string, never, never>["before"][number]["run"]>,
    [event: BeforeWriteEvent]
  >
>;
export type _AfterResource = Assert<
  Equals<AfterWriteEvent<string>["resource"], Option.Option<string>>
>;
export type _Due = Assert<Equals<ReturnType<typeof duePublications<never>>, ListFilter<never>>>;
export type _GetDocument = Assert<
  Equals<
    ReturnType<typeof documents.get>,
    Effect.Effect<Option.Option<ProseDocument>, StoreFailure, Transaction>
  >
>;

// A version row's document reference: the hash, required on the resource
// and at create, optional (carried forward) at update.
export const Note = Resource.make("notes", {
  attributes: { ...documentRef("title"), ...documentRef("body") },
});
export type _NoteAttributes = Assert<
  Equals<typeof Note.Type.attributes, { readonly title: string; readonly body: string }>
>;
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the upstream projection exactly, and effect-jsonapi's update presence is `?: T | undefined` */
export type _NoteUpdate = Assert<
  Equals<
    Omit<typeof Note.updateInput.Type, "id">,
    { readonly title?: string | undefined; readonly body?: string | undefined }
  >
>;
/* oxlint-enable effect/prefer-option-over-null */

// ── edges ────────────────────────────────────────────────────────────────

declare const edgeStore: EdgeStore<EdgeRow, Subquery, StoreFailure, Transaction>;
interface CreateLink {
  readonly postId: string;
  readonly termId: string;
}
interface LinkDoc {
  readonly id: string;
}
export const links = defineEdgeOps({
  type: "links",
  ends: {
    post: { column: "postId", type: "posts", access: ownedAccess(), nodes: leaves, maxEdges: 5 },
    term: { column: "termId", type: "terms", access: { kind: "reference" }, nodes: leaves },
  },
  edges: edgeStore,
  ...anonymousSeams,
  values: (input: CreateLink) => ({ postId: input.postId, termId: input.termId }),
  toResource: (row): LinkDoc => ({ id: row.id }),
  onConflict: "ignore",
  writeGate: rungGate((policy) => policy.canModerate),
});
// Each operation's error channel, spelled out: a tag that degraded to `any`,
// or one that dropped out, fails the assertion.
export type _EdgeCreate = Assert<
  Equals<
    ReturnType<typeof links.create>,
    Effect.Effect<
      EdgeWrite,
      | Unauthorized
      | Forbidden
      | NodeNotFound
      | EdgeConflict
      | EdgeCardinalityExceeded
      | InvalidValidity
      | StoreFailure,
      Transaction
    >
  >
>;
// Validity intervals (pulpit#210): the one edge update, and the instant filter.
export type _EdgeCloseValidity = Assert<
  Equals<
    ReturnType<typeof links.closeValidity>,
    Effect.Effect<
      { readonly id: string },
      Unauthorized | Forbidden | NodeNotFound | EdgeNotFound | InvalidValidity | StoreFailure,
      Transaction
    >
  >
>;
export type _EdgeCloseValidityParameters = Assert<
  Equals<Parameters<typeof links.closeValidity>, [id: string, at: Date]>
>;
export type _EdgeValidity = Assert<
  Equals<EdgeValidity, { readonly from: string; readonly to: string }>
>;
export type _ValidAt = Assert<Equals<ReturnType<typeof validAt<never>>, ListFilter<never>>>;
export type _InvalidValidityTag = Assert<Equals<InvalidValidity["_tag"], "InvalidValidity">>;
// Edge membership (pulpit#113): the filter is over the family's `Following`.
export type _EdgeMemberFilter = Assert<
  Equals<
    ReturnType<typeof links.memberFilter>,
    Effect.Effect<ListFilter<Subquery>, StoreFailure, Transaction>
  >
>;
// Edge non-membership (pulpit#191): the complement, over the same `Following`.
export type _EdgeNonMemberFilter = Assert<
  Equals<
    ReturnType<typeof links.nonMemberFilter>,
    Effect.Effect<ListFilter<Subquery>, StoreFailure, Transaction>
  >
>;
// Readable-edge counts per node (pulpit#185): one grouped read, a count per id.
export type _EdgeCountBy = Assert<
  Equals<
    ReturnType<typeof links.countBy>,
    Effect.Effect<HashMap.HashMap<string, number>, StoreFailure, Transaction>
  >
>;
export type _EdgeCountByParameters = Assert<
  Equals<
    Parameters<typeof links.countBy>,
    // oxlint-disable-next-line effect/prefer-option-over-null -- pins the optional `where` parameter's declared `?: T | undefined` (AGENTS.md → Conventions)
    [end: string, ids: ReadonlyArray<string>, where?: ListFilter<never> | undefined]
  >
>;
export type _EdgeGet = Assert<
  Equals<
    ReturnType<typeof links.get>,
    Effect.Effect<LinkDoc, EdgeNotFound | StoreFailure, Transaction>
  >
>;
export type _EdgeDelete = Assert<
  Equals<
    ReturnType<typeof links.delete>,
    Effect.Effect<
      { readonly id: string },
      Unauthorized | Forbidden | NodeNotFound | EdgeNotFound | StoreFailure,
      Transaction
    >
  >
>;
export type _EdgeCreateInput = Assert<Equals<Parameters<typeof links.create>, [input: CreateLink]>>;
export type _EdgeWrite = Assert<
  Equals<EdgeWrite, { readonly id: string; readonly created: boolean }>
>;
export type _EdgeNotFoundTag = Assert<Equals<EdgeNotFound["_tag"], "EdgeNotFound">>;
export type _CardinalityTag = Assert<
  Equals<EdgeCardinalityExceeded["_tag"], "EdgeCardinalityExceeded">
>;
export type _CardinalityMax = Assert<Equals<EdgeCardinalityExceeded["max"], number>>;
export type _CardinalityEnd = Assert<Equals<EdgeCardinalityExceeded["end"], string>>;
export type _ConflictTag = Assert<Equals<EdgeConflict["_tag"], "EdgeConflict">>;
export type _DeclarationTag = Assert<Equals<EdgeDeclarationError["_tag"], "EdgeDeclarationError">>;
export type _EdgeGate = Assert<
  Equals<
    ReturnType<EdgeWriteGate<StoreFailure, Transaction>>,
    Effect.Effect<unknown, Unauthorized | Forbidden | NodeNotFound | StoreFailure, Transaction>
  >
>;
export type _EndpointColumn = Assert<Equals<ReturnType<typeof endpointColumn>, string>>;
export type _EdgesBarrel = Assert<Equals<typeof Edges.defineEdgeOps, typeof defineEdgeOps>>;

// ── proposals ────────────────────────────────────────────────────────────

export type _ProposalsBarrel = Assert<
  Equals<typeof Proposals.defineProposals, typeof defineProposals>
>;
export type _ProposalStatus = Assert<
  Equals<ProposalStatus, "pending" | "accepted" | "rejected" | "withdrawn">
>;
export type _ProposalBase = Assert<Equals<ProposalRow["baseVersion"], bigint>>;
export type _Accept = Assert<
  Equals<
    Effect.Success<ReturnType<ProposalOps<StoreFailure, Transaction>["accept"]>>,
    { readonly id: string; readonly version: bigint }
  >
>;
export type _Classify = Assert<
  Equals<
    ReturnType<typeof classifyProposalConflict>["conflictingAttributes"],
    ReadonlyArray<string>
  >
>;
// A localised leaf's proposals (pulpit#184): the per-locale patch as submitted, and the verdict by locale.
export type _ProposalLocales = Assert<Equals<ProposalRow["locales"], Option.Option<Schema.Json>>>;
export type _ClassifyLocales = Assert<
  Equals<
    ReturnType<typeof classifyProposalConflict>["conflictingLocales"],
    { readonly [locale: string]: ReadonlyArray<string> }
  >
>;
export type _ProposedBy = Assert<Equals<VersionRow["proposedBy"], Option.Option<string>>>;

// ── blobs ────────────────────────────────────────────────────────────────

export type _BlobsBarrel = Assert<Equals<typeof Blobs.defineFileWrites, typeof defineFileWrites>>;
export type _FileUrl = Assert<Equals<ReturnType<typeof fileUrl>, Option.Option<string>>>;
export type _FileWrite = Assert<Equals<FileWrite["bytesPending"], boolean>>;
export type _FileWriteVersion = Assert<Equals<FileWrite["version"], bigint>>;

// ── paths (pulpit#57) ────────────────────────────────────────────────────

export type _PathsBarrel = Assert<Equals<typeof Paths.routable, typeof routable>>;
export type _PathEntry = Assert<
  Equals<PathEntry, { readonly nodeId: string; readonly canonical: boolean }>
>;
export type _PathClaim = Assert<
  Equals<
    PathStore<StoreFailure, Transaction>["claim"],
    (nodeId: string, path: string) => Effect.Effect<void, PathTaken | StoreFailure, Transaction>
  >
>;
export type _PathLookup = Assert<
  Equals<
    PathStore<StoreFailure, Transaction>["lookup"],
    (path: string) => Effect.Effect<Option.Option<PathEntry>, StoreFailure, Transaction>
  >
>;
export type _PathTakenTag = Assert<Equals<PathTaken["_tag"], "PathTaken">>;
export type _PathNotFoundTag = Assert<Equals<PathNotFound["_tag"], "PathNotFound">>;
export type _PathTakenPath = Assert<Equals<PathTaken["path"], string>>;
export type _Resolution = Assert<
  Equals<
    Resolution<PostDoc>,
    | { readonly kind: "node"; readonly id: string; readonly resource: PostDoc }
    | { readonly kind: "redirect"; readonly id: string; readonly path: string }
  >
>;
export type _Resolve = Assert<
  Equals<
    RoutableOps<PostDoc, StoreFailure, Transaction>["resolve"],
    (path: string) => Effect.Effect<Resolution<PostDoc>, PathNotFound | StoreFailure, Transaction>
  >
>;
export type _RoutableUpdateError = Assert<
  Equals<
    Extract<
      Effect.Error<ReturnType<RoutableOps<PostDoc, StoreFailure, Transaction>["update"]>>,
      PathTaken
    >,
    PathTaken
  >
>;

// ── moderation ───────────────────────────────────────────────────────────

export type _ModerationBarrel = Assert<
  Equals<typeof Moderation.defineModeration, typeof defineModeration>
>;
export type _Grade = Assert<Equals<ReturnType<typeof gradeScores>, ModerationGrade>>;
export type _GradePriority = Assert<
  Equals<ModerationGrade["priority"], "low" | "medium" | "high" | "urgent">
>;
export type _ReportStatus = Assert<Equals<ReportStatus, "open" | "resolved" | "dismissed">>;
export type _ModerationHook = Assert<
  Equals<ReturnType<typeof moderationHook<StoreFailure, Transaction>>["name"], string>
>;

// ── publication lifecycle ────────────────────────────────────────────────

export type _WorkingCopyBarrel = Assert<
  Equals<typeof WorkingCopy.defineWorkingCopy, typeof defineWorkingCopy>
>;
export type _PublicationOps = Assert<
  Equals<
    SubtypeOps<string, StoreFailure, Transaction>["publication"],
    Option.Option<PublicationOps<StoreFailure, Transaction>>
  >
>;
export type _FactVersion = Assert<Equals<PublicationFact["version"], Option.Option<bigint>>>;
export type _PublicResource = Assert<
  Equals<
    ReturnType<SubtypeOps<string, StoreFailure, Transaction>["publicResource"]>,
    Effect.Effect<Option.Option<string>, StoreFailure, Transaction>
  >
>;

// ── comments ─────────────────────────────────────────────────────────────

export type _CommentsBarrel = Assert<Equals<typeof Comments.defineComments, typeof defineComments>>;
export type _DepthError = Assert<Equals<CommentDepthExceeded["maxDepth"], number>>;

// ── purge ────────────────────────────────────────────────────────────────

export type _PurgeBarrel = Assert<Equals<typeof Purge.definePurge, typeof definePurge>>;
export type _PurgeOp = Assert<
  Equals<
    ReturnType<PurgeOps<StoreFailure, Transaction>["purge"]>,
    Effect.Effect<PurgeReport, Unauthorized | Forbidden | NodeNotFound | StoreFailure, Transaction>
  >
>;
export type _PurgeReportBytes = Assert<Equals<PurgeReport["bytesLeft"], ReadonlyArray<string>>>;

// ── search (pulpit#204) ──────────────────────────────────────────────────

export type _SearchBarrel = Assert<Equals<typeof Search.fuseRankings, typeof fuseRankings>>;
export type _Fused = Assert<Equals<ReturnType<typeof fuseRankings>, ReadonlyArray<FusedHit>>>;
export type _FusedRanks = Assert<Equals<FusedHit["ranks"], { readonly [branch: string]: number }>>;
declare const branches: ReadonlyArray<SearchBranch<Subquery, StoreFailure, Transaction>>;
export const searchOver = hybridSearch({ branches });
export type _HybridSearch = Assert<
  Equals<
    ReturnType<typeof searchOver>,
    Effect.Effect<ReadonlyArray<FusedHit>, StoreFailure, Transaction>
  >
>;
export type _EmbedPending = Assert<
  Equals<
    ReturnType<typeof embedPending<string, StoreFailure, Transaction>>,
    Effect.Effect<EmbeddingBatch, StoreFailure | EmbeddingMismatch, Transaction>
  >
>;

// ── budgets ──────────────────────────────────────────────────────────────

export type _BudgetsBarrel = Assert<Equals<typeof Budgets.bindBudget, typeof bindBudget>>;
export type _BudgetSpend = Assert<
  Equals<
    ReturnType<BoundBudget<StoreFailure, Transaction>["spend"]>,
    Effect.Effect<void, WriteRejected | StoreFailure, Transaction>
  >
>;
export type _BudgetTake = Assert<
  Equals<
    ReturnType<BudgetCounter<StoreFailure, Transaction>["take"]>,
    Effect.Effect<boolean, StoreFailure, Transaction>
  >
>;
export type _BudgetRequestLimit = Assert<Equals<BudgetRequest["limit"], number>>;
export type _BudgetHook = Assert<
  Equals<
    ReturnType<typeof budgetHook<StoreFailure, Transaction>>["run"],
    BeforeWriteHook<StoreFailure, Transaction>["run"]
  >
>;
export type _CountingCounter = Assert<
  Equals<
    ReturnType<typeof countingCounter<StoreFailure, Transaction>>,
    BudgetCounter<StoreFailure, Transaction>
  >
>;
export type _RateLimited = Assert<Equals<typeof RATE_LIMITED, "rate-limited">>;
export type _IsRateLimited = Assert<
  Equals<Parameters<typeof isRateLimited>, [error: WriteRejected]>
>;
export type _ProposalSubmitBudget = Assert<
  WriteRejected extends Effect.Error<ReturnType<ProposalOps<StoreFailure, Transaction>["submit"]>>
    ? true
    : false
>;
