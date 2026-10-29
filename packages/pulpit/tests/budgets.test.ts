/**
 * Write budgets (pulpit#199): a bound budget refuses the write past its
 * limit with `WriteRejected` (`RATE_LIMITED`), frees up as its window
 * rolls (a fixed clock), exempts the moderate rung, and spends through a
 * chain write's before hook, a proposal's `submit` and a report's `file`.
 *
 * @module tests/budgets
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  bindBudget,
  BudgetDeclarationError,
  budgetHook,
  countingCounter,
  isRateLimited,
  RATE_LIMITED,
  type BudgetCounter,
  type WriteBudget,
} from "../src/budgets.ts";
import { defineReports } from "../src/moderation.ts";
import { defineProposals, InvalidProposalPatch } from "../src/proposals.ts";
import {
  defineSubtype,
  ownedAccess,
  WriteRejected,
  type LeafRow,
  type Viewer,
} from "../src/subtype.ts";
import {
  makeInMemoryBudgetCounter,
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryProposalStore,
  makeInMemoryReportStore,
  makeInMemoryWriteCountStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** The failure's tag and, for a refusal, its reason. */
const failureOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) =>
          error instanceof WriteRejected ? `WriteRejected:${error.reason}` : error._tag,
        )
      : Option.none(),
  );

const budget = (
  options: Partial<WriteBudget> = {},
  counter: BudgetCounter<never, never> = makeInMemoryBudgetCounter(),
) =>
  bindBudget({
    type: "comments",
    budget: { limit: 2, windowSeconds: 60, ...options },
    counter,
    policy: gardeneriaPolicy,
  });

const EPOCH = DateTime.toDate(DateTime.makeUnsafe(0));
const rateLimited = Option.some(`WriteRejected:${RATE_LIMITED}`);

describe("bindBudget — the limit and its window", () => {
  it("admits `limit` writes in a window, refuses the next as rate-limited, and frees up as it rolls", async () => {
    const bound = budget();
    const who = Option.some(member);
    const outcomes = await run(
      Effect.gen(function* () {
        yield* bound.spend(who, "create", "c-1");
        yield* TestClock.adjust("30 seconds");
        yield* bound.spend(who, "create", "c-2");
        const third = yield* failureOf(bound.spend(who, "create", "c-3"));
        // Past 60s the first write has left the window; the second still counts.
        yield* TestClock.adjust("31 seconds");
        const afterRoll = yield* failureOf(bound.spend(who, "create", "c-4"));
        const overAgain = yield* failureOf(bound.spend(who, "create", "c-5"));
        return [third, afterRoll, overAgain];
      }),
    );
    expect(outcomes).toEqual([rateLimited, Option.none(), rateLimited]);
  });

  it("counts per account and per action", async () => {
    const bound = budget({ limit: 1 });
    const outcomes = await run(
      Effect.gen(function* () {
        yield* bound.spend(Option.some(member), "create", "c-1");
        return [
          yield* failureOf(bound.spend(Option.some(otherMember), "create", "c-2")),
          yield* failureOf(bound.spend(Option.some(member), "update", "c-1")),
          yield* failureOf(bound.spend(Option.some(member), "create", "c-3")),
        ];
      }),
    );
    expect(outcomes).toEqual([Option.none(), Option.none(), rateLimited]);
  });

  it("exempts the moderate rung by default, or the declared rung, and spends nothing for them or the anonymous", async () => {
    const counter = makeInMemoryBudgetCounter();
    const bound = budget({ limit: 1 }, counter);
    await run(
      Effect.gen(function* () {
        yield* bound.spend(Option.some(moderator), "create", "c-1");
        yield* bound.spend(Option.some(moderator), "create", "c-2");
        yield* bound.spend(Option.none(), "create", "c-3");
      }),
    );
    expect(counter.spends()).toEqual([]);
    const strict = budget({ limit: 1, exempt: () => () => false });
    const second = await run(
      Effect.gen(function* () {
        yield* strict.spend(Option.some(moderator), "create", "c-1");
        return yield* failureOf(strict.spend(Option.some(moderator), "create", "c-2"));
      }),
    );
    expect(second).toEqual(rateLimited);
  });

  it("names the refusal so the wire can tell it apart", async () => {
    const bound = budget({ limit: 1 });
    const exit = await run(
      Effect.gen(function* () {
        yield* bound.spend(Option.some(member), "create", "c-1");
        return yield* Effect.flip(bound.spend(Option.some(member), "create", "c-2"));
      }),
    );
    expect(exit).toEqual(
      new WriteRejected({ type: "comments", id: "c-2", action: "create", reason: RATE_LIMITED }),
    );
    expect(isRateLimited(exit)).toBe(true);
    expect(
      isRateLimited(new WriteRejected({ type: "t", id: "i", action: "a", reason: "invalid" })),
    ).toBe(false);
  });

  it("throws at declaration for a limit or window that is not a positive safe integer", () => {
    Arr.forEach(
      [{ limit: 0 }, { limit: 1.5 }, { windowSeconds: -1 }, { windowSeconds: Number.NaN }],
      (bad) => expect(() => budget(bad)).toThrow(BudgetDeclarationError),
    );
  });
});

