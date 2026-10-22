/**
 * **The subtype operation factory** — a leaf's CRUD, version history and
 * list, gated by its access kind, over the version chain and a
 * current-version view.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/subtype.ts`
 * (`defineNodeSubtypeE`, `LeafAccess`, the gates `requireWriterE` /
 * `requireCreatorE` / `stampOwnerE` / `ownedListFilterE`), its
 * `packages/database/src/guards.ts` (`canViewOwnedE`, `ownedReadScopeE`) and
 * website's `apps/api/src/operations/to-resource.ts`
 * (`loadListVisibilityFilters`, the two-state list predicate). A `#NNN` here
 * names a gardeneria issue.
 *
 * ## Access kinds
 *
 * - `reference` — corpus material. Create / update / delete / restore gate on
 *   the corpus-write rung; when the view has a `visibility` column, reads
 *   show only `public` rows below the view-private rung, apart from the
 *   soft-delete axis, and the `followers` rows whose declared
 *   `followersOfColumn` names the viewer or an account they follow
 *   (pulpit#92). A
 *   write or history read to an existing row also needs the row to be one
 *   `get` would serve the caller (pulpit#101).
 * - `owned` — a member's own row. Create gates on any signed-in account and
 *   stamps the owner; every other write loads the owner and gates on
 *   owner-or-moderator (a missing owner is `NotFound`, never an open gate);
 *   `get` applies {@link canViewOwned} to the row; `list` applies the same
 *   facts as a {@link ListFilter} ({@link ownedListFilter}), so the two can
 *   never disagree.
 *
 * ## Invariants
 *
 * - A read (`get` / `getMany` / `list`) answers a hidden row as
 *   {@link NodeNotFound} or omits it, never {@link Forbidden}
 *   (`SEC-AUTH-ENUM-001`): a 403 would confirm the row exists. The write and
 *   history gate ({@link requireWriter}) does answer `Forbidden` for an
 *   existing owned row the caller doesn't own, whatever its visibility, so
 *   it deliberately confirms existence to a signed-in caller (pulpit#24;
 *   SECURITY.md → "Existence disclosure by the write gates"). On a reference
 *   leaf, a corpus writer's write or history read to a row `get` hides from
 *   them fails `NodeNotFound`, as `get` does, before the chain is reached
 *   (pulpit#101, `PUB-009`).
 * - A list's order ({@link ListOrder}) only places the rows its filters
 *   chose: it never changes membership or the total, and a column that is
 *   not sortable (outside the leaf's `sortable` allow-list or, without one,
 *   the view's declared `columns`) fails {@link InvalidListOrder} before
 *   anything is read, never reaching the store (pulpit#112).
 * - Soft-deleted rows are visible only to the view-deleted rung, and a list
 *   includes them only when the caller also asked (`includeDeleted`).
 * - A declaration naming columns the view lacks fails closed — nothing lists,
 *   and `get` / `getMany` show nothing.
 * - The follower seam, when a runtime does not provide one, answers "nobody
 *   follows anybody" — a `followers` row is then its owner's and the rung's
 *   alone. Fail closed.
 *
 * ## Lifecycle hooks
 *
 * A leaf's write side effects compose as {@link LifecycleHooks} (pulpit#45):
 * before hooks run inside each write, after its gate and before the append,
 * and may transform the patch or refuse the write ({@link WriteRejected});
 * after hooks run in {@link subtypeHandlers} once the write's transaction
 * has returned, and never fail it. The cache write-through is the first
 * after hook ({@link cacheWriteThrough}). Events fire on explicit writes
 * only: a future `publishedAt` arriving emits nothing (`./publication`'s
 * `duePublications` drives an application's sweep instead).
 *
 * ## Seams
 *
 * Three things the kernel does not own, each an explicit parameter rather
 * than an import (see the package README → Seams for each one's expected
 * shape and which package, if any, fills it):
 *
 * - the **viewer** and the **role axes** ({@link Viewer}, {@link AccessPolicy})
 *   and the **follower** answer — effect-auth's session context, role ladder
 *   and `IsFollower`. Its read scope (`OwnedAccess` / `Guard` / `Ladder` /
 *   `Cacheability`) is on effect-auth's `trunk` but unpublished (release PR
 *   effect-auth#177);
 * - the **current-version view** ({@link LeafStore}) — a Drizzle store over
 *   effect-drizzle-ext's `makeCurrentVersionView`;
 * - the **handlers config** the factory's operations plug into
 *   ({@link subtypeHandlers}) — the record a JSON:API server's resource
 *   handlers are expected to accept (effect-jsonapi's `ResourceHandlers`,
 *   exported since 0.15.0 but not yet wired here; pulpit#5), with the
 *   write-through to the resource cache the application fills.
 *
 * @copyright Thomas Foster
 * @module pulpit/subtype
 * @since 0.1.0
 */

import * as Array from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ResourceHandlers, type Assemble, type Handlers } from "@thomasfosterau/effect-jsonapi";
import type { Visibility } from "./content.ts";
import { always, and, eq, isIn, ne, never, or, type ListFilter } from "./filter.ts";
import { canViewOwnedRow, declaresColumns, ownedFacts } from "./internal/owned-columns.ts";
import { canViewReferenceRow, referenceListFilter } from "./internal/reference-columns.ts";
import {
  defineVersionChain,
  NodeNotFound,
  type ChainPatch,
  type ChainState,
  type ChainWrite,
  type ColumnValue,
  type Precondition,
  type StaleVersion,
  type VersionAction,
  type VersionChainStore,
  type VersionComparison,
  type VersionConflict,
  type VersionNotFound,
  type VersionSnapshot,
  type NodeAlreadyExists,
  type WriteAction,
  type ChainAppendEvent,
} from "./version-chain.ts";

// ── The viewer seam ───────────────────────────────────────────────────

/**
 * The signed-in account the operation acts as: an id and a role on the application's ladder.
 *
 * @since 0.1.0
 */
export interface ViewerAccount {
  readonly id: string;
  readonly role: string;
}

/**
 * The viewer: an account, or none for an anonymous request (effect-auth's session context).
 *
 * @since 0.1.0
 */
export type Viewer = Option.Option<ViewerAccount>;

/**
 * The role axes the kernel asks about — each an application-named rung
 * (`VIEW_PRIVATE_MIN_ROLE`, `VIEW_DELETED_MIN_ROLE`, `MODERATE_MIN_ROLE`,
 * `CORPUS_WRITE_MIN_ROLE`) compared by the application's one
 * `hasRoleAtLeast`, which must fail closed on an unknown role. effect-auth's
 * role-ladder factory produces these.
 *
 * @since 0.1.0
 */
export interface AccessPolicy {
  /** May see `private` rows and drafts (gardeneria: moderator+; website: admin). */
  readonly canViewPrivate: (account: ViewerAccount) => boolean;
  /** May see soft-deleted rows (gardeneria: moderator+; website: admin). */
  readonly canViewDeleted: (account: ViewerAccount) => boolean;
  /** May write someone else's owned row (gardeneria: moderator+). */
  readonly canModerate: (account: ViewerAccount) => boolean;
  /** May write reference data directly (gardeneria: contributor+). */
  readonly canWriteCorpus: (account: ViewerAccount) => boolean;
}

/**
 * The follower seam — the `followers` visibility state's one external fact.
 * `isFollower` answers one row's question; `following` answers a list's, as
 * whatever the list filter's `in` node takes (a subquery in SQL, #1107).
 *
 * @since 0.1.0
 */
export interface FollowerSeam<Following, R> {
  /** Whether `followerId` follows `ownerId`: the single-row question `canViewOwned` asks. */
  readonly isFollower: (followerId: string, ownerId: string) => Effect.Effect<boolean, never, R>;
  /**
   * The owners `followerId` follows, as the list filter's `in` set (a
   * subquery in SQL, never a materialised array).
   */
  readonly following: (followerId: string) => Following;
}

/**
 * The fail-closed follower seam: nobody follows anybody. `nobody` is the
 * matches-nothing value of the `in` node (SQL: `(select null::uuid where false)`).
 *
 * @since 0.1.0
 */
export const nobodyFollows = <Following>(nobody: Following): FollowerSeam<Following, never> => ({
  isFollower: () => Effect.succeed(false),
  following: () => nobody,
});

// ── Errors ────────────────────────────────────────────────────────────

/**
 * No signed-in viewer where one is required: the wire's 401.
 *
 * @since 0.1.0
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

/**
 * A signed-in viewer below the rung a write needs: the wire's 403. Never used to hide a row.
 *
 * @since 0.1.0
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

/**
 * A list order the leaf does not sort by: a key whose column is not sortable
 * (outside the leaf's `sortable` allow-list or, without one, outside the
 * view's declared `LeafStore.columns`), a direction other than `asc` /
 * `desc`, or input not shaped as an order at all (an `orderBy` that is not
 * an array, a key that is not an object, a `column` that is not a string).
 * The wire's 400. The order is checked before the viewer or anything else is
 * read, so it says nothing about any row, but **it does say which columns
 * are sortable**: without a `sortable` allow-list, that a name is (or is
 * not) one of the view's columns. `column` is the caller's own key, never
 * passed to the store, or `""` when the key carries no string column
 * (pulpit#112).
 *
 * @since 0.1.0
 */
