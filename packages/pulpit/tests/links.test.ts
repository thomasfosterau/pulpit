/**
 * Ordered link lists (pulpit#266): the one gated read over a collection of
 * entry nodes, each pointing at a path or a node, with a per-locale label.
 * An entry whose target the viewer can't follow (a private, unpublished,
 * scheduled or tombstoned page, an unclaimed path, an alias to a hidden
 * node) is omitted without a gap or a trace (`SEC-AUTH-ENUM-001`), and the
 * owner and the view-private rung see what others can't. A nested list
 * (pulpit#313) is read in place, and omitted when hidden, empty, cyclic or
 * past the depth cap.
 *
 * @module tests/links
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { defineCollection, MAX_COLLECTION_SIZE } from "../src/collections.ts";
import { LOCALE_COLUMN } from "../src/filter.ts";
import { DEFAULT_LINK_DEPTH, defineLinkList, type Link, type LinkTarget } from "../src/links.ts";
import { resolveLocalised } from "../src/pages.ts";
import { routable } from "../src/paths.ts";
import {
  defineLocaleLevel,
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type PublishOptions,
  type Viewer,
} from "../src/subtype.ts";
import {
  makeInMemoryCollectionStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryPathStore,
  makeInMemoryPublication,
  makeInMemoryVersionChain,
} from "../src/testing.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const anonymous: Viewer = Option.none();
const as = (account: typeof member): Viewer => Option.some(account);
const DAY = 24 * 60 * 60 * 1000;

interface Entry {
  readonly label: unknown;
  readonly path: unknown;
  readonly nodeId: unknown;
  readonly listId: unknown;
}

/** Pages (routable, localised, publish-gated), a menu leaf, entry leaf and their collection. */
const site = (declared: { readonly maxDepth?: number } = {}) => {
  let viewer: Viewer = as(member);
  const viewerOf = Effect.sync(() => viewer);

  const pageChain = makeInMemoryVersionChain("pages");
  const pageStore = makeInMemoryLeafStore(pageChain, {
    columns: ["slug", "title", "visibility", "draft"],
    localised: true,
  });
  const publication = makeInMemoryPublication({ chain: pageChain, leaves: pageStore, now: NOW });
  const pages = routable(
    defineSubtype({
      type: "pages",
      access: ownedAccess({ draft: true }),
      chain: pageChain,
      leaves: publication.leaves,
      viewer: viewerOf,
      policy: gardeneriaPolicy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => ({ locale: row[LOCALE_COLUMN], title: row["title"] }),
      locales: defineLocaleLevel({ columns: ["title"] }),
      publication: { live: publication.live, facts: publication.facts },
    }),
    { column: "slug", paths: makeInMemoryPathStore(), chain: pageChain },
  );

  const menuChain = makeInMemoryVersionChain("menus");
  const menus = defineSubtype({
    type: "menus",
    access: ownedAccess(),
    chain: menuChain,
    leaves: makeInMemoryLeafStore(menuChain, { columns: ["visibility"], now: NOW }),
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow) => ({ id: row.id }),
  });
  const itemChain = makeInMemoryVersionChain("menu-items");
  const items = defineSubtype({
    type: "menu-items",
    access: ownedAccess(),
    chain: itemChain,
    leaves: makeInMemoryLeafStore(itemChain, {
      columns: ["visibility", "path", "nodeId", "listId", "label"],
      localised: true,
      now: NOW,
    }),
    viewer: viewerOf,
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([]),
    toResource: (row: LeafRow): Entry => ({
      label: row["label"],
      path: row["path"],
      nodeId: row["nodeId"],
      listId: row["listId"],
    }),
    locales: defineLocaleLevel({ columns: ["label"] }),
  });
  const collection = defineCollection({
    type: "menu-items",
    parent: menus,
    members: items,
    store: makeInMemoryCollectionStore(),
  });
  const links = defineLinkList({
    type: "menu-links",
    defaultLocale: "en",
    ...declared,
    entries: collection,
    entryLeaf: items,
    target: (entry: Entry): Option.Option<LinkTarget> =>
      P.isString(entry.path)
        ? Option.some({ kind: "path", path: entry.path })
        : P.isString(entry.nodeId)
          ? Option.some({ kind: "node", id: entry.nodeId })
          : P.isString(entry.listId)
            ? Option.some({ kind: "list", id: entry.listId })
            : Option.none(),
    resolve: resolveLocalised(pages, { defaultLocale: "en" }),
    nodes: pages,
  });

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
  const publish = (id: string, options?: PublishOptions) =>
    Effect.flatMap(Effect.fromOption(pages.publication), (live) => live.publish(id, options));

  const page = (slug: string, visibility: string, titles: Record<string, string> = { en: slug }) =>
    pages.create({
      id: Option.none(),
      state: { slug, visibility, draft: false },
      locales: Arr.reduce(R.toEntries(titles), {}, (acc, [tag, title]) => ({
        ...acc,
        [tag]: { title },
      })),
    });
  const menu = (visibility = "public") =>
    Effect.map(menus.create({ id: Option.none(), state: { visibility } }), ({ id }) => id);
  /** An entry appended to `menuId`; `labels` per locale, `target` as columns. */
  const entry = (
    menuId: string,
    labels: Record<string, string>,
    target: { readonly path?: string; readonly nodeId?: string; readonly listId?: string },
  ) =>
    Effect.gen(function* () {
      const { id } = yield* items.create({
        id: Option.none(),
        state: { visibility: "public", ...target },
        locales: Arr.reduce(R.toEntries(labels), {}, (acc, [tag, label]) => ({
          ...acc,
          [tag]: { label },
        })),
      });
      yield* collection.append(menuId, id);
      return id;
    });
  /** The links `who` reads, as their labels in order (plus indices, when asked). */
  const read = (who: Viewer, menuId: string, locale = "en") =>
    actAs(who, links.list(menuId, locale));
  const labels = (who: Viewer, menuId: string, locale = "en") =>
    Effect.map(read(who, menuId, locale), (found) => Arr.map(found, (link) => link.entry.label));
  return { pages, collection, links, page, menu, entry, publish, read, labels };
};

