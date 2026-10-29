/**
 * **Reactions** (pulpit#196) — one reaction per account per node, a kind
 * from the family's own vocabulary, behind the target's read gate, with a
 * tally per kind for a page of nodes in one grouped read.
 *
 * The behavioural spec is gardeneria's `social.reactions` table
 * (`packages/database/src/tables/reactions.ts`), its model
 * (`packages/models/src/models/reactions.ts`) and its operations
 * (`apps/api/src/operations/reactions.ts`), with their tests.
 *
 * ## The model (owner decision on pulpit#196)
 *
 * - **A reaction is a fact beside the node**, like an edge: no version
 *   chain and no history. The store keys it `(node, account)`, so an
 *   account has at most one reaction per node: reacting again with another
 *   kind replaces it, and unreacting hard-deletes it.
 * - **The kinds are the family's.** {@link defineReactions} takes the
 *   vocabulary (gardeneria's `like | celebrate | helpful | curious |
 *   sympathise`) and throws {@link ReactionDeclarationError} at import for a
 *   malformed one; the kernel holds no list of kinds.
 * - **The target's read gate applies to every operation**
 *   (`SEC-AUTH-ENUM-001`): reacting to, or unreacting from, a node the
 *   viewer can't read fails `NodeNotFound`, never `Forbidden`; a tally
 *   counts only nodes the viewer can read; and the viewer's own list omits
 *   a reaction whose node has since been hidden from them.
 * - **Account erasure** (pulpit#207) deletes a member's reactions through
 *   {@link ReactionStore.eraseAccount}, which the erasure operation calls;
 *   no reaction operation exposes it.
 *
 * Mute and block (pulpit#195) suppress interaction only, which a family
 * enforces with its own gate around `react` once the social graph lands;
 * a tally counts every account's reactions.
 *
 * @copyright Thomas Foster
 * @module pulpit/reactions
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { MAX_SET_VALUES } from "./filter.ts";
import { nowDate, signedIn as signedInAs } from "./internal/plain-rows.ts";
import { MAX_PAGE_LIMIT, type SubtypeOps, type Unauthorized, type Viewer } from "./subtype.ts";
import type { NodeNotFound } from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * A family's reaction vocabulary, as {@link defineReactions} validated it.
 *
 * @since 0.1.0
 */
export interface ReactionKinds {
  readonly kinds: ReadonlyArray<string>;
}

/**
 * Thrown by {@link reactionKinds} at import for a malformed vocabulary: no
 * kind, an empty kind or a kind named twice. Never an Effect failure: no
 * runtime exists when a family is declared.
 *
 * @since 0.1.0
 */
export class ReactionDeclarationError extends Schema.TaggedError<ReactionDeclarationError>()(
  "ReactionDeclarationError",
  { message: Schema.String },
) {}

/**
 * Declare a family's reaction vocabulary. Throws
 * {@link ReactionDeclarationError} for no kind, an empty kind or a repeated
 * one.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { reactionKinds } from "@thomasfosterau/pulpit/reactions";
 *
 * const kinds = reactionKinds(["like", "celebrate", "helpful"]);
 * deepStrictEqual(kinds.kinds, ["like", "celebrate", "helpful"]);
 * ```
 *
 * @since 0.1.0
 */
export const reactionKinds = (kinds: ReadonlyArray<string>): ReactionKinds => {
  if (!Arr.isReadonlyArrayNonEmpty(kinds)) {
    throw new ReactionDeclarationError({ message: "reactions declare no kind" });
  }
  if (kinds.some((kind) => kind === "")) {
    throw new ReactionDeclarationError({ message: "a reaction kind is empty" });
  }
  const repeated = Arr.findFirst(kinds, (kind, index) => kinds.slice(0, index).includes(kind));
  if (Option.isSome(repeated)) {
    throw new ReactionDeclarationError({
      message: `the reaction kind '${repeated.value}' is named twice`,
    });
  }
  return { kinds: [...kinds] };
};

// ── Errors ────────────────────────────────────────────────────────────

/**
 * A kind the family doesn't declare: the wire's 422.
 *
 * @since 0.1.0
 */
export class InvalidReactionKind extends Schema.TaggedError<InvalidReactionKind>()(
  "InvalidReactionKind",
  { type: Schema.String, kind: Schema.String },
) {}

// ── The seam ──────────────────────────────────────────────────────────

