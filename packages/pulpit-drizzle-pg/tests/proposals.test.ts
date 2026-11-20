/**
 * The proposal store with no database (a canned transaction): what each
 * method asks of the transaction, the decode of a stored row (its `NULL`s as
 * options, the head version read as text), and a malformed id reading
 * nothing. The SQL runs against PostgreSQL in `tests/integration/proposals.test.ts`.
 */

import { always } from "@thomasfosterau/pulpit/Filter";
import type { ProposalRow } from "@thomasfosterau/pulpit/Proposals";
import { getTableName } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeProposalStore } from "../src/Proposals.ts";
import { cannedTransaction } from "./fixtures/canned.ts";
import { database, owners, proposals, tables } from "./fixtures/tree.ts";

const store = makeProposalStore({
  table: proposals,
  root: tables.root,
  owners,
  CurrentTransaction: database.CurrentTransaction,
});

const ID = "00000000-0000-4000-9000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000001";
const AT = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

const stored = {
  id: ID,
  targetId: TARGET,
  targetType: "posts",
  authorId: "u-1",
  patch: { title: "Hi" },
  locales: null,
  rationale: null,
  baseVersion: 0n,
  status: "pending",
  submittedAt: AT,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  appliedVersion: null,
};
const row: ProposalRow = {
  ...stored,
  locales: Option.none(),
  rationale: Option.none(),
  status: "pending",
  decidedAt: Option.none(),
  decidedBy: Option.none(),
  decisionNote: Option.none(),
  appliedVersion: Option.none(),
};

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

describe("makeProposalStore over canned rows", () => {
  it("the table is named proposal by default", () => {
    expect(getTableName(proposals)).toBe("proposal");
  });

  it.effect("get decodes the row and reads the head version off its text", () =>
    Effect.gen(function* () {
      const { value, calls } = yield* runWith([{ ...stored, targetVersion: "3" }], store.get(ID));
      expect(value).toEqual(Option.some({ row, targetVersion: Option.some(3n) }));
      expect(calls).toEqual(["select", "from", "innerJoin", "where", "limit"]);
      expect((yield* runWith([{ ...stored, targetVersion: null }], store.get(ID))).value).toEqual(
        Option.some({ row, targetVersion: Option.none() }),
      );
      expect((yield* runWith([], store.get(ID))).value).toEqual(Option.none());
    }),
  );

  it.effect("a malformed id reads nothing and writes nothing", () =>
    Effect.gen(function* () {
      expect(yield* runWith([stored], store.get("x"))).toEqual({ value: Option.none(), calls: [] });
      expect(yield* runWith([stored], store.lock("x"))).toEqual({
        value: Option.none(),
        calls: [],
      });
      const decision = {
        status: "rejected" as const,
        decidedAt: AT,
        decidedBy: "u-2",
        decisionNote: Option.none(),
        appliedVersion: Option.none(),
      };
      expect((yield* runWith([], store.close("x", decision))).calls).toEqual([]);
    }),
  );

  it.effect("lock reads the row FOR UPDATE; close updates; insert inserts", () =>
    Effect.gen(function* () {
      const locked = yield* runWith([stored], store.lock(ID));
      expect(locked.value).toEqual(Option.some(row));
      expect(locked.calls).toContain("for");
      const decision = {
        status: "accepted" as const,
        decidedAt: AT,
        decidedBy: "u-2",
        decisionNote: Option.some("ok"),
        appliedVersion: Option.some(1n),
      };
      expect((yield* runWith([], store.close(ID, decision))).calls).toEqual([
        "update",
        "set",
        "where",
      ]);
      expect(
        (yield* runWith(
          [],
          store.insert({ ...row, locales: Option.some({ en: { heading: "Hi" } }), patch: null }),
        )).calls,
      ).toEqual(["insert", "values"]);
    }),
  );

  it.effect("list pages the decoded rows with the window total", () =>
    Effect.gen(function* () {
      const page = yield* runWith(
        [{ ...stored, targetVersion: "0", pageTotal: 7 }],
        store.list({ where: always, limit: 5, offset: 0 }),
      );
      expect(page.value).toEqual({ rows: [{ row, targetVersion: Option.some(0n) }], total: 7 });
      expect(
        (yield* runWith([], store.list({ where: always, limit: 5, offset: 0 }))).value,
      ).toEqual({
        rows: [],
        total: 0,
      });
    }),
  );

  it.effect("eraseAuthor answers the changed count, and reads nothing for a zero limit", () =>
    Effect.gen(function* () {
      const query = { accountId: "u-1", replacement: "gone", limit: 10 };
      expect((yield* runWith([{ changed: 3 }], store.eraseAuthor(query))).value).toBe(3);
      expect((yield* runWith([], store.eraseAuthor(query))).value).toBe(0);
      expect(yield* runWith([{ changed: 3 }], store.eraseAuthor({ ...query, limit: 0 }))).toEqual({
        value: 0,
        calls: [],
      });
    }),
  );

  it.effect("mintId reads a generated UUID", () =>
    Effect.gen(function* () {
      expect((yield* runWith([{ id: ID }], store.mintId)).value).toBe(ID);
    }),
  );

  it.effect("a stored row outside the contract is a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provideService(
          store.get(ID),
          database.CurrentTransaction,
          cannedTransaction([{ ...stored, status: "lost", targetVersion: null }]).tx,
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
