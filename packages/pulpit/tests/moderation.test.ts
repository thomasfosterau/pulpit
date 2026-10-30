/**
 * The moderation workflow (pulpit#51).
 *
 * - Threshold grading: gardeneria's `packages/jobs/tests/moderation-thresholds.test.ts`,
 *   over one leaf's threshold map.
 * - The transition rules, case by case (`moderatePatch`), and through a
 *   leaf's hooks end to end: a create starts pending, only the moderate
 *   rung decides, a re-review attribute sends an approved row back to
 *   pending, a restored version never brings an old approval back, and an
 *   owner may always withdraw (delete).
 * - The decision (`moderate`), stamped, and its gate.
 * - The review-queue filter, the moderate rung's alone.
 * - Member reports: filing needs a readable target (`NodeNotFound`, never
 *   `Forbidden`), reading is the reporter's and the rung's, and only the
 *   rung resolves.
 *
 * @module tests/moderation
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { always, eq, evaluate, never } from "../src/filter.ts";
import {
  DEFAULT_MODERATION_THRESHOLD,
  defineModeration,
  defineReports,
  gradeScores,
  isModerationTransition,
  moderatedColumns,
  moderatePatch,
  moderationHook,
  reviewQueueFilter,
  type ModerationScores,
} from "../src/moderation.ts";
import {
  defineSubtype,
  ownedAccess,
  type BeforeWriteEvent,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type { ChainState, WriteAction } from "../src/version-chain.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryReportStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

// ── Grading ───────────────────────────────────────────────────────────

const scores = (
  flagged: boolean,
  categoryScores: { readonly [category: string]: number },
): ModerationScores => ({ flagged, categoryScores });

const bars = (entries: { readonly [category: string]: number }) => entries;

describe("gradeScores — the default bar", () => {
  it("does not flag a score at or below the default", () => {
    const grade = gradeScores(scores(false, { hate: DEFAULT_MODERATION_THRESHOLD }), bars({}));
    expect(grade.isFlagged).toBe(false);
    expect(grade.exceeded).toEqual([]);
  });

  it("flags a score strictly above the default", () => {
    const grade = gradeScores(scores(false, { hate: 0.51 }), bars({}));
    expect(grade.isFlagged).toBe(true);
    expect(grade.exceeded).toEqual(["hate"]);
  });

  it("reports the top score across every category, breaching or not", () => {
    const grade = gradeScores(scores(false, { hate: 0.2, sexual: 0.44 }), bars({}));
    expect(grade.topScore).toBeCloseTo(0.44);
    expect(grade.isFlagged).toBe(false);
  });

  it("takes a default of the caller's own", () => {
    expect(gradeScores(scores(false, { hate: 0.3 }), bars({}), 0.25).exceeded).toEqual(["hate"]);
  });
});

describe("gradeScores — configured overrides", () => {
  it("uses a category's own bar in place of the default", () => {
    expect(gradeScores(scores(false, { hate: 0.2 }), bars({ hate: 0.1 })).exceeded).toEqual([
      "hate",
    ]);
    const lenient = gradeScores(scores(false, { hate: 0.9 }), bars({ hate: 0.95 }));
    expect(lenient.exceeded).toEqual([]);
    expect(lenient.isFlagged).toBe(false);
  });

  it("applies each category's own bar independently, and sorts the breaches", () => {
    const grade = gradeScores(
      scores(false, { violence: 0.3, hate: 0.3, sexual: 0.3 }),
      bars({ violence: 0.2, hate: 0.2, sexual: 0.9 }),
    );
    expect(grade.exceeded).toEqual(["hate", "violence"]);
  });
});

describe("gradeScores — the classifier's own flag", () => {
  it("is never overridden downward by a lenient threshold", () => {
    const grade = gradeScores(scores(true, { hate: 0.4 }), bars({ hate: 0.99 }));
    expect(grade.isFlagged).toBe(true);
    expect(grade.exceeded).toEqual([]);
  });

  it("still lands in a band derived from the top score, not in `low`", () => {
    expect(gradeScores(scores(true, { hate: 0.8 }), bars({ hate: 0.99 })).priority).toBe("high");
  });
});

describe("gradeScores — priority bands", () => {
  const bandFor = (score: number) =>
    gradeScores(scores(false, { hate: score }), bars({ hate: 0.05 })).priority;

  it("maps the worst breaching score onto a band", () => {
    expect([0.95, 0.8, 0.6, 0.2].map(bandFor)).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("bands on the worst breach, not on the worst score", () => {
    const grade = gradeScores(
      scores(false, { hate: 0.55, sexual: 0.98 }),
      bars({ hate: 0.5, sexual: 0.99 }),
    );
    expect(grade.exceeded).toEqual(["hate"]);
    expect(grade.priority).toBe("medium");
  });
});

describe("gradeScores — unassessed categories", () => {
  it("cannot breach, because `not assessed` is absent rather than zero", () => {
    const grade = gradeScores(scores(false, {}), bars({ hate: 0 }));
    expect(grade).toEqual({ isFlagged: false, exceeded: [], topScore: 0, priority: "low" });
  });
});

// ── Transitions ───────────────────────────────────────────────────────

describe("isModerationTransition", () => {
  it("starts a new row pending, and moves an existing one to any other state", () => {
    expect(isModerationTransition(Option.none(), "pending")).toBe(true);
    expect(isModerationTransition(Option.none(), "approved")).toBe(false);
    const moves = [
      ["pending", "approved"],
      ["pending", "rejected"],
      ["approved", "rejected"],
      ["rejected", "approved"],
      ["approved", "pending"],
      ["rejected", "pending"],
    ] as const;
    expect(moves.every(([from, to]) => isModerationTransition(Option.some(from), to))).toBe(true);
    expect(isModerationTransition(Option.some("pending"), "pending")).toBe(false);
  });
});

describe("moderatePatch — the rules, case by case", () => {
  const declaration = moderatedColumns(["body"]);
  const event = (
    action: WriteAction,
    prior: Option.Option<ChainState>,
    patch: BeforeWriteEvent["patch"],
    who: Viewer,
  ): BeforeWriteEvent => ({
    type: "comments",
    action,
    id: "c-1",
    prior: Option.map(prior, (state) => ({ version: 3n, action: "update", timestamp: NOW, state })),
    patch,
    actorId: Option.map(who, (account) => account.id),
    viewer: who,
  });
  const apply = (input: BeforeWriteEvent) =>
    moderatePatch(input, declaration, gardeneriaPolicy, NOW);
  const approved = {
    body: "Hello",
    moderationState: "approved",
    moderatedAt: NOW,
    moderatedBy: "m",
  };

  it("a create starts pending, and may not ask for another state", () => {
    expect(apply(event("create", Option.none(), { body: "x" }, Option.some(member)))).toEqual(
      Result.succeed({ body: "x", moderationState: "pending" }),
    );
    expect(
      Result.isFailure(
        apply(
          event("create", Option.none(), { moderationState: "approved" }, Option.some(moderator)),
        ),
      ),
    ).toBe(true);
  });

  it("a decision is the moderate rung's, stamped; anyone else's is refused", () => {
    const decide = (who: ViewerAccount) =>
      apply(
        event("update", Option.some(approved), { moderationState: "rejected" }, Option.some(who)),
      );
    expect(decide(moderator)).toEqual(
      Result.succeed({ moderationState: "rejected", moderatedAt: NOW, moderatedBy: moderator.id }),
    );
    expect(Result.isFailure(decide(member))).toBe(true);
    expect(
      Result.isFailure(
        apply(
          event(
            "update",
            Option.some(approved),
            { moderationState: "bogus" },
            Option.some(moderator),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("echoing the current state is no change, for anyone", () => {
    expect(
      apply(
        event(
          "update",
          Option.some(approved),
          { moderationState: "approved" },
          Option.some(member),
        ),
      ),
    ).toEqual(Result.succeed({ moderationState: "approved" }));
  });

  it("an edit to a re-review attribute sends an approved row back to pending; others don't", () => {
    expect(
      apply(event("update", Option.some(approved), { body: "Edited" }, Option.some(member))),
    ).toEqual(Result.succeed({ body: "Edited", moderationState: "pending" }));
    expect(
      apply(event("update", Option.some(approved), { body: "Hello" }, Option.some(member))),
    ).toEqual(Result.succeed({ body: "Hello" }));
    expect(
      apply(event("update", Option.some(approved), { title: "t" }, Option.some(member))),
    ).toEqual(Result.succeed({ title: "t" }));
    const rejected = { ...approved, moderationState: "rejected" };
    expect(
      apply(event("update", Option.some(rejected), { body: "Edited" }, Option.some(member))),
    ).toEqual(Result.succeed({ body: "Edited" }));
  });

  it("a restored version keeps the prior decision below the moderate rung", () => {
    const pending = {
      body: "Edited",
      moderationState: "pending",
      moderatedAt: NOW,
      moderatedBy: "m",
    };
    const old = { body: "Hello", moderationState: "approved", moderatedAt: NOW, moderatedBy: "m" };
    expect(apply(event("restoreVersion", Option.some(pending), old, Option.some(member)))).toEqual(
      Result.succeed({ ...old, moderationState: "pending" }),
    );
    // The rung's restore brings the old state back as it was, unstamped.
    expect(
      apply(event("restoreVersion", Option.some(pending), old, Option.some(moderator))),
    ).toEqual(Result.succeed(old));
  });

  it("a delete is untouched: withdrawal needs no decision", () => {
    expect(apply(event("delete", Option.some(approved), {}, Option.some(member)))).toEqual(
      Result.succeed({}),
    );
  });
});

// ── End to end ────────────────────────────────────────────────────────

const comments = () => {
  const chain = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["body", "visibility", "moderationState", "moderatedAt", "moderatedBy"],
    now: NOW,
  });
  let viewer: Viewer = Option.none();
  const viewerOf = Effect.sync(() => viewer);
  const declaration = moderatedColumns(["body"]);
  const target = defineSubtype<LeafRow, LeafRow, InMemoryFollowing, never, never>({
    type: "comments",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => row,
    hooks: Effect.succeed({
      before: [moderationHook(declaration, gardeneriaPolicy)],
      after: [],
    }),
  });
  const moderation = defineModeration({
    target,
    declaration,
    viewer: viewerOf,
    policy: gardeneriaPolicy,
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const post = async () =>
    (
      await run(
        actAs(
          Option.some(member),
          target.create({ id: Option.none(), state: { body: "Hello", visibility: "public" } }),
        ),
      )
    ).id;
  const stateOf = () => chain.rows().at(-1)?.state["moderationState"];
  return { chain, target, moderation, actAs, post, stateOf };
};

describe("the rules through a leaf's hooks", () => {
  it("create pending → moderate approved (stamped) → an edit to body sends it back", async () => {
    const { chain, target, moderation, actAs, post, stateOf } = comments();
    const id = await post();
    expect(stateOf()).toBe("pending");
    await run(actAs(Option.some(moderator), moderation.moderate(id, "approved")));
    expect(chain.rows().at(-1)?.state).toMatchObject({
      moderationState: "approved",
      moderatedBy: moderator.id,
    });
    await run(actAs(Option.some(member), target.update({ id, patch: { body: "Edited" } })));
    expect(stateOf()).toBe("pending");
  });

  it("an owner can't approve their own row, and the refusal appends nothing", async () => {
    const { chain, target, actAs, post } = comments();
    const id = await post();
    expect(
      await tagOf(
        actAs(Option.some(member), target.update({ id, patch: { moderationState: "approved" } })),
      ),
    ).toEqual(Option.some("WriteRejected"));
    expect(chain.rows()).toHaveLength(1);
  });

  it("moderate is the rung's: refused before anything is read", async () => {
    const { chain, moderation, actAs, post } = comments();
    const id = await post();
    expect(await tagOf(actAs(Option.some(member), moderation.moderate(id, "approved")))).toEqual(
      Option.some("Forbidden"),
    );
    expect(await tagOf(actAs(Option.none(), moderation.moderate(id, "approved")))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(
      await tagOf(actAs(Option.some(moderator), moderation.moderate("missing", "approved"))),
    ).toEqual(Option.some("NodeNotFound"));
    expect(chain.rows()).toHaveLength(1);
  });

  it("an owner withdraws their own approved row by deleting it", async () => {
    const { chain, target, moderation, actAs, post } = comments();
    const id = await post();
    await run(actAs(Option.some(moderator), moderation.moderate(id, "approved")));
    await run(actAs(Option.some(member), target.delete(id)));
    expect(chain.rows().at(-1)?.action).toBe("delete");
  });
});

describe("reviewQueueFilter", () => {
  it("is the pending rows for the moderate rung, nothing for anyone else", () => {
    expect(reviewQueueFilter(Option.some(moderator), gardeneriaPolicy)).toEqual(
      eq("moderationState", "pending"),
    );
    expect(reviewQueueFilter(Option.some(member), gardeneriaPolicy)).toEqual(never);
    expect(reviewQueueFilter(Option.none(), gardeneriaPolicy, "state")).toEqual(never);
    const context = { now: NOW, contains: () => false };
    const queue = reviewQueueFilter(Option.some(moderator), gardeneriaPolicy, "state");
    expect(evaluate(queue, { state: "pending" }, context)).toBe(true);
    expect(evaluate(queue, { state: "approved" }, context)).toBe(false);
    expect(always).toEqual({ kind: "always" });
  });
});

// ── Reports ───────────────────────────────────────────────────────────

describe("defineReports — member reports", () => {
  const setup = () => {
    const leaf = comments();
    const store = makeInMemoryReportStore();
    let viewer: Viewer = Option.none();
    const reports = defineReports({
      target: leaf.target,
      reports: store,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
    });
    const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      leaf.actAs(
        who,
        Effect.suspend(() => {
          viewer = who;
          return effect;
        }),
      );
    return { ...leaf, store, reports, as };
  };

  it("files against a readable target, and refuses a hidden or missing one as NodeNotFound", async () => {
    const { reports, as, target, actAs } = setup();
    const open = (
      await run(
        actAs(
          Option.some(member),
          target.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
        ),
      )
    ).id;
    const hidden = (
      await run(
        actAs(
          Option.some(member),
          target.create({ id: Option.none(), state: { body: "Hi", visibility: "private" } }),
        ),
      )
    ).id;
    const file = (targetId: string) =>
      reports.file({ targetId, reason: "spam", details: Option.none() });
    expect(await tagOf(as(Option.some(otherMember), file(open)))).toEqual(Option.none());
    expect(await tagOf(as(Option.some(otherMember), file(hidden)))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(as(Option.some(otherMember), file("missing")))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(as(Option.none(), file(open)))).toEqual(Option.some("Unauthorized"));
  });

  it("is read by its reporter and the rung, and resolved by the rung alone", async () => {
    const { reports, store, as, post } = setup();
    const target = await post();
    const { id } = await run(
      as(
        Option.some(otherMember),
        reports.file({ targetId: target, reason: "spam", details: Option.some("bot") }),
      ),
    );
    const listed = async (who: Viewer) =>
      (
        await run(
          as(
            who,
            reports.list({
              targetId: Option.none(),
              status: Option.some("open"),
              limit: 10,
              offset: 0,
            }),
          ),
        )
      ).rows.map((row) => row.id);
    expect(await listed(Option.some(moderator))).toEqual([id]);
    expect(await listed(Option.some(otherMember))).toEqual([id]);
    // The target's own author learns nothing of who reported it.
    expect(await listed(Option.some(member))).toEqual([]);
    expect(await listed(Option.none())).toEqual([]);
    expect(await tagOf(as(Option.some(member), reports.get(id)))).toEqual(
      Option.some("ReportNotFound"),
    );
    expect((await run(as(Option.some(otherMember), reports.get(id)))).reason).toBe("spam");
    expect(
      await tagOf(as(Option.some(otherMember), reports.resolve(id, "dismissed", Option.none()))),
    ).toEqual(Option.some("Forbidden"));
    await run(as(Option.some(moderator), reports.resolve(id, "resolved", Option.some("removed"))));
    expect(store.rows()[0]).toMatchObject({
      status: "resolved",
      resolvedBy: Option.some(moderator.id),
      resolutionNote: Option.some("removed"),
    });
    expect(
      await tagOf(as(Option.some(moderator), reports.resolve(id, "dismissed", Option.none()))),
    ).toEqual(Option.some("ReportClosed"));
    expect(
      await tagOf(
        as(Option.some(moderator), reports.resolve("missing", "dismissed", Option.none())),
      ),
    ).toEqual(Option.some("ReportNotFound"));
    expect(await listed(Option.some(moderator))).toEqual([]);
  });
});
