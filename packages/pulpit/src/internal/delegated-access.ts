/**
 * **The bridge to effect-auth's read access** (pulpit#5, option (c)): the
 * kernel's row predicates and read scope are decided by effect-auth's
 * `OwnedAccess` / `ReferenceAccess`, never spelt here.
 *
 * effect-auth reads the viewer from a `Guard` kit's viewer service and the
 * follower and member seams from the context (`IsFollower` / `IsMember`),
 * while the kernel's predicates take the viewer, the `AccessPolicy` and the
 * follower seam as values. The bridge crosses that gap without changing the
 * kernel's signatures:
 *
 * - a private two-rung ladder (`member` < `private`) and viewer service: an
 *   account is `private` exactly when the policy's `canViewPrivate` admits
 *   it, so effect-auth's `viewPrivate` axis is the kernel's view-private
 *   rung;
 * - the kernel's follower seam, provided per call as effect-auth's
 *   `IsFollower` (and, when it answers `isMember`, `IsMember`) over the
 *   caller's own context, so a seam with requirements still runs in them.
 *
 * effect-auth's rules then hold for every kernel read: a viewer whose id is
 * empty is anonymous (effect-auth#661), an unprovided seam fails closed, and
 * a seam is asked only for a signed-in viewer on a published row of its
 * visibility. Every value a row carries is read by the caller first
 * (`ownedFacts`, {@link referenceRowOf}), so a NULL or out-of-enum
 * visibility reaches effect-auth as `"private"`, never as an absent axis.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 * Typed structurally, so it never imports `./subtype`. Only server-side
 * modules reach it (`./registry` and `./content` never import effect-auth).
 *
 * @internal
 */
import { Guard, Ladder, OwnedAccess, ReferenceAccess } from "@thomasfosterau/effect-auth";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Visibility } from "../content.ts";
import type { ColumnValue } from "../version-chain.ts";

const isVisibility = Schema.is(Visibility);

/**
 * The parts of `./subtype`'s viewer, policy and follower seam the bridge
 * reads, structurally.
 *
 * @internal
 */
export interface Account {
  readonly id: string;
}
/** @internal */
export interface PrivateRung<A> {
  readonly canViewPrivate: (account: A) => boolean;
}
/** @internal */
export interface Seam<R> {
  readonly isFollower: (followerId: string, ownerId: string) => Effect.Effect<boolean, never, R>;
  readonly isMember?: (accountId: string, groupId: string) => Effect.Effect<boolean, never, R>;
}

/** The bridge's ladder: below and at the kernel's view-private rung. */
const Rungs = Ladder.make(["member", "private"]);

/** The viewer as the bridge's guard kit sees it: the account's id, and its rung on {@link Rungs}. */
interface BridgedAccount {
  readonly id: string;
  readonly role: string;
}

/** The bridge's own viewer service, provided per call; never seen outside this module. */
class BridgedViewer extends Context.Service<BridgedViewer, Option.Option<BridgedAccount>>()(
  "@thomasfosterau/pulpit/internal/BridgedViewer",
) {}

const guards = Guard.make({ ladder: Rungs, viewer: BridgedViewer });
const owned = OwnedAccess.make({ guards, viewPrivate: "private" });
const reference = ReferenceAccess.make({ guards, viewPrivate: "private" });

/**
 * The viewer the kernel's reads act as: an account whose id is empty reads
 * as anonymous, as effect-auth's guards read it (effect-auth#661). The rung
 * checks outside the delegated predicates (the view-deleted rung, the
 * head-reading rungs) read the viewer through it, so they agree with them.
 *
 * @internal
 */
export const knownViewer = <A extends Account>(viewer: Option.Option<A>): Option.Option<A> =>
  Option.filter(viewer, (account) => Str.isNonEmpty(account.id));

const bridged = <A extends Account>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
): Option.Option<BridgedAccount> =>
  Option.map(viewer, (account) => ({
    id: account.id,
    role: policy.canViewPrivate(account) ? "private" : "member",
  }));

