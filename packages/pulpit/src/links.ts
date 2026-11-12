/**
 * **Ordered link lists** (pulpit#266) — an ordered, localised list of
 * links under a parent node, read for one viewer, with nested lists
 * (pulpit#313): a site's navigation and its sub-menus, a
 * footer's links, a "related reading" strip. A menu is the usual example,
 * but the kernel names no application type, so this is the generic shape an
 * application binds (see the package README → Link lists).
 *
 * It adds one read over the existing modules and no store of its own:
 *
 * - **the list** — a `./collections` collection (pulpit#193) of entry
 *   nodes under the parent node. Its order, its size bound and its parent
 *   gate are the collection's;
 * - **the entry leaf** — a `defineSubtype` leaf with a locale level
 *   (`defineLocaleLevel`) whose version rows hold the link's target and,
 *   per locale, its label. The application declares the columns, and
 *   {@link LinkListDefinition.target} reads the target off the resource;
 * - **the target** — a path, resolved through `./pages`' `resolveLocalised`
 *   (or `./paths`' `resolve` behind it), a node, read through its leaf's
 *   gated `getMany`, or another list under the same collection (a nested
 *   list: a sub-menu), read by the same gated read;
 * - **the read** — {@link LinkListOps.list}, here.
 *
 * ## The gate (`SEC-AUTH-ENUM-001`)
 *
 * Every rule is the leaf's own. {@link LinkListOps.list} keeps an entry only
 * when the viewer can read the entry itself (its leaf's `getLocalised`, in
 * one of the requested locale's fallbacks) **and** can follow its target
 * (a path the viewer resolves, or a node the viewer reads). So a hidden,
 * unpublished, scheduled or tombstoned page, an unclaimed path and an alias
 * to a hidden node are all omitted, alike. The result is renumbered over
 * what is kept: it leaves no gap and carries neither an omitted entry's id
 * nor its target. The owner and the view-private rung read the head, as the
 * targets' own gates give, so they see the entries others can't. A parent
 * the viewer can't read is `NodeNotFound`, as for any collection.
 *
 * ## Nesting (pulpit#313)
 *
 * A nested list is an entry whose target is another parent node of the same
 * collection, so it needs no storage of its own. The read recurses into it
 * and keeps it only when the viewer can read its parent and it has at least
 * one link the viewer may follow: a nested list that is hidden, or ends up
 * empty, is omitted exactly as a hidden entry is (`SEC-AUTH-ENUM-001`).
 * Recursion is cut two ways, so a cycle never loops: an entry whose target
 * is the list it sits in, or any list above it, is omitted, and so is one
 * that would nest past {@link LinkListDefinition.maxDepth}. The whole read,
 * every level together, reads at most `MAX_COLLECTION_SIZE` entries
 * (`SEC-INPUT-003`).
 *
 * @copyright Thomas Foster
 * @module pulpit/links
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { MAX_COLLECTION_SIZE, type CollectionOps } from "./collections.ts";
import { localeFallbacks, type LocalisedResolution } from "./pages.ts";
import type { PathNotFound } from "./paths.ts";
import type { LocalisedResource, SubtypeOps } from "./subtype.ts";
import type { NodeNotFound } from "./version-chain.ts";

/**
 * How deep a read nests by default when its definition declares no
 * {@link LinkListDefinition.maxDepth}: the top list and two levels of
 * nested lists below it.
 *
 * @since 0.2.0
 */
export const DEFAULT_LINK_DEPTH = 3;

/**
 * What an entry points at: a path (resolved for the viewer, and followed
 * through an alias to its canonical path), a node (read for the viewer) or
 * another list's parent node (a nested list, read for the viewer).
 *
 * @since 0.2.0
 */
export type LinkTarget =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "list"; readonly id: string };

/**
 * What a followable entry's target resolved to: the node it names; for a
 * path target the canonical path the viewer is sent to; and for a nested
 * list its links the viewer may follow, never empty.
 *
 * @since 0.2.0
 */
export type FollowedTarget<Entry> =
  | { readonly kind: "path"; readonly id: string; readonly path: string }
  | { readonly kind: "node"; readonly id: string }
  | {
      readonly kind: "list";
      readonly id: string;
      readonly links: Arr.NonEmptyReadonlyArray<Link<Entry>>;
    };

/**
 * One link as {@link LinkListOps.list} returns it: the entry's id, its
 * position among the links the viewer may follow (from 0), the entry
 * resource in the locale the fallback chose, and the resolved target.
 *
 * @since 0.2.0
 */
