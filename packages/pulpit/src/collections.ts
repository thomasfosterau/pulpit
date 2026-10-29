/**
 * **Ordered collections** (pulpit#193) — positioned members of a parent
 * node: a list's items, an album's media, a byline's authors, a menu's
 * entries.
 *
 * The behavioural spec is website's ordered list items (a reorder appends
 * a parent version) and in-the-dark's list entries (an updatable position
 * beside the chain), with their tests.
 *
 * ## The model (owner decision on pulpit#193)
 *
 * Both models, opt-in per family, over **one store seam**
 * ({@link CollectionStore}), which holds each member's position:
 *
 * - **`mutable`** (the default): the order is state beside the chain, like
 *   an edge. A write changes the store and nothing else.
 * - **`versioned`**: every write also appends a parent version through the
 *   parent leaf's own `update`, recording the whole order (the member ids,
 *   in order) in a declared parent column, so `VERSION-CHAIN-001` covers it
 *   and history shows each reorder. After the parent's `restoreVersion`,
 *   {@link CollectionOps.resync} replaces the store's order with the one
 *   the restored version records, keeping only the members the writer can
 *   read, as `append` does.
 *
 *   That column holds the id of every member, the ones a reader of the
 *   parent may not be able to read included, so it must stay out of the
 *   parent's viewer-facing resource (`EDGE-001`): wrap the parent leaf's
 *   `toResource` with {@link hideRecordedOrder}. The parent's history
 *   (`getVersion`, `compare`) still shows it, behind the write gate
 *   (`READ-009`).
 *
 * ## The gates
 *
 * - **Reads** go through the parent's read gate (`get`): a hidden parent is
 *   `NodeNotFound`, never `Forbidden` (`SEC-AUTH-ENUM-001`). Each member is
 *   read through the member leaf's own gate (`getMany`), and one the viewer
 *   can't read is omitted, from the page and from its total, as `EDGE-001`
 *   omits an edge with a hidden end.
 * - **Writes** pass the parent's write gate (`authorize`), and a member must
 *   be one the writer can read (`NodeNotFound` otherwise).
 * - A collection holds at most {@link MAX_COLLECTION_SIZE} members, so every
 *   read and reorder is one bounded read (`SEC-INPUT-003`).
 *
 * @copyright Thomas Foster
 * @module pulpit/collections
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { byCodePoint } from "./internal/list-order.ts";
import {
  MAX_PAGE_LIMIT,
  type Forbidden,
  type LeafRow,
  type Page,
  type SubtypeOps,
  type Unauthorized,
  type WriteRejected,
} from "./subtype.ts";
import {
  NodeNotFound,
  type StaleVersion,
  type VersionChainStore,
  type VersionConflict,
} from "./version-chain.ts";

/**
 * The most members a collection holds (`SEC-INPUT-003`): every read and
 * reorder reads the whole order once, so it is bounded.
 *
 * @since 0.1.0
 */
export const MAX_COLLECTION_SIZE = MAX_PAGE_LIMIT;

// ── Errors ────────────────────────────────────────────────────────────

/**
 * The member is already in the collection: the wire's 409.
 *
 * @since 0.1.0
 */
export class AlreadyMember extends Schema.TaggedError<AlreadyMember>()("AlreadyMember", {
  parentId: Schema.String,
  memberId: Schema.String,
}) {}

/**
 * The member is not in the collection: the wire's 404.
 *
 * @since 0.1.0
 */
export class NotMember extends Schema.TaggedError<NotMember>()("NotMember", {
  parentId: Schema.String,
  memberId: Schema.String,
}) {}

/**
 * The collection already holds {@link MAX_COLLECTION_SIZE} members: the
 * wire's 409.
 *
 * @since 0.1.0
 */
export class CollectionFull extends Schema.TaggedError<CollectionFull>()("CollectionFull", {
  parentId: Schema.String,
  max: Schema.Number,
}) {}

// ── The seam ──────────────────────────────────────────────────────────

/**
 * One member's place in a collection.
 *
 * @since 0.1.0
 */
export interface CollectionEntry {
  readonly memberId: string;
  readonly position: number;
}

/**
 * The membership table an application supplies, keyed
 * `(parent_id, member_id)` with both foreign keys cascading. A store seam:
 * no policy, never opens a transaction, fails only with its `E`. See the
 * package README → Seams.
 *
 * @since 0.1.0
 */