const runAtNow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW.getTime());
      return yield* effect;
    }).pipe(Effect.provide(TestClock.layer())),
  );

/** A menu of one entry per page state, in a fixed order, with the visible ones interleaved. */
const seeded = Effect.fn(function* (ops: ReturnType<typeof site>) {
  const home = yield* ops.page("home", "public");
  yield* ops.publish(home.id);
  const secret = yield* ops.page("secret", "private");
  yield* ops.publish(secret.id);
  yield* ops.page("draft", "public");
  const scheduled = yield* ops.page("scheduled", "public");
  yield* ops.publish(scheduled.id, {
    at: DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() + DAY)),
  });
  const gone = yield* ops.page("gone", "public");
  yield* ops.publish(gone.id);
  yield* ops.pages.delete(gone.id);
  const contact = yield* ops.page("contact", "public");
  yield* ops.publish(contact.id);

  const menuId = yield* ops.menu();
  const ids = {
    home: yield* ops.entry(menuId, { en: "Home" }, { path: "home" }),
    secret: yield* ops.entry(menuId, { en: "Secret" }, { path: "secret" }),
    draft: yield* ops.entry(menuId, { en: "Draft" }, { path: "draft" }),
    scheduled: yield* ops.entry(menuId, { en: "Scheduled" }, { path: "scheduled" }),
    gone: yield* ops.entry(menuId, { en: "Gone" }, { path: "gone" }),
    unclaimed: yield* ops.entry(menuId, { en: "Nowhere" }, { path: "nowhere" }),
    contact: yield* ops.entry(menuId, { en: "Contact" }, { path: "contact" }),
  };
  return { menuId, ids, pageIds: { home, secret, contact } };
});