export interface Link<Entry> {
  readonly entryId: string;
  readonly index: number;
  /** The locale the entry was read in: the first of {@link localeFallbacks} it carries. */
  readonly locale: string;
  readonly entry: Entry;
  readonly target: FollowedTarget<Entry>;
}

/**
 * One family's link list: the ordered collection of entries, the entry
 * leaf, the two target reads and the default locale.
 *
 * @since 0.2.0
 */
export interface LinkListDefinition<Entry, E, R> {
  /** The family's name, traced as `${type}.list`. */
  readonly type: string;
  /** The family's default locale: the last fallback every read tries. */
  readonly defaultLocale: string;
  /**
   * How many levels a read nests, the top list being the first: an entry
   * whose nested list would sit deeper is omitted. `1` reads a flat list.
   * {@link DEFAULT_LINK_DEPTH} when absent.
   */
  readonly maxDepth?: number;
  /**
   * The ordered collection of entry nodes under the parent: its `list`
   * gates the parent and each entry. A nested list is another parent of
   * this same collection.
   */
  readonly entries: Pick<CollectionOps<Entry, E, R>, "list">;
  /** The entry leaf, which carries a locale level: its `getLocalised` reads the entry in the viewer's locale. */
  readonly entryLeaf: Pick<SubtypeOps<Entry, E, R>, "getLocalised">;
  /**
   * What an entry points at, read off its (localised) resource; none for an
   * entry with no target, which is omitted.
   */
  readonly target: (entry: Entry) => Option.Option<LinkTarget>;
  /**
   * The gated path read: `resolveLocalised(pages, { defaultLocale })`. A
   * path the viewer can't resolve fails `PathNotFound`, and the entry is
   * omitted.
   */
  readonly resolve: (
    path: string,
    locale: string,
  ) => Effect.Effect<LocalisedResolution<unknown>, PathNotFound | E, R>;
  /** The target leaf's gated batch read: a node the viewer can't read is absent, and its entry is omitted. */
  readonly nodes: {
    readonly getMany: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<HashMap.HashMap<string, unknown>, E, R>;
  };
}

/**
 * The operation {@link defineLinkList} produces.
 *
 * @since 0.2.0
 */
export interface LinkListOps<Entry, E, R> {
  /**
   * The links under `parentId` the viewer may follow, in the collection's
   * order and in `locale` (falling back as {@link localeFallbacks} does).
   * An entry is omitted when the viewer can't read it, when it carries none
   * of the fallback locales, when it has no target, and when its target
   * isn't one the viewer can read; the rest are renumbered from 0. A nested
   * list is read the same way and is omitted too when its parent is hidden,
   * when it is left empty, when it is the list it sits in or one above it
   * (a cycle), or when it would nest past
   * {@link LinkListDefinition.maxDepth}.
   * Fails `NodeNotFound` for a parent the viewer can't read
   * (`SEC-AUTH-ENUM-001`), with the families' `E` otherwise. The read is
   * bounded by `MAX_COLLECTION_SIZE` entries over every level together
   * (`SEC-INPUT-003`), taken in reading order: the top
   * list's entries, each nested list's read where its entry sits.
   */
  readonly list: (
    parentId: string,
    locale: string,
  ) => Effect.Effect<ReadonlyArray<Link<Entry>>, NodeNotFound | E, R>;
}

/** An entry the viewer can read, with the locale it was read in. */
interface ReadEntry<Entry> extends LocalisedResource<Entry> {
  readonly entryId: string;
}

