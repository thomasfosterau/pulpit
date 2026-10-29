/**
 * Suggested edits (pulpit#49).
 *
 * - The two-tier classification: gardeneria's
 *   `apps/api/tests/proposal-conflict.test.ts`, over pulpit's snapshots
 *   (`state` carries the Content axes too).
 * - The patch rules: gardeneria's `proposal-patch.ts` (forbidden before
 *   unknown, unknown refused loudly, decoded by the leaf).
 * - The operations end to end over the in-memory fakes: the submit gate
 *   (a target the proposer can't read is `NodeNotFound`), the decide gates,
 *   accept appending through the target's update with `proposedBy`, the
 *   conflict refusal, reject and withdraw writing nothing to the target, a
 *   decided proposal staying closed, and the read scope.
 *
 * @module tests/proposals
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import {
  classifyProposalBase,
  classifyProposalConflict,
  defineProposals,
  InvalidProposalPatch,
  PROPOSAL_FORBIDDEN_KEYS,
  validateProposalPatch,
} from "../src/proposals.ts";
import {
  defineLocaleLevel,
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type {
  ChainPatch,
  ChainState,
  LocaleStates,
  VersionSnapshot,
} from "../src/version-chain.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryProposalStore,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

/** A viewer, or the anonymous request. */
type Who = ViewerAccount | "anonymous";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

const snapshot = (version: bigint, state: ChainState): VersionSnapshot => ({
  version,
  action: "update",
  timestamp: NOW,
  state,
});

describe("classifyProposalBase", () => {
  it("is clean only when the target has not moved", () => {
    expect(classifyProposalBase(4n, 4n)).toBe("clean");
    expect(classifyProposalBase(4n, 5n)).toBe("moved");
  });

  it("reports `moved` rather than guessing `stale`", () => {
    expect(classifyProposalBase(1n, 99n)).toBe("moved");
  });
});

describe("classifyProposalConflict", () => {
  it("is clean when the versions match, without comparing anything", () => {
    const only = snapshot(7n, { name: "same" });
    expect(classifyProposalConflict(only, only, ["name"])).toEqual({
      state: "clean",
      conflictingAttributes: [],
      conflictingLocales: {},
    });
  });

  it("is stale when the target moved but not in a patched attribute", () => {
    const base = snapshot(4n, { name: "unchanged", description: "old" });
    const current = snapshot(5n, { name: "unchanged", description: "NEW" });
    expect(classifyProposalConflict(base, current, ["name"])).toEqual({
      state: "stale",
      conflictingAttributes: [],
      conflictingLocales: {},
    });
  });

  it("is conflicting when a patched attribute changed underneath", () => {
    const base = snapshot(4n, { name: "old", description: "d" });
    const current = snapshot(5n, { name: "someone else edited this", description: "d" });
    expect(classifyProposalConflict(base, current, ["name", "description"])).toEqual({
      state: "conflicting",
      conflictingAttributes: ["name"],
      conflictingLocales: {},
    });
  });

  it("names every colliding attribute, not just the first", () => {
    const base = snapshot(4n, { name: "a", description: "b" });
    const current = snapshot(5n, { name: "A", description: "B" });
    expect(
      classifyProposalConflict(base, current, ["name", "description"]).conflictingAttributes,
    ).toEqual(["name", "description"]);
  });

  it("fails closed on an attribute no version snapshot carries", () => {
    const base = snapshot(4n, { name: "same" });
    const current = snapshot(5n, { name: "same" });
    expect(classifyProposalConflict(base, current, ["name", "mappings"])).toEqual({
      state: "conflicting",
      conflictingAttributes: ["mappings"],
      conflictingLocales: {},
    });
  });

  it("does not fail closed when the target never moved", () => {
    const only = snapshot(4n, { name: "same" });
    expect(classifyProposalConflict(only, only, ["mappings"]).state).toBe("clean");
  });

  it("compares documents structurally, key order included", () => {
    const base = snapshot(4n, { content: { type: "doc", content: [{ type: "paragraph" }] } });
    const current = snapshot(5n, { content: { content: [{ type: "paragraph" }], type: "doc" } });
    expect(classifyProposalConflict(base, current, ["content"]).state).toBe("stale");
  });

  it("detects a change nested inside a document", () => {
    const base = snapshot(4n, { content: { type: "doc", content: [{ text: "before" }] } });
    const current = snapshot(5n, { content: { type: "doc", content: [{ text: "after" }] } });
    expect(classifyProposalConflict(base, current, ["content"]).state).toBe("conflicting");
  });

  it("treats a null-to-value transition, and a clear, as a change", () => {
    const base = snapshot(4n, { url: null });
    const current = snapshot(5n, { url: "https://example.test" });
    expect(classifyProposalConflict(base, current, ["url"]).state).toBe("conflicting");
    expect(classifyProposalConflict(current, base, ["url"]).state).toBe("conflicting");
  });

  it("treats two nulls as unchanged", () => {
    const base = snapshot(4n, { url: null });
    const current = snapshot(5n, { url: null });
    expect(classifyProposalConflict(base, current, ["url"]).state).toBe("stale");
  });

  it("reads the Content axes from the state like any other column", () => {
    const base = snapshot(4n, { name: "n", visibility: "public", draft: false });
    const current = snapshot(5n, { name: "n", visibility: "private", draft: false });
    expect(
      classifyProposalConflict(base, current, ["visibility", "draft"]).conflictingAttributes,
    ).toEqual(["visibility"]);
  });

  it("reports an empty patch against a moved target as stale, not conflicting", () => {
    const base = snapshot(4n, { name: "a" });
    const current = snapshot(5n, { name: "b" });
    expect(classifyProposalConflict(base, current, []).state).toBe("stale");
  });
});

