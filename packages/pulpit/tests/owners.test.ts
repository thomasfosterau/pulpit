/**
 * Distinct readable owners (pulpit#186): `SubtypeOps.owners` agrees with the
 * owners of `list`'s rows for every viewer, gated and ungated, and
 * `readableOwners` is their exact union across leaves.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { MAX_SET_VALUES } from "../src/filter.ts";
import { byCodePoint } from "../src/internal/list-order.ts";
import {
  defineSubtype,
  MAX_PAGE_LIMIT,
  OwnerSetTooLarge,
  ownedAccess,
  readableOwners,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryPublication,
} from "../src/testing.ts";
import {
  admin,
  follower,
  gardeneriaPolicy,
  member,
  moderator,
  NOW,
  otherMember,
} from "./fixtures.ts";

const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();
const follows = makeInMemoryFollowers([[follower.id, [member.id]]]);
const viewers: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", anonymous],
  ["a member", as(member)],
  ["another member", as(otherMember)],
  ["a follower", as(follower)],
  ["a moderator", as(moderator)],
  ["an admin", as(admin)],
];

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(NOW.getTime()), effect).pipe(
      Effect.provide(TestClock.layer()),
    ),
  );

/** An owned leaf, gated or not, seeded with every visibility × draft × owner, and one tombstone. */
const seeded = (gated: boolean) => {
  const chain = makeInMemoryChainStore();
  const heads = makeInMemoryLeafStore(chain, { columns: ["title", "visibility", "draft"] });
  const publication = makeInMemoryPublication({ chain, leaves: heads, now: NOW });
  let viewer: Viewer = anonymous;
  const ops = defineSubtype({
    type: "posts",
    access: ownedAccess({ draft: true }),
    chain,
    leaves: gated ? publication.leaves : heads,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: follows,
    toResource: (row: LeafRow) => row,
    publication: gated ? { live: publication.live, facts: publication.facts } : undefined,
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const owners = [member, otherMember, follower];
  const seed = Effect.forEach(
    Arr.flatMap(owners, (owner) =>
      Arr.flatMap(["public", "followers", "private"], (visibility) =>
        Arr.map([false, true], (draft) => ({ owner, visibility, draft })),
      ),
    ),
    ({ owner, visibility, draft }) =>
      Effect.gen(function* () {
        const { id } = yield* actAs(
          as(owner),
          ops.create({ id: Option.none(), state: { title: "t", visibility, draft } }),
        );
        // Publish half of them on a gated leaf, so live and head differ.
        if (gated && !draft) {
          const lifecycle = yield* Effect.fromOption(ops.publication);
          yield* actAs(as(owner), lifecycle.publish(id));
        }
        return id;
      }),
    { concurrency: 1 },
  );
  const tombstone = Effect.fn("tombstone")(function* () {
    const { id } = yield* actAs(
      as(admin),
      ops.create({ id: Option.none(), state: { title: "t", visibility: "public", draft: false } }),
    );
    yield* actAs(as(admin), ops.delete(id));
  });
  return { ops, actAs, seed: Effect.andThen(seed, tombstone()) };
};

describe("SubtypeOps.owners", () => {
  const cases = Arr.flatMap([false, true], (gated) =>
    Arr.flatMap(viewers, ([name, viewer]) =>
      Arr.map([false, true], (includeDeleted) => ({
        label: `${name}, ${gated ? "publish-gated" : "ungated"}${includeDeleted ? ", deleted included" : ""}`,
        gated,
        viewer,
        includeDeleted,
      })),
    ),
  );

  it.each(cases)(
    "agrees with list's rows for $label",
    async ({ gated, viewer, includeDeleted }) => {
      const { ops, actAs, seed } = seeded(gated);
      const [owners, listed] = await run(
        Effect.andThen(
          seed,
          actAs(
            viewer,
            Effect.all(
              [
                ops.owners({ limit: MAX_PAGE_LIMIT, offset: 0, includeDeleted }),
                ops.list({
                  limit: MAX_PAGE_LIMIT,
                  offset: 0,
                  includeDeleted,
                  where: { kind: "always" },
                }),
              ],
              { concurrency: 1 },
            ),
          ),
        ),
      );
      const expected = Arr.sort(
        Arr.dedupe(
          Arr.flatMap(listed.rows, (row) => {
            const owner = row["ownerId"];
            return Predicate.isString(owner) ? [owner] : [];
          }),
        ),
        byCodePoint,
      );
      expect(owners).toEqual({ rows: expected, total: expected.length });
    },
  );

  it("is not vacuous: anonymous sees each owner's public rows, and no one else's", async () => {
    const { ops, actAs, seed } = seeded(false);
    const owners = await run(
      Effect.andThen(
        seed,
        actAs(anonymous, ops.owners({ limit: 10, offset: 0, includeDeleted: false })),
      ),
    );
    expect(owners.rows).toEqual(Arr.sort([member.id, otherMember.id, follower.id], byCodePoint));
  });

  it("narrows to among, pages, and fails closed past MAX_SET_VALUES", async () => {
    const { ops, actAs, seed } = seeded(false);
    const [among, paged, over] = await run(
      Effect.andThen(
        seed,
        actAs(
          as(admin),
          Effect.all(
            [
              ops.owners({
                limit: 10,
                offset: 0,
                includeDeleted: false,
                among: [member.id, "nobody"],
              }),
              ops.owners({ limit: 1, offset: 1, includeDeleted: false }),
              ops.owners({
                limit: 10,
                offset: 0,
                includeDeleted: false,
                among: Arr.makeBy(MAX_SET_VALUES + 1, (i) => `u-${i}`),
              }),
            ],
            { concurrency: 1 },
          ),
        ),
      ),
    );
    expect(among).toEqual({ rows: [member.id], total: 1 });
    expect(paged.rows).toHaveLength(1);
    // The admin's only row is a tombstone, which `includeDeleted: false` leaves out.
    expect(paged.total).toBe(3);
    expect(over).toEqual({ rows: [], total: 0 });
  });

  it("is empty on a reference leaf, which has no owner", async () => {
    const chain = makeInMemoryChainStore();
    const ops = defineSubtype({
      type: "terms",
      access: { kind: "reference" },
      chain,
      leaves: makeInMemoryLeafStore(chain, { columns: ["name"] }),
      viewer: Effect.succeed(as(admin)),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row: LeafRow) => row,
    });
    await run(ops.create({ id: Option.none(), state: { name: "n" } }));
    expect(await run(ops.owners({ limit: 10, offset: 0, includeDeleted: false }))).toEqual({
      rows: [],
      total: 0,
    });
  });
});

describe("readableOwners", () => {
  const leaf = (type: string, owners: ReadonlyArray<string>, total = owners.length) => ({
    type,
    owners: () => Effect.succeed({ rows: owners, total }),
  });

  it("is the exact, ordered union of each leaf's owners, paged", async () => {
    const leaves = [leaf("posts", ["bo", "ana"]), leaf("pages", ["cy", "bo"]), leaf("media", [])];
    expect(
      await run(readableOwners(leaves, { limit: 2, offset: 1, includeDeleted: false })),
    ).toEqual({ rows: ["bo", "cy"], total: 3 });
  });

  it("refuses a union it can't make exact", async () => {
    const error = await run(
      Effect.flip(
        readableOwners([leaf("posts", ["ana"]), leaf("pages", ["bo"], MAX_PAGE_LIMIT + 1)], {
          limit: 10,
          offset: 0,
          includeDeleted: false,
        }),
      ),
    );
    expect(error).toEqual(new OwnerSetTooLarge({ type: "pages" }));
  });

  it("reads real leaves through their own gates", async () => {
    const posts = seeded(false);
    const pages = seeded(true);
    const union = await run(
      Effect.gen(function* () {
        yield* posts.seed;
        yield* pages.seed;
        return yield* posts.actAs(
          as(otherMember),
          pages.actAs(
            as(otherMember),
            readableOwners([posts.ops, pages.ops], { limit: 10, offset: 0, includeDeleted: false }),
          ),
        );
      }),
    );
    expect(union.rows).toEqual(Arr.sort([member.id, otherMember.id, follower.id], byCodePoint));
  });
});