export class InvalidListOrder extends Schema.TaggedError<InvalidListOrder>()("InvalidListOrder", {
  type: Schema.String,
  column: Schema.String,
}) {}

/**
 * A leaf declared against the rules: a `sortable` entry that is not one of
 * its view's `LeafStore.columns`. Thrown by {@link defineSubtype} when the
 * leaf is declared, never an Effect failure, like `./edges`'
 * `EdgeDeclarationError`: a misspelt allow-list entry must stop its module
 * loading rather than silently leave a column unsortable (pulpit#112).
 *
 * @since 0.1.0
 */
export class SubtypeDeclarationError extends Schema.TaggedError<SubtypeDeclarationError>()(
  "SubtypeDeclarationError",
  { message: Schema.String },
) {}

// ── Read scope and the row predicate ──────────────────────────────────

/**
 * The viewer's owned-material read scope — the three facts a LIST needs to
 * build its filter from, and the set-shaped counterpart of
 * {@link canViewOwned}:
 *
 * - `all` — the view-private rung: no visibility filter;
 * - `public` — anonymous: `visibility = 'public'` only;
 * - `member` — a signed-in account: `public`, OR their own rows, OR
 *   `followers` rows whose owner they follow.
 *
 * @since 0.1.0
 */
export type ReadScope<Following> =
  | { readonly kind: "all" }
  | { readonly kind: "public" }
  | { readonly kind: "member"; readonly userId: string; readonly following: Following };

/**
 * Resolve a viewer's {@link ReadScope}.
 *
 * @since 0.1.0
 */
export const readScopeFor = <Following>(
  viewer: Viewer,
  policy: AccessPolicy,
  followers: FollowerSeam<Following, unknown>,
): ReadScope<Following> =>
  Option.match(viewer, {
    onNone: (): ReadScope<Following> => ({ kind: "public" }),
    onSome: (account): ReadScope<Following> =>
      policy.canViewPrivate(account)
        ? { kind: "all" }
        : { kind: "member", userId: account.id, following: followers.following(account.id) },
  });

/**
 * The facts {@link canViewOwned} reads off an owned row. `draft: false` for a leaf without the axis.
 *
 * @since 0.1.0
 */
export interface OwnedFacts {
  readonly ownerId: string;
  readonly visibility: Visibility;
  readonly draft: boolean;
}

/**
 * The owned-material read predicate — the single interpretation of the
 * three-state visibility axis plus the orthogonal `draft` axis (#1118):
 *
 * | visibility  | who may view                                                   |
 * | ----------- | -------------------------------------------------------------- |
 * | `public`    | everyone, anonymous included                                   |
 * | `followers` | the owner; the owner's followers; the view-private rung        |
 * | `private`   | the owner; the view-private rung                               |
 *
 * `draft: true` narrows whatever `visibility` allows down to the owner and
 * the rung — a `public` draft is exactly as hidden as a `private` one. Never
 * fails; callers turn `false` into {@link NodeNotFound}.
 *
 * `defineSubtype`'s `get` / `getMany` and `./edges`' `canViewEndpoint`
 * apply the same predicate to the row they read. There, an owner column
 * holding no string (a `NULL`, an absent key) reads as no owner: no viewer
 * is its owner and the follower seam is never asked, so the row shows only
 * when `public` and not a draft, or to the rung, as {@link ownedListFilter}
 * lists it (`SEC-AUTH-ENUM-001`).
 *
 * @since 0.1.0
 */
export const canViewOwned = <R>(
  viewer: Viewer,
  policy: AccessPolicy,
  followers: FollowerSeam<unknown, R>,
  row: OwnedFacts,
): Effect.Effect<boolean, never, R> =>
  canViewOwnedRow(viewer, policy, followers, { ...row, ownerId: Option.some(row.ownerId) });

// ── Leaf access and the list filters ──────────────────────────────────

/**
 * The gate selector, mirroring the registry's `referenceData` ⊕ `owned`
 * flags: an `owned` leaf names the VIEW columns its read paths consult, and
 * `draftColumn` only when the leaf actually writes the flag. A `reference`
 * leaf names `followersOfColumn` only when its rows may be `followers`-visible
 * (pulpit#92).
 *
 * @since 0.1.0
 */
export type LeafAccess =
  | {
      readonly kind: "reference";
      /**
       * The view column that plays the owner's part for a `followers` row:
       * it holds the id of the account whose followers may read the row
       * (`PUB-009`). The column is the application's, and holds whatever id
       * its follower seam takes; no id brand is implied. Only the followers
       * check reads it: the account it names and that account's followers
       * read its `followers` rows, but it gets no other owner rights (a
       * `private` row stays the view-private rung's alone), and a value that
       * is not a string names nobody. Absent, or naming a column the view
       * lacks, a `followers` row is hidden below the view-private rung.
       *
       * @since 0.1.0
       */
      // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so the existing `{ kind: "reference" }` declarations keep compiling and a caller can forward its own `undefined`; the omitted key is the absence, read as such by every reader
      readonly followersOfColumn?: string | undefined;
    }
  | {
      readonly kind: "owned";
      readonly ownerColumn: string;
      readonly visibilityColumn: string;
      readonly draftColumn: Option.Option<string>;
    };

/**
 * The owned-leaf access declaration with the conventional factory-built column names.
 *
 * @since 0.1.0
 */
export const ownedAccess = (
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the absence, read as such by every reader, so there is no value to model as an `Option`
  options: { readonly draft?: boolean | undefined } = {},
): Extract<LeafAccess, { kind: "owned" }> => ({
  kind: "owned",
  ownerColumn: "ownerId",
  visibilityColumn: "visibility",
  draftColumn: options.draft === true ? Option.some("draft") : Option.none(),
});

/**
 * The owned-leaf LIST filter — {@link ReadScope} rendered over the leaf's
 * declared view columns. When the leaf carries a draft column, every
 * non-owner arm additionally requires `draft = false`; the owner's own arm
 * never does, so a member lists their own drafts. Columns the view lacks
 * fail closed.
 *
 * @since 0.1.0
 */
export const ownedListFilter = <Following>(
  access: Extract<LeafAccess, { kind: "owned" }>,
  viewColumns: ReadonlySet<string>,
  scope: ReadScope<Following>,
): ListFilter<Following> => {
  if (!declaresColumns(access, viewColumns)) return never;
  const published = (filter: ListFilter<Following>): ListFilter<Following> =>
    Option.match(access.draftColumn, {
      onNone: () => filter,
      onSome: (draft) => and(filter, eq(draft, false)),
    });
  return Match.value(scope).pipe(
    Match.discriminatorsExhaustive("kind")({
      all: (): ListFilter<Following> => always,
      public: () => published(eq(access.visibilityColumn, "public")),
      member: (member) =>
        or(
          published(eq(access.visibilityColumn, "public")),
          eq(access.ownerColumn, member.userId),
          published(
            and(
              eq(access.visibilityColumn, "followers"),
              isIn(access.ownerColumn, member.following),
            ),
          ),
        ),
    }),
  );
};

/**
 * The soft-delete arm of every list: tombstones only when the caller asked
 * AND holds the view-deleted rung — asking without the rung changes nothing.
 *
 * @since 0.1.0
 */
export const softDeleteFilter = <Following>(
  viewer: Viewer,
  policy: AccessPolicy,
  includeDeleted: boolean,
): ListFilter<Following> =>
  includeDeleted && Option.exists(viewer, policy.canViewDeleted) ? always : ne("action", "delete");

/**
 * The reference-leaf privacy arm (`PUB-009`): `visibility = 'public'` unless
 * the viewer holds the view-private rung, or the view has no visibility
 * column (an Entity leaf rides no such axis). Given a followers arm (the
 * leaf's `access`, declaring `followersOfColumn` over a view that carries
 * it, and the follower seam), a signed-in viewer also lists the `followers`
 * rows whose column names them or an account they follow (pulpit#92):
 * `visibility = 'followers' AND (<followersOfColumn> = <viewer> OR
 * <followersOfColumn> IN (<following>))`. Without one (the default,
 * `Option.none()`), a `followers` row is the view-private rung's alone.
 * Pass `Option.some({ access, followers })` whenever the leaf declares
 * `followersOfColumn`: `defineSubtype`'s `get` / `getMany` read the
 * declared column, so the three-argument form agrees with them only for a
 * leaf without it (for one with it, `get` serves `followers` rows this
 * hides).
 *
 * @since 0.1.0
 */