/** The leaf's decoder: string values only, as a stand-in for its update schema. */
const decodeStrings = (patch: Schema.Json): Effect.Effect<ChainPatch, InvalidProposalPatch> =>
  Predicate.isObject(patch) &&
  !Array.isArray(patch) &&
  Record.every(patch, (value) => Predicate.isString(value))
    ? Effect.succeed(Record.filter(patch, Predicate.isString))
    : Effect.fail(new InvalidProposalPatch({ type: "pages", reason: "a value is not a string" }));

describe("validateProposalPatch — the patch rules", () => {
  const validate = (patch: Schema.Json) =>
    Effect.runPromiseExit(
      validateProposalPatch("pages", patch, {
        attributes: ["title", "body", "visibility"],
        forbidden: PROPOSAL_FORBIDDEN_KEYS,
        decode: decodeStrings,
      }),
    );
  const reason = async (patch: Schema.Json) => {
    const exit = await validate(patch);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error.reason)
      : Option.none();
  };

  it("reserves identity and the publication axes to the owner", () => {
    expect(PROPOSAL_FORBIDDEN_KEYS).toEqual(["id", "type", "visibility", "draft", "publishedAt"]);
  });

  it("decodes an admissible patch and reports its keys in declaration order", async () => {
    const exit = await validate({ body: "b", title: "t" });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      patch: { body: "b", title: "t" },
      touchedKeys: ["title", "body"],
      locales: {},
      touchedLocales: {},
    });
  });

  it("refuses a non-object and an empty patch", async () => {
    expect(await reason(["title"])).toEqual(Option.some("expected an object of attribute changes"));
    expect(await reason(null)).toEqual(Option.some("expected an object of attribute changes"));
    expect(await reason({})).toEqual(Option.some("it proposes no changes"));
  });

  it("refuses a forbidden key before an unknown one, even where the leaf declares it", async () => {
    expect(await reason({ visibility: "public", bogus: "x" })).toEqual(
      Option.some(
        "`visibility` can't be proposed: identity and publication are the owner's to set",
      ),
    );
    expect(await reason({ draft: "false" })).toEqual(
      Option.some("`draft` can't be proposed: identity and publication are the owner's to set"),
    );
  });

  it("refuses an unknown key loudly rather than dropping it", async () => {
    expect(await reason({ titel: "t" })).toEqual(
      Option.some("`titel` is not a proposable attribute"),
    );
  });

  it("refuses what the leaf's decoder refuses", async () => {
    expect(await reason({ title: 7 })).toEqual(Option.some("a value is not a string"));
  });
});

