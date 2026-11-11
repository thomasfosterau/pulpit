/**
 * `./discovery` (pulpit#203) against the in-memory seams.
 *
 * - What is discoverable: for every visibility × draft × moderation state ×
 *   tombstone × path cell of an owned leaf, the feed and the sitemap list a
 *   row exactly when it is `public`, not a draft, `approved`, live and has a
 *   canonical path (`SEC-AUTH-ENUM-001`, `CACHE-AUTH-005`).
 * - A publish-gated leaf lists its live version, never the head; a node
 *   never published, unpublished, or published only at a future stamp is
 *   not listed.
 * - Keyset paging: every page size walks the same order with no node
 *   skipped or repeated, ties and `NULL` keys included, and a page the
 *   guards thin still carries the cursor on.
 * - The declaration's refusals, and the purge hint per write.
 *
 * @module tests/discovery
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import {
  defineDiscovery,
  DiscoveryDeclarationError,
  lastModified,
  purgeHintHook,
  type DiscoveryCursor,
  type DiscoveryPage,
  type DiscoveryRequest,
  type PurgeHint,
} from "../src/discovery.ts";
import {
  defineLocaleLevel,
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type SubtypeDefinition,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  makeInMemoryVersionChain,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryPathStore,
  makeInMemoryPublication,
  type InMemoryFollowing,
} from "../src/testing.ts";
import type { ChainState, WriteAction } from "../src/version-chain.ts";
import { follower, gardeneriaPolicy, member, NOW } from "./fixtures.ts";

const as = (account: ViewerAccount): Viewer => Option.some(account);

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(NOW.getTime()), effect).pipe(
      Effect.provide(TestClock.layer()),
    ),
  );

/** The JSON:API shape the serveability guard reads. */
interface Resource {
  readonly id: string;
  readonly attributes: { readonly [column: string]: LeafRow[string] };
}

const toResource = (row: LeafRow): Resource => {
  const { id, version: _version, action: _action, ownerId: _ownerId, ...attributes } = row;
  return { id, attributes };
};

const project = (resource: Resource) => ({
  title: String(resource.attributes["title"]),
  summary: Option.none<string>(),
  image: Option.none<{ readonly url: string; readonly alt: Option.Option<string> }>(),
  schemaType: "Article",
  published: Option.liftPredicate(
    resource.attributes["publishedAt"],
    (value) => value instanceof Date,
  ),
  modified: Option.none<Date>(),
});

const at = (minutes: number) =>
  DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() - minutes * 60_000));

/** An owned leaf with the draft and moderation axes, its stores, and an actor switch. */
const fixture = (options: {
  readonly gated: boolean;
  readonly sortable: Option.Option<ReadonlyArray<string>>;
}) => {
  const chain = makeInMemoryVersionChain("posts");
  const heads = makeInMemoryLeafStore(chain, {
    columns: ["title", "visibility", "draft", "moderationState", "createdAt", "publishedAt"],
  });
  const publication = makeInMemoryPublication({ chain, leaves: heads, now: NOW });
  const paths = makeInMemoryPathStore();
  let viewer: Viewer = as(member);
  const leaf: SubtypeDefinition<LeafRow, Resource, InMemoryFollowing, never, never> = {
    type: "posts",
    access: ownedAccess({ draft: true, moderation: true }),
    chain,
    leaves: options.gated ? publication.leaves : heads,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: makeInMemoryFollowers([[follower.id, [member.id]]]),
    toResource,
    sortable: Option.getOrUndefined(options.sortable),
    publication: options.gated ? { live: publication.live, facts: publication.facts } : undefined,
  };
  const ops = defineSubtype(leaf);
  const create = (
    id: string,
    state: ChainState,
    path: Option.Option<string> = Option.some(`/${id}`),
  ) =>
    Effect.gen(function* () {
      viewer = as(member);
      yield* ops.create({ id: Option.some(id), state });
      yield* Effect.forEach(Option.toArray(path), (claimed) => paths.claim(id, claimed), {
        concurrency: 1,
      });
    });
  return { leaf, ops, paths, create, publication };
};

