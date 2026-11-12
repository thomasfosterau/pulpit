/**
 * Content localisation (pulpit#56, model (b)): the locale is a level in the
 * version chain. One node per item; its locales share its history, draft,
 * visibility and publication; the shared (untranslated) columns live once in
 * the chain state and the translated ones per locale.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Order from "effect/Order";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { always, evaluate, locale, LOCALE_COLUMN, MAX_SET_VALUES, never } from "../src/filter.ts";
import { renameColumns } from "../src/internal/filter-columns.ts";
import {
  defineLocaleLevel,
  defineSubtype,
  ownedAccess,
  SubtypeDeclarationError,
  WriteRejected,
  type LeafRow,
  type LeafStore,
  type LocalisedResource,
  type LifecycleHooks,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  type InMemoryFollowing,
  type InMemoryLeafStore,
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryPublication,
} from "../src/testing.ts";
import {
  applyLocalePatch,
  defineVersionChain,
  diffLocales,
  localesOf,
  type ColumnValue,
} from "../src/version-chain.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember, textOf } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();
const follows = makeInMemoryFollowers([]);
const context = { now: NOW, contains: (_: HashSet.HashSet<string>, __: ColumnValue) => false };

// ── The pure locale level ─────────────────────────────────────────────

describe("applyLocalePatch", () => {
  it("is tri-state per locale: a patch updates, null drops, absent carries forward", () => {
    const before = { en: { title: "Hello", body: "b" }, fr: { title: "Bonjour" } };
    expect(
      applyLocalePatch(before, {
        en: { title: "Hi", body: undefined },
        fr: null,
        de: { title: "Hallo" },
      }),
    ).toEqual({ en: { title: "Hi", body: "b" }, de: { title: "Hallo" } });
    expect(applyLocalePatch(before, { fr: undefined })).toEqual(before);
    expect(applyLocalePatch(before, {})).toEqual(before);
  });
});

describe("diffLocales", () => {
  it("reports each added, removed and changed locale, and omits an unchanged one", () => {
    expect(
      diffLocales(
        { en: { title: "Hello" }, fr: { title: "Bonjour" }, it: { title: "Ciao" } },
        { en: { title: "Hi" }, de: { title: "Hallo" }, it: { title: "Ciao" } },
      ),
    ).toEqual({
      en: {
        _tag: "changed",
        changes: { title: { _tag: "changed", before: "Hello", after: "Hi" } },
      },
      fr: { _tag: "removed", before: { title: "Bonjour" } },
      de: { _tag: "added", after: { title: "Hallo" } },
    });
    expect(diffLocales({}, {})).toEqual({});
  });
});

// ── The chain ─────────────────────────────────────────────────────────

describe("the version chain's locale level", () => {
  const setup = () => {
    const store = makeInMemoryVersionChain("pages");
    return { store, chain: defineVersionChain("pages", store) };
  };

  it("appends one version of the whole node per write, however few locales it touches", async () => {
    const { store, chain } = setup();
    const snapshots = await run(
      Effect.gen(function* () {
        const { id } = yield* chain.create({
          id: Option.none(),
          state: { colour: "red" },
          locales: { en: { title: "Hello" } },
          actorId: Option.none(),
        });
        yield* chain.update({
          id,
          patch: {},
          locales: { fr: { title: "Bonjour" } },
          actorId: Option.none(),
        });
        yield* chain.update({ id, patch: { colour: "blue" }, actorId: Option.none() });
        yield* chain.update({ id, patch: {}, locales: { en: null }, actorId: Option.none() });
        return yield* Effect.forEach([0n, 1n, 2n, 3n], (version) => chain.getVersion(id, version), {
          concurrency: 1,
        });
      }),
    );
    expect(store.rows()).toHaveLength(4);
    expect(snapshots.map((snapshot) => [snapshot.state, localesOf(snapshot)])).toEqual([
      [{ colour: "red" }, { en: { title: "Hello" } }],
      [{ colour: "red" }, { en: { title: "Hello" }, fr: { title: "Bonjour" } }],
      [{ colour: "blue" }, { en: { title: "Hello" }, fr: { title: "Bonjour" } }],
      [{ colour: "blue" }, { fr: { title: "Bonjour" } }],
    ]);
  });

  it("carries the locales through a tombstone, and restoreVersion restores every locale together", async () => {
    const { chain } = setup();
    const [tombstone, restored] = await run(
      Effect.gen(function* () {
        const { id } = yield* chain.create({
          id: Option.none(),
          state: { colour: "red" },
          locales: { en: { title: "Hello" }, fr: { title: "Bonjour" } },
          actorId: Option.none(),
        });
        yield* chain.update({
          id,
          patch: { colour: "blue" },
          locales: { en: { title: "Hi" }, fr: null, de: { title: "Hallo" } },
          actorId: Option.none(),
        });
        const deleted = yield* chain.delete(id, Option.none());
        const back = yield* chain.restoreVersion(id, 0n, Option.none());
        return [
          yield* chain.getVersion(id, deleted.version),
          yield* chain.getVersion(id, back.version),
        ] as const;
      }),
    );
    expect(localesOf(tombstone)).toEqual({ en: { title: "Hi" }, de: { title: "Hallo" } });
    expect(restored.state).toEqual({ colour: "red" });
    expect(localesOf(restored)).toEqual({ en: { title: "Hello" }, fr: { title: "Bonjour" } });
  });

  it("compare reports the per-locale changes beside the shared ones", async () => {
    const { chain } = setup();
    const comparison = await run(
      Effect.gen(function* () {
        const { id } = yield* chain.create({
          id: Option.none(),
          state: { colour: "red" },
          locales: { en: { title: "Hello" } },
          actorId: Option.none(),
        });
        yield* chain.update({
          id,
          patch: {},
          locales: { en: { title: "Hi" } },
          actorId: Option.none(),
        });
        return yield* chain.compare(id, 0n, 1n);
      }),
    );
    expect(comparison.changes).toEqual({});
    expect(comparison.locales).toEqual({
      en: {
        _tag: "changed",
        changes: { title: { _tag: "changed", before: "Hello", after: "Hi" } },
      },
    });
  });

  it("writes no locale level for a leaf that carries none", async () => {
    const { store, chain } = setup();
    await run(
      chain.create({ id: Option.none(), state: { colour: "red" }, actorId: Option.none() }),
    );
    expect(store.rows()[0]).not.toHaveProperty("locales");
  });
});

// ── The filter arm ────────────────────────────────────────────────────

describe("the locale arm", () => {
  it("matches a row whose locale is one of the set; a NULL locale and an absent one match none", () => {
    const filter = locale(["fr", "en"]);
    expect(evaluate(filter, { id: "a", [LOCALE_COLUMN]: "en" }, context)).toBe(true);
    expect(evaluate(filter, { id: "a", [LOCALE_COLUMN]: "de" }, context)).toBe(false);
    expect(evaluate(filter, { id: "a", [LOCALE_COLUMN]: null }, context)).toBe(false);
    expect(evaluate(filter, { id: "a" }, context)).toBe(false);
  });

  it("folds no locale, and more than MAX_SET_VALUES, to never", () => {
    expect(locale([])).toEqual(never);
    expect(locale(Array.from({ length: MAX_SET_VALUES + 1 }, (_, i) => `l${i}`))).toEqual(never);
  });

  it("is renamed with the rest of a filter's columns", () => {
    expect(renameColumns(locale(["fr"]), (column) => `end.${column}`)).toEqual({
      kind: "locale",
      column: `end.${LOCALE_COLUMN}`,
      locales: ["fr"],
    });
  });
});

// ── The subtype ───────────────────────────────────────────────────────

interface Page {
  readonly id: string;
  readonly locale: ColumnValue;
  readonly title: ColumnValue;
  readonly colour: ColumnValue;
}

const toPage = (row: LeafRow): Page => ({
  id: row.id,
  locale: row[LOCALE_COLUMN] ?? null,
  title: row["title"] ?? null,
  colour: row["colour"] ?? null,
});

const level = defineLocaleLevel({ columns: ["title"] });

const pages = (
  options: {
    readonly gated?: boolean;
    readonly hooks?: LifecycleHooks<Page, never, never>;
    readonly leaves?: (
      store: InMemoryLeafStore,
    ) => LeafStore<LeafRow, InMemoryFollowing, never, never>;
  } = {},
) => {
  const chain = makeInMemoryVersionChain("pages");
  const store = makeInMemoryLeafStore(chain, {
    columns: ["title", "colour", "visibility", "draft"],
    localised: true,
  });
  const heads = options.leaves === undefined ? store : options.leaves(store);
  const publication = makeInMemoryPublication({ chain, leaves: store, now: NOW });
  let viewer: Viewer = as(member);
  const base = {
    type: "pages",
    access: ownedAccess({ draft: options.gated === true }),
    chain,
    leaves: options.gated === true ? publication.leaves : heads,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: follows,
    toResource: toPage,
    locales: level,
  };
  const hooked =
    options.hooks === undefined ? base : { ...base, hooks: Effect.succeed(options.hooks) };
  const ops = defineSubtype(
    options.gated === true
      ? { ...hooked, publication: { live: publication.live, facts: publication.facts } }
      : hooked,
  );
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  return { chain, ops, actAs };
};

const seed = (ops: ReturnType<typeof pages>["ops"], visibility = "public") =>
  ops.create({
    id: Option.none(),
    state: { colour: "red", visibility, draft: false },
    locales: { en: { title: "Hello" }, fr: { title: "Bonjour" } },
  });

describe("getLocalised", () => {
  it("returns the first locale in the caller's order that the node carries", async () => {
    const { ops, actAs } = pages();
    const [first, fallback, none] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops);
        return [
          yield* actAs(anonymous, ops.getLocalised(id, ["fr", "en"])),
          yield* actAs(anonymous, ops.getLocalised(id, ["de", "en", "fr"])),
          yield* Effect.flip(actAs(anonymous, ops.getLocalised(id, ["de", "it"]))),
        ] as const;
      }),
    );
    expect(first).toEqual({
      locale: "fr",
      resource: expect.objectContaining({ locale: "fr", title: "Bonjour", colour: "red" }),
    });
    expect(fallback.locale).toBe("en");
    expect(fallback.resource.title).toBe("Hello");
    expect(none._tag).toBe("NodeNotFound");
  });

  it("skips a node the viewer cannot read as missing, never reporting it", async () => {
    const { ops, actAs } = pages();
    const [hidden, missing, owner] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops, "private");
        return [
          yield* Effect.flip(actAs(as(otherMember), ops.getLocalised(id, ["en"]))),
          yield* Effect.flip(actAs(as(otherMember), ops.getLocalised("nope", ["en"]))),
          yield* actAs(as(member), ops.getLocalised(id, ["en"])),
        ] as const;
      }),
    );
    // Hidden and missing are the same answer (SEC-AUTH-ENUM-001).
    expect(hidden._tag).toBe("NodeNotFound");
    expect(missing._tag).toBe("NodeNotFound");
    expect(owner.locale).toBe("en");
  });

  it("serves a reader the live version's locales and the owner the head's", async () => {
    const { ops, actAs } = pages({ gated: true });
    const [reader, owner, rung] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops);
        yield* TestClock.setTime(NOW.getTime());
        const publication = yield* Effect.fromOption(ops.publication);
        yield* publication.publish(id);
        yield* ops.update({ id, patch: {}, locales: { fr: { title: "Salut" } } });
        return [
          yield* actAs(anonymous, ops.getLocalised(id, ["fr"])),
          yield* actAs(as(member), ops.getLocalised(id, ["fr"])),
          yield* actAs(as(moderator), ops.getLocalised(id, ["fr"])),
        ] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(reader.resource.title).toBe("Bonjour");
    expect(owner.resource.title).toBe("Salut");
    expect(rung.resource.title).toBe("Salut");
  });
});

describe("a localised leaf's list", () => {
  it("reads one row per locale, the shared columns the same on each, narrowed by the locale arm", async () => {
    const { ops } = pages();
    const [all, french] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops);
        yield* ops.update({ id, patch: { colour: "blue" } });
        const request = { limit: 10, offset: 0, includeDeleted: false };
        return [
          yield* ops.list({ ...request, where: { kind: "always" } }),
          yield* ops.list({ ...request, where: locale(["fr"]) }),
        ] as const;
      }),
    );
    expect(all.total).toBe(2);
    expect(all.rows.map((row) => [row.locale, row.title, row.colour])).toEqual(
      expect.arrayContaining([
        ["en", "Hello", "blue"],
        ["fr", "Bonjour", "blue"],
      ]),
    );
    expect(french.rows.map((row) => row.title)).toEqual(["Bonjour"]);
  });
});

describe("a localised leaf's fallback list (pulpit#272)", () => {
  const request = { limit: 10, offset: 0, includeDeleted: false, where: always };
  /** Three public nodes: en + fr, fr only, de only. */
  const seeded = (ops: ReturnType<typeof pages>["ops"]) =>
    Effect.gen(function* () {
      const both = yield* seed(ops);
      const french = yield* ops.create({
        id: Option.none(),
        state: { colour: "blue", visibility: "public", draft: false },
        locales: { fr: { title: "Salut" } },
      });
      const german = yield* ops.create({
        id: Option.none(),
        state: { colour: "green", visibility: "public", draft: false },
        locales: { de: { title: "Hallo" } },
      });
      return { both: both.id, french: french.id, german: german.id };
    });
  const served = (page: { readonly rows: ReadonlyArray<LocalisedResource<Page>> }) =>
    Arr.map(page.rows, (row) => [row.resource.id, row.locale, row.resource.title] as const);

  /** Which seeded node a case expects, and in which locale. */
  type Expected = ReadonlyArray<readonly ["both" | "french", string]>;
  it.each<{ readonly locales: ReadonlyArray<string>; readonly expected: Expected }>([
    {
      locales: ["fr", "en"],
      expected: [
        ["both", "fr"],
        ["french", "fr"],
      ],
    },
    {
      locales: ["en", "fr"],
      expected: [
        ["both", "en"],
        ["french", "fr"],
      ],
    },
    { locales: ["en"], expected: [["both", "en"]] },
    { locales: ["it"], expected: [] },
    { locales: [], expected: [] },
  ])("serves each node once, in its first of $locales", async ({ locales, expected }) => {
    const { ops, actAs } = pages();
    const [ids, page] = await run(
      Effect.gen(function* () {
        const ids = yield* seeded(ops);
        return [ids, yield* actAs(anonymous, ops.listLocalised({ ...request, locales }))] as const;
      }),
    );
    const want = Arr.sort(
      Arr.map(expected, ([node, tag]) => [ids[node], tag] as const),
      Order.mapInput(Order.String, ([id]: readonly [string, string]) => id),
    );
    expect(Arr.map(page.rows, (row) => [row.resource.id, row.locale] as const)).toEqual(want);
    // The total counts nodes, never locale rows.
    expect(page.total).toBe(want.length);
    expect(Arr.every(page.rows, (row) => row.resource.locale === row.locale)).toBe(true);
  });

  it("pages over nodes, stably, with the same total on every page", async () => {
    const { ops, actAs } = pages();
    const pagesRead = await run(
      Effect.gen(function* () {
        yield* seeded(ops);
        const locales = ["de", "fr", "en"];
        return yield* Effect.forEach(
          [0, 1, 2],
          (offset) =>
            actAs(anonymous, ops.listLocalised({ ...request, limit: 1, offset, locales })),
          { concurrency: 1 },
        );
      }),
    );
    expect(Arr.map(pagesRead, (page) => page.total)).toEqual([3, 3, 3]);
    const ids = Arr.flatMap(pagesRead, (page) => Arr.map(page.rows, (row) => row.resource.id));
    expect(Arr.dedupe(ids)).toHaveLength(3);
    expect(ids).toHaveLength(3);
  });

  it("orders by the request's order, after the locale is chosen", async () => {
    const { ops, actAs } = pages();
    const page = await run(
      Effect.gen(function* () {
        yield* seeded(ops);
        return yield* actAs(
          anonymous,
          ops.listLocalised({
            ...request,
            orderBy: [{ column: "colour", direction: "desc" }],
            locales: ["en", "fr", "de"],
          }),
        );
      }),
    );
    expect(Arr.map(page.rows, (row) => row.resource.colour)).toEqual(["red", "green", "blue"]);
  });

  it("omits a row the viewer cannot read in every locale (SEC-AUTH-ENUM-001)", async () => {
    const { ops, actAs } = pages();
    const [stranger, owner] = await run(
      Effect.gen(function* () {
        yield* seed(ops, "private");
        const locales = ["fr", "en"];
        return [
          yield* actAs(as(otherMember), ops.listLocalised({ ...request, locales })),
          yield* actAs(as(member), ops.listLocalised({ ...request, locales })),
        ] as const;
      }),
    );
    expect(stranger).toEqual({ rows: [], total: 0 });
    expect(served(owner)).toEqual([[expect.any(String), "fr", "Bonjour"]]);
  });

  it("serves a reader the live version's locale rows and the owner the head's", async () => {
    const { ops, actAs } = pages({ gated: true });
    const [reader, owner, rung, unpublished] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops);
        yield* TestClock.setTime(NOW.getTime());
        const publication = yield* Effect.fromOption(ops.publication);
        yield* publication.publish(id);
        // The head gains a German translation the live version doesn't carry.
        yield* ops.update({ id, patch: {}, locales: { de: { title: "Hallo" } } });
        yield* ops.create({
          id: Option.none(),
          state: { colour: "blue", visibility: "public", draft: false },
          locales: { de: { title: "Nie" } },
        });
        const locales = ["de", "fr"];
        return [
          yield* actAs(anonymous, ops.listLocalised({ ...request, locales })),
          yield* actAs(as(member), ops.listLocalised({ ...request, locales })),
          yield* actAs(as(moderator), ops.listLocalised({ ...request, locales })),
          yield* actAs(anonymous, ops.listLocalised({ ...request, locales: ["de"] })),
        ] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    // The live version has no German, so a reader falls back to French; the
    // never-published node isn't listed for them at all.
    expect(Arr.map(reader.rows, (row) => row.locale)).toEqual(["fr"]);
    expect(reader.total).toBe(1);
    expect(Arr.map(owner.rows, (row) => row.locale)).toEqual(["de", "de"]);
    expect(Arr.map(rung.rows, (row) => row.locale)).toEqual(["de", "de"]);
    expect(unpublished).toEqual({ rows: [], total: 0 });
  });

  it("refuses an order the leaf cannot sort by, as list does", async () => {
    const { ops } = pages();
    const outcome = await run(
      Effect.flip(
        ops.listLocalised({
          ...request,
          orderBy: [{ column: "nope", direction: "asc" }],
          locales: ["en"],
        }),
      ),
    );
    expect(outcome._tag).toBe("InvalidListOrder");
  });

  it("lists nothing on a leaf without a locale level", async () => {
    const chain = makeInMemoryVersionChain("notes");
    const ops = defineSubtype({
      type: "notes",
      access: ownedAccess(),
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns: ["title", "visibility"] }),
      viewer: Effect.succeed(as(member)),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row: LeafRow) => row,
    });
    const page = await run(
      Effect.andThen(
        ops.create({ id: Option.none(), state: { title: "x", visibility: "public" } }),
        ops.listLocalised({ ...request, locales: ["en"] }),
      ),
    );
    expect(page).toEqual({ rows: [], total: 0 });
  });
});

