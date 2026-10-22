/**
 * `./paths` — a routable leaf's path claims follow its version chain, a path
 * change leaves an alias that redirects, and resolution is gated
 * (`SEC-AUTH-ENUM-001`), over the in-memory chain, leaf and path stores.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { routable, type Resolution } from "../src/paths.ts";
import {
  defineSubtype,
  nobodyFollows,
  ownedAccess,
  subtypeHandlers,
  type LeafRow,
  type Viewer,
} from "../src/subtype.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryLeafStore,
  makeInMemoryPathStore,
  type InMemoryFollowing,
} from "../src/testing.ts";
import * as HashSet from "effect/HashSet";
import type { ColumnValue } from "../src/version-chain.ts";
import { gardeneriaPolicy, member, moderator, NOW, otherMember } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

/** An owned page leaf with a `slug` path column, over in-memory stores. */
const pagesLeaf = () => {
  const chain = makeInMemoryChainStore();
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
    run(
      as(Option.some(member), pages.create({ id: Option.none(), state: { slug, visibility } })),
    ).then(({ id }) => id);
  const resolve = (path: string, who: Viewer = Option.none()) => run(as(who, pages.resolve(path)));
  const resolveTag = (path: string, who: Viewer = Option.none()) =>
    tagOf(as(who, pages.resolve(path)));
  /** Each viewer's outcome for each path, one at a time: its resolution or its error tag. */
  const outcomes = (viewers: ReadonlyArray<Viewer>, paths: ReadonlyArray<string>) =>
    run(
      // One at a time: `as` swaps the one viewer the leaf reads.
      Effect.forEach(
        viewers,
        (who) =>
          Effect.forEach(
            paths,
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
      ),
    );
  return { pages, paths, as, create, resolve, resolveTag, outcomes };
};

const node = (id: string, slug: string): Resolution<unknown> => ({
  kind: "node",
  id,
  resource: { id, slug },
});

describe("routable — claims follow the chain (pulpit#57)", () => {
  it("lets one live node hold a path: a second create or an update onto it fails PathTaken", async () => {
    const leaf = pagesLeaf();
    const about = await leaf.create("about");
    expect(
      await tagOf(
        leaf.pages.create({ id: Option.none(), state: { slug: "about", visibility: "public" } }),
      ),
    ).toEqual(Option.some("PathTaken"));
    const other = await leaf.create("other");
    expect(await tagOf(leaf.pages.update({ id: other, patch: { slug: "about" } }))).toEqual(
      Option.some("PathTaken"),
    );
    expect(await leaf.resolve("about")).toEqual(node(about, "about"));
  });

  it("frees the claim on a tombstone, so another node can take the path", async () => {
    const leaf = pagesLeaf();
    const first = await leaf.create("about");
    await run(leaf.pages.delete(first));
    expect(await leaf.resolveTag("about")).toEqual(Option.some("PathNotFound"));
    // An already tombstoned node writes nothing and frees nothing more.
    await run(leaf.pages.delete(first));
    const second = await leaf.create("about");
    expect(await leaf.resolve("about")).toEqual(node(second, "about"));
  });

  it("re-claims the path on a restore, and fails PathTaken when another node took it meanwhile", async () => {
    const leaf = pagesLeaf();
    const first = await leaf.create("about");
    await run(leaf.pages.delete(first));
    await run(leaf.pages.restore({ id: first, patch: {} }));
    expect(await leaf.resolve("about")).toEqual(node(first, "about"));

    await run(leaf.pages.delete(first));
    const second = await leaf.create("about");
    expect(await tagOf(leaf.pages.restore({ id: first, patch: {} }))).toEqual(
      Option.some("PathTaken"),
    );
    expect(await leaf.resolve("about")).toEqual(node(second, "about"));
  });

  it("restoreVersion claims the restored version's path, promoting its alias back", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("about");
    await run(leaf.pages.update({ id, patch: { slug: "about-us" } }));
    await run(leaf.pages.restoreVersion(id, 0n));
    expect(await leaf.resolve("about")).toEqual(node(id, "about"));
    expect(await leaf.resolve("about-us")).toEqual({ kind: "redirect", id, path: "about" });
  });

  it("claims nothing for a state with no path, and clearing the path frees it", async () => {
    const leaf = pagesLeaf();
    const unrouted = await leaf.create(null);
    expect(HashMap.size(leaf.paths.entries())).toBe(0);
    await run(leaf.pages.update({ id: unrouted, patch: { slug: "late" } }));
    expect(await leaf.resolve("late")).toEqual(node(unrouted, "late"));
    await run(leaf.pages.update({ id: unrouted, patch: { slug: null } }));
    expect(await leaf.resolveTag("late")).toEqual(Option.some("PathNotFound"));
  });

  it("writes no claim for a write that leaves the path as it was", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("about");
    const before = leaf.paths.entries();
    await run(leaf.pages.update({ id, patch: { visibility: "public" } }));
    expect(leaf.paths.entries()).toBe(before);
  });

  it("keeps the claims inside subtypeHandlers' boundary", async () => {
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
    const created = await run(
      handlers.create({ id: Option.none(), state: { slug: "about", visibility: "public" } }),
    );
    expect(transacted).toEqual(["commit"]);
    expect(await leaf.resolve("about")).toEqual(node(created.id, "about"));
  });
});

