/**
 * The moderation workflow.
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
 * - The report state machine, and its link to content moderation: upholding
 *   a report rejects the target and settles its queue, and a content
 *   decision through `withReports` closes the target's open reports.
 *
 * @module tests/moderation
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { always, eq, evaluate, never } from "../src/Filter.ts";
import {
  DEFAULT_MODERATION_THRESHOLD,
  defineModeration,
  defineReports,
  gradeScores,
  isModerationTransition,
  isReportTransition,
  moderatedColumns,
  moderatePatch,
  moderationHook,
  reportOutcomeOf,
  reviewQueueFilter,
  withReports,
  type ModerationScores,
} from "../src/Moderation.ts";
import {
  defineSubtype,
  ownedAccess,
  type BeforeWriteEvent,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/Subtype.ts";
import type { ChainState, WriteAction } from "../src/VersionChain.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryReportStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

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
  const chain = makeInMemoryVersionChain("comments");
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
  const post = () =>
    Effect.map(
      actAs(
        Option.some(member),
        target.create({ id: Option.none(), state: { body: "Hello", visibility: "public" } }),
      ),
      (value) => value.id,
    );
  const stateOf = () => chain.rows().at(-1)?.state["moderationState"];
  return { chain, target, moderation, actAs, post, stateOf };
};

describe("the rules through a leaf's hooks", () => {
  it.effect("create pending → moderate approved (stamped) → an edit to body sends it back", () =>
    Effect.gen(function* () {
      const { chain, target, moderation, actAs, post, stateOf } = comments();
      const id = yield* post();
      expect(stateOf()).toBe("pending");
      yield* actAs(Option.some(moderator), moderation.moderate(id, "approved"));
      expect(chain.rows().at(-1)?.state).toMatchObject({
        moderationState: "approved",
        moderatedBy: moderator.id,
      });
      yield* actAs(Option.some(member), target.update({ id, patch: { body: "Edited" } }));
      expect(stateOf()).toBe("pending");
    }),
  );

  it.effect("an owner can't approve their own row, and the refusal appends nothing", () =>
    Effect.gen(function* () {
      const { chain, target, actAs, post } = comments();
      const id = yield* post();
      expect(
        yield* tagOf(
          actAs(Option.some(member), target.update({ id, patch: { moderationState: "approved" } })),
        ),
      ).toEqual(Option.some("WriteRejected"));
      expect(chain.rows()).toHaveLength(1);
    }),
  );

  it.effect("moderate is the rung's: refused before anything is read", () =>
    Effect.gen(function* () {
      const { chain, moderation, actAs, post } = comments();
      const id = yield* post();
      expect(yield* tagOf(actAs(Option.some(member), moderation.moderate(id, "approved")))).toEqual(
        Option.some("Forbidden"),
      );
      expect(yield* tagOf(actAs(Option.none(), moderation.moderate(id, "approved")))).toEqual(
        Option.some("Unauthorized"),
      );
      expect(
        yield* tagOf(actAs(Option.some(moderator), moderation.moderate("missing", "approved"))),
      ).toEqual(Option.some("NodeNotFound"));
      expect(chain.rows()).toHaveLength(1);
    }),
  );

  it.effect("an owner withdraws their own approved row by deleting it", () =>
    Effect.gen(function* () {
      const { chain, target, moderation, actAs, post } = comments();
      const id = yield* post();
      yield* actAs(Option.some(moderator), moderation.moderate(id, "approved"));
      yield* actAs(Option.some(member), target.delete(id));
      expect(chain.rows().at(-1)?.action).toBe("delete");
    }),
  );
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

  it.effect(
    "files against a readable target, and refuses a hidden or missing one as NodeNotFound",
    () =>
      Effect.gen(function* () {
        const { reports, as, target, actAs } = setup();
        const open = (yield* actAs(
          Option.some(member),
          target.create({ id: Option.none(), state: { body: "Hi", visibility: "public" } }),
        )).id;
        const hidden = (yield* actAs(
          Option.some(member),
          target.create({ id: Option.none(), state: { body: "Hi", visibility: "private" } }),
        )).id;
        const file = (targetId: string) =>
          reports.file({ targetId, reason: "spam", details: Option.none() });
        expect(yield* tagOf(as(Option.some(otherMember), file(open)))).toEqual(Option.none());
        expect(yield* tagOf(as(Option.some(otherMember), file(hidden)))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* tagOf(as(Option.some(otherMember), file("missing")))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* tagOf(as(Option.none(), file(open)))).toEqual(Option.some("Unauthorized"));
      }),
  );

  it.effect("is read by its reporter and the rung, and resolved by the rung alone", () =>
    Effect.gen(function* () {
      const { reports, store, as, post } = setup();
      const target = yield* post();
      const { id } = yield* as(
        Option.some(otherMember),
        reports.file({ targetId: target, reason: "spam", details: Option.some("bot") }),
      );
      const listed = (who: Viewer) =>
        Effect.gen(function* () {
          return (yield* as(
            who,
            reports.list({
              targetId: Option.none(),
              status: Option.some("open"),
              limit: 10,
              offset: 0,
            }),
          )).rows.map((row) => row.id);
        });
      expect(yield* listed(Option.some(moderator))).toEqual([id]);
      expect(yield* listed(Option.some(otherMember))).toEqual([id]);
      // The target's own author learns nothing of who reported it.
      expect(yield* listed(Option.some(member))).toEqual([]);
      expect(yield* listed(Option.none())).toEqual([]);
      expect(yield* tagOf(as(Option.some(member), reports.get(id)))).toEqual(
        Option.some("ReportNotFound"),
      );
      expect((yield* as(Option.some(otherMember), reports.get(id))).reason).toBe("spam");
      expect(
        yield* tagOf(as(Option.some(otherMember), reports.resolve(id, "dismissed", Option.none()))),
      ).toEqual(Option.some("Forbidden"));
      yield* as(Option.some(moderator), reports.resolve(id, "resolved", Option.some("removed")));
      expect(store.rows()[0]).toMatchObject({
        status: "resolved",
        resolvedBy: Option.some(moderator.id),
        resolutionNote: Option.some("removed"),
      });
      expect(
        yield* tagOf(as(Option.some(moderator), reports.resolve(id, "dismissed", Option.none()))),
      ).toEqual(Option.some("ReportClosed"));
      expect(
        yield* tagOf(
          as(Option.some(moderator), reports.resolve("missing", "dismissed", Option.none())),
        ),
      ).toEqual(Option.some("ReportNotFound"));
      expect(yield* listed(Option.some(moderator))).toEqual([]);
    }),
  );
});

describe("the report state machine", () => {
  it("a report is filed open and closes once", () => {
    expect(isReportTransition("open", "resolved")).toBe(true);
    expect(isReportTransition("open", "dismissed")).toBe(true);
    expect(isReportTransition("open", "open")).toBe(false);
    expect(isReportTransition("resolved", "dismissed")).toBe(false);
    expect(isReportTransition("dismissed", "resolved")).toBe(false);
    expect(isReportTransition("resolved", "open")).toBe(false);
  });

  it("a content decision settles reports: rejected upholds, approved dismisses, pending leaves", () => {
    expect(reportOutcomeOf("rejected")).toEqual(Option.some("resolved"));
    expect(reportOutcomeOf("approved")).toEqual(Option.some("dismissed"));
    expect(reportOutcomeOf("pending")).toEqual(Option.none());
  });
});

describe("reports and content moderation, linked", () => {
  const linked = () => {
    const leaf = comments();
    const store = makeInMemoryReportStore();
    let viewer: Viewer = Option.none();
    const viewerOf = Effect.sync(() => viewer);
    const reports = defineReports({
      target: leaf.target,
      reports: store,
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      moderation: leaf.moderation,
    });
    const decide = withReports({ moderation: leaf.moderation, reports: store, viewer: viewerOf });
    const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      leaf.actAs(
        who,
        Effect.suspend(() => {
          viewer = who;
          return effect;
        }),
      );
    const file = (targetId: string) =>
      as(
        Option.some(otherMember),
        reports.file({ targetId, reason: "spam", details: Option.none() }),
      );
    const stateOfNode = (id: string) =>
      leaf.chain.rows().findLast((row) => row.id === id)?.state["moderationState"];
    const statuses = () => store.rows().map((row) => [row.targetId, row.status] as const);
    return { ...leaf, store, reports, decide, as, file, stateOfNode, statuses };
  };

  it.effect("upholding a report rejects the target and closes every open report on it", () =>
    Effect.gen(function* () {
      const { reports, as, post, file, store, stateOfNode, statuses } = linked();
      const [a, b] = [yield* post(), yield* post()];
      const first = yield* file(a);
      yield* file(a);
      yield* file(b);
      yield* as(Option.some(moderator), reports.resolve(first.id, "resolved", Option.some("spam")));
      expect(stateOfNode(a)).toBe("rejected");
      expect(stateOfNode(b)).toBe("pending");
      expect(statuses()).toEqual([
        [a, "resolved"],
        [a, "resolved"],
        [b, "open"],
      ]);
      expect(store.rows()[1]).toMatchObject({
        resolvedBy: Option.some(moderator.id),
        resolutionNote: Option.some("spam"),
      });
    }),
  );

  it.effect("dismissing closes one report and leaves the content as it is", () =>
    Effect.gen(function* () {
      const { reports, as, post, file, stateOfNode, statuses } = linked();
      const a = yield* post();
      const first = yield* file(a);
      yield* file(a);
      yield* as(Option.some(moderator), reports.resolve(first.id, "dismissed", Option.none()));
      expect(stateOfNode(a)).toBe("pending");
      expect(statuses()).toEqual([
        [a, "dismissed"],
        [a, "open"],
      ]);
    }),
  );

  it.effect(
    "upholding a report on content its owner already deleted still closes its reports",
    () =>
      Effect.gen(function* () {
        const { reports, as, post, file, target, statuses } = linked();
        const a = yield* post();
        const { id } = yield* file(a);
        yield* as(Option.some(member), target.delete(a));
        yield* as(Option.some(moderator), reports.resolve(id, "resolved", Option.none()));
        expect(statuses()).toEqual([[a, "resolved"]]);
      }),
  );

  it.effect("a content decision through withReports settles the target's open reports", () =>
    Effect.gen(function* () {
      const { decide, as, post, file, stateOfNode, statuses } = linked();
      const [a, b, c] = [yield* post(), yield* post(), yield* post()];
      yield* file(a);
      yield* file(b);
      yield* file(c);
      yield* as(Option.some(moderator), decide.moderate(a, "rejected"));
      yield* as(Option.some(moderator), decide.moderate(b, "approved"));
      expect(stateOfNode(a)).toBe("rejected");
      expect(stateOfNode(b)).toBe("approved");
      // A re-review sends content back to pending and leaves its reports open.
      yield* as(Option.some(moderator), decide.moderate(b, "pending"));
      expect(statuses()).toEqual([
        [a, "resolved"],
        [b, "dismissed"],
        [c, "open"],
      ]);
    }),
  );

  it.effect("withReports keeps moderate's gate: a refused decision closes nothing", () =>
    Effect.gen(function* () {
      const { decide, as, post, file, statuses } = linked();
      const a = yield* post();
      yield* file(a);
      expect(yield* tagOf(as(Option.some(member), decide.moderate(a, "rejected")))).toEqual(
        Option.some("Forbidden"),
      );
      expect(
        yield* tagOf(as(Option.some(moderator), decide.moderate("missing", "rejected"))),
      ).toEqual(Option.some("NodeNotFound"));
      expect(statuses()).toEqual([[a, "open"]]);
    }),
  );
});
