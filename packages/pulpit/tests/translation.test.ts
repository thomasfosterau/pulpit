/**
 * Translation lineage, staleness and the sweep (pulpit#208), over the
 * in-memory `VersionChain`.
 *
 * - Lineage reads fail closed: a malformed column set is an original locale.
 * - `pending` lists missing targets and stale derived locales, and nothing
 *   once the sweep has translated them; a shared-column edit, a dropped
 *   source or a tombstoned node lists nothing; an unreadable source version
 *   reads as stale.
 * - The sweep lands one write per node in `direct` mode, marked `machine`
 *   and attributed to the bot, and one proposal per node in `proposal` mode,
 *   skipping locales a pending bot proposal covers.
 * - A concurrent edit, a refused landing and a translator that returns
 *   foreign columns are conflict entries, never a failed page.
 * - Paging is keyset on the candidates, with the limit clamped.
 * - A person's edit of a derived locale is stamped `human` and still goes
 *   stale when the source moves on.
 *
 * @module tests/translation
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { makeInMemoryVersionChain } from "../src/testing.ts";
import {
  defaultLineageColumns,
  defineTranslation,
  humanLineageHook,
  lineageOf,
  lineagePatch,
  stampHumanLineage,
  type TranslationCandidates,
  type TranslationLanding,
  type Translator,
} from "../src/translation.ts";
import {
  defineVersionChain,
  StaleVersion,
  type ChainState,
  type UpdateInput,
} from "../src/version-chain.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const BOT = Option.some("u-bot");
const columns = ["title", "body"] as const;
const declaration = {
  type: "pages",
  columns,
  sourceLocale: "en",
  targets: ["en", "fr", "de"],
} as const;

/** A translator that prefixes each string value with its target locale. */
const prefixing: Translator<never, never> = {
  translate: ({ to, values }) =>
    Effect.succeed(R.map(values, (value): ChainState[string] => `${to}:${String(value)}`)),
};