export interface CollectionStore<E, R> {
  /**
   * The parent's members, by position then member id, at most `limit`
   * (never more than {@link MAX_COLLECTION_SIZE} + 1, so the caller can
   * tell a full collection).
   */
  readonly entries: (
    parentId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CollectionEntry>, E, R>;
  /** Replace the parent's whole order with `entries` (positions `0…n-1`), in one statement. */
  readonly replace: (
    parentId: string,
    entries: ReadonlyArray<CollectionEntry>,
  ) => Effect.Effect<void, E, R>;
}

// ── The operations ────────────────────────────────────────────────────

/**
 * How a family keeps its order: beside the chain (`mutable`, the default)
 * or in a parent column, versioned with the parent (`versioned`).
 *
 * @since 0.1.0
 */
export type CollectionMode<E, R> =
  | { readonly kind: "mutable" }
  | {
      readonly kind: "versioned";
      /**
       * The parent column recording the order: the member ids, in order (a
       * `jsonb` array). Keep it out of the parent's resource with
       * {@link hideRecordedOrder} (`EDGE-001`).
       */
      readonly column: string;
      /** The parent leaf's chain store, read (ungated) by `resync` for the restored order. */
      readonly chain: VersionChainStore<E, R>;
    };

/**
 * One family's collection: the parent and member leaves' gated operations,
 * the store and the mode.
 *
 * @since 0.1.0
 */
export interface CollectionDefinition<Parent, Member, E, R> {
  /** The family's name, traced as `${type}.<operation>`. */
  readonly type: string;
  /** The parent leaf: `get` gates a read, `authorize` a write, `update` records a versioned order. */
  readonly parent: Pick<SubtypeOps<Parent, E, R>, "get" | "authorize" | "update">;
  /** The member leaf's gated batch read. */
  readonly members: Pick<SubtypeOps<Member, E, R>, "getMany">;
  readonly store: CollectionStore<E, R>;
  /** The order's model; `mutable` when omitted. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is the default model
  readonly mode?: CollectionMode<E, R> | undefined;
}

/**
 * One member as a read returns it: its id, its position among the members
 * the viewer can see (from 0), and the member resource.
 *
 * @since 0.1.0
 */
export interface CollectionMember<Member> {
  readonly memberId: string;
  readonly index: number;
  readonly resource: Member;
}

type WriteFailure =
  | Unauthorized
  | Forbidden
  | NodeNotFound
  | WriteRejected
  | StaleVersion
  | VersionConflict;

/**
 * The operations {@link defineCollection} produces.
 *
 * @since 0.1.0
 */
export interface CollectionOps<Member, E, R> {
  /**
   * One page of the members the viewer can read, in order, with their
   * total: the parent's read gate first (`NodeNotFound`), each member
   * through its own leaf's, a hidden one omitted. The limit is clamped to
   * `[1, MAX_PAGE_LIMIT]`.
   */
  readonly list: (
    parentId: string,
    request: { readonly limit: number; readonly offset: number },
  ) => Effect.Effect<Page<CollectionMember<Member>>, NodeNotFound | E, R>;
  /**
   * Add `memberId` at the end. Fails the parent's write gate, `NodeNotFound`
   * for a member the writer can't read, {@link AlreadyMember} and
   * {@link CollectionFull}; on a versioned family, the parent `update`'s
   * failures too.
   */
  readonly append: (
    parentId: string,
    memberId: string,
  ) => Effect.Effect<void, WriteFailure | AlreadyMember | CollectionFull | E, R>;
  /**
   * Move `memberId` to `index` (clamped to the order's bounds), shifting the
   * members between. Fails the parent's write gate and {@link NotMember}.
   */
  readonly move: (
    parentId: string,
    memberId: string,
    index: number,
  ) => Effect.Effect<void, WriteFailure | NotMember | E, R>;
  /** Remove `memberId`. Fails the parent's write gate and {@link NotMember}. */
  readonly remove: (
    parentId: string,
    memberId: string,
  ) => Effect.Effect<void, WriteFailure | NotMember | E, R>;
  /**
   * A versioned family's store order replaced by the order the parent's
   * head records (after the parent's `restoreVersion`), behind the parent's
   * write gate, keeping only the members the writer can read (as `append`
   * checks). A mutable family, or a head recording no order, leaves the
   * store as it is.
   */
  readonly resync: (
    parentId: string,
  ) => Effect.Effect<void, Unauthorized | Forbidden | NodeNotFound | E, R>;
}

/**
 * Wrap a parent leaf's `toResource` so the row it maps no longer carries a
 * versioned collection's order `column`: the recorded order names every
 * member, the ones the viewer can't read included, so it must never reach
 * a reader of the parent (`EDGE-001`). The chain still records it, so
 * {@link CollectionOps.resync} reads it back.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import { hideRecordedOrder } from "@thomasfosterau/pulpit/collections";
 *
 * const toResource = hideRecordedOrder("memberOrder", (row) => row);
 * const row = { id: "l-1", version: 2n, action: "update", title: "Ferns", memberOrder: ["i-1"] } as const;
 * deepStrictEqual(toResource(row), { id: "l-1", version: 2n, action: "update", title: "Ferns" });
 * ```
 *
 * @since 0.1.0
 */
export const hideRecordedOrder =
  <Resource>(
    column: string,
    toResource: (row: LeafRow) => Resource,
  ): ((row: LeafRow) => Resource) =>
  (row) => {
    const { [column]: _recorded, ...rest } = row;
    return toResource({ ...rest, id: row.id, version: row.version, action: row.action });
  };

/** The order with positions `0…n-1`. */
const renumber = (ids: ReadonlyArray<string>): ReadonlyArray<CollectionEntry> =>
  Arr.map(ids, (memberId, position) => ({ memberId, position }));

/** By position, then member id: the store's total order. */
const entryOrder: Order.Order<CollectionEntry> = Order.combine(
  Order.mapInput(Order.Number, (entry: CollectionEntry) => entry.position),
  Order.mapInput(byCodePoint, (entry: CollectionEntry) => entry.memberId),
);

/**
 * Bind one family's collection operations. Every operation is traced as
 * `${type}.<operation>`, and the writes run in the caller's transaction (a
 * versioned family's store write and parent append commit together).
 *
 * @since 0.1.0
 */
export const defineCollection = <Parent, Member, E, R>(
  definition: CollectionDefinition<Parent, Member, E, R>,
): CollectionOps<Member, E, R> => {
  const { type, parent, members, store } = definition;
  const mode: CollectionMode<E, R> = definition.mode ?? { kind: "mutable" };

  /** The whole order, as ids (one bounded read). */
  const orderOf = (parentId: string) =>
    Effect.map(store.entries(parentId, MAX_COLLECTION_SIZE + 1), (entries) =>
      Arr.map(Arr.sort(entries, entryOrder), (entry) => entry.memberId),
    );

  /** Write the new order to the store and, on a versioned family, to the parent's chain. */
  const commit = (parentId: string, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* store.replace(parentId, renumber(ids));
      if (mode.kind === "versioned") {
        yield* parent.update({ id: parentId, patch: { [mode.column]: [...ids] } });
      }
    });