/**
 * Bind one family's link list: the gated, nesting read over its collection,
 * entry leaf and target reads. Traced as `${type}.list`.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as HashSet from "effect/HashSet";
 * import * as Option from "effect/Option";
 * import { defineCollection } from "@thomasfosterau/pulpit/collections";
 * import { defineLinkList } from "@thomasfosterau/pulpit/links";
 * import { resolveLocalised } from "@thomasfosterau/pulpit/pages";
 * import { routable } from "@thomasfosterau/pulpit/paths";
 * import { defineLocaleLevel, defineSubtype, nobodyFollows } from "@thomasfosterau/pulpit/subtype";
 * import {
 *   makeInMemoryCollectionStore,
 *   makeInMemoryLeafStore,
 *   makeInMemoryPathStore,
 *   makeInMemoryVersionChain,
 * } from "@thomasfosterau/pulpit/testing";
 *
 * const policy = {
 *   canViewPrivate: () => true,
 *   canViewDeleted: () => true,
 *   canModerate: () => true,
 *   canWriteCorpus: () => true,
 * };
 * const viewer = Effect.succeed(Option.some({ id: "editor", role: "admin" }));
 * const leaf = <Columns extends ReadonlyArray<string>>(
 *   type: string,
 *   columns: Columns,
 *   translated: ReadonlyArray<string>,
 * ) => {
 *   const chain = makeInMemoryVersionChain(type);
 *   const ops = defineSubtype({
 *     type,
 *     access: { kind: "reference" },
 *     chain,
 *     leaves: makeInMemoryLeafStore(chain, { columns: [...columns], localised: translated.length > 0 }),
 *     viewer,
 *     policy,
 *     followers: nobodyFollows(HashSet.empty<string>()),
 *     toResource: (row) => ({ id: row.id, path: row["path"], list: row["list"], label: row["label"] }),
 *     ...(translated.length > 0 ? { locales: defineLocaleLevel({ columns: translated }) } : {}),
 *   });
 *   return { chain, ops };
 * };
 *
 * const pageLeaf = leaf("pages", ["slug", "title"], ["title"]);
 * const pages = routable(pageLeaf.ops, {
 *   column: "slug",
 *   paths: makeInMemoryPathStore(),
 *   chain: pageLeaf.chain,
 * });
 * const menus = leaf("menus", [], []);
 * const items = leaf("menu-items", ["path", "list", "label"], ["label"]);
 * const collection = defineCollection({
 *   type: "menu-items",
 *   parent: menus.ops,
 *   members: items.ops,
 *   store: makeInMemoryCollectionStore(),
 * });
 * const links = defineLinkList({
 *   type: "menu-links",
 *   defaultLocale: "en",
 *   entries: collection,
 *   entryLeaf: items.ops,
 *   target: (entry) =>
 *     typeof entry.path === "string"
 *       ? Option.some({ kind: "path" as const, path: entry.path })
 *       : typeof entry.list === "string"
 *         ? Option.some({ kind: "list" as const, id: entry.list })
 *         : Option.none(),
 *   resolve: resolveLocalised(pages, { defaultLocale: "en" }),
 *   nodes: pages,
 * });
 *
 * const program = Effect.gen(function* () {
 *   yield* pages.create({
 *     id: Option.none(),
 *     state: { slug: "about" },
 *     locales: { en: { title: "About" } },
 *   });
 *   const { id: menuId } = yield* menus.ops.create({ id: Option.none(), state: {} });
 *   const { id: itemId } = yield* items.ops.create({
 *     id: Option.none(),
 *     state: { path: "about" },
 *     locales: { en: { label: "About us" }, pt: { label: "Sobre nós" } },
 *   });
 *   yield* collection.append(menuId, itemId);
 *   // A nested list: an entry whose target is another menu.
 *   const { id: subId } = yield* menus.ops.create({ id: Option.none(), state: {} });
 *   yield* collection.append(subId, itemId);
 *   const { id: subEntry } = yield* items.ops.create({
 *     id: Option.none(),
 *     state: { list: subId },
 *     locales: { en: { label: "More" } },
 *   });
 *   yield* collection.append(menuId, subEntry);
 *   return yield* links.list(menuId, "pt-BR");
 * });
 * const [link, more] = Effect.runSync(program);
 * deepStrictEqual([link?.locale, link?.target.kind, link?.index], ["pt", "path", 0]);
 * deepStrictEqual(
 *   more?.target.kind === "list" ? more.target.links.map((nested) => nested.target.kind) : [],
 *   ["path"],
 * );
 * ```
 *
 * @since 0.2.0
 */
