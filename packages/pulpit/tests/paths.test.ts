/**
 * `./Paths` — a routable leaf's path claims follow its version chain, a path
 * change leaves an alias that redirects, and resolution is gated
 * (`SEC-AUTH-ENUM-001`), over the in-memory chain, leaf and path stores.
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { routable, type Resolution } from "../src/Paths.ts";
import {
  defineSubtype,
  nobodyFollows,
  ownedAccess,
  subtypeHandlers,
  type LeafRow,
  type Viewer,
} from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryLeafStore,
  makeInMemoryPathStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import * as HashSet from "effect/HashSet";
import type { ColumnValue } from "../src/VersionChain.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit)
      ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
      : Option.none();
  });

/** An owned page leaf with a `slug` path column, over in-memory stores. */
const pagesLeaf = () => {
  const chain = makeInMemoryVersionChain("pages");
  const leaves = makeInMemoryLeafStore(chain, { columns: ["slug", "visibility"], now: NOW });
  const paths = makeInMemoryPathStore();
  let viewer: Viewer = Option.some(member);
  const pages = routable(
    defineSubtype({
      type: "pages",
      access: ownedAccess(),
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: nobodyFollows<InMemoryFollowing>(HashSet.empty()),
      toResource: (row: LeafRow) => ({ id: row.id, slug: row["slug"] }),
    }),
    { column: "slug", paths, chain },
  );
  // Acts as `who`, then hands the leaf back to the member, who writes.
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.ensuring(
      Effect.suspend(() => {
        viewer = who;
        return effect;
      }),
      Effect.sync(() => {
        viewer = Option.some(member);
      }),
    );
  const create = (slug: ColumnValue, visibility = "public") =>
    Effect.map(
      as(Option.some(member), pages.create({ id: Option.none(), state: { slug, visibility } })),
      ({ id }) => id,
    );
  const resolve = (path: string, who: Viewer = Option.none()) => as(who, pages.resolve(path));
  const resolveTag = (path: string, who: Viewer = Option.none()) =>
    tagOf(as(who, pages.resolve(path)));
  /** Each viewer's outcome for each path, one at a time: its resolution or its error tag. */
  const outcomes = (viewers: ReadonlyArray<Viewer>, requested: ReadonlyArray<string>) =>
    Effect.forEach(
      viewers,
      (who) =>
        Effect.forEach(
          requested,
          (path) =>
            as(who, pages.resolve(path)).pipe(
              Effect.match({
                onFailure: (error): Resolution<unknown> | string => error._tag,
                onSuccess: (resolved): Resolution<unknown> | string => resolved,
              }),
            ),
          { concurrency: 1 },
        ),
      { concurrency: 1 },
    );
  return { pages, paths, as, create, resolve, resolveTag, outcomes };
};

const node = (id: string, slug: string): Resolution<unknown> => ({
  kind: "node",
  id,
  resource: { id, slug },
});

describe("routable — claims follow the chain", () => {
  it.effect(
    "lets one live node hold a path: a second create or an update onto it fails PathTaken",
    () =>
      Effect.gen(function* () {
        const leaf = pagesLeaf();
        const about = yield* leaf.create("about");
        expect(
          yield* tagOf(
            leaf.pages.create({
              id: Option.none(),
              state: { slug: "about", visibility: "public" },
            }),
          ),
        ).toEqual(Option.some("PathTaken"));
        const other = yield* leaf.create("other");
        expect(yield* tagOf(leaf.pages.update({ id: other, patch: { slug: "about" } }))).toEqual(
          Option.some("PathTaken"),
        );
        expect(yield* leaf.resolve("about")).toEqual(node(about, "about"));
      }),
  );

  it.effect("frees the claim on a tombstone, so another node can take the path", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const first = yield* leaf.create("about");
      yield* leaf.pages.delete(first);
      expect(yield* leaf.resolveTag("about")).toEqual(Option.some("PathNotFound"));
      // An already tombstoned node writes nothing and frees nothing more.
      yield* leaf.pages.delete(first);
      const second = yield* leaf.create("about");
      expect(yield* leaf.resolve("about")).toEqual(node(second, "about"));
    }),
  );

  it.effect(
    "re-claims the path on a restore, and fails PathTaken when another node took it meanwhile",
    () =>
      Effect.gen(function* () {
        const leaf = pagesLeaf();
        const first = yield* leaf.create("about");
        yield* leaf.pages.delete(first);
        yield* leaf.pages.restore({ id: first, patch: {} });
        expect(yield* leaf.resolve("about")).toEqual(node(first, "about"));

        yield* leaf.pages.delete(first);
        const second = yield* leaf.create("about");
        expect(yield* tagOf(leaf.pages.restore({ id: first, patch: {} }))).toEqual(
          Option.some("PathTaken"),
        );
        expect(yield* leaf.resolve("about")).toEqual(node(second, "about"));
      }),
  );

  it.effect("restoreVersion claims the restored version's path, promoting its alias back", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const id = yield* leaf.create("about");
      yield* leaf.pages.update({ id, patch: { slug: "about-us" } });
      yield* leaf.pages.restoreVersion(id, 0n);
      expect(yield* leaf.resolve("about")).toEqual(node(id, "about"));
      expect(yield* leaf.resolve("about-us")).toEqual({ kind: "redirect", id, path: "about" });
    }),
  );

  it.effect("claims nothing for a state with no path, and clearing the path frees it", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const unrouted = yield* leaf.create(null);
      expect(HashMap.size(leaf.paths.entries())).toBe(0);
      yield* leaf.pages.update({ id: unrouted, patch: { slug: "late" } });
      expect(yield* leaf.resolve("late")).toEqual(node(unrouted, "late"));
      yield* leaf.pages.update({ id: unrouted, patch: { slug: null } });
      expect(yield* leaf.resolveTag("late")).toEqual(Option.some("PathNotFound"));
    }),
  );

  it.effect("writes no claim for a write that leaves the path as it was", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const id = yield* leaf.create("about");
      const before = leaf.paths.entries();
      yield* leaf.pages.update({ id, patch: { visibility: "public" } });
      expect(leaf.paths.entries()).toBe(before);
    }),
  );

  it.effect("keeps the claims inside subtypeHandlers' boundary", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const transacted: Array<string> = [];
      const handlers = subtypeHandlers(leaf.pages, {
        inTransaction: Effect.succeed(false),
        transact: (effect) =>
          Effect.ensuring(
            effect,
            Effect.sync(() => transacted.push("commit")),
          ),
        cache: Option.none(),
      });
      const created = yield* handlers.create({
        id: Option.none(),
        state: { slug: "about", visibility: "public" },
      });
      expect(transacted).toEqual(["commit"]);
      expect(yield* leaf.resolve("about")).toEqual(node(created.id, "about"));
    }),
  );
});