describe("defineLinkList (pulpit#266)", () => {
  it("omits entries to a private, unpublished, scheduled or tombstoned page, or an unclaimed path, in order and without a gap", async () => {
    const ops = site();
    const [anon, stranger, indices] = await runAtNow(
      Effect.gen(function* () {
        const { menuId } = yield* seeded(ops);
        return [
          yield* ops.labels(anonymous, menuId),
          yield* ops.labels(as(otherMember), menuId),
          Arr.map(yield* ops.read(anonymous, menuId), (link) => link.index),
        ] as const;
      }),
    );
    expect(anon).toEqual(["Home", "Contact"]);
    expect(stranger).toEqual(["Home", "Contact"]);
    expect(indices).toEqual([0, 1]);
  });

  it("shows the owner and the view-private rung the entries readers can't see, still in order", async () => {
    const ops = site();
    const [owner, rung] = await runAtNow(
      Effect.gen(function* () {
        const { menuId } = yield* seeded(ops);
        return [
          yield* ops.labels(as(member), menuId),
          yield* ops.labels(as(moderator), menuId),
        ] as const;
      }),
    );
    // The tombstoned page freed its path, so it is unclaimed for everyone.
    const expected = ["Home", "Secret", "Draft", "Scheduled", "Contact"];
    expect(owner).toEqual(expected);
    expect(rung).toEqual(expected);
  });

  it("keeps the order a move gives, among the visible entries", async () => {
    const ops = site();
    const read = await runAtNow(
      Effect.gen(function* () {
        const { menuId, ids } = yield* seeded(ops);
        yield* ops.collection.move(menuId, ids.contact, 0);
        yield* ops.collection.move(menuId, ids.secret, 99);
        return yield* ops.labels(anonymous, menuId);
      }),
    );
    expect(read).toEqual(["Contact", "Home"]);
  });

  it("reveals neither an omitted entry's id nor its target", async () => {
    const ops = site();
    const [found, ids, pageIds, json] = await runAtNow(
      Effect.gen(function* () {
        const seed = yield* seeded(ops);
        const links = yield* ops.read(anonymous, seed.menuId);
        return [links, seed.ids, seed.pageIds, Formatter.formatJson(links)] as const;
      }),
    );
    expect(Arr.map(found, (link) => link.entryId)).toEqual([ids.home, ids.contact]);
    expect(Arr.map(found, (link) => link.target.id)).toEqual([pageIds.home.id, pageIds.contact.id]);
    expect(json).not.toContain("secret");
  });

  it("falls back from the requested locale to its base language, then the default", async () => {
    const ops = site();
    const [exact, base, fallback, byTarget] = await runAtNow(
      Effect.gen(function* () {
        const about = yield* ops.page("about", "public", { en: "About", pt: "Sobre" });
        yield* ops.publish(about.id);
        const menuId = yield* ops.menu();
        yield* ops.entry(menuId, { en: "About us", pt: "Sobre nós" }, { path: "about" });
        yield* ops.entry(menuId, { en: "Only English" }, { path: "about" });
        yield* ops.entry(menuId, { fr: "Seulement" }, { path: "about" });
        return [
          yield* ops.read(anonymous, menuId, "pt"),
          yield* ops.read(anonymous, menuId, "pt-BR"),
          yield* ops.read(anonymous, menuId, "de"),
          yield* ops.labels(anonymous, menuId, "fr"),
        ] as const;
      }),
    );
    expect(Arr.map(exact, (link) => [link.locale, link.entry.label])).toEqual([
      ["pt", "Sobre nós"],
      ["en", "Only English"],
    ]);
    expect(Arr.map(base, (link) => link.locale)).toEqual(["pt", "en"]);
    // An entry with none of the fallback locales is omitted, without a gap.
    expect(Arr.map(fallback, (link) => [link.index, link.entry.label])).toEqual([
      [0, "About us"],
      [1, "Only English"],
    ]);

    // The page falls back to `en`, and each entry reads in the first locale it carries.
    expect(byTarget).toEqual(["About us", "Only English", "Seulement"]);
  });

  it("omits an entry whose page carries none of the fallback locales", async () => {
    const ops = site();
    const shown = await runAtNow(
      Effect.gen(function* () {
        const bonjour = yield* ops.page("bonjour", "public", { fr: "Bonjour" });
        yield* ops.publish(bonjour.id);
        const menuId = yield* ops.menu();
        yield* ops.entry(menuId, { en: "Bonjour" }, { path: "bonjour" });
        return yield* ops.labels(anonymous, menuId, "de");
      }),
    );
    expect(shown).toEqual([]);
  });

  it("follows an alias to the canonical path, and omits an alias to a hidden node", async () => {
    const ops = site();
    const [anon, owner] = await runAtNow(
      Effect.gen(function* () {
        const about = yield* ops.page("about", "public");
        yield* ops.publish(about.id);
        yield* ops.pages.update({ id: about.id, patch: { slug: "about-us" } });
        const secret = yield* ops.page("hush", "private");
        yield* ops.publish(secret.id);
        yield* ops.pages.update({ id: secret.id, patch: { slug: "hush-now" } });
        const menuId = yield* ops.menu();
        yield* ops.entry(menuId, { en: "Old about" }, { path: "about" });
        yield* ops.entry(menuId, { en: "Old hush" }, { path: "hush" });
        return [yield* ops.read(anonymous, menuId), yield* ops.read(as(member), menuId)] as const;
      }),
    );
    expect(
      Arr.map(anon, (link) => [link.entry.label, link.target.kind === "path" && link.target.path]),
    ).toEqual([["Old about", "about-us"]]);
    expect(Arr.map(owner, (link) => link.target.kind === "path" && link.target.path)).toEqual([
      "about-us",
      "hush-now",
    ]);
  });

  it("gates a node target by its leaf, and omits an entry with no target", async () => {
    const ops = site();
    const [anon, owner] = await runAtNow(
      Effect.gen(function* () {
        const open = yield* ops.page("open", "public");
        yield* ops.publish(open.id);
        const closed = yield* ops.page("closed", "private");
        yield* ops.publish(closed.id);
        const menuId = yield* ops.menu();
        yield* ops.entry(menuId, { en: "Open" }, { nodeId: open.id });
        yield* ops.entry(menuId, { en: "Closed" }, { nodeId: closed.id });
        yield* ops.entry(menuId, { en: "Missing" }, { nodeId: "no-such-node" });
        yield* ops.entry(menuId, { en: "Bare" }, {});
        return [yield* ops.read(anonymous, menuId), yield* ops.labels(as(member), menuId)] as const;
      }),
    );
    expect(Arr.map(anon, (link) => link.target.kind)).toEqual(["node"]);
    expect(Arr.map(anon, (link) => link.entry.label)).toEqual(["Open"]);
    expect(owner).toEqual(["Open", "Closed"]);
  });

  it("answers a menu the viewer can't read as not found, and an empty one as empty", async () => {
    const ops = site();
    const [hidden, empty] = await runAtNow(
      Effect.gen(function* () {
        const secret = yield* ops.menu("private");
        const bare = yield* ops.menu();
        const outcome = yield* Effect.match(ops.read(anonymous, secret), {
          onFailure: (error) => error._tag,
          onSuccess: () => "found",
        });
        return [outcome, yield* ops.read(anonymous, bare)] as const;
      }),
    );
    expect(hidden).toBe("NodeNotFound");
    expect(empty).toEqual([]);
  });
});

