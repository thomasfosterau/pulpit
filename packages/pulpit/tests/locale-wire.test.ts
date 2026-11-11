/**
 * The locale on the JSON:API wire (pulpit#184, part 2): a localised leaf's
 * effect-jsonapi handlers read the request's `Accept-Language` (reads) and
 * `Content-Language` (writes), report the locale they served, and the
 * resource cache is keyed by locale under one per-id version.
 *
 * - `acceptLanguage`: RFC 9110 ranges in weight order, the unusable dropped.
 * - `localePreferences`: each tag then its prefixes, then the default.
 * - `get` through `getLocalised`: preference, prefix fallback, default
 *   fallback, a node in none of them `NodeNotFound` (`SEC-AUTH-ENUM-001`),
 *   and the locale served reported.
 * - Writes: the translated columns land in the `Content-Language` locale (the
 *   default without one), the rest stay shared.
 * - The cache: a localised leaf's write evicts every locale's entry; the
 *   fake keeps one compare-on-set version per id across its locales.
 *
 * @module tests/locale-wire
 */

import { FlatQuery, Group, Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { makeResourceCache } from "../src/cache.ts";
import { always } from "../src/filter.ts";
import {
  acceptLanguage,
  defineLocaleLevel,
  defineSubtype,
  localePreferences,
  ownedAccess,
  subtypeHandlers,
  subtypeResourceHandlers,
  type LeafRow,
  type LocaleWire,
  type Viewer,
} from "../src/subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryResourceCache,
  makeInMemoryVersionedKv,
} from "../src/testing.ts";
import { gardeneriaPolicy, member } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  run(Effect.map(Effect.flip(effect), (error) => error._tag));

describe("acceptLanguage", () => {
  it.each([
    { header: "fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5", tags: ["fr-CH", "fr", "en"] },
    { header: "en;q=0.2, de", tags: ["de", "en"] },
    { header: "en;q=0.5, fr;q=0.5", tags: ["en", "fr"] },
    { header: "en;q=0, de;Q=1.000", tags: ["de"] },
    { header: "en;q=2, de;q=0.1234, fr;q=abc, it;q=0.75", tags: ["it"] },
    { header: " , ;q=1, *", tags: [] },
    { header: "", tags: [] },
    { header: undefined, tags: [] },
  ])("$header → $tags", ({ header, tags }) => {
    expect(acceptLanguage(header)).toEqual(tags);
  });
});

describe("localePreferences", () => {
  it.each([
    { requested: ["fr-CH", "de"], tags: ["fr-CH", "fr", "de", "en"] },
    { requested: ["zh-Hant-TW"], tags: ["zh-Hant-TW", "zh-Hant", "zh", "en"] },
    { requested: ["en-GB", "en"], tags: ["en-GB", "en"] },
    { requested: ["", "de"], tags: ["de", "en"] },
    { requested: [], tags: ["en"] },
  ])("$requested → $tags", ({ requested, tags }) => {
    expect(localePreferences(requested, "en")).toEqual(tags);
  });
});

// ── The handlers ──────────────────────────────────────────────────────

const Page = Resource.make("pages", {
  attributes: { title: Schema.NullOr(Schema.String), colour: Schema.String },
});
const CreatePage = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  colour: Schema.String,
});
const UpdatePage = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  colour: Schema.optionalKey(Schema.String),
});
const { listQuery } = Group.flat({
  resource: Page,
  list: FlatQuery.listInput({ maxLimit: 100 }),
  create: CreatePage,
  update: UpdatePage,
  hiddenWrites: true,
});

interface PageResource {
  readonly type: "pages";
  readonly id: string;
  readonly attributes: { readonly title: unknown; readonly colour: unknown };
}

const level = defineLocaleLevel({ columns: ["title"] });

/** A request's headers, by lower-case name. */
type Headers = R.ReadonlyRecord<string, string>;
const accepting = (header: string): Headers => ({ "accept-language": header });