export const referencePrivacyFilter = <Following>(
  viewer: Viewer,
  policy: AccessPolicy,
  viewColumns: ReadonlySet<string>,
  followersArm: Option.Option<{
    readonly access: Extract<LeafAccess, { kind: "reference" }>;
    readonly followers: FollowerSeam<Following, unknown>;
  }> = Option.none(),
): ListFilter<Following> =>
  Option.match(followersArm, {
    onNone: () => referenceListFilter<Following>({}, viewColumns, publicOrAll(viewer, policy)),
    onSome: (arm) =>
      referenceListFilter(arm.access, viewColumns, readScopeFor(viewer, policy, arm.followers)),
  });

/** A read scope without the follower set: a member reads as the anonymous do. */
const publicOrAll = <Following>(viewer: Viewer, policy: AccessPolicy): ReadScope<Following> =>
  Option.exists(viewer, policy.canViewPrivate) ? { kind: "all" } : { kind: "public" };

// ── The write gates ───────────────────────────────────────────────────

const signedIn = (viewer: Viewer): Effect.Effect<ViewerAccount, Unauthorized> =>
  Option.match(viewer, {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: Effect.succeed,
  });

const atRung = (
  viewer: Viewer,
  admits: (account: ViewerAccount) => boolean,
): Effect.Effect<ViewerAccount, Unauthorized | Forbidden> =>
  Effect.flatMap(signedIn(viewer), (account) =>
    admits(account) ? Effect.succeed(account) : Effect.fail(new Forbidden()),
  );

/**
 * The gate for a CREATE: reference data → the corpus-write rung; owned → any signed-in account.
 *
 * @since 0.1.0
 */
export const requireCreator = (
  access: LeafAccess,
  viewer: Viewer,
  policy: AccessPolicy,
): Effect.Effect<ViewerAccount, Unauthorized | Forbidden> =>
  access.kind === "reference" ? atRung(viewer, policy.canWriteCorpus) : signedIn(viewer);

/**
 * The gate for a write to an EXISTING row: reference data → the corpus-write
 * rung; owned material → the row's owner or the moderate rung. A missing
 * owner on an owned leaf is {@link NodeNotFound}, never an open gate.
 *
 * On an owned leaf it never reads the row's visibility, draft or delete state:
 * a signed-in caller who is neither the owner nor at the moderate rung gets
 * {@link Forbidden} for any row with an owner record,
 * hidden or not, so the gate deliberately confirms existence (pulpit#24, an
 * exception to `SEC-AUTH-ENUM-001`; SECURITY.md → "Existence disclosure by the
 * write gates"). An anonymous caller gets `Unauthorized` for every id.
 *
 * On a reference leaf this is the rung check alone: it reads no row, so it
 * answers `Unauthorized` / `Forbidden` alike for every id. `defineSubtype`
 * follows it with the read rung the row demands (pulpit#101): a row its `get`
 * hides from the caller fails {@link NodeNotFound}, as `get` does
 * (`PUB-009`, `SEC-AUTH-ENUM-001`). A caller using this gate directly on a
 * reference row must apply that check too.
 *
 * @since 0.1.0
 */
export const requireWriter = <E, R>(
  access: LeafAccess,
  viewer: Viewer,
  policy: AccessPolicy,
  row: { readonly type: string; readonly id: string },
  ownerOf: Effect.Effect<Option.Option<string>, E, R>,
): Effect.Effect<ViewerAccount, Unauthorized | Forbidden | NodeNotFound | E, R> =>
  access.kind === "reference"
    ? atRung(viewer, policy.canWriteCorpus)
    : Effect.gen(function* () {
        const account = yield* signedIn(viewer);
        const owner = yield* ownerOf;
        if (Option.isNone(owner)) return yield* new NodeNotFound(row);
        if (account.id === owner.value || policy.canModerate(account)) return account;
        return yield* new Forbidden();
      });

// ── The current-version view seam ─────────────────────────────────────

/**
 * A current-version view row: its node id, its head `version` and `action`,
 * and the leaf's columns. The view projects `version` from the head row
 * (pulpit#65), so a read carries the version an `If-Match` must name: a
 * mapper stamps it on the wire with {@link versionMeta}, and a
 * single-resource response's `ETag` is {@link versionEtag}. `id`, `version`
 * and `action` are the view's own, so no leaf column may take those names.
 *
 * @since 0.1.0
 */
export interface LeafRow {
  readonly id: string;
  /** The head version, the one an update's `expectedVersion` names. */
  readonly version: bigint;
  readonly action: VersionAction;
  readonly [column: string]: ColumnValue;
}

/**
 * The resource-object `meta` a {@link SubtypeDefinition.toResource} mapper
 * stamps: the row's head version as a decimal string (`bigint` has no JSON
 * form). It reaches only a resource the read already serves the viewer, so it
 * discloses nothing about a hidden row (`SEC-AUTH-ENUM-001`); what it does
 * disclose about a shown one is how many versions its chain holds.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { versionMeta } from "@thomasfosterau/pulpit/subtype";
 *
 * const row = { id: "post-1", version: 3n, action: "update" as const, title: "Hello" };
 * const resource = { type: "posts", id: row.id, meta: versionMeta(row) };
 * strictEqual(resource.meta.version, "3");
 * ```
 *
 * @since 0.1.0
 */
export const versionMeta = (row: Pick<LeafRow, "version">): VersionMeta => ({
  version: String(row.version),
});

/**
 * The resource-object `meta` {@link versionMeta} stamps: the head version as
 * a decimal string.
 *
 * @since 0.1.0
 */
export interface VersionMeta {
  readonly version: string;
}

/**
 * What {@link versionEtag} reads: a resource object, by its optional `meta`.
 *
 * @since 0.1.0
 */
export interface VersionedResource {
  // oxlint-disable-next-line effect/prefer-option-over-null -- a JSON:API resource object's optional member, `?: T | undefined` (AGENTS.md → Conventions)
  readonly meta?: object | undefined;
}

// A version is a non-negative integer with no leading zero: anything else in
// `meta.version` is not one this kernel stamped.
const StampedVersion = Schema.Struct({
  meta: Schema.Struct({
    version: Schema.String.check(
      Schema.isPattern(/^(?:0|[1-9][0-9]*)$/, { description: "a head version in decimal" }),
    ),
  }),
});

/**
 * A single-resource response's `ETag` header value, read from the
 * resource's `meta.version` ({@link versionMeta}): a strong tag (`"3"`)
 * whose value is the head version, so the `If-Match` a client echoes names
 * the version its write expects ({@link UpdateRequest.expectedVersion}; the
 * header's mapping onto it is effect-jsonapi's, which 0.16.3 lacks). None when the value carries no
 * decimal `meta.version`; a collection response takes none, having no single
 * version to tag. Never fails.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { Option } from "effect";
 * import { versionEtag } from "@thomasfosterau/pulpit/subtype";
 *
 * const read = { type: "posts", id: "post-1", meta: { version: "3" } };
 * strictEqual(Option.getOrElse(versionEtag(read), () => "none"), '"3"');
 * const unstamped = { type: "posts", id: "post-1", meta: {} };
 * strictEqual(Option.isNone(versionEtag(unstamped)), true);
 * ```
 *
 * @since 0.1.0
 */
export const versionEtag = (resource: VersionedResource): Option.Option<string> =>
  Option.map(
    Schema.decodeUnknownOption(StampedVersion)(resource),
    ({ meta }) => `"${meta.version}"`,
  );

/**
 * One list page and the unpaged total of rows matching the filter.
 *
 * @since 0.1.0
 */
export interface Page<A> {
  readonly rows: ReadonlyArray<A>;
  readonly total: number;
}

/**
 * The hard cap on a page (`SEC-INPUT-003`): no request drives an unbounded `LIMIT`.
 *
 * @since 0.1.0
 */
export const MAX_PAGE_LIMIT = 1000;

/**
 * One key of a list's order: a column of the leaf's current-version view and
 * its direction. A list sorts by its keys in turn with a `NULL` (or absent)
 * column after every value in **both** directions (`NULLS LAST`, which
 * PostgreSQL's `DESC` does not default to), then by `id` ascending, so the
 * order is total and an offset page never skips or repeats a row. A string
 * sorts by code point (SQL's `COLLATE "C"`), a number or `bigint` by value, a
 * boolean `false` first and a `Date` by its instant; `id` closes in byte
 * order too (pulpit#112).
 *
 * **Only scalar orderable columns.** A sort key's column must hold one
 * scalar orderable type: text, numeric, boolean, timestamp or bigint. A
 * `json` / `jsonb` or array column is outside the contract (PostgreSQL
 * refuses to order `json` and orders `jsonb` by its own rules, which no
 * fake reproduces), so neither an adapter nor a leaf's `sortable` list may
 * offer one.
 *
 * **What an order discloses.** The column need not be one the resource
 * exposes: without a `sortable` allow-list on the leaf
 * ({@link SubtypeDefinition.sortable}), **every** declared view column is
 * sortable, so a caller can rank the rows it may already see by a column the
 * API never shows it, and an {@link InvalidListOrder} tells it which names
 * are view columns. No hidden row, nor any total, is revealed.
 *
 * @since 0.1.0
 */