describe("defineProposals — the operations", () => {
  const curator: ViewerAccount = { id: "u-curator", role: "contributor" };

  const setup = () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, {
      columns: ["title", "body", "visibility"],
      now: NOW,
    });
    let viewer: Viewer = Option.none();
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
    const store = makeInMemoryProposalStore({ chain, leaves });
    const ops = defineProposals({
      type: "pages",
      target,
      chain,
      ownerOf: leaves.ownerOf,
      proposals: store,
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      canPropose: () => true,
      attributes: ["title", "body"],
      decode: decodeStrings,
    });
    const actAs = <A, E>(who: Who, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who === "anonymous" ? Option.none() : Option.some(who);
        return effect;
      });
    const page = async (visibility: string) =>
      (
        await run(
          actAs(
            member,
            target.create({
              id: Option.none(),
              state: { title: "Title", body: "Body", visibility },
            }),
          ),
        )
      ).id;
    const propose = async (targetId: string, patch: Schema.Json, who = curator) =>
      (await run(actAs(who, ops.submit({ targetId, patch, rationale: Option.some("typo") })))).id;
    return { chain, store, target, ops, actAs, page, propose };
  };

  it("submit stamps the head as the base and stores the patch as submitted", async () => {
    const { store, page, propose, actAs, target } = setup();
    const id = await page("public");
    await run(actAs(member, target.update({ id, patch: { body: "Edited" } })));
    const proposal = await propose(id, { title: "Better" });
    expect(store.rows()).toMatchObject([
      {
        id: proposal,
        targetId: id,
        targetType: "pages",
        authorId: curator.id,
        patch: { title: "Better" },
        rationale: Option.some("typo"),
        baseVersion: 1n,
        status: "pending",
      },
    ]);
  });

  it("submit refuses the anonymous, a refused rung, a target the proposer can't read, and a bad patch", async () => {
    const { ops, actAs, page } = setup();
    const hidden = await page("private");
    const open = await page("public");
    const submit = (targetId: string, patch: Schema.Json) =>
      ops.submit({ targetId, patch, rationale: Option.none() });
    expect(await tagOf(actAs("anonymous", submit(open, { title: "x" })))).toEqual(
      Option.some("Unauthorized"),
    );
    // Hidden and missing are one answer (SEC-AUTH-ENUM-001).
    expect(await tagOf(actAs(curator, submit(hidden, { title: "x" })))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(actAs(curator, submit("missing", { title: "x" })))).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(await tagOf(actAs(curator, submit(open, { visibility: "private" })))).toEqual(
      Option.some("InvalidProposalPatch"),
    );
  });

  it("submit refuses an account below the propose rung", async () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
    const viewer = Effect.succeed(Option.some(member));
    const ops = defineProposals({
      type: "pages",
      target: defineSubtype({
        type: "pages",
        access: ownedAccess(),
        chain,
        leaves,
        viewer,
        policy: gardeneriaPolicy,
        followers: makeInMemoryFollowers([]),
        toResource: (row: LeafRow) => row,
      }),
      chain,
      ownerOf: leaves.ownerOf,
      proposals: makeInMemoryProposalStore({ chain, leaves }),
      viewer,
      policy: gardeneriaPolicy,
      canPropose: (account) => account.role !== "user",
      attributes: ["title"],
      decode: decodeStrings,
    });
    expect(
      await tagOf(ops.submit({ targetId: "any", patch: { title: "x" }, rationale: Option.none() })),
    ).toEqual(Option.some("Forbidden"));
  });

  it("accept appends through the target's update as the acceptor, with the proposer as proposedBy", async () => {
    const { chain, store, ops, actAs, page, propose } = setup();
    const id = await page("public");
    const proposal = await propose(id, { title: "Better" });
    const written = await run(actAs(member, ops.accept(proposal, { note: Option.some("thanks") })));
    expect(written).toEqual({ id, version: 1n });
    const appended = chain.rows().at(-1);
    expect(appended).toMatchObject({
      action: "update",
      version: 1n,
      actorId: Option.some(member.id),
      proposedBy: Option.some(curator.id),
      state: { title: "Better", body: "Body" },
    });
    expect(store.rows()[0]).toMatchObject({
      status: "accepted",
      decidedBy: Option.some(member.id),
      decisionNote: Option.some("thanks"),
      appliedVersion: Option.some(1n),
    });
    // An ordinary write records no proposer.
    expect(chain.rows()[0]?.proposedBy).toEqual(Option.none());
  });

  it("accept of a stale proposal applies; of a conflicting one refuses and writes nothing", async () => {
    const { chain, store, ops, actAs, page, propose, target } = setup();
    const id = await page("public");
    const stale = await propose(id, { title: "Better" });
    const conflicting = await propose(id, { body: "Mine" });
    await run(actAs(member, target.update({ id, patch: { body: "Theirs" } })));
    const review = await run(actAs(member, ops.review(conflicting)));
    expect(review.baseState).toEqual(Option.some("moved"));
    expect(review.conflict).toEqual({
      state: "conflicting",
      conflictingAttributes: ["body"],
      conflictingLocales: {},
    });
    expect(await tagOf(actAs(member, ops.accept(conflicting)))).toEqual(
      Option.some("ProposalConflict"),
    );
    expect(chain.rows()).toHaveLength(2);
    expect((await run(actAs(member, ops.review(stale)))).conflict.state).toBe("stale");
    await run(actAs(member, ops.accept(stale)));
    expect(chain.rows().at(-1)?.state).toEqual({
      title: "Better",
      body: "Theirs",
      visibility: "public",
    });
    expect(store.rows().map((row) => row.status)).toEqual(["accepted", "pending"]);
  });

  it("decide is the target's write gate: a stranger is refused before the status is read", async () => {
    const { ops, actAs, page, propose, chain } = setup();
    const id = await page("public");
    const proposal = await propose(id, { title: "Better" });
    expect(await tagOf(actAs(otherMember, ops.accept(proposal)))).toEqual(Option.some("Forbidden"));
    expect(await tagOf(actAs(otherMember, ops.reject(proposal)))).toEqual(Option.some("Forbidden"));
    expect(await tagOf(actAs(otherMember, ops.review(proposal)))).toEqual(Option.some("Forbidden"));
    expect(await tagOf(actAs("anonymous", ops.accept(proposal)))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(await tagOf(actAs(member, ops.accept("missing")))).toEqual(
      Option.some("ProposalNotFound"),
    );
    // A moderator may decide someone else's row.
    await run(actAs(moderator, ops.accept(proposal)));
    expect(chain.rows()).toHaveLength(2);
  });

  it("a decided proposal stays closed; reject and withdraw write nothing to the target", async () => {
    const { chain, store, ops, actAs, page, propose } = setup();
    const id = await page("public");
    const rejected = await propose(id, { title: "No" });
    const withdrawn = await propose(id, { title: "Never mind" });
    await run(actAs(member, ops.reject(rejected, { note: Option.some("no") })));
    expect(await tagOf(actAs(otherMember, ops.withdraw(withdrawn)))).toEqual(
      Option.some("Forbidden"),
    );
    await run(actAs(curator, ops.withdraw(withdrawn)));
    expect(chain.rows()).toHaveLength(1);
    expect(store.rows().map((row) => [row.status, row.decidedBy])).toEqual([
      ["rejected", Option.some(member.id)],
      ["withdrawn", Option.some(curator.id)],
    ]);
    expect(await tagOf(actAs(member, ops.accept(rejected)))).toEqual(Option.some("ProposalClosed"));
    expect(await tagOf(actAs(member, ops.reject(withdrawn)))).toEqual(
      Option.some("ProposalClosed"),
    );
    expect(await tagOf(actAs(curator, ops.withdraw(rejected)))).toEqual(
      Option.some("ProposalClosed"),
    );
    expect(await tagOf(actAs(member, ops.review(rejected)))).toEqual(Option.some("ProposalClosed"));
  });

  it("a proposal whose target was deleted can still be rejected", async () => {
    const { ops, actAs, page, propose, target, store } = setup();
    const id = await page("public");
    const proposal = await propose(id, { title: "Better" });
    await run(actAs(member, target.delete(id)));
    await run(actAs(member, ops.reject(proposal)));
    expect(store.rows()[0]?.status).toBe("rejected");
  });

  it("accept re-validates the stored patch", async () => {
    const { ops, actAs, page, store } = setup();
    const id = await page("public");
    await run(
      store.insert({
        id: "p-old",
        targetId: id,
        targetType: "pages",
        authorId: curator.id,
        patch: { retired: "x" },
        locales: Option.none(),
        rationale: Option.none(),
        baseVersion: 0n,
        status: "pending",
        submittedAt: NOW,
        decidedAt: Option.none(),
        decidedBy: Option.none(),
        decisionNote: Option.none(),
        appliedVersion: Option.none(),
      }),
    );
    expect(await tagOf(actAs(member, ops.accept("p-old")))).toEqual(
      Option.some("InvalidProposalPatch"),
    );
  });

  it("reads: the moderate rung reads all, the author and the target's owner their own, nobody else any", async () => {
    const { ops, actAs, page, propose } = setup();
    const id = await page("public");
    const proposal = await propose(id, { title: "Better" });
    const listed = async (who: Who) =>
      (
        await run(
          actAs(
            who,
            ops.list({ targetId: Option.none(), status: Option.none(), limit: 50, offset: 0 }),
          ),
        )
      ).rows.map((view) => view.proposal.id);
    expect(await listed(moderator)).toEqual([proposal]);
    expect(await listed(curator)).toEqual([proposal]);
    expect(await listed(member)).toEqual([proposal]);
    expect(await listed(otherMember)).toEqual([]);
    expect(await listed("anonymous")).toEqual([]);
    expect((await run(actAs(curator, ops.get(proposal)))).baseState).toEqual(Option.some("clean"));
    expect(await tagOf(actAs(otherMember, ops.get(proposal)))).toEqual(
      Option.some("ProposalNotFound"),
    );
    expect(await tagOf(actAs("anonymous", ops.get(proposal)))).toEqual(
      Option.some("ProposalNotFound"),
    );
  });

  it("list narrows by target and status, newest first, and omits the verdict once decided", async () => {
    const { ops, actAs, page, propose } = setup();
    const first = await page("public");
    const second = await page("public");
    const a = await propose(first, { title: "A" });
    const b = await propose(second, { title: "B" });
    await run(actAs(member, ops.reject(a)));
    const list = (targetId: Option.Option<string>, status: Option.Option<"pending" | "rejected">) =>
      run(actAs(moderator, ops.list({ targetId, status, limit: 50, offset: 0 })));
    const all = await list(Option.none(), Option.none());
    // Equal submission instants close by id, descending.
    expect(all.rows.map((view) => view.proposal.id)).toEqual([b, a]);
    expect(all.rows.map((view) => view.baseState)).toEqual([Option.some("clean"), Option.none()]);
    expect(
      (await list(Option.some(first), Option.none())).rows.map((view) => view.proposal.id),
    ).toEqual([a]);
    expect((await list(Option.none(), Option.some("pending"))).total).toBe(1);
  });
});