/** Run one of effect-auth's read decisions as `viewer`, with the kernel's seam as its follower and member seams. */
const decide = <A extends Account, R>(
  decision: Effect.Effect<boolean, never, BridgedViewer>,
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  seam: Seam<R>,
): Effect.Effect<boolean, never, R> =>
  Effect.flatMap(Effect.context<R>(), (context) => {
    const asViewer = decision.pipe(
      Effect.provideService(BridgedViewer, bridged(viewer, policy)),
      Effect.provideService(OwnedAccess.IsFollower, {
        isFollower: (followerId, ownerId) =>
          Effect.provideContext(seam.isFollower(followerId, ownerId), context),
        following: () => OwnedAccess.nobody,
      }),
    );
    const { isMember } = seam;
    if (isMember === undefined) return asViewer;
    return Effect.provideService(asViewer, OwnedAccess.IsMember, {
      isMember: (accountId, groupId) =>
        Effect.provideContext(isMember(accountId, groupId), context),
      groupsOf: () => OwnedAccess.nobody,
    });
  });

/**
 * Whether `viewer` may read an owned row: `OwnedAccess.canView` over the
 * row's facts. Never fails.
 *
 * @internal
 */
export const canViewOwnedDelegated = <A extends Account, R>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  seam: Seam<R>,
  row: OwnedAccess.OwnedRow,
): Effect.Effect<boolean, never, R> => decide(owned.canView(row), viewer, policy, seam);

/**
 * Whether `viewer` may read a reference row: `ReferenceAccess.canView` over
 * the row's facts ({@link referenceRowOf}). Never fails.
 *
 * @internal
 */
export const canViewReferenceDelegated = <A extends Account, R>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
  seam: Seam<R>,
  row: ReferenceAccess.ReferenceRow,
): Effect.Effect<boolean, never, R> => decide(reference.canView(row), viewer, policy, seam);

/**
 * The facts a reference row is decided from, as effect-auth reads them. A
 * view without the visibility axis omits `visibility` (every row visible);
 * on a view with it, any value outside the enum (a NULL included) is
 * `"private"`, never omitted, since an omitted axis reads as unscoped (fail
 * open). `visibility` is none for a view without the column, else the
 * row's value. An absent followers-of account or group is omitted: nobody.
 *
 * @internal
 */
export const referenceRowOf = (facts: {
  readonly visibility: Option.Option<ColumnValue>;
  readonly followersOf: Option.Option<string>;
  readonly groupId: Option.Option<string>;
}): ReferenceAccess.ReferenceRow =>
  Option.match(facts.visibility, {
    onNone: (): ReferenceAccess.ReferenceRow => ({}),
    onSome: (visibility): ReferenceAccess.ReferenceRow => ({
      visibility: isVisibility(visibility) ? visibility : "private",
      followersOf: Option.getOrUndefined(facts.followersOf),
      groupId: Option.getOrUndefined(facts.groupId),
    }),
  });

/**
 * The kind of a viewer's read scope, as `OwnedAccess.readScope` (which
 * `ReferenceAccess.readScope` shares) decides it: `public` for no viewer
 * (an empty id included, {@link knownViewer}), `all` where the guard kit's
 * `decideRole` admits the view-private rung, and `member` with the viewer's
 * id otherwise. It is synchronous because the kernel's list filters are:
 * effect-auth's `readScope` is an `Effect` over the same two guard reads,
 * and `tests/effect-auth.test.ts` pins the two to the same answer for every
 * viewer. The sets a `member` scope carries are the kernel seam's own
 * answers, filled by the caller, as effect-auth fills them from
 * `IsFollower.following` / `IsMember.groupsOf`. Never throws.
 *
 * @internal
 */
export const readScopeDelegated = <A extends Account>(
  viewer: Option.Option<A>,
  policy: PrivateRung<A>,
):
  | { readonly kind: "all" }
  | { readonly kind: "public" }
  | { readonly kind: "member"; readonly userId: string } =>
  Option.match(bridged(knownViewer(viewer), policy), {
    onNone: () => ({ kind: "public" }) as const,
    onSome: (account) =>
      guards.decideRole(account, "private")
        ? ({ kind: "all" } as const)
        : ({ kind: "member", userId: account.id } as const),
  });