/** A localised `pages` leaf behind effect-jsonapi's handlers, with the request's headers in hand. */
const localisedPages = () => {
  const chain = makeInMemoryVersionChain("pages");
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["title", "colour", "visibility"],
    localised: true,
  });
  const viewer: Viewer = Option.some(member);
  const ops = defineSubtype({
    type: "pages",
    access: ownedAccess(),
    chain,
    leaves,
    viewer: Effect.succeed(viewer),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow): PageResource => ({
      type: "pages",
      id: row.id,
      attributes: { title: row["title"] ?? null, colour: row["colour"] ?? null },
    }),
    locales: level,
  });
  const cache = makeInMemoryResourceCache<PageResource>(() => true);
  const record = subtypeHandlers(ops, {
    inTransaction: Effect.succeed(false),
    transact: (effect) => effect,
    cache: Option.some(cache),
    localised: true,
  });
  /** The current request's headers, by lower-case name. */
  let headers: Headers = {};
  const served: Array<string> = [];
  const wire: LocaleWire<never> = {
    level,
    defaultLocale: "en",
    acceptLanguage: Effect.sync(() => R.get(headers, "accept-language")),
    contentLanguage: Effect.sync(() => R.get(headers, "content-language")),
    served: (tag) => Effect.sync(() => void served.push(tag)),
  };
  const handlers = subtypeResourceHandlers(
    record,
    {
      type: "pages",
      segment: "pages",
      listQuery,
      linkBase: Effect.succeed("https://example.test"),
      listRequest: (query) => ({
        limit: query.limit,
        offset: query.offset,
        includeDeleted: false,
        where: always,
      }),
      createInput: (payload: typeof CreatePage.Type) => ({
        id: Option.none(),
        state: { ...payload, visibility: "public" },
      }),
      updateInput: ({ id, ...patch }: typeof UpdatePage.Type) => ({ id, patch }),
    },
    wire,
  );
  /** Run `effect` as a request carrying these headers. */
  const request = <A, E>(carrying: Headers, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      headers = carrying;
      return effect;
    });
  const seed = ops.create({
    id: Option.none(),
    state: { colour: "red", visibility: "public" },
    locales: { en: { title: "Hello" }, fr: { title: "Bonjour" } },
  });
  return { ops, cache, handlers, request, served, seed };
};

describe("a localised leaf's get, through Accept-Language", () => {
  it.each([
    { accept: "fr", headers: accepting("fr"), locale: "fr", title: "Bonjour" },
    {
      accept: "fr-CH, en;q=0.5",
      headers: accepting("fr-CH, en;q=0.5"),
      locale: "fr",
      title: "Bonjour",
    },
    {
      accept: "de, en;q=0.1, fr;q=0.2",
      headers: accepting("de, en;q=0.1, fr;q=0.2"),
      locale: "fr",
      title: "Bonjour",
    },
    { accept: "de", headers: accepting("de"), locale: "en", title: "Hello" },
    { accept: "(none)", headers: {}, locale: "en", title: "Hello" },
  ])("Accept-Language $accept → $locale", async ({ headers, locale, title }) => {
    const { handlers, request, served, seed } = localisedPages();
    const document = await run(
      Effect.flatMap(seed, ({ id }) => request(headers, handlers.get({ params: { id } }))),
    );
    expect(document.data.attributes).toEqual({ title, colour: "red" });
    expect(served).toEqual([locale]);
  });

  it("answers a node in none of the preferences, the default included, as NodeNotFound", async () => {
    const { ops, handlers, request, served } = localisedPages();
    const outcome = await tagOf(
      Effect.flatMap(
        ops.create({
          id: Option.none(),
          state: { colour: "red", visibility: "public" },
          locales: { fr: { title: "Bonjour" } },
        }),
        ({ id }) => request(accepting("de"), handlers.get({ params: { id } })),
      ),
    );
    expect(outcome).toBe("NodeNotFound");
    expect(served).toEqual([]);
  });
});

describe("a localised leaf's writes, through Content-Language", () => {
  it("lands the translated columns in the Content-Language locale and answers in it", async () => {
    const { ops, handlers, request, served } = localisedPages();
    const [created, german, english] = await run(
      Effect.gen(function* () {
        const created = yield* request(
          { "content-language": "de", "accept-language": "fr" },
          handlers.create({ payload: { title: "Hallo", colour: "red" } }),
        );
        return [
          created,
          yield* ops.getLocalised(created.data.id, ["de"]),
          yield* Effect.flip(ops.getLocalised(created.data.id, ["en"])),
        ] as const;
      }),
    );
    expect(created.data).toHaveProperty("attributes", { title: "Hallo", colour: "red" });
    expect(served).toEqual(["de"]);
    expect(german.resource.attributes).toEqual({ title: "Hallo", colour: "red" });
    expect(english._tag).toBe("NodeNotFound");
  });

  it("patches one locale, carries the others forward, and keeps a shared-only patch shared", async () => {
    const { ops, handlers, request, seed } = localisedPages();
    const [french, english] = await run(
      Effect.gen(function* () {
        const { id } = yield* seed;
        yield* request(
          { "content-language": "fr" },
          handlers.update({ params: { id }, payload: { id, title: "Salut" } }),
        );
        yield* request({}, handlers.update({ params: { id }, payload: { id, colour: "blue" } }));
        return [yield* ops.getLocalised(id, ["fr"]), yield* ops.getLocalised(id, ["en"])] as const;
      }),
    );
    expect(french.resource.attributes).toEqual({ title: "Salut", colour: "blue" });
    expect(english.resource.attributes).toEqual({ title: "Hello", colour: "blue" });
  });

  it("lands a write without Content-Language in the default locale, first tag of a list otherwise", async () => {
    const { ops, handlers, request } = localisedPages();
    const [plain, listed] = await run(
      Effect.gen(function* () {
        const plain = yield* request(
          {},
          handlers.create({ payload: { title: "Hi", colour: "red" } }),
        );
        const listed = yield* request(
          { "content-language": " it , de" },
          handlers.create({ payload: { title: "Ciao", colour: "red" } }),
        );
        return [
          yield* ops.getLocalised(plain.data.id, ["en"]),
          yield* ops.getLocalised(listed.data.id, ["it"]),
        ] as const;
      }),
    );
    expect(plain.locale).toBe("en");
    expect(listed.locale).toBe("it");
  });
});

