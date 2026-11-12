/**
 * The membership and group-owner stores against PostgreSQL (pulpit#364),
 * checked against the kernel's `makeInMemoryMembershipStore` and
 * `makeInMemoryGroupOwners` over the same calls: active memberships and
 * pending invitations in one table, every membership read and write over
 * active rows alone, a direct add activating an invitation, `accept`,
 * `removeGroup` taking both statuses, `eraseAccount`'s one limit across
 * both, the `groupsOf` subquery, and `reassignOwner` in bounded batches.
 * Beyond the fakes, deleting a group or an account cascades.
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import { makePgDatabase, pgClientFromUrl } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { Invitation, Membership } from "@thomasfosterau/pulpit/audience";
import {
  makeInMemoryGroupOwners,
  makeInMemoryMembershipStore,
} from "@thomasfosterau/pulpit/testing";
import { getTableName, sql, type SQL } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makeGroupOwners, makeMembershipStore } from "../../src/memberships.ts";
import { accounts, groups, memberships } from "../fixtures/tree.ts";

const database = makePgDatabase({ relations: {}, key: "PulpitMembershipDatabase" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(
  database.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL_TEST"), (url) =>
          pgClientFromUrl({ url, maxConnections: 2 }),
        ),
      ),
    ),
    Layer.orDie,
  ),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, typeof CurrentTransaction.Identifier>) =>
  runtime.runPromise(transact(effect));

const store = makeMembershipStore({ table: memberships, CurrentTransaction });
const memory = makeInMemoryMembershipStore();
const owners = makeGroupOwners({
  table: groups,
  id: groups.id,
  owner: groups.ownerId,
  CurrentTransaction,
});
const seeded: ReadonlyArray<readonly [string, string]> = [
  ["g1", "ana"],
  ["g2", "ana"],
  ["g3", "ana"],
  ["g4", "ben"],
];
const memoryOwners = makeInMemoryGroupOwners(seeded);

const at = (minute: number) =>
  DateTime.toDate(DateTime.makeUnsafe(`2026-11-01T12:${String(minute).padStart(2, "0")}:00.000Z`));
const member = (
  groupId: string,
  accountId: string,
  minute: number,
  role: Membership["role"] = "member",
): Membership => ({
  groupId,
  accountId,
  role,
  at: at(minute),
});
const invitation = (
  groupId: string,
  accountId: string,
  invitedBy: string,
  minute: number,
): Invitation => ({
  groupId,
  accountId,
  role: "member",
  invitedBy,
  at: at(minute),
});

beforeAll(async () => {
  await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      yield* tx.execute(
        sql.raw(
          `TRUNCATE pulpit_test.${getTableName(accounts)}, pulpit_test.${getTableName(groups)} CASCADE`,
        ),
      );
      yield* tx
        .insert(accounts)
        .values(Arr.map(["ana", "ben", "cy", "dee", "eve", "fay", "gus"], (id) => ({ id })));
      yield* tx.insert(groups).values(Arr.map(seeded, ([id, ownerId]) => ({ id, ownerId })));
    }),
  );
});

type Call<A> = {
  readonly sql: Effect.Effect<A, unknown, typeof CurrentTransaction.Identifier>;
  readonly memory: Effect.Effect<A>;
};
/** Each call in turn against both stores, every answer kept. */
const sequence = <A>(calls: ReadonlyArray<Call<A>>) =>
  Arr.reduce(
    calls,
    Promise.resolve<ReadonlyArray<{ readonly sql: A; readonly memory: A }>>([]),
    (previous, call) =>
      previous.then(async (done) => [
        ...done,
        { sql: await run(call.sql), memory: await Effect.runPromise(call.memory) },
      ]),
  );
const agree = async <A>(calls: ReadonlyArray<Call<A>>) => {
  const answers = await sequence(calls);
  expect(Arr.map(answers, (a) => a.sql)).toEqual(Arr.map(answers, (a) => a.memory));
  return Arr.map(answers, (a) => a.sql);
};