  const list = Effect.fn(`${type}.list`)(function* (
    parentId: string,
    request: { readonly limit: number; readonly offset: number },
  ) {
    // A parent the viewer can't read is missing to them (SEC-AUTH-ENUM-001).
    yield* parent.get(parentId);
    const ids = Arr.take(yield* orderOf(parentId), MAX_COLLECTION_SIZE);
    const readable = Arr.isReadonlyArrayNonEmpty(ids)
      ? yield* members.getMany(ids)
      : HashMap.empty<string, Member>();
    const shown = Arr.getSomes(
      Arr.map(ids, (memberId) =>
        Option.map(HashMap.get(readable, memberId), (resource) => ({ memberId, resource })),
      ),
    );
    const limit = Math.max(1, Math.min(Math.trunc(request.limit), MAX_PAGE_LIMIT));
    const offset = Math.max(0, Math.trunc(request.offset));
    return {
      rows: Arr.map(shown.slice(offset, offset + limit), (member, at) => ({
        ...member,
        index: offset + at,
      })),
      total: shown.length,
    };
  });

  const append = Effect.fn(`${type}.append`)(function* (parentId: string, memberId: string) {
    yield* parent.authorize(parentId);
    const readable = yield* members.getMany([memberId]);
    if (!HashMap.has(readable, memberId)) {
      return yield* new NodeNotFound({ type, id: memberId });
    }
    const ids = yield* orderOf(parentId);
    if (ids.includes(memberId)) return yield* new AlreadyMember({ parentId, memberId });
    if (ids.length >= MAX_COLLECTION_SIZE) {
      return yield* new CollectionFull({ parentId, max: MAX_COLLECTION_SIZE });
    }
    yield* commit(parentId, [...ids, memberId]);
  });

  const move = Effect.fn(`${type}.move`)(function* (
    parentId: string,
    memberId: string,
    index: number,
  ) {
    yield* parent.authorize(parentId);
    const ids = yield* orderOf(parentId);
    if (!ids.includes(memberId)) return yield* new NotMember({ parentId, memberId });
    const rest = Arr.filter(ids, (id) => id !== memberId);
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, rest.length));
    yield* commit(parentId, [...rest.slice(0, at), memberId, ...rest.slice(at)]);
  });

  const remove = Effect.fn(`${type}.remove`)(function* (parentId: string, memberId: string) {
    yield* parent.authorize(parentId);
    const ids = yield* orderOf(parentId);
    if (!ids.includes(memberId)) return yield* new NotMember({ parentId, memberId });
    yield* commit(
      parentId,
      Arr.filter(ids, (id) => id !== memberId),
    );
  });

  const resync = Effect.fn(`${type}.resync`)(function* (parentId: string) {
    yield* parent.authorize(parentId);
    if (mode.kind !== "versioned") return;
    const head = yield* mode.chain.head(parentId);
    if (Option.isNone(head)) return;
    const snapshot = yield* mode.chain.snapshot(parentId, head.value.version);
    const recorded = Option.flatMap(snapshot, (version) => {
      const value = version.state[mode.column] ?? null;
      return Arr.isArray<unknown>(value) ? Option.some(value) : Option.none();
    });
    if (Option.isNone(recorded)) return;
    const ids = Arr.take(
      Arr.dedupe(Arr.filter(recorded.value, Predicate.isString)),
      MAX_COLLECTION_SIZE,
    );
    // Gate parity with `append`: the column is writable through the parent's
    // own `update`, so keep only the members the writer can read.
    const readable = Arr.isReadonlyArrayNonEmpty(ids)
      ? yield* members.getMany(ids)
      : HashMap.empty<string, Member>();
    yield* store.replace(parentId, renumber(Arr.filter(ids, (id) => HashMap.has(readable, id))));
  });

  return { list, append, move, remove, resync };
};