describe("routable — aliases and gated resolution (pulpit#57, SEC-AUTH-ENUM-001)", () => {
  it("leaves the old path as an alias that redirects to the canonical one", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("about");
    await run(leaf.pages.update({ id, patch: { slug: "about-us" } }));
    await run(leaf.pages.update({ id, patch: { slug: "company" } }));
    expect(await leaf.resolve("about")).toEqual({ kind: "redirect", id, path: "company" });
    expect(await leaf.resolve("about-us")).toEqual({ kind: "redirect", id, path: "company" });
    expect(await leaf.resolve("company")).toEqual(node(id, "company"));
    expect(await leaf.resolveTag("nowhere")).toEqual(Option.some("PathNotFound"));
  });

  it("lets another node claim an alias, which then resolves to that node", async () => {
    const leaf = pagesLeaf();
    const first = await leaf.create("about");
    await run(leaf.pages.update({ id: first, patch: { slug: "about-us" } }));
    const second = await leaf.create("about");
    expect(await leaf.resolve("about")).toEqual(node(second, "about"));
    expect(await leaf.resolve("about-us")).toEqual(node(first, "about-us"));
  });

  it("answers a hidden node's path, and an alias to it, as not found, never a redirect", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("draft-page", "private");
    await run(leaf.pages.update({ id, patch: { slug: "secret" } }));
    const paths = ["secret", "draft-page"];
    expect(await leaf.outcomes([Option.none(), Option.some(otherMember)], paths)).toEqual([
      ["PathNotFound", "PathNotFound"],
      ["PathNotFound", "PathNotFound"],
    ]);
    // The owner and the view-private rung read the row, so its paths resolve.
    const shown = [node(id, "secret"), { kind: "redirect", id, path: "secret" }];
    expect(await leaf.outcomes([Option.some(member), Option.some(moderator)], paths)).toEqual([
      shown,
      shown,
    ]);
  });

  it("answers an alias whose node has no canonical path now as not found", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("about");
    await run(leaf.pages.update({ id, patch: { slug: "about-us" } }));
    await run(leaf.pages.update({ id, patch: { slug: null } }));
    expect(await leaf.resolveTag("about")).toEqual(Option.some("PathNotFound"));
  });

  it("answers a tombstoned node's aliases as not found, even to the view-deleted rung", async () => {
    const leaf = pagesLeaf();
    const id = await leaf.create("about");
    await run(leaf.pages.update({ id, patch: { slug: "about-us" } }));
    await run(leaf.pages.delete(id));
    expect(
      await leaf.outcomes([Option.none(), Option.some(moderator)], ["about", "about-us"]),
    ).toEqual([
      ["PathNotFound", "PathNotFound"],
      ["PathNotFound", "PathNotFound"],
    ]);
  });
});
