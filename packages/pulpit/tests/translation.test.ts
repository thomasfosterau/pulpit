/**
 * Translation lineage, staleness and the sweep, over the
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

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
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
} from "../src/Translation.ts";
import {
  defineVersionChain,
  StaleVersion,
  type ChainState,
  type UpdateInput,
} from "../src/VersionChain.ts";
import { showValue } from "./fixtures.ts";

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
    Effect.succeed(R.map(values, (value): ChainState[string] => `${to}:${showValue(value)}`)),
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
    Effect.tap(
      ops.create({ id: Option.some(id), state: { slug: id }, locales, actorId: Option.none() }),
      () => Effect.sync(() => ids.push(id)),
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
    Effect.flatMap(port.head(id), (entry) =>
      port.getVersion(
        id,
        Option.match(entry, { onNone: () => -1n, onSome: ({ version }) => version }),
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
  it.effect(
    "lists the missing targets, lands them in one machine write, and then lists nothing",
    () =>
      Effect.gen(function* () {
        const { create, direct, head, port } = fixture();
        yield* create("n-1", { en: { title: "Hello", body: "World" } });
        const translation = direct();

        const pending = yield* translation.pending(first);
        expect(
          Arr.map(pending.pairs, ({ locale, reason, source }) => ({ locale, reason, source })),
        ).toEqual([
          { locale: "fr", reason: "missing", source: "en" },
          { locale: "de", reason: "missing", source: "en" },
        ]);

        const summary = yield* translation.sweep(first);
        expect(Arr.map(summary.landed, ({ locale }) => locale)).toEqual(["fr", "de"]);
        expect(summary.conflicts).toEqual([]);
        const after = yield* head("n-1");
        expect(after.version).toBe(1n);
        expect(after.locales?.["fr"]).toEqual({
          title: "fr:Hello",
          body: "fr:World",
          derivedFrom: "en",
          derivedFromVersion: "0",
          derivation: "machine",
        });
        expect(Arr.map(port.rows(), (row) => row.actorId)).toEqual([Option.none(), BOT]);
        expect((yield* translation.pending(first)).pairs).toEqual([]);
      }),
  );

  it.effect(
    "goes stale when the source's translatable columns change, and clears on re-translation",
    () =>
      Effect.gen(function* () {
        const { create, direct, ops, head } = fixture();
        yield* create("n-1", { en: { title: "Hello", body: "World" } });
        const translation = direct();
        yield* translation.sweep(first);

        yield* ops.update({
          id: "n-1",
          patch: {},
          locales: { en: { title: "Hi" } },
          actorId: Option.none(),
        });
        const pending = yield* translation.pending(first);
        expect(Arr.map(pending.pairs, ({ locale, reason }) => ({ locale, reason }))).toEqual([
          { locale: "fr", reason: "stale" },
          { locale: "de", reason: "stale" },
        ]);

        yield* translation.sweep(first);
        const after = yield* head("n-1");
        expect(after.locales?.["de"]?.["title"]).toBe("de:Hi");
        expect(after.locales?.["de"]?.["derivedFromVersion"]).toBe("2");
        expect((yield* translation.pending(first)).pairs).toEqual([]);
      }),
  );

  it.effect("isn't stale after an edit outside the source's translatable columns", () =>
    Effect.gen(function* () {
      const { create, direct, ops } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const translation = direct();
      yield* translation.sweep(first);
      yield* ops.update({ id: "n-1", patch: { slug: "renamed" }, actorId: Option.none() });
      expect((yield* translation.pending(first)).pairs).toEqual([]);
    }),
  );

  it.effect("reads an unreadable source version as stale", () =>
    Effect.gen(function* () {
      const { create, direct } = fixture();
      yield* create("n-1", {
        en: { title: "Hello" },
        fr: {
          title: "Bonjour",
          derivedFrom: "en",
          derivedFromVersion: "99",
          derivation: "machine",
        },
        de: { title: "Hallo" },
      });
      const pending = yield* direct().pending(first);
      expect(Arr.map(pending.pairs, ({ locale, reason }) => ({ locale, reason }))).toEqual([
        { locale: "fr", reason: "stale" },
      ]);
    }),
  );

  it.effect("lists nothing for a tombstoned node, an original locale or a dropped source", () =>
    Effect.gen(function* () {
      const { create, direct, ops } = fixture();
      yield* create("gone", { en: { title: "Hello" } });
      yield* ops.delete("gone", Option.none());
      yield* create("originals", {
        en: { title: "Hello" },
        fr: { title: "Salut" },
        de: { title: "Hallo" },
      });
      yield* create("orphan", {
        fr: { title: "Bonjour", derivedFrom: "en", derivedFromVersion: "0", derivation: "machine" },
      });
      expect((yield* direct().pending(first)).pairs).toEqual([]);
    }),
  );
});

describe("conflicts", () => {
  it.effect("a concurrent edit is a CONFLICT entry, and nothing is written", () =>
    Effect.gen(function* () {
      const { create, direct, port } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const racing = direct(() =>
        Effect.fail(new StaleVersion({ type: "pages", id: "n-1", expected: 0n, current: 1n })),
      );
      const summary = yield* racing.sweep(first);
      expect(summary.landed).toEqual([]);
      expect(summary.conflicts).toEqual([{ id: "n-1", locales: ["fr", "de"], reason: "CONFLICT" }]);
      expect(port.rows()).toHaveLength(1);
    }),
  );

  it.effect.each([
    {
      label: "a tagged refusal is its tag",
      error: { _tag: "WriteRejected" },
      reason: "WriteRejected",
    },
    { label: "an untagged one is REJECTED", error: "boom", reason: "REJECTED" },
  ])("$label", ({ error, reason }) =>
    Effect.gen(function* () {
      const { create, direct } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const summary = yield* direct(() => Effect.fail(error)).sweep(first);
      expect(summary.conflicts).toEqual([{ id: "n-1", locales: ["fr", "de"], reason }]);
    }),
  );

  it.effect("a translator returning a column outside the family's is TRANSLATOR_COLUMNS", () =>
    Effect.gen(function* () {
      const { create, translation, ops, port } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const leaky: Translator<never, never> = {
        translate: ({ values }) => Effect.succeed({ ...values, derivation: "human" }),
      };
      const summary = yield* translation(
        { kind: "direct", update: ops.update, actorId: BOT },
        leaky,
      ).sweep(first);
      expect(summary.conflicts).toEqual([
        { id: "n-1", locales: ["fr", "de"], reason: "TRANSLATOR_COLUMNS" },
      ]);
      expect(port.rows()).toHaveLength(1);
    }),
  );
});

describe("the proposal sweep", () => {
  it.effect("submits one proposal per node and skips a locale a pending bot proposal covers", () =>
    Effect.gen(function* () {
      const { create, translation, port } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const submitted: Array<unknown> = [];
      const summary = yield* translation({
        kind: "proposal",
        submit: (input) => Effect.sync(() => submitted.push(input)),
        hasPending: (_, locale) => Effect.succeed(locale === "fr"),
      }).sweep(first);
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
    }),
  );

  it.effect(
    "proposes every pending locale without a hasPending check, and skips a node with none due",
    () =>
      Effect.gen(function* () {
        const { create, translation } = fixture();
        yield* create("n-1", { en: { title: "Hello" } });
        const proposals = translation({ kind: "proposal", submit: () => Effect.void });
        const summary = yield* proposals.sweep(first);
        expect(Arr.map(summary.landed, ({ locale }) => locale)).toEqual(["fr", "de"]);
        const skipping = translation({
          kind: "proposal",
          submit: () => Effect.void,
          hasPending: () => Effect.succeed(true),
        });
        const all = yield* skipping.sweep(first);
        expect(all.landed).toEqual([]);
        expect(Arr.map(all.skipped, ({ locale }) => locale)).toEqual(["fr", "de"]);
      }),
  );
});

describe("paging", () => {
  it.effect("pages the candidates by id, with the cursor after the last node read", () =>
    Effect.gen(function* () {
      const { create, direct } = fixture();
      yield* create("a", { en: { title: "A" } });
      yield* create("b", { en: { title: "B" } });
      yield* create("c", { en: { title: "C" } });
      const translation = direct();
      const one = yield* translation.pending({ after: Option.none(), limit: 2 });
      expect(Arr.dedupe(Arr.map(one.pairs, ({ id }) => id))).toEqual(["a", "b"]);
      expect(one.next).toEqual(Option.some("b"));
      const two = yield* translation.pending({ after: one.next, limit: 2 });
      expect(Arr.dedupe(Arr.map(two.pairs, ({ id }) => id))).toEqual(["c"]);
      expect(two.next).toEqual(Option.none());
    }),
  );

  it.effect.each([0, -3, Number.NaN])("clamps a limit of %s to one node", (limit) =>
    Effect.gen(function* () {
      const { create, direct } = fixture();
      yield* create("a", { en: { title: "A" } });
      yield* create("b", { en: { title: "B" } });
      const page = yield* direct().pending({ after: Option.none(), limit });
      expect(Arr.dedupe(Arr.map(page.pairs, ({ id }) => id))).toEqual(["a"]);
      expect(page.next).toEqual(Option.some("a"));
    }),
  );
});

describe("human edits (humanLineageHook)", () => {
  it.effect("stamps a person's edit of a machine translation human, which still goes stale", () =>
    Effect.gen(function* () {
      const { create, direct, ops, head } = fixture();
      yield* create("n-1", { en: { title: "Hello" } });
      const translation = direct();
      yield* translation.sweep(first);
      yield* ops.update({
        id: "n-1",
        patch: {},
        locales: { fr: { title: "Salut" } },
        actorId: Option.none(),
      });
      const after = yield* head("n-1");
      expect(after.locales?.["fr"]).toEqual({
        title: "Salut",
        derivedFrom: "en",
        derivedFromVersion: "0",
        derivation: "human",
      });
      yield* ops.update({
        id: "n-1",
        patch: {},
        locales: { en: { title: "Hi" } },
        actorId: Option.none(),
      });
      const pending = yield* translation.pending(first);
      expect(Arr.map(pending.pairs, ({ locale }) => locale)).toEqual(["fr", "de"]);
    }),
  );

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
    expect(stampHumanLineage(declaration, { prior: Option.none() })).toEqual({});
  });

  it.effect("is a subtype before hook that passes the shared patch through", () =>
    Effect.gen(function* () {
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
      expect(yield* hook.run(event)).toEqual({ slug: "s" });
      const locales = hook.locales ?? (() => Effect.succeed({}));
      expect(yield* locales(event)).toEqual({
        fr: { title: "Salut", derivation: "human" },
      });
    }),
  );
});