/** A read as nested labels: a nested list's label carries its own links'. */
type Outline = string | readonly [string, ReadonlyArray<Outline>];
const outlineOf = (links: ReadonlyArray<Link<Entry>>): ReadonlyArray<Outline> =>
  Arr.map(links, (link): Outline => {
    const label = String(link.entry.label);
    return link.target.kind === "list" ? [label, outlineOf(link.target.links)] : label;
  });

describe("defineLinkList — nested lists (pulpit#313)", () => {
  it("reads a nested list in place, in order, and omits a hidden or empty one without a gap", async () => {
    const ops = site();
    const [anon, owner, indices] = await runAtNow(
      Effect.gen(function* () {
        const home = yield* ops.page("home", "public");
        yield* ops.publish(home.id);
        const secret = yield* ops.page("secret", "private");
        yield* ops.publish(secret.id);

        const top = yield* ops.menu();
        const about = yield* ops.menu();
        const hidden = yield* ops.menu("private");
        const empty = yield* ops.menu();
        const bare = yield* ops.menu();
        yield* ops.entry(about, { en: "Secret" }, { path: "secret" });
        yield* ops.entry(about, { en: "Home again" }, { path: "home" });
        yield* ops.entry(hidden, { en: "Behind" }, { path: "home" });
        yield* ops.entry(empty, { en: "Only secret" }, { path: "secret" });

        yield* ops.entry(top, { en: "Hidden" }, { listId: hidden });
        yield* ops.entry(top, { en: "Home" }, { path: "home" });
        yield* ops.entry(top, { en: "Empty" }, { listId: empty });
        yield* ops.entry(top, { en: "About" }, { listId: about });
        yield* ops.entry(top, { en: "Bare" }, { listId: bare });
        yield* ops.entry(top, { en: "Missing" }, { listId: "no-such-menu" });
        const read = yield* ops.read(anonymous, top);
        return [
          outlineOf(read),
          outlineOf(yield* ops.read(as(member), top)),
          Arr.map(read, (link) =>
            link.target.kind === "list"
              ? [link.index, Arr.map(link.target.links, (nested) => nested.index)]
              : link.index,
          ),
        ] as const;
      }),
    );
    expect(anon).toEqual(["Home", ["About", ["Home again"]]]);
    expect(indices).toEqual([0, [1, [0]]]);
    // The owner reads the private menu and the private page; a list with no entries stays out.
    expect(owner).toEqual([
      ["Hidden", ["Behind"]],
      "Home",
      ["Empty", ["Only secret"]],
      ["About", ["Secret", "Home again"]],
    ]);
  });

  it("reveals neither a hidden nested list's id nor its entries", async () => {
    const ops = site();
    const [json, hiddenId] = await runAtNow(
      Effect.gen(function* () {
        const home = yield* ops.page("home", "public");
        yield* ops.publish(home.id);
        const top = yield* ops.menu();
        const hidden = yield* ops.menu("private");
        yield* ops.entry(hidden, { en: "Behind" }, { path: "home" });
        yield* ops.entry(top, { en: "Hidden" }, { listId: hidden });
        yield* ops.entry(top, { en: "Home" }, { path: "home" });
        return [Formatter.formatJson(yield* ops.read(anonymous, top)), hidden] as const;
      }),
    );
    expect(json).not.toContain(hiddenId);
    expect(json).not.toContain("Behind");
  });

  it("cuts a cycle: an entry to its own list or one above it is omitted", async () => {
    const ops = site({ maxDepth: 10 });
    const [fromA, fromB] = await runAtNow(
      Effect.gen(function* () {
        const home = yield* ops.page("home", "public");
        yield* ops.publish(home.id);
        const a = yield* ops.menu();
        const b = yield* ops.menu();
        yield* ops.entry(a, { en: "A home" }, { path: "home" });
        yield* ops.entry(a, { en: "To B" }, { listId: b });
        yield* ops.entry(a, { en: "To A" }, { listId: a });
        yield* ops.entry(b, { en: "B home" }, { path: "home" });
        yield* ops.entry(b, { en: "Back to A" }, { listId: a });
        return [yield* ops.labels(anonymous, a), outlineOf(yield* ops.read(anonymous, b))] as const;
      }),
    );
    expect(fromA).toEqual(["A home", "To B"]);
    expect(fromB).toEqual(["B home", ["Back to A", ["A home"]]]);
  });

  it("nests to DEFAULT_LINK_DEPTH levels, or the declared maxDepth, and omits what lies deeper", async () => {
    const chainOf = (ops: ReturnType<typeof site>) =>
      Effect.gen(function* () {
        const home = yield* ops.page("home", "public");
        yield* ops.publish(home.id);
        const lists = yield* Effect.forEach(Arr.range(1, 5), () => ops.menu(), {
          concurrency: 1,
        });
        yield* Effect.forEach(
          lists,
          (id, at) =>
            Effect.gen(function* () {
              yield* ops.entry(id, { en: `Level ${at + 1}` }, { path: "home" });
              const next = Arr.get(lists, at + 1);
              if (Option.isSome(next)) {
                yield* ops.entry(id, { en: `Into ${at + 2}` }, { listId: next.value });
              }
            }),
          { concurrency: 1 },
        );
        return outlineOf(yield* ops.read(anonymous, Arr.headNonEmpty(lists)));
      });
    const [byDefault, flat, deep] = await runAtNow(
      Effect.all(
        [chainOf(site()), chainOf(site({ maxDepth: 1 })), chainOf(site({ maxDepth: 5 }))],
        {
          concurrency: 1,
        },
      ),
    );
    expect(DEFAULT_LINK_DEPTH).toBe(3);
    expect(byDefault).toEqual(["Level 1", ["Into 2", ["Level 2", ["Into 3", ["Level 3"]]]]]);
    expect(flat).toEqual(["Level 1"]);
    expect(deep).toEqual([
      "Level 1",
      [
        "Into 2",
        ["Level 2", ["Into 3", ["Level 3", ["Into 4", ["Level 4", ["Into 5", ["Level 5"]]]]]]],
      ],
    ]);
  });

  it("reads at most MAX_COLLECTION_SIZE entries over every level, in reading order", async () => {
    const ops = site();
    const sizes = await runAtNow(
      Effect.gen(function* () {
        const home = yield* ops.page("home", "public");
        yield* ops.publish(home.id);
        const top = yield* ops.menu();
        const wide = yield* ops.menu();
        yield* Effect.forEach(
          Arr.range(1, 25),
          (n) => ops.entry(wide, { en: `Wide ${n}` }, { nodeId: home.id }),
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          Arr.range(1, 40),
          (n) => ops.entry(top, { en: `Into ${n}` }, { listId: wide }),
          { concurrency: 1 },
        );
        const read = yield* ops.read(anonymous, top);
        return Arr.map(read, (link) =>
          link.target.kind === "list" ? link.target.links.length : 0,
        );
      }),
    );
    // The top list's 40 entries leave 960: 38 nested reads of 25, one of the 10
    // left, and none for the last entry, whose list is left empty.
    expect(MAX_COLLECTION_SIZE).toBe(1000);
    expect(sizes).toEqual([...Arr.replicate(25, 38), 10]);
  });
});
