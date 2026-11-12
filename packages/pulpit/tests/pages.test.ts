/**
 * `./pages` — the page recipe's one resolution read (pulpit#201): a path and
 * a locale resolve to the node in the best locale it carries, to a redirect
 * from an alias, or to `PathNotFound`, over a routable, localised,
 * publish-gated leaf on the in-memory stores. A hidden, unpublished,
 * scheduled or tombstoned page answers every reader exactly as a missing
 * path does (`SEC-AUTH-ENUM-001`).
 *
 * @module tests/pages
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { localeFallbacks, resolveLocalised, type LocalisedResolution } from "../src/pages.ts";
import { routable } from "../src/paths.ts";
import {
  defineLocaleLevel,
  defineSubtype,
  nobodyFollows,
  ownedAccess,
  type LeafRow,
  type PublishOptions,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryLeafStore,
  makeInMemoryPathStore,
  makeInMemoryPublication,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { LOCALE_COLUMN } from "../src/filter.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();

interface Page {
  readonly locale: unknown;
  readonly title: unknown;
}

/** A routable, localised, publish-gated owned page leaf; `member` writes. */
const site = () => {
  const chain = makeInMemoryVersionChain("pages");
  const store = makeInMemoryLeafStore(chain, {
    columns: ["slug", "title", "visibility", "draft"],
    localised: true,
  });
  const publication = makeInMemoryPublication({ chain, leaves: store, now: NOW });
  let viewer: Viewer = as(member);
  const pages = routable(
    defineSubtype({
      type: "pages",
      access: ownedAccess({ draft: true }),
      chain,
      leaves: publication.leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: nobodyFollows<InMemoryFollowing>(HashSet.empty()),
      toResource: (row: LeafRow): Page => ({
        locale: row[LOCALE_COLUMN],
        title: row["title"],
      }),
      locales: defineLocaleLevel({ columns: ["title"] }),
      publication: { live: publication.live, facts: publication.facts },
    }),
    { column: "slug", paths: makeInMemoryPathStore(), chain },
  );
  const resolve = resolveLocalised(pages, { defaultLocale: "en" });
  /** Run `effect` as `who`, then hand the leaf back to the member. */
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.ensuring(
      Effect.suspend(() => {
        viewer = who;
        return effect;
      }),
      Effect.sync(() => {
        viewer = as(member);
      }),
    );
  /** Each viewer's answer for `path` in `locale`: the resolution, or the error's tag. */
  const answer = (who: Viewer, path: string, locale: string) =>
    actAs(who, resolve(path, locale)).pipe(
      Effect.match({
        onFailure: (error): LocalisedResolution<Page> | string => error._tag,
        onSuccess: (resolved): LocalisedResolution<Page> | string => resolved,
      }),
    );
  const publish = (id: string, options?: PublishOptions) =>
    Effect.flatMap(Effect.fromOption(pages.publication), (live) => live.publish(id, options));
  return { pages, resolve, answer, publish };
};

const runAtNow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      return yield* effect;
    }).pipe(Effect.provide(TestClock.layer())),
  );

const DAY = 24 * 60 * 60 * 1000;

describe("localeFallbacks", () => {
  it.each([
    { requested: "pt-BR", fallback: "en", expected: ["pt-BR", "pt", "en"] },
    { requested: "zh-Hant-TW", fallback: "en", expected: ["zh-Hant-TW", "zh-Hant", "zh", "en"] },
    { requested: "en", fallback: "en", expected: ["en"] },
    { requested: "en-GB", fallback: "en", expected: ["en-GB", "en"] },
    { requested: "", fallback: "en", expected: ["en"] },
    { requested: "fr--", fallback: "", expected: ["fr"] },
  ])("$requested with default $fallback", ({ requested, fallback, expected }) => {
    expect(localeFallbacks(requested, fallback)).toEqual(expected);
  });
});

