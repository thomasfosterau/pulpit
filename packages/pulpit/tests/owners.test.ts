/**
 * Distinct readable owners: `SubtypeOps.owners` agrees with the
 * owners of `list`'s rows for every viewer, gated and ungated, and
 * `readableOwners` is their exact union across leaves.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { MAX_SET_VALUES } from "../src/Filter.ts";
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
} from "../src/Subtype.ts";
import {
  makeInMemoryVersionChain,
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
  Effect.andThen(TestClock.setTime(NOW.getTime()), effect);

/** An owned leaf, gated or not, seeded with every visibility × draft × owner, and one tombstone. */
const seeded = (gated: boolean) => {
  const chain = makeInMemoryVersionChain("posts");
  const heads = makeInMemoryLeafStore(chain, { columns: ["title", "visibility", "draft"] });
  const publication = makeInMemoryPublication({ chain, leaves: heads, now: NOW });
  let viewer: Viewer = anonymous;
  const leaf = {
    type: "posts",
    access: ownedAccess({ draft: true }),
    chain,
    leaves: gated ? publication.leaves : heads,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: follows,
    toResource: (row: LeafRow) => row,
  };
  const ops = defineSubtype(
    gated ? { ...leaf, publication: { live: publication.live, facts: publication.facts } } : leaf,
  );
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

  it.effect.each(cases)("agrees with list's rows for $label", ({ gated, viewer, includeDeleted }) =>
    Effect.gen(function* () {
      const { ops, actAs, seed } = seeded(gated);
      const [owners, listed] = yield* run(
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
            return P.isString(owner) ? [owner] : [];
          }),
        ),
        byCodePoint,
      );
      expect(owners).toEqual({ rows: expected, total: expected.length });
    }),
  );

  it.effect("is not vacuous: anonymous sees each owner's public rows, and no one else's", () =>
    Effect.gen(function* () {
      const { ops, actAs, seed } = seeded(false);
      const owners = yield* run(
        Effect.andThen(
          seed,
          actAs(anonymous, ops.owners({ limit: 10, offset: 0, includeDeleted: false })),
        ),
      );
      expect(owners.rows).toEqual(Arr.sort([member.id, otherMember.id, follower.id], byCodePoint));
    }),
  );

  it.effect("narrows to among, pages, and fails closed past MAX_SET_VALUES", () =>
    Effect.gen(function* () {
      const { ops, actAs, seed } = seeded(false);
      const [among, paged, over] = yield* run(
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
    }),
  );

  it.effect("is empty on a reference leaf, which has no owner", () =>
    Effect.gen(function* () {
      const chain = makeInMemoryVersionChain("terms");
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
      yield* run(ops.create({ id: Option.none(), state: { name: "n" } }));
      expect(yield* run(ops.owners({ limit: 10, offset: 0, includeDeleted: false }))).toEqual({
        rows: [],
        total: 0,
      });
    }),
  );
});
const ownedLeaf = (type: string, owners: ReadonlyArray<string>, total = owners.length) => ({
  type,
  owners: () => Effect.succeed({ rows: owners, total }),
});

describe("readableOwners", () => {
  it.effect("is the exact, ordered union of each leaf's owners, paged", () =>
    Effect.gen(function* () {
      const leaves = [
        ownedLeaf("posts", ["bo", "ana"]),
        ownedLeaf("pages", ["cy", "bo"]),
        ownedLeaf("media", []),
      ];
      expect(
        yield* run(readableOwners(leaves, { limit: 2, offset: 1, includeDeleted: false })),
      ).toEqual({ rows: ["bo", "cy"], total: 3 });
    }),
  );

  it.effect("refuses a union it can't make exact", () =>
    Effect.gen(function* () {
      const error = yield* run(
        Effect.flip(
          readableOwners(
            [ownedLeaf("posts", ["ana"]), ownedLeaf("pages", ["bo"], MAX_PAGE_LIMIT + 1)],
            {
              limit: 10,
              offset: 0,
              includeDeleted: false,
            },
          ),
        ),
      );
      expect(error).toEqual(new OwnerSetTooLarge({ type: "pages" }));
    }),
  );

  it.effect("reads real leaves through their own gates", () =>
    Effect.gen(function* () {
      const posts = seeded(false);
      const pages = seeded(true);
      const union = yield* run(
        Effect.gen(function* () {
          yield* posts.seed;
          yield* pages.seed;
          return yield* posts.actAs(
            as(otherMember),
            pages.actAs(
              as(otherMember),
              readableOwners([posts.ops, pages.ops], {
                limit: 10,
                offset: 0,
                includeDeleted: false,
              }),
            ),
          );
        }),
      );
      expect(union.rows).toEqual(Arr.sort([member.id, otherMember.id, follower.id], byCodePoint));
    }),
  );
});
