/**
 * **The comments family** — threaded comments on any node, as versioned
 * owned leaves, behind the target's own read gate and the moderation gate.
 *
 * The behavioural spec is gardeneria's `apps/api/src/operations/comments.ts`
 * (`isCommentReadableBy`, `moderationVisibilityFilter`,
 * `targetVisibilityFilter`) and its tests
 * (`comment-visibility.test.ts`, `comment-target-visibility-flip.test.ts`);
 * a `#NNN` here names a gardeneria issue.
 *
 * ## The model (owner decisions on pulpit#50)
 *
 * - **A comment is a versioned owned leaf**, built with `./subtype`'s
 *   `defineSubtype`: edits append versions, a delete tombstones, and its
 *   history is gated like any leaf's. Its moderation state is
 *   `./moderation`'s, so the leaf's hooks carry `moderationHook` (a new
 *   comment starts `pending`).
 * - **Reply depth is the family's `maxDepth`**, default `1` (gardeneria):
 *   `0` is flat (website), `N` threads `N` deep. A reply past it fails
 *   {@link CommentDepthExceeded}. Each comment stores its `targetType`,
 *   `targetId`, `parentId` (`null` at the top) and `depth` (`0` at the
 *   top), written by `create`.
 *
 * ## The read gates (all three, `SEC-AUTH-ENUM-001`)
 *
 * A comment reads to a viewer only when:
 *
 * 1. the comment leaf's own `get` serves it (its owned visibility, and a
 *    tombstone only to the view-deleted rung);
 * 2. it is `approved`, or the viewer wrote it, or holds the moderate rung
 *    ({@link canViewModerated} / {@link moderationListFilter}, one rule in
 *    two readings): moderation is not ownership, so the target's owner
 *    does not see a pending comment on their own row;
 * 3. the viewer can read its target, through the target leaf's own `get`:
 *    a comment on a target they can't read is missing to them, whatever
 *    its own state, and listing by target checks the target first.
 *
 * Anything else is `NodeNotFound`, never `Forbidden`. Writes to an
 * existing comment are the comment leaf's own (its author, or the moderate
 * rung).
 *
 * @copyright Thomas Foster
 * @module pulpit/comments
 * @since 0.1.0
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { always, and, eq, or, type ListFilter } from "./filter.ts";
import type { ModerationDeclaration } from "./moderation.ts";
import {
  MAX_PAGE_LIMIT,
  type AccessPolicy,
  type Forbidden,
  type InvalidListOrder,
  type LeafRow,
  type LeafStore,
  type ListOrder,
  type Page,
  type SubtypeOps,
  type Unauthorized,
  type Viewer,
  type WriteRejected,
} from "./subtype.ts";
import {
  NodeNotFound,
  type ChainState,
  type ChainWrite,
  type NodeAlreadyExists,
  type VersionConflict,
} from "./version-chain.ts";

// ── Errors ────────────────────────────────────────────────────────────

/**
 * A reply that would nest deeper than the family's `maxDepth`: the wire's
 * 422.
 *
 * @since 0.1.0
 */
export class CommentDepthExceeded extends Schema.TaggedError<CommentDepthExceeded>()(
  "CommentDepthExceeded",
  { type: Schema.String, parentId: Schema.String, maxDepth: Schema.Number },
) {}

/**
 * A comments family declared against the rules: a `maxDepth` that is not
 * a non-negative safe integer. Thrown by {@link defineComments} when the
 * family is declared, never an Effect failure.
 *
 * @since 0.1.0
 */
export class CommentDeclarationError extends Schema.TaggedError<CommentDeclarationError>()(
  "CommentDeclarationError",
  { message: Schema.String },
) {}

// ── The moderation gate ───────────────────────────────────────────────

/**
 * The columns the moderation gate reads: the comment's author (its owner
 * column) and its moderation state.
 *
 * @since 0.1.0
 */
export interface ModeratedColumns {
  readonly authorColumn: string;
  readonly stateColumn: string;
}

/**
 * The moderation gate on one comment row: the moderate rung reads every
 * state, a signed-in viewer their own comments in every state, and
 * everyone else only an exactly `approved` one. The single-row reading of
 * {@link moderationListFilter}; the two never disagree. Never fails.
 *
 * @since 0.1.0
 */
export const canViewModerated = (
  viewer: Viewer,
  policy: AccessPolicy,
  columns: ModeratedColumns,
  row: LeafRow,
): boolean =>
  row[columns.stateColumn] === "approved" ||
  Option.exists(
    viewer,
    (account) =>
      policy.canModerate(account) ||
      (Predicate.isString(row[columns.authorColumn]) && row[columns.authorColumn] === account.id),
  );