describe("a localised leaf's cache, keyed by locale", () => {
  it("evicts every locale's entry on a write, raising the id's version", async () => {
    const { cache, handlers, request, seed } = localisedPages();
    const [before, after] = await run(
      Effect.gen(function* () {
        const { id, version } = yield* seed;
        const page = (title: string): PageResource => ({
          type: "pages",
          id,
          attributes: { title, colour: "red" },
        });
        yield* cache.set(id, page("Hello"), version, "en");
        yield* cache.set(id, page("Bonjour"), version, "fr");
        const before = [cache.get(id, "en"), cache.get(id, "fr")];
        const written = yield* request(
          { "content-language": "fr" },
          handlers.update({ params: { id }, payload: { id, title: "Salut" } }),
        );
        return [before, { id, written }] as const;
      }),
    );
    expect(Arr.map(before, Option.isSome)).toEqual([true, true]);
    expect(cache.get(after.id, "en")).toEqual(Option.none());
    expect(cache.get(after.id, "fr")).toEqual(Option.none());
    expect(cache.versionOf(after.id)).toEqual(Option.some(1n));
  });

  /** The two caches the locale rules are checked on: the fake and `./cache`'s reference cache (pulpit#271). */
  const caches = [
    {
      label: "the in-memory fake",
      make: () => {
        const cache = makeInMemoryResourceCache<string>((resource) => resource !== "secret");
        return {
          set: cache.set,
          delete: cache.delete,
          // oxlint-disable-next-line effect/prefer-option-over-null -- the caches' optional `locale` parameter, `?: T | undefined` (AGENTS.md → Conventions)
          get: (id: string, locale?: string | undefined) => Effect.succeed(cache.get(id, locale)),
        };
      },
    },
    {
      label: "./cache's makeResourceCache",
      make: () =>
        makeResourceCache({
          kv: makeInMemoryVersionedKv(),
          schema: Schema.String,
          serveable: (resource) => resource !== "secret",
          prefix: "pages:v1:",
          ttlSeconds: 60,
        }),
    },
  ] as const;

  it.each(caches)(
    "keeps one compare-on-set version per id across its locales (pulpit#121) — $label",
    ({ make }) => {
      const cache = make();
      /** Each locale's read, `Option.none()` for the id's unlocalised entry. */
      const read = (locales: ReadonlyArray<Option.Option<string>>) =>
        Effect.runSync(
          Effect.forEach(locales, (locale) => cache.get("p", Option.getOrUndefined(locale)), {
            concurrency: 1,
          }),
        );
      const tags = (...locales: ReadonlyArray<string>) => Arr.map(locales, Option.some);
      Effect.runSync(
        Effect.gen(function* () {
          yield* cache.set("p", "hello", 1n, "en");
          yield* cache.set("p", "bonjour", 1n, "fr");
          yield* cache.set("p", "secret", 1n, "de");
        }),
      );
      expect(read(tags("en", "fr", "de"))).toEqual([
        Option.some("hello"),
        Option.some("bonjour"),
        Option.none(),
      ]);
      Effect.runSync(
        Effect.gen(function* () {
          yield* cache.set("p", "hi", 2n, "en");
          // A fill that read version 1 is behind the id's version now, in any locale.
          yield* cache.set("p", "bonjour", 1n, "fr");
        }),
      );
      expect(read([...tags("en", "fr"), Option.none()])).toEqual([
        Option.some("hi"),
        Option.none(),
        Option.none(),
      ]);
      Effect.runSync(cache.delete("p", 3n));
      expect(read(tags("en", "fr"))).toEqual([Option.none(), Option.none()]);
      // A write at the evicted id's next version caches again, in its own locale only.
      Effect.runSync(cache.set("p", "salut", 4n, "fr"));
      expect(read(tags("fr", "en"))).toEqual([Option.some("salut"), Option.none()]);
    },
  );
});
