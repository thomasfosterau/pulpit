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
import { describe, expect, it } from "vite-plus/test";
import { makeGroupOwners, makeMembershipStore } from "../src/memberships.ts";
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
  return Effect.runPromise(
    Effect.map(Effect.provideService(effect, database.CurrentTransaction, tx), (value) => ({
      value,
      calls,
    })),
  );
};
const answer = async <A, E>(
  rows: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, typeof database.CurrentTransaction.Identifier>,
) => (await runWith(rows, effect)).value;

describe("makeMembershipStore over canned rows", () => {
  it("add, invite and removeGroup read the written count", async () => {
    expect(await answer([{ n: 1 }], store.add(membership))).toBe(true);
    expect(await answer([{ n: 0 }], store.add(membership))).toBe(false);
    expect(await answer([{ n: 1 }], store.invite(invitation))).toBe(true);
    expect(await answer([], store.invite(invitation))).toBe(false);
    expect(await answer([{ n: 3 }], store.removeGroup("g1"))).toBe(3);
  });

  it("setRole, remove, accept and removeInvitation answer whether a row changed", async () => {
    const row = [{ role: "member" }];
    expect(await answer(row, store.setRole("g1", "ana", "admin"))).toBe(true);
    expect(await answer([], store.setRole("g1", "ana", "admin"))).toBe(false);
    expect(await answer(row, store.remove("g1", "ana"))).toBe(true);
    expect(await answer(row, store.accept("g1", "ana", at))).toBe(true);
    expect(await answer([], store.removeInvitation("g1", "ana"))).toBe(false);
  });

  it("roleOf and invitationOf decode the row, or none", async () => {
    expect(await answer([{ role: "admin" }], store.roleOf("g1", "ana"))).toEqual(
      Option.some("admin"),
    );
    expect(await answer([], store.roleOf("g1", "ana"))).toEqual(Option.none());
    expect(await answer([{ ...invitation, total: 1 }], store.invitationOf("g1", "ana"))).toEqual(
      Option.some(invitation),
    );
    const { tx } = cannedTransaction([{ role: "owner" }]);
    const exit = await Effect.runPromiseExit(
      Effect.provideService(store.roleOf("g1", "ana"), database.CurrentTransaction, tx),
    );
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });

  it("list and invitations read the window total, and count again past the end", async () => {
    expect(
      await answer(
        [{ accountId: "ana", role: "member", at, total: 4 }],
        store.list({ groupId: "g1", limit: 1, offset: 0 }),
      ),
    ).toEqual({ rows: [{ accountId: "ana", role: "member", at }], total: 4 });
    expect(await answer([], store.list({ groupId: "g1", limit: 1, offset: 9 }))).toEqual({
      rows: [],
      total: 0,
    });
    expect(
      await answer(
        [{ ...invitation, total: 2 }],
        store.invitations({ by: "account", accountId: "ana", limit: 1, offset: 0 }),
      ),
    ).toEqual({ rows: [invitation], total: 2 });
    expect(
      await answer([], store.invitations({ by: "group", groupId: "g1", limit: 1, offset: 5 })),
    ).toEqual({ rows: [], total: 0 });
  });

  it("isMember is an EXISTS over active rows, and reads a failing query as false", async () => {
    expect(await answer([{ role: "member" }], store.isMember("ana", "g1"))).toBe(true);
    expect(await answer([], store.isMember("ana", "g1"))).toBe(false);
    expect(
      await Effect.runPromise(
        Effect.provideService(
          store.isMember("ana", "g1"),
          database.CurrentTransaction,
          failingTransaction("connection lost"),
        ),
      ),
    ).toBe(false);
  });

  it("groupsOf is a subquery over active rows; eraseAccount below one reads nothing", async () => {
    const query = new PgDialect().sqlToQuery(store.groupsOf("ana"));
    expect(query.sql).toContain("'active'");
    expect(query.params).toEqual(["ana"]);
    expect(await runWith([], store.eraseAccount("ana", 0))).toEqual({ value: 0, calls: [] });
    expect(await answer([{ erased: 2 }], store.eraseAccount("ana", 5))).toBe(2);
  });
});

describe("makeGroupOwners over canned rows", () => {
  it("ownerOf decodes the owner, or none; reassignOwner counts, none below one", async () => {
    expect(await answer([{ owner: "ana" }], owners.ownerOf("g1"))).toEqual(Option.some("ana"));
    expect(await answer([], owners.ownerOf("g1"))).toEqual(Option.none());
    expect(await answer([{ n: 2 }], owners.reassignOwner("ana", "ben", 5))).toBe(2);
    expect(await runWith([], owners.reassignOwner("ana", "ben", 0))).toEqual({
      value: 0,
      calls: [],
    });
  });
});