describe("resolveLocalised (pulpit#201)", () => {
  it("resolves a published page in the requested locale, its base language, or the default", async () => {
    const { pages, answer, publish } = site();
    const [id, exact, base, fallback, none] = await runAtNow(
      Effect.gen(function* () {
        const { id: pageId } = yield* pages.create({
          id: Option.none(),
          state: { slug: "about", visibility: "public", draft: false },
          locales: { en: { title: "About" }, pt: { title: "Sobre" } },
        });
        yield* publish(pageId);
        return [
          pageId,
          yield* answer(anonymous, "about", "pt"),
          yield* answer(anonymous, "about", "pt-BR"),
          yield* answer(anonymous, "about", "de"),
          yield* answer(anonymous, "nowhere", "en"),
        ] as const;
      }),
    );
    expect(exact).toEqual({
      kind: "node",
      id,
      locale: "pt",
      resource: { locale: "pt", title: "Sobre" },
    });
    expect(base).toEqual(exact);
    expect(fallback).toEqual({
      kind: "node",
      id,
      locale: "en",
      resource: { locale: "en", title: "About" },
    });
    expect(none).toBe("PathNotFound");
  });

  it("answers a page in none of the fallback locales as not-found", async () => {
    const { pages, answer, publish } = site();
    const outcome = await runAtNow(
      Effect.gen(function* () {
        const { id } = yield* pages.create({
          id: Option.none(),
          state: { slug: "bonjour", visibility: "public", draft: false },
          locales: { fr: { title: "Bonjour" } },
        });
        yield* publish(id);
        return yield* answer(anonymous, "bonjour", "de");
      }),
    );
    expect(outcome).toBe("PathNotFound");
  });

  it("redirects from an alias to the canonical path, without reading a locale", async () => {
    const { pages, answer, publish } = site();
    const [id, redirected] = await runAtNow(
      Effect.gen(function* () {
        const { id: pageId } = yield* pages.create({
          id: Option.none(),
          state: { slug: "about", visibility: "public", draft: false },
          locales: { en: { title: "About" } },
        });
        yield* pages.update({ id: pageId, patch: { slug: "about-us" } });
        yield* publish(pageId);
        return [pageId, yield* answer(anonymous, "about", "xx")] as const;
      }),
    );
    expect(redirected).toEqual({ kind: "redirect", id, path: "about-us" });
  });

  /** A page in each hidden state, by the path it claims. */
  const hidden = Effect.fn(function* (ops: ReturnType<typeof site>) {
    const { pages, publish } = ops;
    const create = (slug: string, visibility: string) =>
      pages.create({
        id: Option.none(),
        state: { slug, visibility, draft: false },
        locales: { en: { title: slug } },
      });
    const secret = yield* create("secret", "private");
    yield* publish(secret.id);
    yield* create("unpublished", "public");
    const scheduled = yield* create("scheduled", "public");
    yield* publish(scheduled.id, { at: DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() + DAY)) });
    const gone = yield* create("gone", "public");
    yield* publish(gone.id);
    yield* pages.delete(gone.id);
  });

  const hiddenPaths = ["secret", "unpublished", "scheduled", "gone", "never-claimed"] as const;

  it.each(
    Arr.map(
      [
        ["anonymous", anonymous],
        ["another member", as(otherMember)],
      ] as const,
      ([label, viewer]) => ({ label, viewer }),
    ),
  )(
    "hides a private, unpublished, scheduled or tombstoned page from $label as a missing path",
    async ({ viewer }) => {
      const ops = site();
      const outcomes = await runAtNow(
        Effect.gen(function* () {
          yield* hidden(ops);
          return yield* Effect.forEach(hiddenPaths, (path) => ops.answer(viewer, path, "en"), {
            concurrency: 1,
          });
        }),
      );
      expect(outcomes).toEqual(Arr.map(hiddenPaths, () => "PathNotFound"));
    },
  );

  it("serves the owner and the view-private rung the head of a page readers can't see", async () => {
    const ops = site();
    const [owner, rung, gone] = await runAtNow(
      Effect.gen(function* () {
        yield* hidden(ops);
        return [
          yield* Effect.forEach(
            ["secret", "unpublished", "scheduled"],
            (path) => ops.answer(as(member), path, "en"),
            { concurrency: 1 },
          ),
          yield* Effect.forEach(
            ["secret", "unpublished", "scheduled"],
            (path) => ops.answer(as(moderator), path, "en"),
            { concurrency: 1 },
          ),
          yield* ops.answer(as(member), "gone", "en"),
        ] as const;
      }),
    );
    expect(
      Arr.map([...owner, ...rung], (outcome) => (P.isString(outcome) ? outcome : outcome.kind)),
    ).toEqual(Arr.replicate("node", 6));
    // A tombstone frees its path: it is gone for its owner too.
    expect(gone).toBe("PathNotFound");
  });
});
