/**
 * @copyright Thomas Foster
 *
 * The kernel's `MembershipStore` and `GroupOwnerStore` (docs/seams.md →
 * `MembershipStore` and `GroupOwnerStore`, pulpit#227, pulpit#274) on
 * PostgreSQL (pulpit#364): a group's members and pending invitations in one
 * membership table keyed `(group_id, account_id)`, and the bounded owner
 * reassignment over the application's own group table. A pending row is an
 * invitation, not a membership: every membership read and write takes the
 * `active` rows alone. `groupsOf` is a SQL subquery, the list filter's `in`
 * set, never materialised. Every call runs in the caller's
 * `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import {
  MembershipRole,
  type GroupOwnerStore,
  type GroupOwnership,
  type Invitation,
  type Membership,
  type MembershipStore,
} from "@thomasfosterau/pulpit/audience";
import { and, asc, eq, sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  check,
  index,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
  type PgSchema,
  type PgTable,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { eraseBatch } from "./internal/erase.ts";
import type { StoreQueryError } from "./internal/owners.ts";

/**
 * Build the membership table (`name`, `membership` by default): `group_id`,
 * `account_id`, `role` (`member | admin`), `status` (`active | pending`),
 * `invited_by` (the inviting account, `NULL` exactly on an active row) and
 * `at` (`DEFAULT now()`), primary key `(group_id, account_id)`, indexed on
 * `account_id`. The keys are `text`; `groups` (the application's group id)
 * and `accounts` (its account key), when given, make `group_id`, and
 * `account_id` and `invited_by`, reference them `ON DELETE CASCADE`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makeMembershipTable } from "@thomasfosterau/pulpit-drizzle-pg/memberships";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema } from "drizzle-orm/pg-core";
 *
 * const memberships = makeMembershipTable({ schema: pgSchema("social") });
 * strictEqual(getTableName(memberships), "membership");
 * ```
 *
 * @since 0.0.0
 */
export const makeMembershipTable = (options: {
  readonly schema: PgSchema;
  readonly groups?: AnyPgColumn;
  readonly accounts?: AnyPgColumn;
  readonly name?: string;
}) => {
  const name = options.name ?? "membership";
  const key = (column: string, target?: AnyPgColumn) => {
    const built = text(column);
    return target === undefined
      ? built
      : built.references((): AnyPgColumn => target, { onDelete: "cascade" });
  };
  return options.schema.table(
    name,
    {
      groupId: key("group_id", options.groups).notNull(),
      accountId: key("account_id", options.accounts).notNull(),
      role: text("role").$type<MembershipRole>().notNull(),
      status: text("status").$type<"active" | "pending">().notNull(),
      invitedBy: key("invited_by", options.accounts),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({ name: `${name}_pkey`, columns: [table.groupId, table.accountId] }),
      check(`${name}_role`, sql`${table.role} IN ('member', 'admin')`),
      check(`${name}_status`, sql`${table.status} IN ('active', 'pending')`),
      check(`${name}_inviter`, sql`(${table.status} = 'active') = (${table.invitedBy} IS NULL)`),
      index(`${name}_account`).on(table.accountId),
    ],
  );
};

/**
 * The membership table: {@link makeMembershipTable}'s.
 *
 * @since 0.0.0
 */
export type MembershipTable = ReturnType<typeof makeMembershipTable>;

const decodeMembers = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      role: MembershipRole,
      at: Schema.Date,
      total: Schema.Int,
    }),
  ),
);
const decodeInvitations = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      groupId: Schema.String,
      accountId: Schema.String,
      role: MembershipRole,
      invitedBy: Schema.String,
      at: Schema.Date,
      total: Schema.Int,
    }),
  ),
);
const decodeRoles = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ role: MembershipRole })),
);
const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })));

/** The first row's count, or zero. */
const countOf = (rows: ReadonlyArray<{ readonly n: number }>): number =>
  Option.match(Arr.head(rows), { onNone: () => 0, onSome: ({ n }) => n });

/**
 * Bind the kernel's `MembershipStore` to the membership table, in the
 * caller's `CurrentTransaction`; its `Following` is a SQL subquery.
 *
 * - `add` is `INSERT … ON CONFLICT (group_id, account_id) DO UPDATE SET
 *   status = 'active', role, at, invited_by = NULL WHERE status =
 *   'pending' RETURNING`: a direct add activates a pending invitation, and an
 *   active row is untouched.
 * - `setRole` is `UPDATE … WHERE … AND role <> $role RETURNING`, `remove`
 *   `DELETE … RETURNING`, `roleOf` one row's role, `isMember` an `EXISTS` (a
 *   failure reads as `false`, failing closed), all over active rows.
 * - `list` and `invitations` are one page `ORDER BY at`, then the other key,
 *   with the window total (a page past the end counts the rows instead).
 * - `removeGroup` deletes both statuses; `eraseAccount(accountId, limit)`
 *   deletes at most `limit` of the account's rows of both statuses and the
 *   pending rows it invited, counted together (`PERF-DB-001`).
 * - `invite` is `INSERT … status = 'pending' … ON CONFLICT DO NOTHING`,
 *   `accept` `UPDATE … SET status = 'active', at, invited_by = NULL WHERE …
 *   AND status = 'pending'`, `removeInvitation` the pending row's `DELETE`.
 *
 * @since 0.0.0
 */