describe("a localised leaf's writes", () => {
  const rejected = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
    run(Effect.map(Effect.flip(effect), (error) => error._tag));

  it("keep shared columns shared and translated ones per locale", async () => {
    const { ops } = pages();
    const { id } = await run(seed(ops));
    expect(await rejected(ops.update({ id, patch: { title: "x" } }))).toBe("WriteRejected");
    expect(await rejected(ops.update({ id, patch: {}, locales: { fr: { colour: "x" } } }))).toBe(
      "WriteRejected",
    );
    expect(await rejected(ops.update({ id, patch: {}, locales: { "": { title: "x" } } }))).toBe(
      "WriteRejected",
    );
    // A carry-forward key is no write, and dropping a locale names no column.
    await run(ops.update({ id, patch: { title: undefined }, locales: { fr: null } }));
  });

  it("refuse a locale on a leaf with no locale level", async () => {
    const chain = makeInMemoryVersionChain("posts");
    const ops = defineSubtype({
      type: "posts",
      access: ownedAccess(),
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns: ["title", "visibility"] }),
      viewer: Effect.succeed(as(member)),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: toPage,
    });
    expect(
      await rejected(
        ops.create({ id: Option.none(), state: { visibility: "public" }, locales: { en: {} } }),
      ),
    ).toBe("WriteRejected");
    expect(await rejected(ops.getLocalised("any", ["en"]))).toBe("NodeNotFound");
  });
});