export const defineLinkList = <Entry, E, R>(
  definition: LinkListDefinition<Entry, E, R>,
): LinkListOps<Entry, E, R> => {
  const { type, defaultLocale, entries, entryLeaf, target, resolve, nodes } = definition;
  const maxDepth = definition.maxDepth ?? DEFAULT_LINK_DEPTH;

  /** The entry in the first fallback locale it carries; an unreadable one, or one in none, is absent. */
  const readEntry = (entryId: string, locales: ReadonlyArray<string>) =>
    entryLeaf.getLocalised(entryId, locales).pipe(
      Effect.map((found): Option.Option<ReadEntry<Entry>> => Option.some({ entryId, ...found })),
      Effect.catchTag("NodeNotFound", () => Effect.succeedNone),
    );

  /** The target a path resolves to for the viewer; none when it resolves for nobody they are. */
  const followPath = (path: string, locale: string) =>
    resolve(path, locale).pipe(
      Effect.map((resolved): Option.Option<FollowedTarget<Entry>> =>
        Option.some({
          kind: "path",
          id: resolved.id,
          // An alias is followed to the node's canonical path.
          path: resolved.kind === "redirect" ? resolved.path : path,
        }),
      ),
      Effect.catchTag("PathNotFound", () => Effect.succeedNone),
    );

  /**
   * One list's links, read under the shared entry `budget`. `open` holds the
   * lists on the way down, `parentId` last, so its length is this list's
   * depth.
   */
  const readList = (
    parentId: string,
    locale: string,
    open: Arr.NonEmptyReadonlyArray<string>,
    budget: Ref.Ref<number>,
  ): Effect.Effect<ReadonlyArray<Link<Entry>>, NodeNotFound | E, R> =>
    Effect.gen(function* () {
      // The collection's own gates: the parent (`NodeNotFound`) and each entry.
      const page = yield* entries.list(parentId, { limit: MAX_COLLECTION_SIZE, offset: 0 });
      const rows = yield* Ref.modify(budget, (left) => {
        const taken = Arr.take(page.rows, left);
        return [taken, left - taken.length] as const;
      });
      const locales = localeFallbacks(locale, defaultLocale);
      const read = Arr.getSomes(
        yield* Effect.forEach(rows, (row) => readEntry(row.memberId, locales), {
          concurrency: 1,
        }),
      );
      const targeted = Arr.getSomes(
        Arr.map(read, (found) => Option.map(target(found.resource), (to) => ({ found, to }))),
      );
      // One gated read for every node target.
      const nodeIds = Arr.dedupe(
        Arr.getSomes(
          Arr.map(targeted, ({ to }) => (to.kind === "node" ? Option.some(to.id) : Option.none())),
        ),
      );
      const readable = Arr.isReadonlyArrayNonEmpty(nodeIds)
        ? yield* nodes.getMany(nodeIds)
        : HashMap.empty<string, unknown>();
      const follow = (to: LinkTarget): Effect.Effect<Option.Option<FollowedTarget<Entry>>, E, R> =>
        Match.value(to).pipe(
          Match.discriminatorsExhaustive("kind")({
            path: (path) => followPath(path.path, locale),
            node: (node) =>
              Effect.succeed(
                HashMap.has(readable, node.id)
                  ? Option.some<FollowedTarget<Entry>>({ kind: "node", id: node.id })
                  : Option.none(),
              ),
            list: (nested) => followList(nested.id, locale, open, budget),
          }),
        );
      const followed = yield* Effect.forEach(
        targeted,
        ({ found, to }) =>
          Effect.map(
            follow(to),
            Option.map((resolved) => ({ found, resolved })),
          ),
        { concurrency: 1 },
      );
      return Arr.map(Arr.getSomes(followed), ({ found, resolved }, index): Link<Entry> => ({
        entryId: found.entryId,
        index,
        locale: found.locale,
        entry: found.resource,
        target: resolved,
      }));
    });

  /**
   * A nested list, as a target: none for a cycle (a list already open above
   * it), past the depth cap, for a parent the viewer can't read, and for a
   * list left empty, the budget's end included (`SEC-AUTH-ENUM-001`).
   */
  const followList = (
    id: string,
    locale: string,
    open: Arr.NonEmptyReadonlyArray<string>,
    budget: Ref.Ref<number>,
  ): Effect.Effect<Option.Option<FollowedTarget<Entry>>, E, R> =>
    open.length >= maxDepth || Arr.contains(open, id)
      ? Effect.succeedNone
      : readList(id, locale, Arr.append(open, id), budget).pipe(
          Effect.map((links) =>
            Arr.isReadonlyArrayNonEmpty(links)
              ? Option.some<FollowedTarget<Entry>>({ kind: "list", id, links })
              : Option.none(),
          ),
          Effect.catchTag("NodeNotFound", () => Effect.succeedNone),
        );

  const list = Effect.fn(`${type}.list`)(function* (parentId: string, locale: string) {
    const budget = yield* Ref.make(MAX_COLLECTION_SIZE);
    return yield* readList(parentId, locale, Arr.of(parentId), budget);
  });

  return { list };
};