export const makeMembershipStore = <I, Relations extends AnyRelations>(config: {
  readonly table: MembershipTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): MembershipStore<SQL, StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  const at = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;
  const keyed = (groupId: string, accountId: string, status: "active" | "pending") =>
    and(eq(table.groupId, groupId), eq(table.accountId, accountId), eq(table.status, status));
  /** Run a statement that returns one row per row it wrote; whether any did. */
  const wrote = (statement: SQL) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* executeRows<{ readonly n: number }>(
        tx,
        sql`WITH written AS (${statement}) SELECT count(*)::int AS n FROM written`,
      );
      return countOf(yield* Effect.orDie(decodeCount(rows)));
    });
  /** The rows matching `where`, counted (a page past the end reads no window total). */
  const counted = (where: SQL) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(where);
      return countOf(yield* Effect.orDie(decodeCount(rows)));
    });
  const totalOf = (page: ReadonlyArray<{ readonly total: number }>, where: SQL) =>
    Option.match(Arr.head(page), {
      onSome: ({ total }) => Effect.succeed(total),
      onNone: () => counted(where),
    });
  const window = sql<number>`(count(*) over ())::int`;
  const isActive = (groupId: string, accountId: string) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ role: table.role })
        .from(table)
        .where(keyed(groupId, accountId, "active"))
        .limit(1);
      return Arr.isReadonlyArrayNonEmpty(rows);
    });

  return {
    add: (membership: Membership) =>
      Effect.map(
        wrote(sql`INSERT INTO ${table} (group_id, account_id, role, status, at)
          VALUES (${membership.groupId}, ${membership.accountId}, ${membership.role}, 'active', ${at(membership.at)})
          ON CONFLICT (group_id, account_id) DO UPDATE
          SET status = 'active', role = EXCLUDED.role, at = EXCLUDED.at, invited_by = NULL
          WHERE ${table.status} = 'pending'
          RETURNING 1`),
        (n) => n > 0,
      ),
    setRole: (groupId, accountId, role) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const changed = yield* tx
          .update(table)
          .set({ role })
          .where(and(keyed(groupId, accountId, "active"), sql`${table.role} <> ${role}`))
          .returning({ role: table.role });
        return Arr.isReadonlyArrayNonEmpty(changed);
      }),
    remove: (groupId, accountId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const gone = yield* tx
          .delete(table)
          .where(keyed(groupId, accountId, "active"))
          .returning({ role: table.role });
        return Arr.isReadonlyArrayNonEmpty(gone);
      }),
    roleOf: (groupId, accountId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ role: table.role })
          .from(table)
          .where(keyed(groupId, accountId, "active"))
          .limit(1);
        const roles = yield* Effect.orDie(decodeRoles(rows));
        return Option.map(Arr.head(roles), ({ role }) => role);
      }),
    list: ({ groupId, limit, offset }) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const where = sql`${table.groupId} = ${groupId} AND ${table.status} = 'active'`;
        const rows = yield* tx
          .select({ accountId: table.accountId, role: table.role, at: table.at, total: window })
          .from(table)
          .where(where)
          .orderBy(asc(table.at), asc(table.accountId))
          .limit(Math.max(0, Math.trunc(limit)))
          .offset(Math.max(0, Math.trunc(offset)));
        const page = yield* Effect.orDie(decodeMembers(rows));
        return {
          rows: Arr.map(page, ({ accountId, role, at: since }) => ({ accountId, role, at: since })),
          total: yield* totalOf(page, where),
        };
      }),
    removeGroup: (groupId) =>
      wrote(sql`DELETE FROM ${table} WHERE ${table.groupId} = ${groupId} RETURNING 1`),
    isMember: (accountId, groupId) =>
      Effect.orElseSucceed(isActive(groupId, accountId), () => false),
    groupsOf: (accountId) =>
      sql`(SELECT ${table.groupId} FROM ${table} WHERE ${table.accountId} = ${accountId} AND ${table.status} = 'active')`,
    eraseAccount: (accountId, limit) =>
      Effect.flatMap(CurrentTransaction, (tx) =>
        eraseBatch(tx, {
          table,
          key: [table.groupId, table.accountId],
          where: sql`${table.accountId} = ${accountId} OR (${table.status} = 'pending' AND ${table.invitedBy} = ${accountId})`,
          limit,
        }),
      ),
    invite: (invitation: Invitation) =>
      Effect.map(
        wrote(sql`INSERT INTO ${table} (group_id, account_id, role, status, invited_by, at)
          VALUES (${invitation.groupId}, ${invitation.accountId}, ${invitation.role}, 'pending', ${invitation.invitedBy}, ${at(invitation.at)})
          ON CONFLICT DO NOTHING
          RETURNING 1`),
        (n) => n > 0,
      ),
    invitationOf: (groupId, accountId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({
            groupId: table.groupId,
            accountId: table.accountId,
            role: table.role,
            invitedBy: table.invitedBy,
            at: table.at,
            total: sql<number>`1`,
          })
          .from(table)
          .where(keyed(groupId, accountId, "pending"))
          .limit(1);
        const found = yield* Effect.orDie(decodeInvitations(rows));
        return Option.map(Arr.head(found), ({ total: _total, ...invitation }) => invitation);
      }),
    accept: (groupId, accountId, joinedAt) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const changed = yield* tx
          .update(table)
          .set({ status: "active", at: joinedAt, invitedBy: null })
          .where(keyed(groupId, accountId, "pending"))
          .returning({ role: table.role });
        return Arr.isReadonlyArrayNonEmpty(changed);
      }),
    removeInvitation: (groupId, accountId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const gone = yield* tx
          .delete(table)
          .where(keyed(groupId, accountId, "pending"))
          .returning({ role: table.role });
        return Arr.isReadonlyArrayNonEmpty(gone);
      }),
    invitations: (query) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const [mine, other] =
          query.by === "group"
            ? [sql`${table.groupId} = ${query.groupId}`, table.accountId]
            : [sql`${table.accountId} = ${query.accountId}`, table.groupId];
        const where = sql`${mine} AND ${table.status} = 'pending'`;
        const rows = yield* tx
          .select({
            groupId: table.groupId,
            accountId: table.accountId,
            role: table.role,
            invitedBy: table.invitedBy,
            at: table.at,
            total: window,
          })
          .from(table)
          .where(where)
          .orderBy(asc(table.at), asc(other))
          .limit(Math.max(0, Math.trunc(query.limit)))
          .offset(Math.max(0, Math.trunc(query.offset)));
        const page = yield* Effect.orDie(decodeInvitations(rows));
        return {
          rows: Arr.map(page, ({ total: _total, ...invitation }) => invitation),
          total: yield* totalOf(page, where),
        };
      }),
  };
};

