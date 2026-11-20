/**
 * The membership and group-owner stores with no database (a canned
 * transaction): the answer each statement's rows map to, `isMember`
 * failing closed, a page past the end counting again, and a limit below
 * one issuing no statement. The statements run against PostgreSQL in
 * `tests/integration/memberships.test.ts`.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeGroupOwners, makeMembershipStore } from "../src/Memberships.ts";
import { cannedTransaction, failingTransaction } from "./fixtures/canned.ts";
import { database, groups, memberships } from "./fixtures/tree.ts";

const store = makeMembershipStore({
  table: memberships,
  CurrentTransaction: database.CurrentTransaction,
});
const owners = makeGroupOwners({
  table: groups,
  id: groups.id,
  owner: groups.ownerId,
  CurrentTransaction: database.CurrentTransaction,
});
const at = DateTime.toDate(DateTime.makeUnsafe("2026-11-01T12:00:00.000Z"));
const membership = { groupId: "g1", accountId: "ana", role: "member", at } as const;
const invitation = { ...membership, invitedBy: "ben" } as const;

const runWith = <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => {
  const { tx, calls } = cannedTransaction(rows);
  return Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
    value,
    calls,
  }));
};
const answer = <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => Effect.map(runWith(rows, effect), (value) => value.value);

describe("makeMembershipStore over canned rows", () => {
  it.effect("add, invite and removeGroup read the written count", () =>
    Effect.gen(function* () {
      expect(yield* answer([{ n: 1 }], store.add(membership))).toBe(true);
      expect(yield* answer([{ n: 0 }], store.add(membership))).toBe(false);
      expect(yield* answer([{ n: 1 }], store.invite(invitation))).toBe(true);
      expect(yield* answer([], store.invite(invitation))).toBe(false);
      expect(yield* answer([{ n: 3 }], store.removeGroup("g1"))).toBe(3);
    }),
  );

  it.effect("setRole, remove, accept and removeInvitation answer whether a row changed", () =>
    Effect.gen(function* () {
      const row = [{ role: "member" }];
      expect(yield* answer(row, store.setRole("g1", "ana", "admin"))).toBe(true);
      expect(yield* answer([], store.setRole("g1", "ana", "admin"))).toBe(false);
      expect(yield* answer(row, store.remove("g1", "ana"))).toBe(true);
      expect(yield* answer(row, store.accept("g1", "ana", at))).toBe(true);
      expect(yield* answer([], store.removeInvitation("g1", "ana"))).toBe(false);
    }),
  );

  it.effect("roleOf and invitationOf decode the row, or none", () =>
    Effect.gen(function* () {
      expect(yield* answer([{ role: "admin" }], store.roleOf("g1", "ana"))).toEqual(
        Option.some("admin"),
      );
      expect(yield* answer([], store.roleOf("g1", "ana"))).toEqual(Option.none());
      expect(yield* answer([{ ...invitation, total: 1 }], store.invitationOf("g1", "ana"))).toEqual(
        Option.some(invitation),
      );
      const { tx } = cannedTransaction([{ role: "owner" }]);
      const exit = yield* Effect.exit(
        Effect.provideService(store.roleOf("g1", "ana"), database.CurrentTransaction, tx),
      );
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
    }),
  );

  it.effect("list and invitations read the window total, and count again past the end", () =>
    Effect.gen(function* () {
      expect(
        yield* answer(
          [{ accountId: "ana", role: "member", at, total: 4 }],
          store.list({ groupId: "g1", limit: 1, offset: 0 }),
        ),
      ).toEqual({ rows: [{ accountId: "ana", role: "member", at }], total: 4 });
      expect(yield* answer([], store.list({ groupId: "g1", limit: 1, offset: 9 }))).toEqual({
        rows: [],
        total: 0,
      });
      expect(
        yield* answer(
          [{ ...invitation, total: 2 }],
          store.invitations({ by: "account", accountId: "ana", limit: 1, offset: 0 }),
        ),
      ).toEqual({ rows: [invitation], total: 2 });
      expect(
        yield* answer([], store.invitations({ by: "group", groupId: "g1", limit: 1, offset: 5 })),
      ).toEqual({ rows: [], total: 0 });
    }),
  );

  it.effect("isMember is an EXISTS over active rows, and reads a failing query as false", () =>
    Effect.gen(function* () {
      expect(yield* answer([{ role: "member" }], store.isMember("ana", "g1"))).toBe(true);
      expect(yield* answer([], store.isMember("ana", "g1"))).toBe(false);
      expect(
        yield* Effect.provideService(
          store.isMember("ana", "g1"),
          database.CurrentTransaction,
          failingTransaction("connection lost"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("groupsOf is a subquery over active rows; eraseAccount below one reads nothing", () =>
    Effect.gen(function* () {
      const query = new PgDialect().sqlToQuery(store.groupsOf("ana"));
      expect(query.sql).toContain("'active'");
      expect(query.params).toEqual(["ana"]);
      expect(yield* runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
      expect(yield* answer([{ erased: 2 }], store.eraseAccount("ana", 5))).toBe(2);
    }),
  );
});

describe("makeGroupOwners over canned rows", () => {
  it.effect("ownerOf decodes the owner, or none; reassignOwner counts, none below one", () =>
    Effect.gen(function* () {
      expect(yield* answer([{ owner: "ana" }], owners.ownerOf("g1"))).toEqual(Option.some("ana"));
      expect(yield* answer([], owners.ownerOf("g1"))).toEqual(Option.none());
      expect(yield* answer([{ n: 2 }], owners.reassignOwner("ana", "ben", 5))).toBe(2);
      expect(yield* runWith([], owners.reassignOwner("ana", "ben", 0))).toEqual({
        value: 0,
        calls: [],
      });
    }),
  );
});
