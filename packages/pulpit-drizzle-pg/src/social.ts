/**
 * @copyright Thomas Foster
 *
 * The kernel's `SocialStore` (docs/seams.md → `SocialStore`, pulpit#195)
 * on PostgreSQL (pulpit#364): follows, mutes and blocks between accounts,
 * one relationship table keyed `(kind, from_id, to_id)`. `followingOf` and
 * `silencedBy` are SQL subqueries, the list filter's `in` sets, never
 * materialised. Every call runs in the caller's `CurrentTransaction`.
 *
 * @since 0.0.0
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import type { PgTransaction } from "@thomasfosterau/effect-drizzle-ext-pg";
import type { Relationship, RelationshipKind, SocialStore } from "@thomasfosterau/pulpit/social";
import { and, asc, desc, eq, sql, type AnyRelations, type SQL } from "drizzle-orm";
import {
  check,
  getTableConfig,
  index,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countOf } from "./internal/count.ts";
import { eraseBatch } from "./internal/erase.ts";
import type { StoreQueryError } from "./internal/owners.ts";

/**
 * Build the relationship table (`name`, `relationship` by default):
 * `kind` (`follow | mute | block`, CHECKed), `from_id` and `to_id` (`text`;
 * referencing `accounts`, cascading, when given: the application's account
 * key, a `text` column) and `at` (`DEFAULT now()`), primary key `(kind,
 * from_id, to_id)`, indexed on `(kind, to_id, at DESC)` and `(kind,
 * from_id, at DESC)`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makeRelationshipTable } from "@thomasfosterau/pulpit-drizzle-pg/social";
 * import { getTableName } from "drizzle-orm";
 * import { pgSchema } from "drizzle-orm/pg-core";
 *
 * const relationships = makeRelationshipTable({ schema: pgSchema("social") });
 * strictEqual(getTableName(relationships), "relationship");
 * ```
 *
 * @since 0.0.0
 */
export const makeRelationshipTable = (options: {
  readonly schema: PgSchema;
  readonly accounts?: AnyPgColumn;
  readonly name?: string;
}) => {
  const name = options.name ?? "relationship";
  const { accounts } = options;
  const account = (column: string) => {
    const built = text(column).notNull();
    return accounts === undefined
      ? built
      : built.references((): AnyPgColumn => accounts, { onDelete: "cascade" });
  };
  return options.schema.table(
    name,
    {
      kind: text("kind").$type<RelationshipKind>().notNull(),
      fromId: account("from_id"),
      toId: account("to_id"),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({ name: `${name}_pkey`, columns: [table.kind, table.fromId, table.toId] }),
      check(`${name}_kind`, sql`${table.kind} IN ('follow', 'mute', 'block')`),
      index(`${name}_to`).on(table.kind, table.toId, table.at.desc()),
      index(`${name}_from`).on(table.kind, table.fromId, table.at.desc()),
    ],
  );
};

/**
 * The relationship table: {@link makeRelationshipTable}'s.
 *
 * @since 0.0.0
 */
export type RelationshipTable = ReturnType<typeof makeRelationshipTable>;

const decodeRelated = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ accountId: Schema.String, at: Schema.Date, total: Schema.Int })),
);
const decodeFollow = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ wasBlocked: Schema.Boolean, wasInserted: Schema.Boolean })),
);

/**
 * Bind the kernel's `SocialStore` to the relationship table, in the
 * caller's `CurrentTransaction`; its `Following` is a SQL subquery.
 *
 * - `addFollow` and `addBlock` first take `pg_advisory_xact_lock` on the
 *   unordered account pair (its two keys hash the table's schema-qualified
 *   name with the lesser and the greater account id), so the two are
 *   atomic against each other. `addFollow` is then one statement, `INSERT …
 *   SELECT … WHERE NOT EXISTS (a block either way) ON CONFLICT DO NOTHING`,
 *   answering `blocked` when a block stands; `addBlock` deletes both follows
 *   and inserts the block in one statement.
 * - `add` (a mute) is `INSERT … ON CONFLICT DO NOTHING RETURNING`, `remove`
 *   `DELETE … RETURNING`, `has` and `isFollowing` an `EXISTS` (a failing
 *   `isFollowing` reads as `false`, failing closed).
 * - `list` is one page by `from_id` or `to_id`, `ORDER BY at DESC`, then the
 *   other account's id, with the window total (a page past the end counts
 *   the rows instead).
 * - `followingOf(follower)` is `SELECT to_id … WHERE kind = 'follow' AND
 *   from_id = $follower`, `silencedBy(viewer)` the same over `kind IN
 *   ('mute', 'block')`.
 * - `eraseAccount(accountId, limit)` deletes at most `limit` of the rows
 *   from or to the account and counts them (`PERF-DB-001`).
 *
 * @since 0.0.0
 */