describe("defineLocaleLevel", () => {
  it("throws at declaration for no column, a repeat or a reserved name", () => {
    expect(() => defineLocaleLevel({ columns: [] })).toThrow(SubtypeDeclarationError);
    expect(() => defineLocaleLevel({ columns: ["title", "title"] })).toThrow(
      SubtypeDeclarationError,
    );
    expect(() => defineLocaleLevel({ columns: [LOCALE_COLUMN] })).toThrow(SubtypeDeclarationError);
  });

  it("is checked against the view by defineSubtype", () => {
    const chain = makeInMemoryVersionChain("pages");
    const declare = (localised: boolean, columns: ReadonlyArray<string>) => () =>
      defineSubtype({
        type: "pages",
        access: ownedAccess(),
        chain,
        leaves: makeInMemoryLeafStore(chain, { columns: ["title", "visibility"], localised }),
        viewer: Effect.succeed(anonymous),
        policy: gardeneriaPolicy,
        followers: follows,
        toResource: toPage,
        locales: defineLocaleLevel({ columns }),
      });
    expect(declare(true, ["subtitle"])).toThrow(SubtypeDeclarationError);
    expect(declare(false, ["title"])).toThrow(SubtypeDeclarationError);
    expect(declare(true, ["title"])).not.toThrow();
  });
});