describe("routable — aliases and gated resolution (SEC-AUTH-ENUM-001)", () => {
  it.effect("leaves the old path as an alias that redirects to the canonical one", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const id = yield* leaf.create("about");
      yield* leaf.pages.update({ id, patch: { slug: "about-us" } });
      yield* leaf.pages.update({ id, patch: { slug: "company" } });
      expect(yield* leaf.resolve("about")).toEqual({ kind: "redirect", id, path: "company" });
      expect(yield* leaf.resolve("about-us")).toEqual({ kind: "redirect", id, path: "company" });
      expect(yield* leaf.resolve("company")).toEqual(node(id, "company"));
      expect(yield* leaf.resolveTag("nowhere")).toEqual(Option.some("PathNotFound"));
    }),
  );

  it.effect("lets another node claim an alias, which then resolves to that node", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const first = yield* leaf.create("about");
      yield* leaf.pages.update({ id: first, patch: { slug: "about-us" } });
      const second = yield* leaf.create("about");
      expect(yield* leaf.resolve("about")).toEqual(node(second, "about"));
      expect(yield* leaf.resolve("about-us")).toEqual(node(first, "about-us"));
    }),
  );

  it.effect(
    "answers a hidden node's path, and an alias to it, as not found, never a redirect",
    () =>
      Effect.gen(function* () {
        const leaf = pagesLeaf();
        const id = yield* leaf.create("draft-page", "private");
        yield* leaf.pages.update({ id, patch: { slug: "secret" } });
        const paths = ["secret", "draft-page"];
        expect(yield* leaf.outcomes([Option.none(), Option.some(otherMember)], paths)).toEqual([
          ["PathNotFound", "PathNotFound"],
          ["PathNotFound", "PathNotFound"],
        ]);
        // The owner and the view-private rung read the row, so its paths resolve.
        const shown = [node(id, "secret"), { kind: "redirect", id, path: "secret" }];
        expect(yield* leaf.outcomes([Option.some(member), Option.some(moderator)], paths)).toEqual([
          shown,
          shown,
        ]);
      }),
  );

  it.effect("answers an alias whose node has no canonical path now as not found", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const id = yield* leaf.create("about");
      yield* leaf.pages.update({ id, patch: { slug: "about-us" } });
      yield* leaf.pages.update({ id, patch: { slug: null } });
      expect(yield* leaf.resolveTag("about")).toEqual(Option.some("PathNotFound"));
    }),
  );

  it.effect("answers a tombstoned node's aliases as not found, even to the view-deleted rung", () =>
    Effect.gen(function* () {
      const leaf = pagesLeaf();
      const id = yield* leaf.create("about");
      yield* leaf.pages.update({ id, patch: { slug: "about-us" } });
      yield* leaf.pages.delete(id);
      expect(
        yield* leaf.outcomes([Option.none(), Option.some(moderator)], ["about", "about-us"]),
      ).toEqual([
        ["PathNotFound", "PathNotFound"],
        ["PathNotFound", "PathNotFound"],
      ]);
    }),
  );
});