describe("countingCounter — count within the transaction", () => {
  it("admits while fewer than `limit` writes were made in the window, and spends nothing itself", async () => {
    const store = makeInMemoryWriteCountStore();
    const bound = budget({ limit: 2 }, countingCounter(store));
    const who = Option.some(member);
    const outcomes = await run(
      Effect.gen(function* () {
        // Only the write's own row is the spend: checking twice records nothing.
        yield* bound.spend(who, "create", "c-1");
        yield* bound.spend(who, "create", "c-1");
        store.record({ type: "comments", action: "create", accountId: member.id, at: NOW });
        store.record({ type: "comments", action: "create", accountId: member.id, at: NOW });
        return yield* failureOf(bound.spend(who, "create", "c-3"));
      }).pipe(Effect.tap(() => TestClock.setTime(NOW.getTime()))),
    );
    expect(outcomes).toEqual(rateLimited);
    // Writes before the window never count.
    const fresh = makeInMemoryWriteCountStore();
    fresh.record({ type: "comments", action: "create", accountId: member.id, at: EPOCH });
    const counted = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW.getTime());
        return yield* fresh.countSince({
          type: "comments",
          action: "create",
          accountId: member.id,
          since: DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() - 60_000)),
        });
      }),
    );
    expect(counted).toBe(0);
  });
});

describe("budgetHook — a chain write's budget", () => {
  const leaf = (limit: number) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["body", "visibility"], now: NOW });
    let viewer: Viewer = Option.some(member);
    const target = defineSubtype({
      type: "comments",
      access: ownedAccess(),
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
      hooks: Effect.succeed({ before: [budgetHook(budget({ limit }))], after: [] }),
    });
    const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    const create = () =>
      target.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } });
    return { chain, target, as, create };
  };

  it("refuses the create past the limit, appending nothing, and leaves updates alone", async () => {
    const { chain, target, create } = leaf(1);
    const outcome = await run(
      Effect.gen(function* () {
        const first = yield* create();
        yield* target.update({ id: first.id, patch: { body: "Edited" } });
        yield* target.update({ id: first.id, patch: { body: "Edited again" } });
        return yield* failureOf(create());
      }),
    );
    expect(outcome).toEqual(rateLimited);
    expect(chain.rows().length).toBe(3);
  });

  it("passes a locale patch through without spending again", () => {
    const hook = budgetHook(budget());
    const patch = { "fr-FR": { body: "Salut" } };
    const event = {
      action: "update" as const,
      id: "c-1",
      prior: Option.none(),
      patch: {},
      locales: patch,
      actorId: Option.some(member.id),
      type: "comments",
      viewer: Option.some(member),
    };
    expect(Effect.runSync(hook.locales?.(event) ?? Effect.succeed({}))).toEqual(patch);
    expect(
      Effect.runSync(hook.locales?.({ ...event, locales: undefined }) ?? Effect.die("none")),
    ).toEqual({});
  });
});

describe("opt-in budgets on proposals and reports", () => {
  const setup = () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, {
      columns: ["title", "visibility", "moderationState"],
      now: NOW,
    });
    let viewer: Viewer = Option.some(member);
    const viewerOf = Effect.sync(() => viewer);
    const target = defineSubtype({
      type: "pages",
      access: ownedAccess(),
      chain,
      leaves,
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
    });
    const bound = bindBudget({
      type: "pages",
      budget: { limit: 1, windowSeconds: 3600 },
      counter: makeInMemoryBudgetCounter(),
      policy: gardeneriaPolicy,
    });
    const proposals = defineProposals({
      type: "pages",
      target,
      chain,
      ownerOf: leaves.ownerOf,
      proposals: makeInMemoryProposalStore({ chain, leaves }),
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      canPropose: () => true,
      attributes: ["title"],
      decode: (patch) =>
        Schema.is(Schema.Record(Schema.String, Schema.String))(patch)
          ? Effect.succeed(patch)
          : Effect.fail(new InvalidProposalPatch({ type: "pages", reason: "strings only" })),
      budget: bound,
    });
    const reports = defineReports({
      target,
      reports: makeInMemoryReportStore(),
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      budget: bound,
    });
    const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    return { target, proposals, reports, as };
  };

  it("throttles submit and file, each as its own action, and refuses an invalid submission before spending", async () => {
    const { target, proposals, reports, as } = setup();
    const outcomes = await run(
      Effect.gen(function* () {
        const page = yield* as(
          Option.some(otherMember),
          target.create({ id: Option.none(), state: { title: "T", visibility: "public" } }),
        );
        const submit = (title: Schema.Json) =>
          as(
            Option.some(member),
            proposals.submit({ targetId: page.id, patch: { title }, rationale: Option.none() }),
          );
        const file = () =>
          as(
            Option.some(member),
            reports.file({ targetId: page.id, reason: "spam", details: Option.none() }),
          );
        const invalid = yield* failureOf(submit(1));
        yield* submit("Better");
        const secondSubmit = yield* failureOf(submit("Best"));
        yield* file();
        const secondFile = yield* failureOf(file());
        return [invalid, secondSubmit, secondFile];
      }),
    );
    expect(outcomes).toEqual([Option.some("InvalidProposalPatch"), rateLimited, rateLimited]);
  });
});