/**
 * The moderation gate as a list filter: {@link canViewModerated}'s three
 * arms.
 *
 * @since 0.1.0
 */
export const moderationListFilter = <Following>(
  viewer: Viewer,
  policy: AccessPolicy,
  columns: ModeratedColumns,
): ListFilter<Following> =>
  Option.match(viewer, {
    onNone: (): ListFilter<Following> => eq(columns.stateColumn, "approved"),
    onSome: (account): ListFilter<Following> =>
      policy.canModerate(account)
        ? always
        : or<Following>(eq(columns.stateColumn, "approved"), eq(columns.authorColumn, account.id)),
  });

// ── The family ────────────────────────────────────────────────────────

/**
 * A target leaf a comment may hang off: its read, which the target gate
 * runs as the viewer.
 *
 * @since 0.1.0
 */
export interface CommentTarget<E, R> {
  /** The target leaf's own `get`: `NodeNotFound` for a target the viewer can't read. */
  readonly get: (id: string) => Effect.Effect<unknown, NodeNotFound | E, R>;
}

/**
 * A comments family's declaration.
 *
 * @since 0.1.0
 */
export interface CommentsDefinition<Resource, Following, E, R> {
  /**
   * The comment leaf's operations (`defineSubtype` over an owned access,
   * with `moderationHook` among its hooks).
   */
  readonly comments: SubtypeOps<Resource, E, R>;
  /** The comment leaf's current-version view: the rows the gates read their facts from. */
  readonly leaves: LeafStore<LeafRow, Following, E, R>;
  /** The leaves a comment may target, by wire type; any other type is `NodeNotFound`. */
  readonly targets: { readonly [type: string]: CommentTarget<E, R> };
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
  /** The moderation declaration the comment leaf's hook uses; its `column` is the state the gate reads. */
  readonly moderation: ModerationDeclaration;
  /** The comment's author column: the leaf's `ownerColumn` (conventionally `ownerId`). */
  readonly authorColumn: string;
  /**
   * How deep replies nest: `0` flat, `1` (the default) one level of
   * replies, `N` deeper. A non-negative safe integer, or
   * {@link defineComments} throws {@link CommentDeclarationError}.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the default depth of 1
  readonly maxDepth?: number | undefined;
}

/**
 * A comment create: its target, its parent comment (none for a top-level
 * comment), and the leaf's own columns (its body, its visibility).
 *
 * @since 0.1.0
 */
export interface CommentCreate {
  readonly id: Option.Option<string>;
  readonly targetType: string;
  readonly targetId: string;
  readonly parentId: Option.Option<string>;
  readonly state: ChainState;
}

/**
 * One page of a target's comments.
 *
 * @since 0.1.0
 */
export interface CommentListRequest {
  readonly targetType: string;
  readonly targetId: string;
  /**
   * None: every comment on the target; some none: the top-level comments
   * (`depth = 0`); some parent: that comment's replies.
   */
  readonly parentId: Option.Option<Option.Option<string>>;
  readonly limit: number;
  readonly offset: number;
  /** Tombstoned comments too, for the view-deleted rung (as the leaf's own `list` takes it). */
  readonly includeDeleted: boolean;
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the leaf's default order
  readonly orderBy?: ReadonlyArray<ListOrder> | undefined;
}

/**
 * The operations {@link defineComments} produces.
 *
 * @since 0.1.0
 */
export interface CommentOps<Resource, E, R> {
  /**
   * Comment on a target the viewer can read, as a reply to `parentId`
   * when given (a comment on the same target the viewer can read). Fails
   * `NodeNotFound` for an unreadable target or parent, a parent on another
   * target included; {@link CommentDepthExceeded} past `maxDepth`; and as
   * the comment leaf's `create` does (`Unauthorized` when anonymous).
   */
  readonly create: (
    input: CommentCreate,
  ) => Effect.Effect<
    ChainWrite,
    | NodeNotFound
    | CommentDepthExceeded
    | Unauthorized
    | Forbidden
    | WriteRejected
    | NodeAlreadyExists
    | VersionConflict
    | E,
    R
  >;
  /** One comment, through all three read gates; `NodeNotFound` otherwise. */
  readonly get: (id: string) => Effect.Effect<Resource, NodeNotFound | E, R>;
  /**
   * A target's comments, after its target gate (`NodeNotFound` for a target
   * the viewer can't read), through the comment leaf's own list and the
   * moderation gate. The page is clamped to `MAX_PAGE_LIMIT`; an unsortable
   * order fails `InvalidListOrder`, as the comment leaf's `list` does.
   */
  readonly listByTarget: (
    request: CommentListRequest,
  ) => Effect.Effect<Page<Resource>, NodeNotFound | InvalidListOrder | E, R>;
}

/**
 * Bind a comments family over its comment leaf. Edits, deletes and history
 * stay the comment leaf's own operations.
 *
 * @since 0.1.0
 */
export const defineComments = <Resource, Following, E, R>(
  definition: CommentsDefinition<Resource, Following, E, R>,
): CommentOps<Resource, E, R> => {
  const { comments, leaves, policy } = definition;
  const type = comments.type;
  const maxDepth = definition.maxDepth ?? 1;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new CommentDeclarationError({
      message: `${type}: maxDepth must be a non-negative safe integer, not ${maxDepth}`,
    });
  }
  const columns: ModeratedColumns = {
    authorColumn: definition.authorColumn,
    stateColumn: definition.moderation.column,
  };