type Keyed = { readonly groupId: string; readonly accountId: string };
const byKey = Order.combine(
  Order.mapInput(Str.Order, (row: Keyed) => row.groupId),
  Order.mapInput(Str.Order, (row: Keyed) => row.accountId),
);
const storedRows = async () => {
  const rows = await run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return yield* tx.select().from(memberships);
    }),
  );
  return {
    active: Arr.sort(
      Arr.map(
        Arr.filter(rows, (row) => row.status === "active"),
        ({ groupId, accountId, role, at: since }) => ({ groupId, accountId, role, at: since }),
      ),
      byKey,
    ),
    pending: Arr.sort(
      Arr.map(
        Arr.filter(rows, (row) => row.status === "pending"),
        ({ groupId, accountId, role, invitedBy, at: since }) => ({
          groupId,
          accountId,
          role,
          invitedBy,
          at: since,
        }),
      ),
      byKey,
    ),
  };
};
const expectSameRows = async () => {
  const rows = await storedRows();
  expect(rows.active).toEqual(Arr.sort(memory.rows(), byKey));
  expect(rows.pending).toEqual(Arr.sort(memory.pending(), byKey));
};
const groupIds = (set: SQL) =>
  run(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* executeRows<{ readonly id: string }>(
        tx,
        sql`SELECT g AS id FROM ${set} AS s(g) ORDER BY g`,
      );
      return Arr.map(rows, (row) => row.id);
    }),
  );

describe("MembershipStore over PostgreSQL agrees with the in-memory store", () => {
  it("add, invite and a direct add over an invitation", async () => {
    const answers = await agree<boolean>([
      {
        sql: store.add(member("g1", "ana", 1, "admin")),
        memory: memory.add(member("g1", "ana", 1, "admin")),
      },
      { sql: store.add(member("g1", "ben", 2)), memory: memory.add(member("g1", "ben", 2)) },
      { sql: store.add(member("g1", "ben", 3)), memory: memory.add(member("g1", "ben", 3)) },
      {
        sql: store.invite(invitation("g1", "cy", "ana", 4)),
        memory: memory.invite(invitation("g1", "cy", "ana", 4)),
      },
      {
        sql: store.invite(invitation("g1", "cy", "ana", 5)),
        memory: memory.invite(invitation("g1", "cy", "ana", 5)),
      },
      {
        sql: store.invite(invitation("g1", "ben", "ana", 5)),
        memory: memory.invite(invitation("g1", "ben", "ana", 5)),
      },
      {
        sql: store.invite(invitation("g1", "dee", "ana", 6)),
        memory: memory.invite(invitation("g1", "dee", "ana", 6)),
      },
      {
        sql: store.invite(invitation("g2", "dee", "ben", 6)),
        memory: memory.invite(invitation("g2", "dee", "ben", 6)),
      },
      { sql: store.add(member("g1", "dee", 7)), memory: memory.add(member("g1", "dee", 7)) },
    ]);
    expect(answers).toEqual([true, true, false, true, false, false, true, true, true]);
    await expectSameRows();
  });

  it("membership reads take active rows alone; invitationOf reads the pending one", async () => {
    await agree<unknown>([
      { sql: store.roleOf("g1", "ana"), memory: memory.roleOf("g1", "ana") },
      { sql: store.roleOf("g1", "cy"), memory: memory.roleOf("g1", "cy") },
      { sql: store.isMember("ben", "g1"), memory: memory.isMember("ben", "g1") },
      { sql: store.isMember("cy", "g1"), memory: memory.isMember("cy", "g1") },
      { sql: store.invitationOf("g1", "cy"), memory: memory.invitationOf("g1", "cy") },
      { sql: store.invitationOf("g1", "ben"), memory: memory.invitationOf("g1", "ben") },
    ]);
    expect(await run(store.roleOf("g1", "cy"))).toEqual(Option.none());
    expect(await groupIds(store.groupsOf("dee"))).toEqual(
      Arr.sort(Arr.fromIterable(memory.groupsOf("dee")), Str.Order),
    );
    expect(await groupIds(store.groupsOf("dee"))).toEqual(["g1"]);
  });

  it("list and invitations are one page oldest first, with the total", async () => {
    const pages = [
      { limit: 10, offset: 0 },
      { limit: 2, offset: 1 },
      { limit: 5, offset: 9 },
    ];
    await agree<unknown>(
      Arr.map(pages, (page) => ({
        sql: store.list({ groupId: "g1", ...page }),
        memory: memory.list({ groupId: "g1", ...page }),
      })),
    );
    await agree<unknown>([
      ...Arr.map(pages, (page) => ({
        sql: store.invitations({ by: "group", groupId: "g1", ...page }),
        memory: memory.invitations({ by: "group", groupId: "g1", ...page }),
      })),
      {
        sql: store.invitations({ by: "account", accountId: "dee", limit: 5, offset: 0 }),
        memory: memory.invitations({ by: "account", accountId: "dee", limit: 5, offset: 0 }),
      },
    ]);
    expect((await run(store.list({ groupId: "g1", limit: 5, offset: 9 }))).total).toBe(3);
  });

  it("setRole, remove, accept and removeInvitation change only their status", async () => {
    const answers = await agree<boolean>([
      { sql: store.setRole("g1", "ben", "admin"), memory: memory.setRole("g1", "ben", "admin") },
      { sql: store.setRole("g1", "ben", "admin"), memory: memory.setRole("g1", "ben", "admin") },
      { sql: store.setRole("g1", "cy", "admin"), memory: memory.setRole("g1", "cy", "admin") },
      { sql: store.remove("g1", "cy"), memory: memory.remove("g1", "cy") },
      { sql: store.accept("g1", "cy", at(20)), memory: memory.accept("g1", "cy", at(20)) },
      { sql: store.accept("g1", "cy", at(21)), memory: memory.accept("g1", "cy", at(21)) },
      { sql: store.removeInvitation("g2", "dee"), memory: memory.removeInvitation("g2", "dee") },
      { sql: store.removeInvitation("g1", "ben"), memory: memory.removeInvitation("g1", "ben") },
      { sql: store.remove("g1", "ben"), memory: memory.remove("g1", "ben") },
    ]);
    expect(answers).toEqual([true, false, false, false, true, false, true, false, true]);
    await expectSameRows();
  });

  it("removeGroup takes both statuses; eraseAccount counts both against one limit", async () => {
    await agree<boolean>([
      {
        sql: store.invite(invitation("g3", "eve", "fay", 30)),
        memory: memory.invite(invitation("g3", "eve", "fay", 30)),
      },
      { sql: store.add(member("g3", "fay", 31)), memory: memory.add(member("g3", "fay", 31)) },
      {
        sql: store.invite(invitation("g4", "gus", "fay", 32)),
        memory: memory.invite(invitation("g4", "gus", "fay", 32)),
      },
      { sql: store.add(member("g4", "fay", 33)), memory: memory.add(member("g4", "fay", 33)) },
      {
        sql: store.invite(invitation("g2", "fay", "ana", 34)),
        memory: memory.invite(invitation("g2", "fay", "ana", 34)),
      },
    ]);
    expect(
      await agree<number>([{ sql: store.removeGroup("g3"), memory: memory.removeGroup("g3") }]),
    ).toEqual([2]);
    expect(
      await agree<number>([
        { sql: store.eraseAccount("fay", 2), memory: memory.eraseAccount("fay", 2) },
        { sql: store.eraseAccount("fay", 2), memory: memory.eraseAccount("fay", 2) },
        { sql: store.eraseAccount("fay", 2), memory: memory.eraseAccount("fay", 2) },
      ]),
    ).toEqual([2, 1, 0]);
    expect(await run(store.eraseAccount("ana", 0))).toBe(0);
    await expectSameRows();
  });
});

