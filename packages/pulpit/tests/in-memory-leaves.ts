/**
 * An in-memory {@link LeafStore} over the in-memory chain store: the
 * current-version view (each node's head state, its head `action`, and its
 * owner) plus the owner stamp, and a role ladder and follower seam in the
 * shape effect-auth is expected to supply.
 *
 * @module tests/in-memory-leaves
 */

import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { evaluate } from "../src/filter.ts";
import type {
  AccessPolicy,
  FollowerSeam,
  LeafRow,
  LeafStore,
  ViewerAccount,
} from "../src/subtype.ts";
import type { InMemoryChainStore } from "./in-memory-chain.ts";

/** The follower seam's set-shaped answer, in memory. */
export type Following = ReadonlySet<string>;

/** A fixed clock for the publication predicates. */
export const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-09-18T00:00:00.000Z"));

/**
 * The view over the chain: the head state of every node, with `ownerId`
 * merged in from the owner stamps (the apps' `core.node_owner` join).
 */
export const makeInMemoryLeafStore = (
  chain: InMemoryChainStore,
  columns: ReadonlyArray<string>,
): LeafStore<LeafRow, Following, never, never> & {
  readonly owners: Map<string, string>;
} => {
  const owners = new Map<string, string>();
  const view = (): ReadonlyArray<LeafRow> => {
    const heads = new Map<string, LeafRow>();
    for (const row of chain.rows()) {
      const base: LeafRow = { ...row.state, id: row.id, action: row.action };
      heads.set(
        row.id,
        Option.match(Option.fromNullishOr(owners.get(row.id)), {
          onNone: () => base,
          onSome: (ownerId): LeafRow => ({ ...base, ownerId }),
        }),
      );
    }
    // Total order on `id`, the order every list closes with.
    return Array.sort(
      [...heads.values()],
      Order.mapInput(Order.String, (row: LeafRow) => row.id),
    );
  };
  const find = (id: string) => Array.findFirst(view(), (row) => row.id === id);
  return {
    owners,
    columns: new Set(["id", "action", "ownerId", ...columns]),
    get: (id) => Effect.sync(() => find(id)),
    getMany: (ids) => Effect.sync(() => view().filter((row) => ids.includes(row.id))),
    list: ({ where, limit, offset }) =>
      Effect.sync(() => {
        const matching = view().filter((row) =>
          evaluate(where, row, {
            now: NOW,
            contains: (set: Following, value) => Predicate.isString(value) && set.has(value),
          }),
        );
        return { rows: matching.slice(offset, offset + limit), total: matching.length };
      }),
    ownerOf: (id) => Effect.sync(() => Option.fromNullishOr(owners.get(id))),
    stampOwner: (id, ownerId) => Effect.sync(() => void owners.set(id, ownerId)),
  };
};

/** gardeneria's ladder, compared the one way it allows: fail closed on an unknown role. */
const LADDER = ["user", "contributor", "moderator", "admin"] as const;
const rank = (role: string) => LADDER.findIndex((rung) => rung === role);
const atLeast = (min: (typeof LADDER)[number]) => (account: ViewerAccount) =>
  rank(account.role) >= 0 && rank(account.role) >= rank(min);

/** gardeneria's axes: moderator+ sees private and deleted rows and moderates; contributor+ writes the corpus. */
export const gardeneriaPolicy: AccessPolicy = {
  canViewPrivate: atLeast("moderator"),
  canViewDeleted: atLeast("moderator"),
  canModerate: atLeast("moderator"),
  canWriteCorpus: atLeast("contributor"),
};

/** website's axes: admin alone sees private and deleted rows. */
export const websitePolicy: AccessPolicy = {
  canViewPrivate: atLeast("admin"),
  canViewDeleted: atLeast("admin"),
  canModerate: atLeast("admin"),
  canWriteCorpus: atLeast("contributor"),
};

/** A follower seam over an explicit `follower → followed owners` table. */
export const followersOf = (
  table: ReadonlyMap<string, ReadonlyArray<string>>,
): FollowerSeam<Following, never> => ({
  isFollower: (followerId, ownerId) =>
    Effect.succeed((table.get(followerId) ?? []).includes(ownerId)),
  following: (followerId) => new Set(table.get(followerId) ?? []),
});

export const member: ViewerAccount = { id: "u-member", role: "user" };
export const otherMember: ViewerAccount = { id: "u-other", role: "user" };
export const follower: ViewerAccount = { id: "u-follower", role: "user" };
export const contributor: ViewerAccount = { id: "u-contributor", role: "contributor" };
export const moderator: ViewerAccount = { id: "u-moderator", role: "moderator" };
export const admin: ViewerAccount = { id: "u-admin", role: "admin" };