describe("over a localised leaf (pulpit#184)", () => {
  const atLocales = (version: bigint, locales: LocaleStates): VersionSnapshot => ({
    ...snapshot(version, { colour: "red" }),
    locales,
  });

  describe("classifyProposalConflict per locale", () => {
    const base = atLocales(4n, { en: { title: "Hello" }, fr: { title: "Bonjour" } });

    it("is stale when only an untouched locale changed", () => {
      const current = atLocales(5n, { en: { title: "Hi" }, fr: { title: "Bonjour" } });
      expect(classifyProposalConflict(base, current, [], { fr: ["title"] })).toEqual({
        state: "stale",
        conflictingAttributes: [],
        conflictingLocales: {},
      });
    });

    it("conflicts when a touched translated column changed underneath", () => {
      const current = atLocales(5n, { en: { title: "Hello" }, fr: { title: "Salut" } });
      expect(classifyProposalConflict(base, current, [], { fr: ["title"] })).toEqual({
        state: "conflicting",
        conflictingAttributes: [],
        conflictingLocales: { fr: ["title"] },
      });
    });

    it("a new translation neither version carries is not a conflict; one added since is", () => {
      const moved = atLocales(5n, { en: { title: "Hi" }, fr: { title: "Bonjour" } });
      expect(classifyProposalConflict(base, moved, [], { de: ["title"] }).state).toBe("stale");
      const added = atLocales(5n, { ...base.locales, de: { title: "Hallo" } });
      expect(
        classifyProposalConflict(base, added, [], { de: ["title"] }).conflictingLocales,
      ).toEqual({ de: ["title"] });
    });

    it("conflicts on a touched locale dropped since the base", () => {
      const dropped = atLocales(5n, { en: { title: "Hello" } });
      expect(
        classifyProposalConflict(base, dropped, [], { fr: ["title"] }).conflictingLocales,
      ).toEqual({ fr: ["title"] });
    });

    it("fails closed on a translated column either version lacks", () => {
      const current = atLocales(5n, { en: { title: "Hello" }, fr: { title: "Bonjour", alt: "x" } });
      expect(
        classifyProposalConflict(base, current, [], { fr: ["alt"] }).conflictingLocales,
      ).toEqual({
        fr: ["alt"],
      });
    });

    it("equal versions are clean without comparing anything", () => {
      expect(classifyProposalConflict(base, base, [], { fr: ["title"] }).state).toBe("clean");
    });
  });

  describe("validateProposalPatch with a per-locale patch", () => {
    const validate = (patch: Schema.Json, locales: Schema.Json, localeAttributes = ["title"]) =>
      Effect.runPromiseExit(
        validateProposalPatch("pages", patch, {
          attributes: ["colour"],
          forbidden: PROPOSAL_FORBIDDEN_KEYS,
          decode: decodeStrings,
          locales,
          localeAttributes,
        }),
      );
    const reason = async (
      patch: Schema.Json,
      locales: Schema.Json,
      localeAttributes?: Array<string>,
    ) => {
      const exit = await validate(patch, locales, localeAttributes);
      return Exit.isFailure(exit)
        ? Option.map(Exit.findErrorOption(exit), (error) => error.reason)
        : Option.none();
    };

    it("takes a translation alone, decoded, with its touched columns", async () => {
      const exit = await validate({}, { fr: { title: "Salut" } });
      expect(Exit.isSuccess(exit) && exit.value).toEqual({
        patch: {},
        touchedKeys: [],
        locales: { fr: { title: "Salut" } },
        touchedLocales: { fr: ["title"] },
      });
    });

    it("refuses dropping a translation, an empty or malformed locale, and an empty proposal", async () => {
      expect(await reason({}, { fr: null })).toEqual(
        Option.some("dropping the `fr` translation is the owner's to do"),
      );
      expect(await reason({}, { fr: {} })).toEqual(Option.some("it proposes no changes for `fr`"));
      expect(await reason({}, { fr: "x" })).toEqual(
        Option.some("expected an object of attribute changes for `fr`"),
      );
      expect(await reason({}, { "": { title: "x" } })).toEqual(
        Option.some("a locale tag is empty"),
      );
      expect(await reason({}, ["fr"])).toEqual(
        Option.some("expected an object of changes per locale"),
      );
      expect(await reason({}, {})).toEqual(Option.some("it proposes no changes"));
    });

    it("refuses a shared column in a locale, a forbidden one, and any locale on a leaf without translations", async () => {
      expect(await reason({}, { fr: { colour: "x" } })).toEqual(
        Option.some("`colour` is not a proposable attribute (in `fr`)"),
      );
      expect(await reason({}, { fr: { visibility: "public" } })).toEqual(
        Option.some(
          "`visibility` can't be proposed: identity and publication are the owner's to set (in `fr`)",
        ),
      );
      expect(await reason({ colour: "x" }, { fr: { title: "x" } }, [])).toEqual(
        Option.some("this leaf takes no translated attributes"),
      );
    });

    it("refuses what the leaf's decoder refuses in a locale", async () => {
      expect(await reason({}, { fr: { title: 7 } })).toEqual(
        Option.some("a value is not a string"),
      );
    });
  });

  describe("defineProposals end to end", () => {
    const curator: ViewerAccount = { id: "u-curator", role: "contributor" };

    const setup = () => {
      const chain = makeInMemoryChainStore();
      const leaves = makeInMemoryLeafStore(chain, {
        columns: ["title", "colour", "visibility"],
        localised: true,
        now: NOW,
      });
      let viewer: Viewer = Option.none();
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
        locales: defineLocaleLevel({ columns: ["title"] }),
      });
      const store = makeInMemoryProposalStore({ chain, leaves });
      const ops = defineProposals({
        type: "pages",
        target,
        chain,
        ownerOf: leaves.ownerOf,
        proposals: store,
        viewer: viewerOf,
        policy: gardeneriaPolicy,
        canPropose: () => true,
        attributes: ["colour"],
        localeAttributes: ["title"],
        decode: decodeStrings,
      });
      const actAs = <A, E>(who: ViewerAccount, effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          viewer = Option.some(who);
          return effect;
        });
      const page = () =>
        run(
          actAs(
            member,
            target.create({
              id: Option.none(),
              state: { colour: "red", visibility: "public" },
              locales: { en: { title: "Hello" }, fr: { title: "Bonjour" } },
            }),
          ),
        ).then(({ id }) => id);
      const propose = (targetId: string, locales: Schema.Json, patch: Schema.Json = {}) =>
        run(
          actAs(curator, ops.submit({ targetId, patch, locales, rationale: Option.none() })),
        ).then(({ id }) => id);
      const title = (id: string, locale: string) =>
        run(actAs(member, target.getLocalised(id, [locale]))).then(
          ({ resource }) => resource["title"],
        );
      return { store, target, ops, actAs, page, propose, title };
    };

    it("stores the per-locale patch as submitted and accepts it as one update", async () => {
      const { store, ops, actAs, page, propose, title } = setup();
      const id = await page();
      const proposal = await propose(id, { fr: { title: "Salut" } }, { colour: "blue" });
      expect(store.rows()[0]?.locales).toEqual(Option.some({ fr: { title: "Salut" } }));
      const written = await run(actAs(member, ops.accept(proposal)));
      expect(written.version).toBe(1n);
      expect(await title(id, "fr")).toBe("Salut");
      expect(await title(id, "en")).toBe("Hello");
    });

    it("an edit to another locale leaves the proposal stale and acceptable", async () => {
      const { ops, actAs, page, propose, target, title } = setup();
      const id = await page();
      const proposal = await propose(id, { fr: { title: "Salut" } });
      await run(actAs(member, target.update({ id, patch: {}, locales: { en: { title: "Hi" } } })));
      const review = await run(actAs(member, ops.review(proposal)));
      expect(review.conflict.state).toBe("stale");
      await run(actAs(member, ops.accept(proposal)));
      expect(await title(id, "fr")).toBe("Salut");
      expect(await title(id, "en")).toBe("Hi");
    });

    it("an edit to the touched translation conflicts, and accept refuses it naming the locale", async () => {
      const { ops, actAs, page, propose, target, title } = setup();
      const id = await page();
      const proposal = await propose(id, { fr: { title: "Salut" } });
      await run(
        actAs(member, target.update({ id, patch: {}, locales: { fr: { title: "Coucou" } } })),
      );
      const review = await run(actAs(member, ops.review(proposal)));
      expect(review.conflict).toEqual({
        state: "conflicting",
        conflictingAttributes: [],
        conflictingLocales: { fr: ["title"] },
      });
      const refused = await Effect.runPromiseExit(actAs(member, ops.accept(proposal)));
      expect(
        Exit.isFailure(refused) && Option.getOrUndefined(Exit.findErrorOption(refused)),
      ).toMatchObject({
        _tag: "ProposalConflict",
        attributes: [],
        locales: { fr: ["title"] },
      });
      expect(await title(id, "fr")).toBe("Coucou");
    });

    it("refuses a proposal that drops a translation at submit", async () => {
      const { ops, actAs, page } = setup();
      const id = await page();
      expect(
        await tagOf(
          actAs(
            curator,
            ops.submit({
              targetId: id,
              patch: {},
              locales: { fr: null },
              rationale: Option.none(),
            }),
          ),
        ),
      ).toEqual(Option.some("InvalidProposalPatch"));
    });
  });
});