export interface ListOrder {
  /** A sortable column of the view; any other fails the list with {@link InvalidListOrder}. */
  readonly column: string;
  readonly direction: "asc" | "desc";
}

/**
 * The read seam over a leaf's fail-closed current-version view, plus the
 * owner stamp. `columns` is the view's column set — what the owned filter
 * checks its declaration against.
 *
 * @since 0.1.0
 */
export interface LeafStore<Row extends LeafRow, Following, E, R> {
  /** The view's column names; an owned declaration naming a column outside this set reads nothing (`get`, `getMany` or `list`). */
  readonly columns: ReadonlySet<string>;
  /** One row of the current-version view by id, or none. Applies no visibility policy. */
  readonly get: (id: string) => Effect.Effect<Option.Option<Row>, E, R>;
  /** One `id = ANY($ids)` read, never `ids.length` sequential gets. */
  readonly getMany: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Row>, E, R>;
  /**
   * The page under `where`, with the unpaged total, ordered totally by
   * `orderBy` and then `id`: `ORDER BY <column> ASC|DESC NULLS LAST, …,
   * id ASC`, every string key under `COLLATE "C"` (see {@link ListOrder}).
   * `orderBy` arrives checked: each column is in `columns`, each direction
   * `asc` or `desc`, no column twice; empty is `id` ascending alone. The
   * order never changes which rows match `where`, nor `total`.
   */
  readonly list: (query: {
    readonly where: ListFilter<Following>;
    readonly orderBy: ReadonlyArray<ListOrder>;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<Page<Row>, E, R>;
  /** The owner of an owned node (`core.node_owner`), or none. */
  readonly ownerOf: (id: string) => Effect.Effect<Option.Option<string>, E, R>;
  /** Record a freshly created owned node's owner. */
  readonly stampOwner: (id: string, ownerId: string) => Effect.Effect<void, E, R>;
}

// ── The lifecycle hook seam ───────────────────────────────────────────

/**
 * A before hook's refusal: the write it was shown does not happen, and the
 * caller's transaction rolls back with it. `reason` is the hook's own,
 * for the wire's 422 (or whatever the application maps it to).
 *
 * @since 0.1.0
 */
export class WriteRejected extends Schema.TaggedError<WriteRejected>()("WriteRejected", {
  type: Schema.String,
  id: Schema.String,
  action: Schema.String,
  reason: Schema.String,
}) {}

/**
 * What a {@link BeforeWriteHook} is shown: the chain's {@link ChainAppendEvent}
 * (the action, the node, the head the write extends, the patch), plus the
 * leaf's type and the request's viewer.
 *
 * @since 0.1.0
 */
export interface BeforeWriteEvent extends ChainAppendEvent {
  readonly type: string;
  readonly viewer: Viewer;
}

/**
 * A hook that runs inside the write, after its gate and its head read and
 * before the version is appended, in the caller's transaction. It returns
 * the patch the write applies (the event's, or a transformed one: a derived
 * slug, a normalised field), or fails the write, appending nothing, with
 * {@link WriteRejected} or the store's `E` (an outbox insert that failed). A
 * side effect that must not be lost belongs here, as a row the same
 * transaction writes (an outbox), never in an {@link AfterWriteHook}.
 *
 * @since 0.1.0
 */
export interface BeforeWriteHook<E, R> {
  /** Names the hook in its span and in a logged failure. */
  readonly name: string;
  readonly run: (event: BeforeWriteEvent) => Effect.Effect<ChainPatch, WriteRejected | E, R>;
}

/**
 * What an {@link AfterWriteHook} is shown, once the write has committed:
 * the leaf's type, the action, the version entry the write landed at, and
 * the resource as its writer now reads it (none for a `delete`, or when the
 * write hid the row from its own writer or the re-read failed).
 *
 * @since 0.1.0
 */
export interface AfterWriteEvent<Resource> {
  readonly type: string;
  readonly action: WriteAction;
  readonly write: ChainWrite;
  readonly resource: Option.Option<Resource>;
}

/**
 * A hook that runs after the write's transaction has committed
 * ({@link subtypeHandlers}, which owns the boundary). It never fails the
 * write: its failure, a defect included, goes to the hooks'
 * {@link LifecycleHooks.afterFailure} policy, and the next hook still runs
 * under `"log"`. It runs uninterruptibly, so a committed write always
 * reaches it; a delivery that must survive a crash is an outbox row
 * written by a {@link BeforeWriteHook} instead.
 *
 * @since 0.1.0
 */
export interface AfterWriteHook<Resource, E, R> {
  /** Names the hook in its span and in a logged failure. */
  readonly name: string;
  readonly run: (event: AfterWriteEvent<Resource>) => Effect.Effect<void, E, R>;
}

/**
 * A leaf's write side effects, composed per leaf type by the application:
 * provide them from a `Context` service (a `Layer`) through
 * {@link SubtypeDefinition.hooks}. The hooks run in array order, so their
 * order is deterministic and is the application's to choose; the default is
 * none ({@link noHooks}).
 *
 * Events fire on explicit writes only: `create`, `update`, `restore`,
 * `delete` (not an already tombstoned node's, which writes nothing) and
 * `restoreVersion`. A scheduled version whose `publishedAt` stamp arrives
 * later writes nothing and emits nothing; an application that needs a side
 * effect when scheduled content goes live drives a sweep from its cron with
 * `./publication`'s `duePublications`.
 *
 * @since 0.1.0
 */
export interface LifecycleHooks<Resource, E, R> {
  readonly before: ReadonlyArray<BeforeWriteHook<E, R>>;
  readonly after: ReadonlyArray<AfterWriteHook<Resource, E, R>>;
  /**
   * What an after hook's failure becomes: `"log"` (the default) logs its
   * cause at error level and goes on; `"defect"` dies with it, so the
   * handler fails with a defect although the write committed.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the `"log"` default
  readonly afterFailure?: "log" | "defect" | undefined;
}

/**
 * No hooks: the default for a leaf that declares none.
 *
 * @since 0.1.0
 */
export const noHooks = <Resource = never, E = never, R = never>(): LifecycleHooks<
  Resource,
  E,
  R
> => ({ before: [], after: [] });

/**
 * Concatenate hook sets in order: `a`'s before hooks run before `b`'s, and
 * likewise after. The first set's `afterFailure` that is given wins.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { composeHooks, noHooks, type BeforeWriteHook } from "@thomasfosterau/pulpit/subtype";
 *
 * const audit: BeforeWriteHook<never, never> = {
 *   name: "audit",
 *   run: (event) => Effect.succeed(event.patch),
 * };
 * const hooks = composeHooks({ before: [audit], after: [] }, noHooks());
 * strictEqual(hooks.before[0]?.name, "audit");
 * ```
 *
 * @since 0.1.0
 */
export const composeHooks = <Resource, E, R>(
  ...sets: ReadonlyArray<LifecycleHooks<Resource, E, R>>
): LifecycleHooks<Resource, E, R> => {
  const afterFailure = Array.findFirst(sets, (set) => set.afterFailure !== undefined);
  return {
    before: Array.flatMap(sets, (set) => set.before),
    after: Array.flatMap(sets, (set) => set.after),
    afterFailure: Option.getOrUndefined(
      Option.flatMapNullishOr(afterFailure, (set) => set.afterFailure),
    ),
  };
};

/** Run the before hooks in order, each shown the patch the previous one returned. */
const runBefore = <E, R>(
  hooks: ReadonlyArray<BeforeWriteHook<E, R>>,
  event: BeforeWriteEvent,
): Effect.Effect<ChainPatch, WriteRejected | E, R> =>
  Effect.reduce(
    hooks,
    () => event.patch,
    (patch, hook) =>
      hook.run({ ...event, patch }).pipe(Effect.withSpan(`${event.type}.before.${hook.name}`)),
  );

/** Run the after hooks in order, each failure handed to the policy, never to the write. */
const runAfter = <Resource, E, R>(
  hooks: LifecycleHooks<Resource, E, R>,
  event: AfterWriteEvent<Resource>,
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    hooks.after,
    (hook) =>
      hook.run(event).pipe(
        Effect.withSpan(`${event.type}.after.${hook.name}`),
        Effect.catchCause((cause) =>
          hooks.afterFailure === "defect"
            ? Effect.die(Cause.squash(cause))
            : Effect.logError(`${event.type}.after.${hook.name} failed`, cause),
        ),
      ),
    { concurrency: 1, discard: true },
  );

// ── The factory ───────────────────────────────────────────────────────

/**
 * A key's column when it is an object with a string `column`, else `""`.
 * Typed as the request types it, but read as a caller may really send it.
 */
const columnOf = (key: ListOrder | ReadonlyArray<ListOrder>): string =>
  Predicate.isObject(key) && Predicate.isString(key.column) ? key.column : "";

/**
 * A list request's order as the store receives it: an array whose every key
 * is an object with a sortable string `column` and a direction `asc` or
 * `desc`, or {@link InvalidListOrder} for the first key that isn't (or for an
 * `orderBy` that is no array), so no unsortable name reaches SQL and no
 * out-of-type input dies. A repeated column is dropped (its first key
 * already ordered every tie it could), which bounds the keys by the view's
 * columns; each key is rebuilt, so nothing but `column` and `direction`
 * reaches the store.
 */
const checkedOrder = (
  type: string,
  isSortable: (column: string) => boolean,
  keys: ReadonlyArray<ListOrder>,
): Effect.Effect<ReadonlyArray<ListOrder>, InvalidListOrder> => {
  // The request's types are not checked at runtime: a decoded query or an
  // untyped caller can send any value here, so every guard reads it as such.
  const isKey = (key: ListOrder): boolean =>
    Predicate.isObject(key) &&
    Predicate.isString(key.column) &&
    isSortable(key.column) &&
    (key.direction === "asc" || key.direction === "desc");
  // A boolean, not a guard: narrowing a typed array to `Array<unknown>` would lose its keys' type.
  const isList = (value: ReadonlyArray<ListOrder>): boolean => Array.isArray(value);
  if (!isList(keys)) return Effect.fail(new InvalidListOrder({ type, column: columnOf(keys) }));
  return Option.match(
    Array.findFirst(keys, (key) => !isKey(key)),
    {
      onNone: () =>
        Effect.succeed(
          Array.map(
            Array.dedupeWith(keys, (self, that) => self.column === that.column),
            ({ column, direction }): ListOrder => ({ column, direction }),
          ),
        ),
      onSome: (key) => Effect.fail(new InvalidListOrder({ type, column: columnOf(key) })),
    },
  );
};

/**
 * The leaf's sortable-column test, its `sortable` allow-list checked against
 * the view's columns once, when the leaf is declared: an entry outside them
 * throws {@link SubtypeDeclarationError}. Without an allow-list, every
 * declared view column is sortable.
 */
const sortableColumns = (
  type: string,
  columns: ReadonlySet<string>,
  // oxlint-disable-next-line effect/prefer-option-over-null -- `SubtypeDefinition.sortable` as declared, an optional `?: T | undefined` field (AGENTS.md → Conventions)
  sortable: ReadonlyArray<string> | undefined,
): ((column: string) => boolean) => {
  if (sortable === undefined) return (column) => columns.has(column);
  const undeclared = Array.findFirst(sortable, (column) => !columns.has(column));
  if (Option.isSome(undeclared)) {
    throw new SubtypeDeclarationError({
      message: `${type}: sortable names '${undeclared.value}', which is not a column of the view`,
    });
  }
  return (column) => Array.contains(sortable, column);
};

/**
 * A leaf's declaration: its type and access, its seams, and its row → resource mapper.
 *
 * @since 0.1.0
 */
export interface SubtypeDefinition<Row extends LeafRow, Resource, Following, E, R> {
  /** The leaf's JSON:API wire type — names spans and tags `NodeNotFound`. */
  readonly type: string;
  /** How the leaf is gated: `reference` corpus material or `owned` per-member rows. */
  readonly access: LeafAccess;
  /** The version-chain store the writes append through. */
  readonly chain: VersionChainStore<E, R>;
  /** The current-version view the reads and lists go through, plus the owner stamp. */
  readonly leaves: LeafStore<Row, Following, E, R>;
  /** The request's viewer (effect-auth's session context). */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /** The application's role axes. */
  readonly policy: AccessPolicy;
  /** The follower seam; {@link nobodyFollows} when the runtime provides none. */
  readonly followers: FollowerSeam<Following, R>;
  /** Shape a view row into the resource (sync; links resolved by the caller's mapper). */
  readonly toResource: (row: Row) => Resource;
  /**
   * The columns a list may sort by ({@link ListRequest.orderBy}); each must
   * be one of the view's `LeafStore.columns`, holding a scalar orderable
   * type (text, numeric, boolean, timestamp or bigint, never `json` /
   * `jsonb` or an array), or {@link defineSubtype} throws
   * {@link SubtypeDeclarationError}. An order key on any other column fails
   * {@link InvalidListOrder}. With a list, `id` sorts only if listed; `[]`
   * admits only the default `id`-ascending order, so any non-empty
   * {@link ListRequest.orderBy} fails {@link InvalidListOrder}.
   *
   * **Omitted, every declared view column is sortable**, the columns the
   * resource never shows included. That default discloses two things to any
   * caller: the ranking, among the rows it may already see, by any view
   * column (a `rank` or a moderation score it can't read), and, through
   * {@link InvalidListOrder}'s 400, which names are view columns. It never
   * reveals a hidden row nor changes a total (`SEC-AUTH-ENUM-001`). Declare
   * the list to sort only by what the resource exposes (pulpit#112).
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the every-declared-column default
  readonly sortable?: ReadonlyArray<string> | undefined;
  /**
   * The leaf's lifecycle hooks, read per write: an Effect, so the
   * application can hold them in a `Context` service and provide it with a
   * `Layer`. The before hooks run inside every write; the after hooks run in
   * {@link subtypeHandlers} once its transaction has committed. Omitted, the
   * leaf has none ({@link noHooks}), and a write reads nothing extra.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no hooks"
  readonly hooks?: Effect.Effect<LifecycleHooks<Resource, E, R>, never, R> | undefined;
}

/**
 * A list request, as the decoded query hands it over.
 *
 * @since 0.1.0
 */
export interface ListRequest {
  readonly limit: number;
  readonly offset: number;
  readonly includeDeleted: boolean;
  /** The family's own extra predicate (a `?filter[published]=`), or `always`. */
  readonly where: ListFilter<never>;
  /**
   * The order, its keys in turn, closed by `id` ascending with `NULL`s last
   * in both directions (see {@link ListOrder}); absent, empty or `null` (as
   * an unchecked caller may send it, the same as absent) is `id` ascending
   * alone. A column that is not sortable (outside the leaf's
   * `sortable` allow-list or, **when the leaf declares none, any view column
   * at all, the ones the resource never shows included**), a direction other
   * than `asc` / `desc`, or input not shaped as an order (no array, a key
   * that is no object, a `column` that is no string) fails the list with
   * {@link InvalidListOrder}, before the viewer is read; a repeated column
   * adds nothing and is dropped. The order discloses the visible rows'
   * ranking by any sortable column, and the 400 which names are sortable;
   * never a hidden row or a total (see {@link SubtypeDefinition.sortable}).
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions), so a caller can forward its own `undefined` under `exactOptionalPropertyTypes`; the omitted key is the default order
  readonly orderBy?: ReadonlyArray<ListOrder> | undefined;
}

type Gate = Unauthorized | Forbidden;

/**
 * An update's input: the node, the tri-state patch, an optional expected
 * version and, for an edit that applies an accepted proposal, the
 * contributor the version records as `proposedBy` (`./proposals`).
 *
 * @since 0.1.0
 */
export interface UpdateRequest extends Precondition {
  readonly id: string;
  readonly patch: ChainPatch;
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no proposal", and a given value is itself an `Option`
  readonly proposedBy?: Option.Option<string> | undefined;
}

/**
 * The operations {@link defineSubtype} produces for one leaf. Every write
 * also fails {@link WriteRejected} when one of the leaf's before hooks
 * refuses it, after the gate and with nothing appended.
 *
 * @since 0.1.0
 */
export interface SubtypeOps<Resource, E, R> {
  /** The leaf's wire type, as declared. */
  readonly type: string;
  /** The access declaration the operations gate by. */
  readonly access: LeafAccess;
  /**
   * The leaf's lifecycle hooks, as {@link SubtypeDefinition.hooks} provides
   * them; {@link subtypeHandlers} runs their after hooks.
   */
  readonly hooks: Effect.Effect<LifecycleHooks<Resource, E, R>, never, R>;
  /**
   * Create the node at version 0, stamping the viewer as owner on an owned
   * leaf. Fails `Unauthorized` when anonymous, `Forbidden` below the
   * corpus-write rung on a reference leaf, `NodeAlreadyExists` when a
   * caller-supplied id is taken.
   */
  readonly create: (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
  }) => Effect.Effect<
    ChainWrite,
    Gate | WriteRejected | NodeAlreadyExists | VersionConflict | E,
    R
  >;
  /**
   * Append a tri-state patch. Fails `Unauthorized` when anonymous,
   * `Forbidden` below the write rung (the corpus-write rung for reference
   * data, owner-or-moderator for an owned row), `NodeNotFound` when an
   * owned row has no owner, when a reference row is one `get` hides from the
   * caller (`PUB-009`; pulpit#101), or when the node is unknown or
   * tombstoned, and `StaleVersion` when `input.expectedVersion` is not the
   * head (checked after the gate, so only a writer learns the head).
   */
  readonly update: (
    input: UpdateRequest,
  ) => Effect.Effect<
    ChainWrite,
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  /**
   * {@link SubtypeOps.update}, except a tombstone does not fail: the node
   * comes back live (`VERSION-CHAIN-006`). Fails as `update` does, apart from
   * the tombstone. On a reference leaf only the view-deleted rung can see a
   * tombstone, so only it can restore one; anyone else gets `NodeNotFound`.
   */
  readonly restore: (
    input: { readonly id: string; readonly patch: ChainPatch } & Precondition,
  ) => Effect.Effect<
    ChainWrite,
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  /**
   * Tombstone the node (idempotent: an already tombstoned node reports
   * `alreadyDeleted: true` and writes nothing, whatever the precondition).
   * Fails `Unauthorized` when anonymous, `Forbidden` below the write rung,
   * `NodeNotFound` when an owned row has no owner, when a reference row
   * (an already tombstoned one included) is one `get` hides from the caller
   * (`PUB-009`; pulpit#101), or when the node is unknown, and
   * `StaleVersion` when a live node's head is not
   * `precondition.expectedVersion`.
   */
  readonly delete: (
    id: string,
    precondition?: Precondition,
  ) => Effect.Effect<
    ChainWrite & { readonly alreadyDeleted: boolean },
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  /**
   * The row as a resource. Fails `NodeNotFound` when it is missing OR hidden
   * from the viewer (`SEC-AUTH-ENUM-001`).
   */
  readonly get: (id: string) => Effect.Effect<Resource, NodeNotFound | E, R>;
  /** Visible rows by id, in one read; a missing or hidden id is simply absent. */
  readonly getMany: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, Resource>, E, R>;
  /**
   * One page of the rows the viewer may see, with the unpaged total, in
   * `request.orderBy` closed by `id` (`NULL`s last; see {@link ListOrder}).
   * The limit is clamped to {@link MAX_PAGE_LIMIT}. Fails
   * {@link InvalidListOrder}, before the viewer or the store is read, when
   * an order key names a column that is not sortable (see
   * {@link SubtypeDefinition.sortable}) or is not shaped as an order. The
   * order never changes which rows are listed, nor the total
   * (`SEC-AUTH-ENUM-001`).
   */
  readonly list: (request: ListRequest) => Effect.Effect<Page<Resource>, InvalidListOrder | E, R>;
  /**
   * Gated like a write (`READ-009`): the history exposes every state,
   * private and deleted included. Fails as `update` does at the gate (on a
   * reference leaf, `NodeNotFound` for a row `get` hides from the caller,
   * pulpit#101), then `VersionNotFound` when the version has no row.
   */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<VersionSnapshot, Gate | NodeNotFound | VersionNotFound | E, R>;
  /**
   * The field-level change set from version `from` to version `to`: the
   * chain's `compare` (two version reads and `diffStates`, see
   * {@link VersionComparison}) behind exactly {@link SubtypeOps.getVersion}'s
   * gate (`READ-009`), which both run through, so nothing is read before it
   * passes. Fails as `getVersion` does: `Unauthorized` when anonymous;
   * `Forbidden` below the write rung (owner-or-moderator on an owned row,
   * whatever its visibility, pulpit#24; the corpus-write rung on a reference
   * leaf); `NodeNotFound` when an owned row has no owner or a reference row
   * is missing or one `get` hides from the caller (pulpit#101), whichever
   * version is asked for; then `VersionNotFound` for whichever version
   * (`from` first) has no row.
   */
  readonly compare: (
    id: string,
    from: bigint,
    to: bigint,
  ) => Effect.Effect<VersionComparison, Gate | NodeNotFound | VersionNotFound | E, R>;
  /**
   * Re-apply the state at `version` as a new version, gated like a write
   * (on a reference leaf, `NodeNotFound` for a row `get` hides from the
   * caller, pulpit#101). Fails `VersionNotFound`, before writing anything,
   * when that version
   * cannot be fully reconstructed, and `StaleVersion` when the head is not
   * `precondition.expectedVersion`.
   */
  readonly restoreVersion: (
    id: string,
    version: bigint,
    precondition?: Precondition,
  ) => Effect.Effect<
    ChainWrite,
    Gate | WriteRejected | NodeNotFound | VersionNotFound | StaleVersion | VersionConflict | E,
    R
  >;
}

/**
 * Bind a leaf's operations. Every produced operation is traced as
 * `${type}.<operation>`; the write operations run in the caller's
 * transaction (the boundary is the handler seam's, website #1883).
 *
 * Throws {@link SubtypeDeclarationError}, when the leaf is declared, for a
 * `sortable` entry that is not a column of the view.
 *
 * @since 0.1.0
 */
export const defineSubtype = <Row extends LeafRow, Resource, Following, E, R>(
  definition: SubtypeDefinition<Row, Resource, Following, E, R>,
): SubtypeOps<Resource, E, R> => {
  const { type, access, leaves, policy, followers, toResource } = definition;
  const hooks = definition.hooks ?? Effect.succeed(noHooks<Resource, E, R>());
  // The history reads run no hook, so they read through a chain bound without one.
  const history = defineVersionChain(type, definition.chain);
  // Bound only for a leaf that declares hooks, so a leaf without them reads nothing extra.
  const chain = defineVersionChain<E | WriteRejected, R>(
    type,
    definition.chain,
    definition.hooks === undefined
      ? {}
      : {
          beforeAppend: (event) =>
            Effect.flatMap(hooks, ({ before }) =>
              Array.isReadonlyArrayNonEmpty(before)
                ? Effect.flatMap(definition.viewer, (viewer) =>
                    runBefore(before, { ...event, type, viewer }),
                  )
                : Effect.succeed(event.patch),
            ),
        },
  );
  const actor = (account: ViewerAccount) => Option.some(account.id);

  // The view's column set is fixed at bind time, so the owned leaf's
  // declared-column check is answered once, not per row.
  const ownedColumnsDeclared = access.kind === "owned" && declaresColumns(access, leaves.columns);
  // Checked here, so a misspelt `sortable` entry throws when the leaf is declared.
  const isSortable = sortableColumns(type, leaves.columns, definition.sortable);

  /**
   * The row's own visibility, by access kind; the soft-delete axis is checked
   * by the caller. It fails closed exactly where the list filter does, so
   * `get` / `getMany` never serve a row `list` hides (SEC-AUTH-ENUM-001): an
   * owned leaf whose view lacks a declared column shows no row, as
   * `ownedListFilter` lists none; a reference row shows only when the view
   * has no `visibility` column, the viewer holds the view-private rung, its
   * visibility is exactly `public`, or it is exactly `followers` and the
   * viewer is, or follows, the account its declared `followersOfColumn` names, as
   * `referencePrivacyFilter` lists (pulpit#92). The reference arm is one
   * shared predicate with `./edges`' `canViewEndpoint`.
   */
  const rowVisible = (viewer: Viewer, row: Row): Effect.Effect<boolean, never, R> => {
    if (access.kind === "reference") {
      return canViewReferenceRow(access, leaves.columns, viewer, policy, followers, row);
    }
    return ownedColumnsDeclared
      ? canViewOwnedRow(viewer, policy, followers, ownedFacts(access, row))
      : Effect.succeed(false);
  };

  const visible = (viewer: Viewer, row: Row): Effect.Effect<boolean, never, R> =>
    row.action === "delete" && !Option.exists(viewer, policy.canViewDeleted)
      ? Effect.succeed(false)
      : rowVisible(viewer, row);

  /**
   * The row `get` serves the viewer: a missing or hidden row is the same
   * {@link NodeNotFound} (SEC-AUTH-ENUM-001). `get` and the reference write
   * gate both read through it, so they can never disagree (pulpit#101).
   */
  const visibleRow = (viewer: Viewer, id: string): Effect.Effect<Row, NodeNotFound | E, R> =>
    Effect.gen(function* () {
      const row = yield* leaves.get(id);
      if (Option.isSome(row) && (yield* visible(viewer, row.value))) return row.value;
      return yield* new NodeNotFound({ type, id });
    });

  /**
   * The gate for a write or history read to an existing row. On a reference
   * leaf, the corpus-write rung and then the read rung the row demands: a
   * corpus writer who can't `get` the row learns `NodeNotFound`, exactly as
   * from `get`, before any content is read or written (pulpit#101,
   * `PUB-009`). The rung check runs first and reads no row, so a caller below
   * it gets `Unauthorized` / `Forbidden` for every id alike. An owned leaf's
   * gate is unchanged (pulpit#24).
   */
  const writer = (viewer: Viewer, id: string) =>
    Effect.tap(requireWriter(access, viewer, policy, { type, id }, leaves.ownerOf(id)), () =>
      access.kind === "reference" ? Effect.asVoid(visibleRow(viewer, id)) : Effect.void,
    );

  const create = Effect.fn(`${type}.create`)(function* (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
  }) {
    const account = yield* requireCreator(access, yield* definition.viewer, policy);
    const written = yield* chain.create({ ...input, actorId: actor(account) });
    if (access.kind === "owned") yield* leaves.stampOwner(written.id, account.id);
    return written;
  });

  const update = Effect.fn(`${type}.update`)(function* (input: UpdateRequest) {
    const account = yield* writer(yield* definition.viewer, input.id);
    return yield* chain.update({ ...input, actorId: actor(account) });
  });

  const restore = Effect.fn(`${type}.restore`)(function* (
    input: { readonly id: string; readonly patch: ChainPatch } & Precondition,
  ) {
    const account = yield* writer(yield* definition.viewer, input.id);
    return yield* chain.restore({ ...input, actorId: actor(account) });
  });

  const softDelete = Effect.fn(`${type}.delete`)(function* (
    id: string,
    precondition: Precondition = {},
  ) {
    const account = yield* writer(yield* definition.viewer, id);
    return yield* chain.delete(id, actor(account), precondition);
  });

  const get = Effect.fn(`${type}.get`)(function* (id: string) {
    // Hidden and missing are the same answer (SEC-AUTH-ENUM-001).
    return toResource(yield* visibleRow(yield* definition.viewer, id));
  });

  const getMany = Effect.fn(`${type}.getMany`)(function* (ids: ReadonlyArray<string>) {
    if (!Array.isReadonlyArrayNonEmpty(ids)) return HashMap.empty<string, Resource>();
    const viewer = yield* definition.viewer;
    const rows = yield* leaves.getMany(Array.dedupe(ids));
    const shown = yield* Effect.filter(rows, (row) => visible(viewer, row));
    return HashMap.fromIterable(Array.map(shown, (row) => [row.id, toResource(row)] as const));
  });

  const list = Effect.fn(`${type}.list`)(function* (request: ListRequest) {
    const orderBy = yield* checkedOrder(type, isSortable, request.orderBy ?? []);
    const viewer = yield* definition.viewer;
    const privacy =
      access.kind === "owned"
        ? ownedListFilter(access, leaves.columns, readScopeFor(viewer, policy, followers))
        : referencePrivacyFilter(
            viewer,
            policy,
            leaves.columns,
            Option.some({ access, followers }),
          );
    const where = and<Following>(
      softDeleteFilter(viewer, policy, request.includeDeleted),
      privacy,
      request.where,
    );
    const page = yield* leaves.list({
      where,
      orderBy,
      limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
      offset: Math.max(0, Math.trunc(request.offset)),
    });
    return { rows: page.rows.map(toResource), total: page.total };
  });

  /**
   * A history read (`READ-009`): the viewer's {@link writer} gate on `id`,
   * then `read`. `getVersion` and `compare` both run through it, so their
   * gate is one code path and `read` never runs for a caller it refuses.
   */
  const historyRead = <A, E2>(id: string, read: Effect.Effect<A, E2, R>) =>
    Effect.andThen(
      Effect.flatMap(definition.viewer, (viewer) => writer(viewer, id)),
      read,
    );

  const getVersion = Effect.fn(`${type}.getVersion`)(function* (id: string, version: bigint) {
    return yield* historyRead(id, history.getVersion(id, version));
  });

  const compare = Effect.fn(`${type}.compare`)(function* (id: string, from: bigint, to: bigint) {
    return yield* historyRead(id, history.compare(id, from, to));
  });

  const restoreVersion = Effect.fn(`${type}.restoreVersion`)(function* (
    id: string,
    version: bigint,
    precondition: Precondition = {},
  ) {
    const account = yield* writer(yield* definition.viewer, id);
    return yield* chain.restoreVersion(id, version, actor(account), precondition);
  });

  return {
    type,
    access,
    hooks,
    create,
    update,
    restore,
    delete: softDelete,
    get,
    getMany,
    list,
    getVersion,
    compare,
    restoreVersion,
  };
};

// ── The handlers seam ─────────────────────────────────────────────────

/**
 * The resource cache's write side: `set` writes the resource through — the
 * cache itself refuses (and evicts) a non-serveable one, so a
 * `public → private` flip self-purges — and `delete` evicts. The application
 * fills it with a cache it owns; no library is expected to provide one
 * (effect-web dropped its Cloudflare package, and the planned cache with it,
 * on effect-web#33).
 *
 * @since 0.1.0
 */
export interface ResourceCacheSeam<Resource, R> {
  /**
   * Write the resource through; the cache refuses (and evicts) one that
   * isn't serveable. Never fails.
   */
  readonly set: (id: string, resource: Resource) => Effect.Effect<void, never, R>;
  /** Evict the resource. Never fails. */
  readonly delete: (id: string) => Effect.Effect<void, never, R>;
}

/**
 * The resource cache's write-through as an {@link AfterWriteHook}: a write
 * whose writer re-read the resource sets it, and any other (a `delete`, or a
 * write whose re-read failed or no longer shows the row) evicts it
 * (`CACHE-AUTH-005`). {@link subtypeHandlers} runs it first, before the
 * leaf's own after hooks, whenever its config has a cache. Never fails.
 *
 * @since 0.1.0
 */
export const cacheWriteThrough = <Resource, R>(
  cache: ResourceCacheSeam<Resource, R>,
): AfterWriteHook<Resource, never, R> => ({
  name: "cache",
  run: ({ write, resource }) =>
    Option.match(resource, {
      onNone: () => cache.delete(write.id),
      onSome: (value) => cache.set(write.id, value),
    }),
});

/**
 * The handler record a leaf contributes to a JSON:API server's resource
 * handlers — one entry per endpoint, each returning the resource the document
 * assembler wraps — plus the version-restore command, which has no JSON:API
 * endpoint and is run SSR-direct.
 *
 * {@link subtypeResourceHandlers} turns the record into effect-jsonapi's
 * `ResourceHandlers.make` CRUD handlers (pulpit#5).
 *
 * Every write re-reads the row after the chain write and hands it to the
 * leaf's after hooks ({@link LifecycleHooks}), the cache write-through
 * ({@link cacheWriteThrough}) first, so it writes the resource through the
 * cache; that write-through is why these exist rather than each route
 * calling the operation directly: the cache serves
 * anonymous reads, and a write that skipped it would leave them on the
 * superseded content until the TTL expired. The re-read runs as the writer,
 * so a write that hides the row from its own writer fails it
 * (`NodeNotFound`) after the write committed; the handler then evicts the
 * entry before failing with the re-read's own error, as it does for any
 * re-read failure (a store error, a defect, an interrupt), so the cache
 * never keeps the superseded resource (`CACHE-AUTH-005`, pulpit#107). The
 * chain write runs inside `transact` (the handler seam's boundary, website
 * #1883); the re-read stays outside it. An interrupt can't separate a
 * committed write from its write-through or eviction: a failure of the
 * boundary after the operation itself succeeded (an interrupt included)
 * evicts too, since the write may have committed, while a write the gate
 * or the precondition refuses never touches the cache, even when a
 * `transact` that retries internally rolled back an earlier attempt that
 * wrote: only the last attempt counts. That holds for `delete`'s eviction
 * as well.
 *
 * `restore` is the operations' `restore` with the same write-through.
 * `update`, `restore`, `delete` and `restoreVersion` take the operations' optional
 * expected version ({@link Precondition}); the HTTP layer maps a request's
 * `If-Match` onto it and a `StaleVersion` failure onto the 412.
 *
 * @since 0.1.0
 */
export interface SubtypeHandlers<Resource, E, R> {
  readonly list: SubtypeOps<Resource, E, R>["list"];
  readonly get: SubtypeOps<Resource, E, R>["get"];
  readonly create: (input: {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
  }) => Effect.Effect<
    Resource,
    Gate | WriteRejected | NodeAlreadyExists | NodeNotFound | VersionConflict | E,
    R
  >;
  readonly update: (
    input: { readonly id: string; readonly patch: ChainPatch } & Precondition,
  ) => Effect.Effect<
    Resource,
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  readonly restore: (
    input: { readonly id: string; readonly patch: ChainPatch } & Precondition,
  ) => Effect.Effect<
    Resource,
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  readonly delete: (
    id: string,
    precondition?: Precondition,
  ) => Effect.Effect<
    void,
    Gate | WriteRejected | NodeNotFound | StaleVersion | VersionConflict | E,
    R
  >;
  readonly restoreVersion: (
    input: { readonly id: string; readonly version: bigint } & Precondition,
  ) => Effect.Effect<
    Resource,
    Gate | WriteRejected | NodeNotFound | VersionNotFound | StaleVersion | VersionConflict | E,
    R
  >;
}

/**
 * What {@link subtypeHandlers} needs besides the operations.
 *
 * @since 0.1.0
 */
export interface SubtypeHandlersConfig<Resource, R> {
  /** The write boundary — always-open: a nested call is a SAVEPOINT (website #1883). */
  readonly transact: <A, E2>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>;
  /** The leaf's cache, when it has one. */
  readonly cache: Option.Option<ResourceCacheSeam<Resource, R>>;
}

/**
 * Wrap a leaf's operations as its handler record. An owned leaf may still
 * be cached — `CACHE-AUTH-005` is enforced by the cache's serveability
 * policy (`./publication`'s `isPubliclyServeable` with `owned: true`), which
 * only ever holds its public rows, and by the handlers' own eviction when a
 * committed write can't be re-read or written through (see
 * {@link SubtypeHandlers}). Each write fails with its operation's error, or
 * with the re-read's.
 *
 * @since 0.1.0
 */
export const subtypeHandlers = <Resource, E, R>(
  ops: SubtypeOps<Resource, E, R>,
  config: SubtypeHandlersConfig<Resource, R>,
): SubtypeHandlers<Resource, E, R> => {
  const evict = (id: string) =>
    Option.match(config.cache, { onNone: () => Effect.void, onSome: (cache) => cache.delete(id) });

  // A write runs under `uninterruptibleMask`: the chain write (inside
  // `transact`) and the re-read stay interruptible through `restore`, but
  // the step between them, and the cache step after, cannot be skipped by
  // an interrupt, so a committed write always reaches its write-through or
  // eviction (`CACHE-AUTH-005`). Once the operation itself has succeeded
  // (its gate passed and the chain write ran), any later failure of the
  // boundary, an interrupt included, evicts: the write may have committed.
  // A request the gate refused never evicts, so a forbidden request can't
  // bust the cache. The flag is cleared at the start of each attempt, so a
  // `transact` that retries internally, rolling back an attempt that wrote,
  // evicts only when its last attempt wrote.
  const committed = <A extends ChainWrite, E2>(
    restore: <AX, EX, RX>(effect: Effect.Effect<AX, EX, RX>) => Effect.Effect<AX, EX, RX>,
    operation: Effect.Effect<A, E2, R>,
  ) =>
    Effect.flatMap(Ref.make(Option.none<string>()), (wrote) =>
      restore(
        config.transact(
          Effect.andThen(
            Ref.set(wrote, Option.none()),
            Effect.tap(operation, ({ id }) => Ref.set(wrote, Option.some(id))),
          ),
        ),
      ).pipe(
        Effect.onError(() =>
          Effect.flatMap(
            Ref.get(wrote),
            Option.match({ onNone: () => Effect.void, onSome: evict }),
          ),
        ),
      ),
    );

  /**
   * The after hooks for one committed write: the cache write-through first
   * (when the leaf has a cache), then the leaf's own, in order.
   */
  const after = (event: AfterWriteEvent<Resource>) =>
    Effect.flatMap(ops.hooks, (hooks) =>
      runAfter(
        {
          ...hooks,
          after: [...Option.toArray(Option.map(config.cache, cacheWriteThrough)), ...hooks.after],
        },
        event,
      ),
    );

  // The re-read runs as the writer, after the write committed, and its
  // outcome is the after hooks' `resource`. When it fails (the write hid
  // the row from its own writer: a corpus writer below the view-private
  // rung making a reference row `private`; a store error; an interrupt),
  // the resource is none and the cache hook evicts: the cache must never go
  // on serving the superseded resource, whatever the writer may read now
  // (`CACHE-AUTH-005`, pulpit#107). The handler then fails with the
  // re-read's own error.
  const write = <E2>(action: WriteAction, operation: Effect.Effect<ChainWrite, E2, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(committed(restore, operation), (written) =>
        Effect.flatMap(Effect.exit(restore(ops.get(written.id))), (reread) =>
          Effect.andThen(
            after({
              type: ops.type,
              action,
              write: { id: written.id, version: written.version },
              resource: Exit.isSuccess(reread) ? Option.some(reread.value) : Option.none(),
            }),
            reread,
          ),
        ),
      ),
    );

  return {
    list: ops.list,
    get: ops.get,
    create: (input) => write("create", ops.create(input)),
    update: (input) => write("update", ops.update(input)),
    restore: (input) => write("restore", ops.restore(input)),
    // An already tombstoned node wrote nothing, so it emits nothing; its
    // cache entry is still evicted, as every delete's is.
    delete: (id, precondition) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(committed(restore, ops.delete(id, precondition)), (written) =>
          written.alreadyDeleted
            ? evict(id)
            : after({
                type: ops.type,
                action: "delete",
                write: { id: written.id, version: written.version },
                resource: Option.none(),
              }),
        ),
      ),
    restoreVersion: (input) =>
      write(
        "restoreVersion",
        ops.restoreVersion(input.id, input.version, { expectedVersion: input.expectedVersion }),
      ),
  };
};

// ── effect-jsonapi's ResourceHandlers ─────────────────────────────────

/**
 * What {@link subtypeResourceHandlers} needs besides the handler record:
 * effect-jsonapi's `ResourceHandlers.make` config without its `ops`, `cache`
 * and `transact` (the record already owns the write boundary, the re-read and
 * the cache write-through), plus the three mappings from the endpoint's
 * decoded inputs onto the operations' own.
 *
 * @since 0.1.0
 */
export interface SubtypeResourceHandlersConfig<
  TQuery,
  TCreate,
  TUpdate extends { readonly id: string },
  V,
  RV,
  RL,
  Targets extends Handlers.IncludeTargets,
> extends Omit<
  ResourceHandlers.ReadOnlyConfig<
    TQuery,
    Assemble.ResourceLike,
    string,
    V,
    never,
    never,
    RV,
    RL,
    never,
    Targets
  >,
  "ops" | "cache"
> {
  /** The decoded list query as a {@link ListRequest}: its page, `includeDeleted`, `where` and order. */
  readonly listRequest: (query: TQuery) => ListRequest;
  /** The decoded create payload as the operation's input: the client id, if any, and the state. */
  readonly createInput: (payload: TCreate) => {
    readonly id: Option.Option<string>;
    readonly state: ChainState;
  };
  /**
   * The decoded update payload as the operation's input: the id, the
   * tri-state patch and the optional expected version.
   */
  readonly updateInput: (
    payload: TUpdate,
  ) => { readonly id: string; readonly patch: ChainPatch } & Precondition;
}

/**
 * A leaf's {@link SubtypeHandlers} as effect-jsonapi's CRUD handlers
 * (`ResourceHandlers.make`), keyed by the endpoint names `Group.flat`
 * declares (pulpit#5). Each write goes through the record, so it keeps the
 * record's `transact` boundary, writer re-read, lifecycle hooks and cache
 * write-through (`CACHE-AUTH-005`); effect-jsonapi is given no `cache` and no
 * `transact` of its own, and its mutation tail re-reads the row once more
 * with `get` to assemble the document. `list` answers the page with the
 * unpaged total, and `delete` the 204. `restore` and `restoreVersion` have no
 * JSON:API endpoint and stay on the record. The handlers fail with the
 * record's errors (and effect-jsonapi's `Conflict` for an `update` whose
 * payload id is not the route's, before any operation runs); mapping them to
 * the wire is the application's `ServerErrors`.
 *
 * @since 0.1.0
 */
export const subtypeResourceHandlers = <
  Resource extends Assemble.ResourceLike,
  E,
  R,
  TQuery,
  TCreate,
  TUpdate extends { readonly id: string },
  V = undefined,
  RV = never,
  RL = never,
  Targets extends Handlers.IncludeTargets = never,
>(
  handlers: SubtypeHandlers<Resource, E, R>,
  config: SubtypeResourceHandlersConfig<TQuery, TCreate, TUpdate, V, RV, RL, Targets>,
) => {
  const { listRequest, createInput, updateInput, ...rest } = config;
  return ResourceHandlers.make<
    TQuery,
    TCreate,
    TUpdate,
    Resource,
    string,
    V,
    | E
    | Gate
    | InvalidListOrder
    | WriteRejected
    | NodeAlreadyExists
    | NodeNotFound
    | StaleVersion
    | VersionConflict,
    R,
    R,
    RV,
    RL,
    never,
    Targets
  >({
    ...rest,
    ops: {
      list: (query) =>
        Effect.map(handlers.list(listRequest(query)), (page) => ({
          items: page.rows,
          totalCount: page.total,
        })),
      get: handlers.get,
      create: (payload) => Effect.map(handlers.create(createInput(payload)), ({ id }) => ({ id })),
      update: (payload) => Effect.map(handlers.update(updateInput(payload)), ({ id }) => ({ id })),
      delete: (id) => handlers.delete(id),
    },
  });
};