describe("GroupOwnerStore over PostgreSQL agrees with the in-memory store", () => {
  it("reassignOwner moves at most limit of the account's groups, by id, until none is left", async () => {
    expect(
      await agree<number>([
        {
          sql: owners.reassignOwner("ana", "gus", 2),
          memory: memoryOwners.reassignOwner("ana", "gus", 2),
        },
        {
          sql: owners.reassignOwner("ana", "gus", 2),
          memory: memoryOwners.reassignOwner("ana", "gus", 2),
        },
        {
          sql: owners.reassignOwner("ana", "gus", 2),
          memory: memoryOwners.reassignOwner("ana", "gus", 2),
        },
      ]),
    ).toEqual([2, 1, 0]);
    await agree<Option.Option<string>>(
      Arr.map(["g1", "g2", "g3", "g4", "g9"], (id) => ({
        sql: owners.ownerOf(id),
        memory: memoryOwners.ownerOf(id),
      })),
    );
    expect(await run(owners.reassignOwner("ben", "gus", 0))).toBe(0);
  });
});

describe("beyond the in-memory fakes", () => {
  it("deleting a group or an account takes its rows (the foreign keys cascade)", async () => {
    await run(store.add(member("g4", "eve", 40)));
    await run(store.invite(invitation("g2", "eve", "gus", 41)));
    await run(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(sql`DELETE FROM ${groups} WHERE ${groups.id} = 'g4'`);
        yield* tx.execute(sql`DELETE FROM ${accounts} WHERE ${accounts.id} = 'gus'`);
      }),
    );
    const rows = await storedRows();
    expect(Arr.filter(rows.active, (row) => row.groupId === "g4")).toEqual([]);
    expect(Arr.filter(rows.pending, (row) => row.invitedBy === "gus")).toEqual([]);
  });
});