/**
 * One stored reaction.
 *
 * @since 0.1.0
 */
export interface ReactionRow {
  readonly nodeId: string;
  readonly accountId: string;
  readonly kind: string;
  readonly reactedAt: Date;
}

/**
 * The reaction table an application supplies (gardeneria's
 * `social.reactions`), keyed `(node_id, account_id)` with both foreign keys
 * cascading. A store seam: no policy, never opens a transaction, fails only
 * with its `E`. See the package README → Seams.
 *
 * @since 0.1.0
 */
export interface ReactionStore<E, R> {
  /**
   * Insert or replace the account's reaction to the node
   * (`INSERT … ON CONFLICT (node_id, account_id) DO UPDATE`), returning the
   * kind it replaced, or none for a first reaction.
   */
  readonly upsert: (row: ReactionRow) => Effect.Effect<Option.Option<string>, E, R>;
  /** Delete the account's reaction to the node; whether a row went. */
  readonly delete: (nodeId: string, accountId: string) => Effect.Effect<boolean, E, R>;
  /**
   * One `GROUP BY node_id, kind` read over `nodeIds` (never empty, no
   * duplicate, at most `MAX_SET_VALUES`): each node's count per kind. A node
   * with no reaction has no key.
   */
  readonly tally: (
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, { readonly [kind: string]: number }>, E, R>;
  /** The account's own reactions, newest first (`reacted_at DESC, node_id`), one page. */
  readonly byAccount: (query: {
    readonly accountId: string;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<ReadonlyArray<ReactionRow>, E, R>;
  /** Delete every reaction the account made (account erasure, pulpit#207); how many went. */
  readonly eraseAccount: (accountId: string) => Effect.Effect<number, E, R>;
}

// ── The operations ────────────────────────────────────────────────────

/**
 * One family's reactions: the kinds, the target leaf's read gate and the
 * store.
 *
 * @since 0.1.0
 */
export interface ReactionsDefinition<Resource, E, R> {
  /** The target leaf's wire type, named in failures. */
  readonly type: string;
  readonly kinds: ReactionKinds;
  /** The target leaf's gated reads: `get` gates a reaction, `getMany` a tally and the viewer's list. */
  readonly target: Pick<SubtypeOps<Resource, E, R>, "get" | "getMany">;
  readonly reactions: ReactionStore<E, R>;
  /** The request's viewer. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
}

/**
 * A node's tally: its count per declared kind (an undeclared kind a store
 * still holds is not counted), and the total.
 *
 * @since 0.1.0
 */
export interface Tally {
  readonly counts: { readonly [kind: string]: number };
  readonly total: number;
}

/**
 * The operations {@link defineReactions} produces.
 *
 * @since 0.1.0
 */
export interface ReactionOps<E, R> {
  /**
   * React to `nodeId` with `kind`, replacing the viewer's earlier reaction
   * to it. Fails `Unauthorized` when anonymous, {@link InvalidReactionKind}
   * for an undeclared kind, and `NodeNotFound` when the viewer can't read
   * the node (`SEC-AUTH-ENUM-001`). Returns the kind it replaced, if any.
   */
  readonly react: (
    nodeId: string,
    kind: string,
  ) => Effect.Effect<
    { readonly replaced: Option.Option<string> },
    Unauthorized | InvalidReactionKind | NodeNotFound | E,
    R
  >;
  /**
   * Remove the viewer's reaction to `nodeId`; whether there was one. Fails
   * `Unauthorized` when anonymous and `NodeNotFound` when the viewer can't
   * read the node.
   */
  readonly unreact: (
    nodeId: string,
  ) => Effect.Effect<{ readonly removed: boolean }, Unauthorized | NodeNotFound | E, R>;
  /**
   * The tally of every node of `nodeIds` the viewer can read, in one
   * `getMany` and one grouped store read (`PERF-DB-001`): each readable node
   * has a key (a zero tally when unreacted), a hidden or missing one has
   * none. More than `MAX_SET_VALUES` distinct ids reads nothing and answers
   * an empty map (`SEC-INPUT-003`).
   */
  readonly tally: (
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, Tally>, E, R>;
  /**
   * One page of the viewer's own reactions, newest first, the limit clamped
   * to `[1, MAX_PAGE_LIMIT]`; a reaction whose node the viewer can no
   * longer read is omitted, so a page may hold fewer rows than the limit.
   * Fails `Unauthorized` when anonymous.
   */
  readonly mine: (request: {
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<ReadonlyArray<ReactionRow>, Unauthorized | E, R>;
}

/**
 * Bind one family's reaction operations. Every operation is traced as
 * `${type}.reactions.<operation>`, and the writes run in the caller's
 * transaction.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import { defineReactions, reactionKinds } from "@thomasfosterau/pulpit/reactions";
 * import { makeInMemoryReactionStore } from "@thomasfosterau/pulpit/testing";
 *
 * const reactions = defineReactions({
 *   type: "posts",
 *   kinds: reactionKinds(["like", "celebrate"]),
 *   // A target leaf where every node is readable; in an application, its `defineSubtype` operations.
 *   target: {
 *     get: (id) => Effect.succeed(id),
 *     getMany: (ids) => Effect.succeed(HashMap.fromIterable(ids.map((id) => [id, id] as const))),
 *   },
 *   reactions: makeInMemoryReactionStore(),
 *   viewer: Effect.succeedSome({ id: "u-1", role: "user" }),
 * });
 * const tally = Effect.runSync(
 *   Effect.andThen(reactions.react("post-1", "like"), reactions.tally(["post-1"])),
 * );
 * deepStrictEqual(Option.map(HashMap.get(tally, "post-1"), (t) => t.total), Option.some(1));
 * ```
 *
 * @since 0.1.0
 */
export const defineReactions = <Resource, E, R>(
  definition: ReactionsDefinition<Resource, E, R>,
): ReactionOps<E, R> => {
  const { type, target, reactions } = definition;
  const kinds = definition.kinds.kinds;
  const signedIn = signedInAs(definition.viewer);

  const react = Effect.fn(`${type}.reactions.react`)(function* (nodeId: string, kind: string) {
    const account = yield* signedIn;
    if (!kinds.includes(kind)) return yield* new InvalidReactionKind({ type, kind });
    // A node the viewer can't read is missing to them (SEC-AUTH-ENUM-001).
    yield* target.get(nodeId);
    const replaced = yield* reactions.upsert({
      nodeId,
      accountId: account.id,
      kind,
      reactedAt: yield* nowDate,
    });
    return { replaced };
  });

  const unreact = Effect.fn(`${type}.reactions.unreact`)(function* (nodeId: string) {
    const account = yield* signedIn;
    yield* target.get(nodeId);
    return { removed: yield* reactions.delete(nodeId, account.id) };
  });

  const zero: { readonly [kind: string]: number } = Record.fromEntries(
    Arr.map(kinds, (kind) => [kind, 0] as const),
  );

  const tally = Effect.fn(`${type}.reactions.tally`)(function* (nodeIds: ReadonlyArray<string>) {
    const wanted = Arr.dedupe(nodeIds);
    if (!Arr.isReadonlyArrayNonEmpty(wanted) || wanted.length > MAX_SET_VALUES) {
      return HashMap.empty<string, Tally>();
    }
    const readable = yield* target.getMany(wanted);
    const shown = Arr.filter(wanted, (id) => HashMap.has(readable, id));
    if (!Arr.isReadonlyArrayNonEmpty(shown)) return HashMap.empty<string, Tally>();
    const counted = yield* reactions.tally(shown);
    return HashMap.fromIterable(
      Arr.map(shown, (id) => {
        const stored = Option.getOrElse(HashMap.get(counted, id), () => ({}));
        const counts = Record.map(zero, (_, kind) =>
          Option.getOrElse(Record.get(stored, kind), () => 0),
        );
        const total = Arr.reduce(Record.values(counts), 0, (sum, count) => sum + count);
        return [id, { counts, total }] as const;
      }),
    );
  });

  const mine = Effect.fn(`${type}.reactions.mine`)(function* (request: {
    readonly limit: number;
    readonly offset: number;
  }) {
    const account = yield* signedIn;
    const rows = yield* reactions.byAccount({
      accountId: account.id,
      limit: Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT)),
      offset: Math.max(0, Math.trunc(request.offset)),
    });
    if (!Arr.isReadonlyArrayNonEmpty(rows)) return rows;
    const readable = yield* target.getMany(Arr.dedupe(Arr.map(rows, (row) => row.nodeId)));
    return Arr.filter(rows, (row) => HashMap.has(readable, row.nodeId));
  });

  return { react, unreact, tally, mine };
};