export const makeSocialStore = <I, Relations extends AnyRelations>(config: {
  readonly table: RelationshipTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): SocialStore<SQL, StoreQueryError<Relations>, I> => {
  const { table, CurrentTransaction } = config;
  // The lock's namespace: the table's schema-qualified name, so same-named
  // relationship tables in two schemas never share a pair's lock.
  const { schema, name } = getTableConfig(table);
  const lockKey = `${schema ?? "public"}.${name}:`;
  const key = (kind: RelationshipKind, from: string, to: string) =>
    and(eq(table.kind, kind), eq(table.fromId, from), eq(table.toId, to));
  const eitherWay = (kind: RelationshipKind, from: string, to: string): SQL =>
    sql`${table.kind} = ${kind} AND ((${table.fromId} = ${from} AND ${table.toId} = ${to}) OR (${table.fromId} = ${to} AND ${table.toId} = ${from}))`;
  /** Take the pair lock `addFollow` and `addBlock` share, then run `statement`'s rows. */
  const underPairLock = <Row extends Record<string, unknown>>(
    relationship: Relationship,
    statement: SQL,
  ) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const { from, to } = relationship;
      yield* tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey} || least(${from}::text, ${to}::text)), hashtext(${lockKey} || greatest(${from}::text, ${to}::text)))`,
      );
      return yield* executeRows<Row>(tx, statement);
    });
  const at = (relationship: Relationship): SQL =>
    sql`${relationship.at.toISOString()}::timestamptz`;
  const toIdsOf = (from: string, kinds: ReadonlyArray<RelationshipKind>): SQL =>
    sql`(SELECT ${table.toId} FROM ${table} WHERE ${table.kind} IN (${sql.join(
      Arr.map(kinds, (kind) => sql`${kind}`),
      sql`, `,
    )}) AND ${table.fromId} = ${from})`;
  const exists = (kind: RelationshipKind, from: string, to: string) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ kind: table.kind })
        .from(table)
        .where(key(kind, from, to))
        .limit(1);
      return Arr.isReadonlyArrayNonEmpty(rows);
    });

  return {
    add: (relationship) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const written = yield* tx
          .insert(table)
          .values({
            kind: relationship.kind,
            fromId: relationship.from,
            toId: relationship.to,
            at: relationship.at,
          })
          .onConflictDoNothing()
          .returning({ kind: table.kind });
        return Arr.isReadonlyArrayNonEmpty(written);
      }),
    addFollow: (relationship) => {
      const { from, to } = relationship;
      return Effect.gen(function* () {
        const rows = yield* underPairLock<{
          readonly wasBlocked: boolean;
          readonly wasInserted: boolean;
        }>(
          relationship,
          sql`WITH blocked AS (
            SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${eitherWay("block", from, to)}) AS blocked
          ),
          inserted AS (
            INSERT INTO ${table} (kind, from_id, to_id, at)
            SELECT 'follow', ${from}, ${to}, ${at(relationship)}
            WHERE NOT (SELECT blocked FROM blocked)
            ON CONFLICT DO NOTHING
            RETURNING 1
          )
          SELECT (SELECT blocked FROM blocked) AS "wasBlocked", EXISTS (SELECT 1 FROM inserted) AS "wasInserted"`,
        );
        const outcome = yield* Effect.orDie(decodeFollow(rows));
        return Option.match(Arr.head(outcome), {
          onNone: () => "present" as const,
          onSome: ({ wasBlocked, wasInserted }) =>
            wasBlocked
              ? ("blocked" as const)
              : wasInserted
                ? ("added" as const)
                : ("present" as const),
        });
      });
    },
    addBlock: (relationship) => {
      const { from, to } = relationship;
      return Effect.gen(function* () {
        const rows = yield* underPairLock<{ readonly n: number }>(
          relationship,
          sql`WITH unfollowed AS (
            DELETE FROM ${table} WHERE ${eitherWay("follow", from, to)}
          ),
          blocked AS (
            INSERT INTO ${table} (kind, from_id, to_id, at)
            VALUES ('block', ${from}, ${to}, ${at(relationship)})
            ON CONFLICT DO NOTHING
            RETURNING 1
          )
          SELECT count(*)::int AS n FROM blocked`,
        );
        return (yield* countOf(rows)) > 0;
      });
    },
    remove: (kind, from, to) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const gone = yield* tx
          .delete(table)
          .where(key(kind, from, to))
          .returning({ kind: table.kind });
        return Arr.isReadonlyArrayNonEmpty(gone);
      }),
    has: exists,
    list: ({ kind, side, accountId, limit, offset }) =>
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        const [mine, other] =
          side === "from" ? [table.fromId, table.toId] : [table.toId, table.fromId];
        const where = and(eq(table.kind, kind), eq(mine, accountId));
        const rows = yield* tx
          .select({ accountId: other, at: table.at, total: sql<number>`(count(*) over ())::int` })
          .from(table)
          .where(where)
          .orderBy(desc(table.at), asc(other))
          .limit(Math.max(0, Math.trunc(limit)))
          .offset(Math.max(0, Math.trunc(offset)));
        const page = yield* Effect.orDie(decodeRelated(rows));
        const total = yield* Option.match(Arr.head(page), {
          onSome: ({ total: counted }) => Effect.succeed(counted),
          onNone: () =>
            Effect.flatMap(
              tx
                .select({ n: sql<number>`count(*)::int` })
                .from(table)
                .where(where),
              countOf,
            ),
        });
        return {
          rows: Arr.map(page, ({ accountId: id, at: since }) => ({ accountId: id, at: since })),
          total,
        };
      }),
    isFollowing: (follower, followed) =>
      Effect.orElseSucceed(exists("follow", follower, followed), () => false),
    followingOf: (follower) => toIdsOf(follower, ["follow"]),
    silencedBy: (viewer) => toIdsOf(viewer, ["mute", "block"]),
    eraseAccount: (accountId, limit) =>
      Effect.flatMap(CurrentTransaction, (tx) =>
        eraseBatch(tx, {
          table,
          key: [table.kind, table.fromId, table.toId],
          where: sql`${table.fromId} = ${accountId} OR ${table.toId} = ${accountId}`,
          limit,
        }),
      ),
  };
};