  /** The target gate: the target leaf's own read, as the viewer. */
  const targetReadable = (targetType: string, targetId: string) =>
    Option.match(Option.fromUndefinedOr(definition.targets[targetType]), {
      onNone: () => Effect.fail(new NodeNotFound({ type: targetType, id: targetId })),
      onSome: (target) => Effect.asVoid(target.get(targetId)),
    });

  /** The comment row a viewer may read, through all three gates, or `NodeNotFound`. */
  const readableRow = (viewer: Viewer, id: string) =>
    Effect.gen(function* () {
      const resource = yield* comments.get(id);
      const row = yield* leaves.get(id);
      if (Option.isNone(row) || !canViewModerated(viewer, policy, columns, row.value)) {
        return yield* new NodeNotFound({ type, id });
      }
      const targetType = row.value["targetType"];
      const targetId = row.value["targetId"];
      if (!Predicate.isString(targetType) || !Predicate.isString(targetId)) {
        return yield* new NodeNotFound({ type, id });
      }
      // A comment on a target the viewer can't read is missing to them.
      yield* Effect.mapError(
        targetReadable(targetType, targetId),
        () => new NodeNotFound({ type, id }),
      );
      return { resource, row: row.value };
    });

  /** A row's stored depth: `0` for a top-level comment; a value that is no number reads as past every limit. */
  const depthOf = (row: LeafRow): number => {
    const depth = row["depth"];
    return Predicate.isNumber(depth) ? depth : Number.POSITIVE_INFINITY;
  };

  const create = Effect.fn(`${type}.comments.create`)(function* (input: CommentCreate) {
    const viewer = yield* definition.viewer;
    yield* targetReadable(input.targetType, input.targetId);
    let depth = 0;
    if (Option.isSome(input.parentId)) {
      const parentId = input.parentId.value;
      const parent = yield* readableRow(viewer, parentId);
      if (
        parent.row["targetId"] !== input.targetId ||
        parent.row["targetType"] !== input.targetType
      ) {
        return yield* new NodeNotFound({ type, id: parentId });
      }
      depth = depthOf(parent.row) + 1;
      if (depth > maxDepth) return yield* new CommentDepthExceeded({ type, parentId, maxDepth });
    }
    return yield* comments.create({
      id: input.id,
      state: {
        ...input.state,
        targetType: input.targetType,
        targetId: input.targetId,
        parentId: Option.getOrNull(input.parentId),
        depth,
      },
    });
  });

  const get = Effect.fn(`${type}.comments.get`)(function* (id: string) {
    return (yield* readableRow(yield* definition.viewer, id)).resource;
  });

  const listByTarget = Effect.fn(`${type}.comments.listByTarget`)(function* (
    request: CommentListRequest,
  ) {
    const viewer = yield* definition.viewer;
    yield* targetReadable(request.targetType, request.targetId);
    const parent = Option.match(request.parentId, {
      onNone: (): ListFilter<never> => always,
      onSome: (parentId) =>
        Option.match(parentId, {
          onNone: (): ListFilter<never> => eq("depth", 0),
          onSome: (id) => eq("parentId", id),
        }),
    });
    return yield* comments.list({
      where: and<never>(
        eq("targetType", request.targetType),
        eq("targetId", request.targetId),
        moderationListFilter<never>(viewer, policy, columns),
        parent,
      ),
      includeDeleted: request.includeDeleted,
      limit: Math.min(request.limit, MAX_PAGE_LIMIT),
      offset: request.offset,
      orderBy: request.orderBy,
    });
  });

  return { create, get, listByTarget };
};