/**
 * Bind the kernel's `GroupOwnership` and `GroupOwnerStore` to the
 * application's group table, `table`, by its `id` and `owner` columns, in
 * the caller's `CurrentTransaction`. Both compare as text, so a `uuid` id
 * column takes any string.
 *
 * - `ownerOf(groupId)` reads the group's owner, or none.
 * - `reassignOwner(accountId, to, limit)` is `UPDATE … SET owner = $to
 *   WHERE id IN (SELECT id … WHERE owner = $accountId ORDER BY id LIMIT
 *   $limit)` and counts the rows (`PERF-DB-001`); a limit below one changes
 *   nothing. Memberships and invitations are left alone.
 *
 * @since 0.0.0
 */
export const makeGroupOwners = <I, Relations extends AnyRelations>(config: {
  readonly table: PgTable;
  readonly id: AnyPgColumn;
  readonly owner: AnyPgColumn;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): GroupOwnership<StoreQueryError<Relations>, I> &
  GroupOwnerStore<StoreQueryError<Relations>, I> => {
  const { table, id, owner, CurrentTransaction } = config;
  const decodeOwners = Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ owner: Schema.String })),
  );
  return {
    ownerOf: (groupId) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const rows = yield* executeRows<{ readonly owner: string }>(
          tx,
          sql`SELECT ${owner}::text AS owner FROM ${table} WHERE ${id}::text = ${groupId} LIMIT 1`,
        );
        const owners = yield* Effect.orDie(decodeOwners(rows));
        return Option.map(Arr.head(owners), (row) => row.owner);
      }),
    reassignOwner: (accountId, to, limit) =>
      limit < 1
        ? Effect.succeed(0)
        : Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            const rows = yield* executeRows<{ readonly n: number }>(
              tx,
              sql`WITH moved AS (
                UPDATE ${table} SET ${sql.identifier(owner.name)} = ${to}
                WHERE ${id} IN (
                  SELECT ${id} FROM ${table} WHERE ${owner}::text = ${accountId}
                  ORDER BY ${id} LIMIT ${Math.trunc(limit)}
                )
                RETURNING 1
              )
              SELECT count(*)::int AS n FROM moved`,
            );
            return countOf(yield* Effect.orDie(decodeCount(rows)));
          }),
  };
};