/** Walk every page of a read, `limit` at a time. */
const walk = (
  read: (request: DiscoveryRequest) => Effect.Effect<DiscoveryPage<Resource>>,
  limit: number,
  after: Option.Option<DiscoveryCursor> = Option.none(),
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.flatMap(read({ limit, after: Option.getOrUndefined(after) }), (page) => {
    const ids = Arr.map(page.items, (item) => item.id);
    return Option.isNone(page.next)
      ? Effect.succeed(ids)
      : Effect.map(walk(read, limit, page.next), (rest) => [...ids, ...rest]);
  });

describe("what is discoverable (an owned leaf)", () => {
  const cells = Arr.flatMap(["public", "followers", "private"] as const, (visibility) =>
    Arr.flatMap([false, true], (draft) =>
      Arr.flatMap(["approved", "pending", "rejected"] as const, (moderationState) =>
        Arr.flatMap([false, true], (tombstoned) =>
          Arr.map([false, true], (pathed) => ({
            visibility,
            draft,
            moderationState,
            tombstoned,
            pathed,
          })),
        ),
      ),
    ),
  );
  const idOf = (cell: (typeof cells)[number]) =>
    `n-${cell.visibility}-${String(cell.draft)}-${cell.moderationState}-${String(cell.tombstoned)}-${String(cell.pathed)}`;
  const expected = Arr.map(
    Arr.filter(
      cells,
      (cell) =>
        cell.visibility === "public" &&
        !cell.draft &&
        cell.moderationState === "approved" &&
        !cell.tombstoned &&
        cell.pathed,
    ),
    idOf,
  );

  const seed = Effect.fn("seed")(function* () {
    const { leaf, ops, paths, create } = fixture({ gated: false, sortable: Option.none() });
    yield* Effect.forEach(
      cells,
      (cell, index) =>
        Effect.gen(function* () {
          const id = idOf(cell);
          yield* create(
            id,
            {
              title: id,
              visibility: cell.visibility,
              draft: cell.draft,
              moderationState: cell.moderationState,
              createdAt: at(index),
            },
            cell.pathed ? Option.some(`/${id}`) : Option.none(),
          );
          if (cell.tombstoned) yield* ops.delete(id);
        }),
      { concurrency: 1 },
    );
    return defineDiscovery({ leaf, paths, feedColumn: "createdAt", project });
  });

  it("the feed lists exactly the public, published, approved, live, routable rows, newest first", async () => {
    const ids = await run(Effect.flatMap(seed(), (discovery) => walk(discovery.feed, 1000)));
    // Seeded oldest-last, so newest first is seed order.
    expect(ids).toEqual(expected);
  });

  it("the sitemap lists the same rows, by id", async () => {
    const ids = await run(Effect.flatMap(seed(), (discovery) => walk(discovery.sitemap, 1000)));
    expect(ids).toEqual(Arr.sort(expected, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it.each([1, 2, 3, 7])("every page size walks the same nodes (limit %i)", async (limit) => {
    const [feed, sitemap] = await run(
      Effect.flatMap(seed(), (discovery) =>
        Effect.all([walk(discovery.feed, limit), walk(discovery.sitemap, limit)], {
          concurrency: 1,
        }),
      ),
    );
    expect(feed).toEqual(expected);
    expect(Arr.dedupe(sitemap)).toEqual(sitemap);
    expect(Arr.sort(sitemap, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      sitemap,
    );
    expect(sitemap.length).toBe(expected.length);
  });

  it("an item carries its canonical path and projected metadata", async () => {
    const page = await run(Effect.flatMap(seed(), (discovery) => discovery.feed({ limit: 1000 })));
    const [item] = page.items;
    expect(item?.path).toBe(`/${expected[0]}`);
    expect(item?.metadata.title).toBe(expected[0]);
    expect(item?.type).toBe("posts");
  });
});

describe("keyset paging", () => {
  it.each([1, 2, 3, 5])(
    "ties and NULL keys never skip or repeat a node (limit %i)",
    async (limit) => {
      const ids = await run(
        Effect.gen(function* () {
          const { leaf, paths, create } = fixture({ gated: false, sortable: Option.none() });
          const keys = [at(1), at(1), null, at(2), at(1), null, at(3)];
          yield* Effect.forEach(
            keys,
            (createdAt, index) =>
              create(`k-${String(index)}`, {
                title: "t",
                visibility: "public",
                draft: false,
                moderationState: "approved",
                createdAt,
              }),
            { concurrency: 1 },
          );
          return yield* walk(
            defineDiscovery({ leaf, paths, feedColumn: "createdAt", project }).feed,
            limit,
          );
        }),
      );
      // Newest first, `id` ascending among ties, NULLs last.
      expect(ids).toEqual(["k-0", "k-1", "k-4", "k-3", "k-6", "k-2", "k-5"]);
    },
  );

  it("a page the guards thin still carries the cursor on", async () => {
    const pages = await run(
      Effect.gen(function* () {
        const { leaf, paths, create } = fixture({ gated: false, sortable: Option.none() });
        yield* Effect.forEach(
          [0, 1, 2],
          (index) =>
            create(
              `g-${String(index)}`,
              {
                title: "t",
                visibility: "public",
                draft: false,
                moderationState: "approved",
                createdAt: at(index),
              },
              index === 0 ? Option.none() : Option.some(`/g-${String(index)}`),
            ),
          { concurrency: 1 },
        );
        const discovery = defineDiscovery({ leaf, paths, feedColumn: "createdAt", project });
        const first = yield* discovery.feed({ limit: 1 });
        const second = yield* discovery.feed({
          limit: 1,
          after: Option.getOrUndefined(first.next),
        });
        return { first, second };
      }),
    );
    expect(pages.first.items).toEqual([]);
    expect(Option.isSome(pages.first.next)).toBe(true);
    expect(Arr.map(pages.second.items, (item) => item.id)).toEqual(["g-1"]);
  });
});

describe("a publish-gated leaf", () => {
  it("lists the live version, never the head, and nothing unpublished or scheduled", async () => {
    const page = await run(
      Effect.gen(function* () {
        const { leaf, ops, paths, create } = fixture({ gated: true, sortable: Option.none() });
        const lifecycle = yield* Effect.fromOption(ops.publication);
        const state = (title: string) => ({
          title,
          visibility: "public",
          draft: false,
          moderationState: "approved",
        });
        yield* create("live", state("live v0"));
        yield* lifecycle.publish("live", { at: at(10) });
        yield* ops.update({ id: "live", patch: { title: "unpublished head" } });
        yield* create("never", state("never"));
        yield* create("scheduled", state("scheduled"));
        yield* lifecycle.publish("scheduled", { at: at(-1) });
        yield* create("withdrawn", state("withdrawn"));
        yield* lifecycle.publish("withdrawn", { at: at(5) });
        yield* lifecycle.unpublish("withdrawn");
        return yield* defineDiscovery({ leaf, paths, feedColumn: "publishedAt", project }).feed({
          limit: 10,
        });
      }),
    );
    expect(Arr.map(page.items, (item) => item.id)).toEqual(["live"]);
    expect(page.items[0]?.metadata.title).toBe("live v0");
    expect(
      Option.getOrUndefined(
        Option.flatMap(Arr.head(page.items), (item) => lastModified(item.metadata)),
      )?.getTime(),
    ).toBe(at(10).getTime());
  });
});

describe("the declaration", () => {
  it("refuses a localised leaf", () => {
    const { leaf, paths } = fixture({ gated: false, sortable: Option.none() });
    expect(() =>
      defineDiscovery({
        leaf: { ...leaf, locales: defineLocaleLevel({ columns: ["title"] }) },
        paths,
        feedColumn: "createdAt",
        project,
      }),
    ).toThrow(DiscoveryDeclarationError);
  });

  it("a feed column the leaf can't sort by is a defect", async () => {
    const exit = await run(
      Effect.exit(
        Effect.suspend(() => {
          const { leaf, paths } = fixture({ gated: false, sortable: Option.some([]) });
          return defineDiscovery({ leaf, paths, feedColumn: "createdAt", project }).feed({
            limit: 1,
          });
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("a feed column holding a value that doesn't order is a defect", async () => {
    const exit = await run(
      Effect.exit(
        Effect.gen(function* () {
          const { leaf, paths, create } = fixture({ gated: false, sortable: Option.none() });
          yield* Effect.forEach(
            ["a", "b"],
            (id) =>
              create(id, {
                title: "t",
                visibility: "public",
                draft: false,
                moderationState: "approved",
                createdAt: at(1),
              }),
            { concurrency: 1 },
          );
          return yield* defineDiscovery({ leaf, paths, feedColumn: "draft", project }).feed({
            limit: 1,
          });
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("a declared serveable guard replaces the leaf's posture", async () => {
    const page = await run(
      Effect.gen(function* () {
        const { leaf, paths, create } = fixture({ gated: false, sortable: Option.none() });
        yield* create("a", {
          title: "keep",
          visibility: "public",
          draft: false,
          moderationState: "approved",
          createdAt: at(1),
        });
        yield* create("b", {
          title: "drop",
          visibility: "public",
          draft: false,
          moderationState: "approved",
          createdAt: at(2),
        });
        return yield* defineDiscovery({
          leaf,
          paths,
          feedColumn: "createdAt",
          project,
          serveable: (resource) => resource.attributes["title"] === "keep",
        }).sitemap({ limit: 10 });
      }),
    );
    expect(Arr.map(page.items, (item) => item.id)).toEqual(["a"]);
  });
});

describe("purgeHintHook", () => {
  const actions: ReadonlyArray<WriteAction> = [
    "create",
    "update",
    "delete",
    "restore",
    "restoreVersion",
    "publish",
    "unpublish",
  ];
  const cases = Arr.flatMap([false, true], (publishGated) =>
    Arr.map(actions, (action) => ({
      label: `${publishGated ? "gated" : "ungated"} ${action}`,
      publishGated,
      action,
      purges: !publishGated || (action !== "create" && action !== "update"),
    })),
  );

  it.each(cases)("$label", async ({ publishGated, action, purges }) => {
    const emitted = await run(
      Effect.gen(function* () {
        const hints = yield* Effect.sync(() => Arr.empty<PurgeHint>());
        const collected: Array<PurgeHint> = [...hints];
        const hook = purgeHintHook<Resource>({
          publishGated,
          emit: (hint) => Effect.sync(() => void collected.push(hint)),
        });
        yield* hook.run({
          type: "posts",
          action,
          write: { id: "p-1", version: 2n },
          resource: Option.none(),
          publication: Option.none(),
        });
        return collected;
      }),
    );
    expect(emitted).toEqual(
      purges ? [{ type: "posts", id: "p-1", tags: ["discovery:posts", "node:posts:p-1"] }] : [],
    );
  });
});