describe("a localised leaf's before hooks (pulpit#56)", () => {
  const shout: LifecycleHooks<Page, never, never>["before"][number] = {
    name: "shout",
    run: (event) => Effect.succeed(event.patch),
    locales: (event) =>
      Effect.succeed(
        R.map(event.locales ?? {}, (change) =>
          change === null || change === undefined
            ? change
            : { ...change, title: textOf(change["title"] ?? null).toUpperCase() },
        ),
      ),
  };
  const blind: LifecycleHooks<Page, never, never>["before"][number] = {
    name: "blind",
    run: (event) => Effect.succeed(event.patch),
  };
  const hooks = (hook: typeof shout) => ({ before: [hook], after: [] });

  it("transform every locale through a hook's locale pass", async () => {
    const { ops, chain } = pages({ hooks: hooks(shout) });
    await run(seed(ops));
    expect(localesOf(chain.rows()[0] ?? { locales: {} })).toEqual({
      en: { title: "HELLO" },
      fr: { title: "BONJOUR" },
    });
  });

  it("fail closed: a hook with no locale pass refuses a locale write, and passes a shared one", async () => {
    const { ops } = pages({ hooks: hooks(blind) });
    const refused = await run(Effect.flip(seed(ops)));
    expect(refused).toBeInstanceOf(WriteRejected);
    const { id } = await run(
      ops.create({
        id: Option.none(),
        state: { colour: "red", visibility: "public", draft: false },
      }),
    );
    await run(ops.update({ id, patch: { colour: "blue" } }));
    expect(
      await run(
        Effect.map(
          Effect.flip(ops.update({ id, patch: {}, locales: { en: { title: "x" } } })),
          (error) => error._tag,
        ),
      ),
    ).toBe("WriteRejected");
  });
});