/** Candidate nodes in ascending id order, keyset-paged. */
const candidatesOf = (ids: () => ReadonlyArray<string>): TranslationCandidates<never, never> => ({
  nodes: ({ after, limit }) =>
    Effect.succeed(
      Arr.take(
        Arr.filter(
          Arr.sort(ids(), (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
          (id) => Option.match(after, { onNone: () => true, onSome: (cursor) => id > cursor }),
        ),
        limit,
      ),
    ),
});

const fixture = () => {
  const port = makeInMemoryVersionChain("pages");
  const ops = defineVersionChain("pages", port, {
    beforeAppendLocales: (event) => Effect.succeed(stampHumanLineage(declaration, event)),
  });
  const ids: Array<string> = [];
  const create = (id: string, locales: Record<string, ChainState>) =>
    run(
      Effect.tap(
        ops.create({ id: Option.some(id), state: { slug: id }, locales, actorId: Option.none() }),
        () => Effect.sync(() => ids.push(id)),
      ),
    );
  const translation = (landing: TranslationLanding<never, never>, translator = prefixing) =>
    defineTranslation({
      ...declaration,
      chain: port,
      candidates: candidatesOf(() => ids),
      translator,
      landing,
    });
  const direct = (update: (input: UpdateInput) => Effect.Effect<unknown, unknown> = ops.update) =>
    translation({ kind: "direct", update, actorId: BOT });
  const head = (id: string) =>
    run(
      Effect.flatMap(port.head(id), (entry) =>
        port.getVersion(
          id,
          Option.match(entry, { onNone: () => -1n, onSome: ({ version }) => version }),
        ),
      ),
    );
  return { port, ops, ids, create, translation, direct, head };
};

const first = { after: Option.none<string>(), limit: 100 };

describe("lineageOf (fails closed)", () => {
  const lineage = { derivedFrom: "en", derivedFromVersion: "4", derivation: "machine" };
  it("reads a complete lineage, the version from a decimal string or a bigint", () => {
    expect(lineageOf(defaultLineageColumns, lineage)).toEqual(
      Option.some({ source: "en", sourceVersion: 4n, method: "machine" }),
    );
    expect(lineageOf(defaultLineageColumns, { ...lineage, derivedFromVersion: 4n })).toEqual(
      Option.some({ source: "en", sourceVersion: 4n, method: "machine" }),
    );
  });

  it.each([
    { label: "no columns", state: {} },
    { label: "a non-string source", state: { ...lineage, derivedFrom: 3 } },
    { label: "an unknown method", state: { ...lineage, derivation: "robot" } },
    { label: "a non-decimal version", state: { ...lineage, derivedFromVersion: "4.5" } },
    { label: "a negative version", state: { ...lineage, derivedFromVersion: "-1" } },
    { label: "a numeric version", state: { ...lineage, derivedFromVersion: 4 } },
  ])("reads $label as an original locale", ({ state }) => {
    expect(lineageOf(defaultLineageColumns, state)).toEqual(Option.none());
  });

  it("lineagePatch writes the version as a decimal string, valid JSON", () => {
    const patch = lineagePatch(defaultLineageColumns, {
      source: "en",
      sourceVersion: 12n,
      method: "machine",
    });
    expect(patch).toEqual({ derivedFrom: "en", derivedFromVersion: "12", derivation: "machine" });
    expect(Schema.is(Schema.Json)(patch)).toBe(true);
  });
});

describe("pending and the direct sweep", () => {
  it("lists the missing targets, lands them in one machine write, and then lists nothing", async () => {
    const { create, direct, head, port } = fixture();
    await create("n-1", { en: { title: "Hello", body: "World" } });
    const translation = direct();

    const pending = await run(translation.pending(first));
    expect(
      Arr.map(pending.pairs, ({ locale, reason, source }) => ({ locale, reason, source })),
    ).toEqual([
      { locale: "fr", reason: "missing", source: "en" },
      { locale: "de", reason: "missing", source: "en" },
    ]);

    const summary = await run(translation.sweep(first));
    expect(Arr.map(summary.landed, ({ locale }) => locale)).toEqual(["fr", "de"]);
    expect(summary.conflicts).toEqual([]);
    const after = await head("n-1");
    expect(after.version).toBe(1n);
    expect(after.locales?.["fr"]).toEqual({
      title: "fr:Hello",
      body: "fr:World",
      derivedFrom: "en",
      derivedFromVersion: "0",
      derivation: "machine",
    });
    expect(Arr.map(port.rows(), (row) => row.actorId)).toEqual([Option.none(), BOT]);
    expect((await run(translation.pending(first))).pairs).toEqual([]);
  });

  it("goes stale when the source's translatable columns change, and clears on re-translation", async () => {
    const { create, direct, ops, head } = fixture();
    await create("n-1", { en: { title: "Hello", body: "World" } });
    const translation = direct();
    await run(translation.sweep(first));

    await run(
      ops.update({
        id: "n-1",
        patch: {},
        locales: { en: { title: "Hi" } },
        actorId: Option.none(),
      }),
    );
    const pending = await run(translation.pending(first));
    expect(Arr.map(pending.pairs, ({ locale, reason }) => ({ locale, reason }))).toEqual([
      { locale: "fr", reason: "stale" },
      { locale: "de", reason: "stale" },
    ]);

    await run(translation.sweep(first));
    const after = await head("n-1");
    expect(after.locales?.["de"]?.["title"]).toBe("de:Hi");
    expect(after.locales?.["de"]?.["derivedFromVersion"]).toBe("2");
    expect((await run(translation.pending(first))).pairs).toEqual([]);
  });

  it("isn't stale after an edit outside the source's translatable columns", async () => {
    const { create, direct, ops } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const translation = direct();
    await run(translation.sweep(first));
    await run(ops.update({ id: "n-1", patch: { slug: "renamed" }, actorId: Option.none() }));
    expect((await run(translation.pending(first))).pairs).toEqual([]);
  });

  it("reads an unreadable source version as stale", async () => {
    const { create, direct } = fixture();
    await create("n-1", {
      en: { title: "Hello" },
      fr: { title: "Bonjour", derivedFrom: "en", derivedFromVersion: "99", derivation: "machine" },
      de: { title: "Hallo" },
    });
    const pending = await run(direct().pending(first));
    expect(Arr.map(pending.pairs, ({ locale, reason }) => ({ locale, reason }))).toEqual([
      { locale: "fr", reason: "stale" },
    ]);
  });

  it("lists nothing for a tombstoned node, an original locale or a dropped source", async () => {
    const { create, direct, ops } = fixture();
    await create("gone", { en: { title: "Hello" } });
    await run(ops.delete("gone", Option.none()));
    await create("originals", {
      en: { title: "Hello" },
      fr: { title: "Salut" },
      de: { title: "Hallo" },
    });
    await create("orphan", {
      fr: { title: "Bonjour", derivedFrom: "en", derivedFromVersion: "0", derivation: "machine" },
    });
    expect((await run(direct().pending(first))).pairs).toEqual([]);
  });
});

describe("conflicts", () => {
  it("a concurrent edit is a CONFLICT entry, and nothing is written", async () => {
    const { create, direct, port } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const racing = direct(() =>
      Effect.fail(new StaleVersion({ type: "pages", id: "n-1", expected: 0n, current: 1n })),
    );
    const summary = await run(racing.sweep(first));
    expect(summary.landed).toEqual([]);
    expect(summary.conflicts).toEqual([{ id: "n-1", locales: ["fr", "de"], reason: "CONFLICT" }]);
    expect(port.rows()).toHaveLength(1);
  });

  it.each([
    {
      label: "a tagged refusal is its tag",
      error: { _tag: "WriteRejected" },
      reason: "WriteRejected",
    },
    { label: "an untagged one is REJECTED", error: "boom", reason: "REJECTED" },
  ])("$label", async ({ error, reason }) => {
    const { create, direct } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const summary = await run(direct(() => Effect.fail(error)).sweep(first));
    expect(summary.conflicts).toEqual([{ id: "n-1", locales: ["fr", "de"], reason }]);
  });

  it("a translator returning a column outside the family's is TRANSLATOR_COLUMNS", async () => {
    const { create, translation, ops, port } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const leaky: Translator<never, never> = {
      translate: ({ values }) => Effect.succeed({ ...values, derivation: "human" }),
    };
    const summary = await run(
      translation({ kind: "direct", update: ops.update, actorId: BOT }, leaky).sweep(first),
    );
    expect(summary.conflicts).toEqual([
      { id: "n-1", locales: ["fr", "de"], reason: "TRANSLATOR_COLUMNS" },
    ]);
    expect(port.rows()).toHaveLength(1);
  });
});

describe("the proposal sweep", () => {
  it("submits one proposal per node and skips a locale a pending bot proposal covers", async () => {
    const { create, translation, port } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const submitted: Array<unknown> = [];
    const summary = await run(
      translation({
        kind: "proposal",
        submit: (input) => Effect.sync(() => submitted.push(input)),
        hasPending: Option.some((_, locale) => Effect.succeed(locale === "fr")),
      }).sweep(first),
    );
    expect(Arr.map(summary.landed, ({ locale }) => locale)).toEqual(["de"]);
    expect(Arr.map(summary.skipped, ({ locale }) => locale)).toEqual(["fr"]);
    expect(submitted).toEqual([
      {
        targetId: "n-1",
        patch: {},
        locales: {
          de: {
            title: "de:Hello",
            derivedFrom: "en",
            derivedFromVersion: "0",
            derivation: "machine",
          },
        },
        rationale: Option.some("machine translation"),
      },
    ]);
    expect(port.rows()).toHaveLength(1);
  });

  it("proposes every pending locale without a hasPending check, and skips a node with none due", async () => {
    const { create, translation } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const proposals = translation({ kind: "proposal", submit: () => Effect.void });
    const summary = await run(proposals.sweep(first));
    expect(Arr.map(summary.landed, ({ locale }) => locale)).toEqual(["fr", "de"]);
    const skipping = translation({
      kind: "proposal",
      submit: () => Effect.void,
      hasPending: Option.some(() => Effect.succeed(true)),
    });
    const all = await run(skipping.sweep(first));
    expect(all.landed).toEqual([]);
    expect(Arr.map(all.skipped, ({ locale }) => locale)).toEqual(["fr", "de"]);
  });
});

describe("paging", () => {
  it("pages the candidates by id, with the cursor after the last node read", async () => {
    const { create, direct } = fixture();
    await create("a", { en: { title: "A" } });
    await create("b", { en: { title: "B" } });
    await create("c", { en: { title: "C" } });
    const translation = direct();
    const one = await run(translation.pending({ after: Option.none(), limit: 2 }));
    expect(Arr.dedupe(Arr.map(one.pairs, ({ id }) => id))).toEqual(["a", "b"]);
    expect(one.next).toEqual(Option.some("b"));
    const two = await run(translation.pending({ after: one.next, limit: 2 }));
    expect(Arr.dedupe(Arr.map(two.pairs, ({ id }) => id))).toEqual(["c"]);
    expect(two.next).toEqual(Option.none());
  });

  it.each([0, -3, Number.NaN])("clamps a limit of %s to one node", async (limit) => {
    const { create, direct } = fixture();
    await create("a", { en: { title: "A" } });
    await create("b", { en: { title: "B" } });
    const page = await run(direct().pending({ after: Option.none(), limit }));
    expect(Arr.dedupe(Arr.map(page.pairs, ({ id }) => id))).toEqual(["a"]);
    expect(page.next).toEqual(Option.some("a"));
  });
});

describe("human edits (humanLineageHook)", () => {
  it("stamps a person's edit of a machine translation human, which still goes stale", async () => {
    const { create, direct, ops, head } = fixture();
    await create("n-1", { en: { title: "Hello" } });
    const translation = direct();
    await run(translation.sweep(first));
    await run(
      ops.update({
        id: "n-1",
        patch: {},
        locales: { fr: { title: "Salut" } },
        actorId: Option.none(),
      }),
    );
    const after = await head("n-1");
    expect(after.locales?.["fr"]).toEqual({
      title: "Salut",
      derivedFrom: "en",
      derivedFromVersion: "0",
      derivation: "human",
    });
    await run(
      ops.update({
        id: "n-1",
        patch: {},
        locales: { en: { title: "Hi" } },
        actorId: Option.none(),
      }),
    );
    const pending = await run(translation.pending(first));
    expect(Arr.map(pending.pairs, ({ locale }) => locale)).toEqual(["fr", "de"]);
  });

  const prior = Option.some({
    version: 1n,
    action: "update" as const,
    timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
    state: {},
    locales: {
      fr: { title: "Bonjour", derivedFrom: "en", derivedFromVersion: "0", derivation: "machine" },
      en: { title: "Hello" },
    },
  });

  it.each([
    {
      label: "an edit setting lineage is left as given",
      patch: { fr: { title: "X", derivation: "machine" } },
      same: true,
    },
    { label: "a non-translatable edit is left as given", patch: { fr: { note: "x" } }, same: true },
    {
      label: "an original locale's edit is left as given",
      patch: { en: { title: "Hi" } },
      same: true,
    },
    { label: "a dropped locale passes through", patch: { fr: null }, same: true },
    { label: "a carried locale passes through", patch: { fr: undefined }, same: true },
    { label: "a machine locale's edit is stamped", patch: { fr: { title: "Salut" } }, same: false },
  ])("$label", ({ patch, same }) => {
    const stamped = stampHumanLineage(declaration, { prior, locales: patch });
    expect(stamped).toEqual(same ? patch : { fr: { title: "Salut", derivation: "human" } });
  });

  it("leaves an already-human locale and a create's patch unchanged", () => {
    const human = Option.map(prior, (snapshot) => ({
      ...snapshot,
      locales: { fr: { ...snapshot.locales.fr, derivation: "human" } },
    }));
    expect(
      stampHumanLineage(declaration, { prior: human, locales: { fr: { title: "Y" } } }),
    ).toEqual({
      fr: { title: "Y" },
    });
    expect(stampHumanLineage(declaration, { prior: Option.none(), locales: undefined })).toEqual(
      {},
    );
  });

  it("is a subtype before hook that passes the shared patch through", async () => {
    const hook = humanLineageHook(declaration);
    const event = {
      action: "update" as const,
      id: "n-1",
      prior,
      patch: { slug: "s" },
      locales: { fr: { title: "Salut" } },
      actorId: Option.none(),
      type: "pages",
      viewer: Option.none(),
    };
    expect(hook.name).toBe("translation-lineage");
    expect(await run(hook.run(event))).toEqual({ slug: "s" });
    const locales = hook.locales ?? (() => Effect.succeed({}));
    expect(await run(locales(event))).toEqual({
      fr: { title: "Salut", derivation: "human" },
    });
  });
});