describe("a localised leaf's read gate (pulpit#56)", () => {
  it("refuses a translated column the read gate reads", () => {
    const chain = makeInMemoryVersionChain("pages");
    const declare = (columns: ReadonlyArray<string>, gated: boolean) => () => {
      const leaves = makeInMemoryLeafStore(chain, {
        columns: ["title", "visibility", "draft", "moderationState", "publishedAt"],
        localised: true,
      });
      const publication = makeInMemoryPublication({ chain, leaves });
      const leaf = {
        type: "pages",
        access: ownedAccess({ draft: true, moderation: true }),
        chain,
        leaves,
        viewer: Effect.succeed(anonymous),
        policy: gardeneriaPolicy,
        followers: follows,
        toResource: toPage,
        locales: defineLocaleLevel({ columns }),
      };
      return defineSubtype(
        gated
          ? { ...leaf, publication: { live: publication.live, facts: publication.facts } }
          : leaf,
      );
    };
    expect(declare(["title", "visibility"], false)).toThrow(SubtypeDeclarationError);
    expect(declare(["title", "ownerId"], false)).toThrow(SubtypeDeclarationError);
    expect(declare(["title", "draft"], false)).toThrow(SubtypeDeclarationError);
    expect(declare(["title", "moderationState"], false)).toThrow(SubtypeDeclarationError);
    expect(declare(["title", "publishedAt"], true)).toThrow(SubtypeDeclarationError);
    expect(declare(["title", "publishedAt"], false)).not.toThrow();
  });

  it("checks each locale row against the gate itself, skipping one a store joined onto other facts", async () => {
    // A store that breaks the contract: its French row claims to be private.
    const { ops, actAs } = pages({
      leaves: (store) => ({
        ...store,
        list: (query) =>
          Effect.map(store.list(query), (page) => ({
            ...page,
            rows: page.rows.map((row) =>
              row[LOCALE_COLUMN] === "fr" ? { ...row, visibility: "private" } : row,
            ),
          })),
      }),
    });
    const read = await run(
      Effect.gen(function* () {
        const { id } = yield* seed(ops);
        return yield* actAs(anonymous, ops.getLocalised(id, ["fr", "en"]));
      }),
    );
    expect(read.locale).toBe("en");
  });
});
