/**
 * The subtype factory's access semantics against the in-memory seams.
 *
 * - The row predicate: gardeneria's `packages/database/tests/guards.test.ts`
 *   (`canViewOwnedE`, the follower seam) plus the draft axis (#1118).
 * - The list filter: that it NEVER disagrees with the row predicate — every
 *   row of the visibility × draft × owner matrix, for every viewer, with and
 *   without a draft column. The apps assert this with integration tests
 *   against a real database; here it is exhaustive.
 * - The reference two-state predicate: website's
 *   `apps/api/tests/list-visibility-filters.test.ts` matrix.
 * - The gates: `requireOwnerOrRole`, the create / write split, a missing
 *   owner failing `NotFound`.
 * - The factory end to end: gardeneria's `owned-target-visibility.test.ts`
 *   matrix (a private target refuses a stranger as `NotFound`, accepts its
 *   owner and a moderator; a public one accepts a stranger), and the
 *   handlers' cache write-through (website's `versionRestoreCommand`).
 * - The factory's reads never disagree (`SEC-AUTH-ENUM-001`): `get` and
 *   `getMany` serve exactly the rows `list` does, for every row state ×
 *   viewer, out-of-enum visibility and a `null` or absent draft included
 *   (pulpit#73).
 *
 * @module tests/subtype
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { Visibility } from "../src/content.ts";
import { always, and, eq, evaluate, ne, never } from "../src/filter.ts";
import {
  canViewOwned,
  defineSubtype,
  nobodyFollows,
  ownedAccess,
  ownedListFilter,
  readScopeFor,
  referencePrivacyFilter,
  requireCreator,
  requireWriter,
  softDeleteFilter,
  subtypeHandlers,
  type AccessPolicy,
  type LeafAccess,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type { ColumnValue, Precondition } from "../src/version-chain.ts";
import { makeInMemoryChainStore } from "./in-memory-chain.ts";
import {
  admin,
  contributor,
  follower,
  followersOf,
  gardeneriaPolicy,
  makeInMemoryLeafStore,
  member,
  moderator,
  NOW,
  otherMember,
  websitePolicy,
  type Following,
} from "./in-memory-leaves.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const tagOf = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Option.Option<string>> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
    : Option.none();
};

const as = (account: ViewerAccount): Viewer => Option.some(account);
const anonymous: Viewer = Option.none();

/** `follower` follows `member`; nobody else follows anybody. */
const follows = followersOf(new Map([[follower.id, [member.id]]]));
const nobody = nobodyFollows<Following>(new Set());

// ── The row predicate ─────────────────────────────────────────────────

describe("canViewOwned (the owned-material read predicate)", () => {
  const view = (
    visibility: Visibility,
    viewer: Viewer,
    /* oxlint-disable effect/prefer-option-over-null -- the workspace's optional-field convention (AGENTS.md → Conventions), as in the options types under test */
    options: {
      readonly draft?: boolean | undefined;
      readonly followers?: typeof follows | undefined;
    } = {},
    /* oxlint-enable effect/prefer-option-over-null */
  ) =>
    run(
      canViewOwned(viewer, gardeneriaPolicy, options.followers ?? follows, {
        ownerId: member.id,
        visibility,
        draft: options.draft ?? false,
      }),
    );

  it("public: everyone, anonymous included", async () => {
    expect(await view("public", anonymous)).toBe(true);
    expect(await view("public", as(otherMember))).toBe(true);
  });

  it("private: the owner and moderator+, nobody else", async () => {
    expect(await view("private", as(member))).toBe(true);
    expect(await view("private", as(moderator))).toBe(true);
    expect(await view("private", as(admin))).toBe(true);
    expect(await view("private", as(otherMember))).toBe(false);
    expect(await view("private", as(contributor))).toBe(false);
    expect(await view("private", anonymous)).toBe(false);
  });

  it("followers: the owner, moderator+, and the owner's followers via the seam", async () => {
    expect(await view("followers", as(member))).toBe(true);
    expect(await view("followers", as(moderator))).toBe(true);
    expect(await view("followers", as(follower))).toBe(true);
    expect(await view("followers", as(contributor))).toBe(false);
    expect(await view("followers", anonymous)).toBe(false);
  });

  it("followers: fails closed under the nobody-follows seam", async () => {
    expect(await view("followers", as(follower), { followers: nobody })).toBe(false);
  });

  it("private never consults the follower seam", async () => {
    const everyoneFollows = {
      isFollower: () => Effect.succeed(true),
      following: () => new Set<string>(),
    };
    expect(await view("private", as(otherMember), { followers: everyoneFollows })).toBe(false);
  });

  it("a draft narrows even public to the owner and moderator+ (#1118)", async () => {
    expect(await view("public", anonymous, { draft: true })).toBe(false);
    expect(await view("public", as(otherMember), { draft: true })).toBe(false);
    expect(await view("followers", as(follower), { draft: true })).toBe(false);
    expect(await view("public", as(member), { draft: true })).toBe(true);
    expect(await view("private", as(moderator), { draft: true })).toBe(true);
  });
});

describe("readScopeFor", () => {
  it("anonymous reads public, a member reads their scope, the rung reads all", () => {
    expect(readScopeFor(anonymous, gardeneriaPolicy, follows)).toEqual({ kind: "public" });
    expect(readScopeFor(as(follower), gardeneriaPolicy, follows)).toEqual({
      kind: "member",
      userId: follower.id,
      following: new Set([member.id]),
    });
    expect(readScopeFor(as(moderator), gardeneriaPolicy, follows)).toEqual({ kind: "all" });
    // The rung is the policy's: website's admin-only axis puts a moderator in `member`.
    expect(readScopeFor(as(moderator), websitePolicy, follows).kind).toBe("member");
  });
});

// ── The list filter never disagrees with the row predicate ───────────

describe("ownedListFilter ≡ canViewOwned", () => {
  const viewers: ReadonlyArray<readonly [string, Viewer]> = [
    ["anonymous", anonymous],
    ["the owner", as(member)],
    ["a follower", as(follower)],
    ["a stranger", as(otherMember)],
    ["a contributor", as(contributor)],
    ["a moderator", as(moderator)],
  ];
  const rows: Array<
    LeafRow & { readonly visibility: Visibility; readonly draft: boolean; readonly ownerId: string }
  > = [];
  for (const visibility of ["public", "followers", "private"] as const) {
    for (const draft of [false, true]) {
      for (const ownerId of [member.id, otherMember.id]) {
        rows.push({
          id: `${visibility}-${draft}-${ownerId}`,
          action: "create",
          visibility,
          draft,
          ownerId,
        });
      }
    }
  }
  const columns = new Set(["id", "action", "ownerId", "visibility", "draft"]);

  for (const withDraft of [true, false]) {
    const access = ownedAccess({ draft: withDraft });
    for (const [name, viewer] of viewers) {
      it(`${withDraft ? "with" : "without"} a draft column, for ${name}`, async () => {
        const filter = ownedListFilter(
          access,
          columns,
          readScopeFor(viewer, gardeneriaPolicy, follows),
        );
        for (const row of rows) {
          const listed = evaluate(filter, row, {
            now: NOW,
            contains: (set: Following, value) => Predicate.isString(value) && set.has(value),
          });
          const seen = await run(
            canViewOwned(viewer, gardeneriaPolicy, follows, {
              ownerId: row.ownerId,
              visibility: row.visibility,
              // A leaf without the axis reads every row as not-a-draft.
              draft: withDraft && row.draft,
            }),
          );
          expect(listed, `${row.id}`).toBe(seen);
        }
      });
    }
  }

  it("reads an explicitly undefined draft option as no draft column", () => {
    expect(ownedAccess({ draft: undefined })).toEqual(ownedAccess());
    expect(ownedAccess({ draft: undefined }).draftColumn).toEqual(Option.none());
  });

  it("fails closed when the declaration names a column the view lacks", () => {
    const filter = ownedListFilter(
      ownedAccess({ draft: true }),
      new Set(["id", "action", "ownerId", "visibility"]),
      { kind: "all" },
    );
    expect(filter).toEqual(never);
  });
});

// ── The reference two-state predicate (website's matrix) ─────────────

describe("the reference list predicates", () => {
  const view = new Set(["id", "action", "visibility"]);
  const reader: ViewerAccount = { id: "u1", role: "user" };
  const filters = (viewer: Viewer, includeDeleted: boolean, columns = view) =>
    and<never>(
      softDeleteFilter(viewer, websitePolicy, includeDeleted),
      referencePrivacyFilter(viewer, websitePolicy, columns),
    );
  const inline = (showDeleted: boolean, showPrivate: boolean) =>
    and<never>(
      showDeleted ? always : ne("action", "delete"),
      showPrivate ? always : eq("visibility", "public"),
    );

  it("an anonymous viewer and a non-admin get both filters", () => {
    expect(filters(anonymous, false)).toEqual(inline(false, false));
    expect(filters(as(reader), false)).toEqual(inline(false, false));
  });

  it("an admin who did not ask for deleted rows still gets the soft-delete filter", () => {
    expect(filters(as(admin), false)).toEqual(inline(false, true));
  });

  it("an admin who asked for deleted rows gets neither filter", () => {
    expect(filters(as(admin), true)).toEqual(always);
  });

  it("`includeDeleted` alone does nothing without the rung, and never relaxes privacy", () => {
    expect(filters(as(reader), true)).toEqual(filters(as(reader), false));
    expect(filters(anonymous, true)).toEqual(inline(false, false));
  });

  it("a view with no visibility column rides no privacy axis", () => {
    expect(filters(anonymous, false, new Set(["id", "action"]))).toEqual(ne("action", "delete"));
  });
});

// ── The gates ─────────────────────────────────────────────────────────

describe("the write gates", () => {
  const reference: LeafAccess = { kind: "reference" };
  const owned = ownedAccess();
  const row = { type: "gardens", id: "g1" };
  const ownedBy = (owner: Option.Option<string>) => Effect.succeed(owner);

  it("create: reference data needs the corpus rung, an owned leaf any account", async () => {
    expect(await tagOf(requireCreator(reference, anonymous, gardeneriaPolicy))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(await tagOf(requireCreator(reference, as(member), gardeneriaPolicy))).toEqual(
      Option.some("Forbidden"),
    );
    expect(await tagOf(requireCreator(reference, as(contributor), gardeneriaPolicy))).toEqual(
      Option.none(),
    );
    expect(await tagOf(requireCreator(owned, anonymous, gardeneriaPolicy))).toEqual(
      Option.some("Unauthorized"),
    );
    expect(await tagOf(requireCreator(owned, as(member), gardeneriaPolicy))).toEqual(Option.none());
  });

  it("an owned write admits the owner whatever their rung, and moderator+ on anyone's row", async () => {
    const gate = (viewer: Viewer) =>
      tagOf(requireWriter(owned, viewer, gardeneriaPolicy, row, ownedBy(Option.some(member.id))));
    expect(await gate(as(member))).toEqual(Option.none());
    expect(await gate(as(moderator))).toEqual(Option.none());
    expect(await gate(as(admin))).toEqual(Option.none());
    // Another member below the rung: Forbidden, not NotFound — a write gate may confirm a row the viewer can already see.
    expect(await gate(as(otherMember))).toEqual(Option.some("Forbidden"));
    expect(await gate(as(contributor))).toEqual(Option.some("Forbidden"));
    expect(await gate(anonymous)).toEqual(Option.some("Unauthorized"));
  });

  it("a missing owner on an owned leaf is NotFound, never an open gate", async () => {
    expect(
      await tagOf(
        requireWriter(owned, as(moderator), gardeneriaPolicy, row, ownedBy(Option.none())),
      ),
    ).toEqual(Option.some("NodeNotFound"));
  });

  it("a reference write needs the corpus rung and never loads an owner", async () => {
    const noOwnerLookup = Effect.die("the reference gate must not load an owner");
    expect(
      await tagOf(requireWriter(reference, as(contributor), gardeneriaPolicy, row, noOwnerLookup)),
    ).toEqual(Option.none());
    expect(
      await tagOf(requireWriter(reference, as(member), gardeneriaPolicy, row, noOwnerLookup)),
    ).toEqual(Option.some("Forbidden"));
  });
});

// ── The factory end to end ────────────────────────────────────────────

const ownedPosts = () => {
  const chain = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, ["title", "visibility", "draft"]);
  let viewer: Viewer = anonymous;
  const ops = defineSubtype({
    type: "posts",
    access: ownedAccess({ draft: true }),
    chain,
    leaves,
    viewer: Effect.sync(() => viewer),
    policy: gardeneriaPolicy,
    followers: follows,
    toResource: (row: LeafRow) => ({
      id: row.id,
      title: row["title"],
      visibility: row["visibility"],
    }),
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const post = async (visibility: Visibility, owner: ViewerAccount = member) => {
    const written = await run(
      actAs(
        as(owner),
        ops.create({ id: Option.none(), state: { title: "A post", visibility, draft: false } }),
      ),
    );
    return written.id;
  };
  return { chain, leaves, ops, actAs, post };
};

describe("defineSubtype — an owned leaf", () => {
  it("create stamps the creating account as owner, and records it as the actor", async () => {
    const { chain, leaves, post } = ownedPosts();
    const id = await post("public");
    expect(leaves.owners.get(id)).toBe(member.id);
    expect(chain.rows()[0]!.actorId).toEqual(Option.some(member.id));
  });

  it("a private target refuses a stranger and the anonymous as NotFound, never Forbidden", async () => {
    const { ops, actAs, post } = ownedPosts();
    const id = await post("private");
    expect(await tagOf(actAs(as(otherMember), ops.get(id)))).toEqual(Option.some("NodeNotFound"));
    expect(await tagOf(actAs(anonymous, ops.get(id)))).toEqual(Option.some("NodeNotFound"));
  });

  it("the same target still reads for whoever may see it", async () => {
    const { ops, actAs, post } = ownedPosts();
    const hidden = await post("private");
    const open = await post("public");
    expect(await tagOf(actAs(as(member), ops.get(hidden)))).toEqual(Option.none());
    expect(await tagOf(actAs(as(moderator), ops.get(hidden)))).toEqual(Option.none());
    expect(await tagOf(actAs(as(otherMember), ops.get(open)))).toEqual(Option.none());
  });

  it("a stranger cannot write; the owner can; a flip to private hides the row from the stranger", async () => {
    const { ops, actAs, post } = ownedPosts();
    const id = await post("public");
    expect(await tagOf(actAs(as(otherMember), ops.update({ id, patch: { title: "x" } })))).toEqual(
      Option.some("Forbidden"),
    );
    await run(actAs(as(member), ops.update({ id, patch: { visibility: "private" } })));
    expect(await tagOf(actAs(as(otherMember), ops.get(id)))).toEqual(Option.some("NodeNotFound"));
  });

  it("a tombstone is hidden from all but the view-deleted rung", async () => {
    const { ops, actAs, post } = ownedPosts();
    const id = await post("public");
    await run(actAs(as(member), ops.delete(id)));
    expect(await tagOf(actAs(as(member), ops.get(id)))).toEqual(Option.some("NodeNotFound"));
    expect(await tagOf(actAs(as(moderator), ops.get(id)))).toEqual(Option.none());
  });

  it("list and getMany apply the same facts as get", async () => {
    const { ops, actAs, post } = ownedPosts();
    const open = await post("public");
    const followersOnly = await post("followers");
    const hidden = await post("private");
    const listed = async (who: Viewer, includeDeleted = false) =>
      (
        await run(actAs(who, ops.list({ limit: 50, offset: 0, includeDeleted, where: always })))
      ).rows.map((row) => row.id);
    expect(await listed(anonymous)).toEqual([open]);
    expect((await listed(as(follower))).sort()).toEqual([open, followersOnly].sort());
    expect((await listed(as(member))).sort()).toEqual([open, followersOnly, hidden].sort());
    const many = await run(
      actAs(as(otherMember), ops.getMany([open, followersOnly, hidden, "missing"])),
    );
    expect([...HashMap.keys(many)]).toEqual([open]);
    // A tombstone lists only when the rung asked for it.
    await run(actAs(as(member), ops.delete(open)));
    expect(await listed(anonymous)).toEqual([]);
    expect(await listed(as(moderator))).not.toContain(open);
    expect(await listed(as(moderator), true)).toContain(open);
  });

  it("list clamps the page to the cap and reports the unpaged total", async () => {
    const { ops, actAs, post } = ownedPosts();
    await post("public");
    await post("public");
    const page = await run(
      actAs(anonymous, ops.list({ limit: 1, offset: 0, includeDeleted: false, where: always })),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    const huge = await run(
      actAs(anonymous, ops.list({ limit: 1e9, offset: -5, includeDeleted: false, where: always })),
    );
    expect(huge.rows).toHaveLength(2);
  });

  it("the version history is gated like a write, and a restore appends", async () => {
    const { chain, ops, actAs, post } = ownedPosts();
    const id = await post("public");
    await run(actAs(as(member), ops.update({ id, patch: { title: "Second" } })));
    expect(await tagOf(actAs(as(otherMember), ops.getVersion(id, 0n)))).toEqual(
      Option.some("Forbidden"),
    );
    const snapshot = await run(actAs(as(member), ops.getVersion(id, 0n)));
    expect(snapshot.state["title"]).toBe("A post");
    const restored = await run(actAs(as(moderator), ops.restoreVersion(id, 0n)));
    expect(restored.version).toBe(2n);
    expect(chain.rows()[2]!.actorId).toEqual(Option.some(moderator.id));
  });
});

describe("defineSubtype — the expected-version precondition", () => {
  /** An owned post at head 1, written by its owner. */
  const atHeadOne = async () => {
    const context = ownedPosts();
    const id = await context.post("public");
    await run(context.actAs(as(member), context.ops.update({ id, patch: { title: "Second" } })));
    return { ...context, id };
  };

  type Ops = ReturnType<typeof ownedPosts>["ops"];
  type Write = (
    ops: Ops,
    id: string,
    precondition: Precondition,
  ) => Effect.Effect<{ readonly version: bigint }, { readonly _tag: string }>;

  const writes: ReadonlyArray<readonly [string, Write]> = [
    ["update", (ops, id, p) => ops.update({ id, patch: { title: "Third" }, ...p })],
    ["restore", (ops, id, p) => ops.restore({ id, patch: { title: "Third" }, ...p })],
    ["delete", (ops, id, p) => ops.delete(id, p)],
    ["restoreVersion", (ops, id, p) => ops.restoreVersion(id, 0n, p)],
  ];

  describe.each(writes)("%s", (_name, write) => {
    it("writes when the expected version is the head", async () => {
      const { chain, ops, actAs, id } = await atHeadOne();
      const written = await run(actAs(as(member), write(ops, id, { expectedVersion: 1n })));
      expect(written.version).toBe(2n);
      expect(chain.rows()).toHaveLength(3);
    });

    it("writes nothing on a stale version, failing StaleVersion with the head", async () => {
      const { chain, ops, actAs, id } = await atHeadOne();
      const before = chain.rows();
      const exit = await Effect.runPromiseExit(
        actAs(as(member), write(ops, id, { expectedVersion: 0n })),
      );
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({
        _tag: "StaleVersion",
        type: "posts",
        id,
        expected: 0n,
        current: 1n,
      });
      expect(chain.rows()).toEqual(before);
    });

    it("without one, writes over whatever the head is", async () => {
      const { chain, ops, actAs, id } = await atHeadOne();
      const written = await run(actAs(as(member), write(ops, id, {})));
      expect(written.version).toBe(2n);
      expect(chain.rows()).toHaveLength(3);
    });

    it("gates first: a caller who may not write learns Forbidden, never the head", async () => {
      const { chain, ops, actAs, id } = await atHeadOne();
      expect(await tagOf(actAs(as(otherMember), write(ops, id, { expectedVersion: 0n })))).toEqual(
        Option.some("Forbidden"),
      );
      expect(chain.rows()).toHaveLength(2);
    });
  });

  it("the handlers thread it through, and a stale write neither caches nor evicts", async () => {
    const { ops, actAs, id } = await atHeadOne();
    const cached = MutableHashMap.make<Array<readonly [string, unknown]>>([id, "cached"]);
    const handlers = subtypeHandlers(ops, {
      transact: (effect) => effect,
      cache: Option.some({
        set: (key, resource) => Effect.sync(() => void MutableHashMap.set(cached, key, resource)),
        delete: (key) => Effect.sync(() => void MutableHashMap.remove(cached, key)),
      }),
    });
    const stale = { expectedVersion: 0n };
    expect(
      await tagOf(actAs(as(member), handlers.update({ id, patch: { title: "x" }, ...stale }))),
    ).toEqual(Option.some("StaleVersion"));
    expect(await tagOf(actAs(as(member), handlers.delete(id, stale)))).toEqual(
      Option.some("StaleVersion"),
    );
    expect(
      await tagOf(actAs(as(member), handlers.restoreVersion({ id, version: 0n, ...stale }))),
    ).toEqual(Option.some("StaleVersion"));
    expect(MutableHashMap.get(cached, id)).toEqual(Option.some("cached"));
    const updated = await run(
      actAs(as(member), handlers.update({ id, patch: { title: "Third" }, expectedVersion: 1n })),
    );
    expect(MutableHashMap.get(cached, id)).toEqual(Option.some(updated));
    await run(actAs(as(member), handlers.restoreVersion({ id, version: 0n, expectedVersion: 2n })));
    await run(actAs(as(member), handlers.delete(id, { expectedVersion: 3n })));
    expect(MutableHashMap.has(cached, id)).toBe(false);
  });
});

describe("defineSubtype — a reference leaf", () => {
  it("writes at the corpus rung; reads are public", async () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, ["name"]);
    let viewer: Viewer = as(member);
    const ops = defineSubtype({
      type: "taxa",
      access: { kind: "reference" },
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: nobody,
      toResource: (row: LeafRow) => ({ id: row.id }),
    });
    expect(await tagOf(ops.create({ id: Option.none(), state: { name: "Quercus" } }))).toEqual(
      Option.some("Forbidden"),
    );
    viewer = as(contributor);
    const { id } = await run(ops.create({ id: Option.none(), state: { name: "Quercus" } }));
    expect(leaves.owners.size).toBe(0);
    viewer = anonymous;
    expect(await tagOf(ops.get(id))).toEqual(Option.none());
  });
});

// ── get ≡ list, end to end, over every row state ─────────────────────

/** A column the seeded state omits, so the row carries no such key (`ColumnValue` has no `undefined`). */
const ABSENT = Symbol("absent");
type Seeded = ColumnValue | typeof ABSENT;

/** One seeded node: its creating account (and so its owner), its state, and whether it is tombstoned. */
interface Seed {
  readonly owner: ViewerAccount;
  readonly state: { readonly [column: string]: Seeded };
  readonly deleted: boolean;
}

/** What one viewer's three reads answer for one seeded row. */
interface RowReads {
  readonly row: string;
  readonly listed: boolean;
  /** `get`'s error tag; none when the row reads. */
  readonly got: Option.Option<string>;
  readonly many: boolean;
}

/** A seeded column for a test name: a string quoted, so `"false"` never reads as `false`. */
const showColumn = (seed: Seed, column: string): string =>
  Option.match(Record.get(seed.state, column), {
    onNone: () => "absent",
    onSome: (value) =>
      value === ABSENT ? "absent" : Predicate.isString(value) ? `"${value}"` : String(value),
  });

const labelOf = (seed: Seed): string =>
  `visibility ${showColumn(seed, "visibility")}, draft ${showColumn(seed, "draft")}, owner ${seed.owner.id}${seed.deleted ? ", deleted" : ""}`;

/** A leaf over the in-memory seams, seeded through the factory's own `create` and `delete`. */
const seededLeaf = (
  access: LeafAccess,
  columns: ReadonlyArray<string>,
  policy: AccessPolicy,
  seeds: ReadonlyArray<Seed>,
) => {
  const chain = makeInMemoryChainStore();
  const leaves = makeInMemoryLeafStore(chain, columns);
  let viewer: Viewer = anonymous;
  const ops = defineSubtype({
    type: "leaves",
    access,
    chain,
    leaves,
    viewer: Effect.sync(() => viewer),
    policy,
    followers: follows,
    toResource: (row: LeafRow) => ({ id: row.id }),
  });
  const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      viewer = who;
      return effect;
    });
  const seeding = Effect.forEach(
    seeds,
    (seed) =>
      actAs(
        as(seed.owner),
        ops.create({
          id: Option.none(),
          state: Record.filterMap(seed.state, (value) =>
            value === ABSENT ? Result.failVoid : Result.succeed(value),
          ),
        }),
      ).pipe(
        Effect.tap(({ id }) =>
          seed.deleted ? actAs(as(seed.owner), ops.delete(id)) : Effect.void,
        ),
        Effect.map(({ id }) => id),
      ),
    // One at a time: `actAs` swaps the one viewer the leaf reads.
    { concurrency: 1 },
  );
  /** Every seeded row as one viewer's reads answer it; `list` asks for tombstones, which `get` shows the rung. */
  const reads = (who: Viewer, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const page = yield* actAs(
        who,
        ops.list({ limit: 1000, offset: 0, includeDeleted: true, where: always }),
      );
      const listed = HashSet.fromIterable(page.rows.map((row) => row.id));
      const many = yield* actAs(who, ops.getMany(ids));
      return yield* Effect.forEach(
        Arr.zip(seeds, ids),
        ([seed, id]) =>
          actAs(who, ops.get(id)).pipe(
            Effect.match({
              onFailure: (error) => Option.some(error._tag),
              onSuccess: () => Option.none<string>(),
            }),
            Effect.map((got): RowReads => ({
              row: labelOf(seed),
              listed: HashSet.has(listed, id),
              got,
              many: HashMap.has(many, id),
            })),
          ),
        { concurrency: 1 },
      );
    });
  return run(Effect.map(seeding, (ids) => ({ reads: (who: Viewer) => run(reads(who, ids)) })));
};

/** Every read agrees with `list`: a listed row reads, and an unlisted one is `NodeNotFound`. */
const expectAgreement = (reads: ReadonlyArray<RowReads>) =>
  expect(reads).toEqual(
    reads.map((read) => ({
      ...read,
      got: read.listed ? Option.none() : Option.some("NodeNotFound"),
      many: read.listed,
    })),
  );

/** Each row as `[listed, read by get]`. */
const shownTo = async (leaf: Awaited<ReturnType<typeof seededLeaf>>, who: Viewer) =>
  (await leaf.reads(who)).map((read) => [read.listed, Option.isNone(read.got)] as const);

/** The labels of the rows `list` showed. */
const listedRows = (reads: ReadonlyArray<RowReads>) =>
  reads.filter((read) => read.listed).map((read) => read.row);

const matrixViewers: ReadonlyArray<readonly [string, Viewer]> = [
  ["anonymous", anonymous],
  ["the owner", as(member)],
  ["a follower", as(follower)],
  ["a stranger", as(otherMember)],
  ["a contributor", as(contributor)],
  ["a moderator", as(moderator)],
  ["an admin", as(admin)],
];
const matrixPolicies: ReadonlyArray<readonly [string, AccessPolicy]> = [
  ["gardeneria", gardeneriaPolicy],
  ["website", websitePolicy],
];
/** The enum, a value outside it, `null`, and no key at all. */
const visibilities: ReadonlyArray<Seeded> = [
  "public",
  "followers",
  "private",
  "friends",
  null,
  ABSENT,
];
/** The two booleans, `null`, a stringly `"false"`, and no key at all. */
const drafts: ReadonlyArray<Seeded> = [false, true, null, "false", ABSENT];

/** Every variant × policy × viewer, as `it.each` rows. */
const matrix = <Variant extends object>(variants: ReadonlyArray<Variant>) =>
  Arr.flatMap(variants, (variant) =>
    Arr.flatMap(matrixPolicies, ([policyName, policy]) =>
      Arr.map(matrixViewers, ([viewerName, viewer]) => ({
        ...variant,
        policyName,
        policy,
        viewerName,
        viewer,
      })),
    ),
  );

describe("defineSubtype — get / getMany never serve a row list hides (SEC-AUTH-ENUM-001)", () => {
  const hidden = [false, false] as const;
  const shown = [true, true] as const;

  it("a reference row at `followers` or out of the enum is public to neither read", async () => {
    const leaf = await seededLeaf({ kind: "reference" }, ["visibility"], gardeneriaPolicy, [
      { owner: contributor, state: { visibility: "followers" }, deleted: false },
      { owner: contributor, state: { visibility: "friends" }, deleted: false },
    ]);
    const strangers = [anonymous, as(member), as(follower), as(contributor)];
    expect(await Promise.all(strangers.map((who) => shownTo(leaf, who)))).toEqual(
      strangers.map(() => [hidden, hidden]),
    );
    expect(await shownTo(leaf, as(moderator))).toEqual([shown, shown]);
  });

  it("an owned row whose draft is `null` or absent is a draft to both reads", async () => {
    const leaf = await seededLeaf(
      ownedAccess({ draft: true }),
      ["visibility", "draft"],
      gardeneriaPolicy,
      [
        { owner: member, state: { visibility: "public", draft: null }, deleted: false },
        { owner: member, state: { visibility: "public" }, deleted: false },
      ],
    );
    const strangers = [anonymous, as(follower), as(otherMember), as(contributor)];
    expect(await Promise.all(strangers.map((who) => shownTo(leaf, who)))).toEqual(
      strangers.map(() => [hidden, hidden]),
    );
    const privileged = [as(member), as(moderator)];
    expect(await Promise.all(privileged.map((who) => shownTo(leaf, who)))).toEqual(
      privileged.map(() => [shown, shown]),
    );
  });

  describe("an owned leaf: visibility × draft × owner × tombstone, for every viewer", () => {
    const seeds: ReadonlyArray<Seed> = Arr.flatMap(visibilities, (visibility) =>
      Arr.flatMap(drafts, (draft) =>
        Arr.flatMap([member, otherMember], (owner) =>
          Arr.map([false, true], (deleted) => ({
            owner,
            state: { title: "t", visibility, draft },
            deleted,
          })),
        ),
      ),
    );

    it("is not vacuous: the anonymous read only the live, public, explicitly published rows", async () => {
      const leaf = await seededLeaf(
        ownedAccess({ draft: true }),
        ["title", "visibility", "draft"],
        gardeneriaPolicy,
        seeds,
      );
      const open = seeds
        .filter(
          (seed) =>
            seed.state["visibility"] === "public" && seed.state["draft"] === false && !seed.deleted,
        )
        .map(labelOf);
      expect(open).toHaveLength(2);
      expect(listedRows(await leaf.reads(anonymous))).toEqual(open);
      expect(listedRows(await leaf.reads(as(moderator)))).toEqual(seeds.map(labelOf));
    });

    it.each(
      matrix([
        {
          variant: "with a draft column",
          access: ownedAccess({ draft: true }),
          columns: ["title", "visibility", "draft"],
        },
        {
          variant: "without a draft column",
          access: ownedAccess(),
          columns: ["title", "visibility", "draft"],
        },
      ]),
    )(
      "$variant, $policyName policy, for $viewerName",
      async ({ access, columns, policy, viewer }) => {
        const leaf = await seededLeaf(access, columns, policy, seeds);
        expectAgreement(await leaf.reads(viewer));
      },
    );

    // The declaration names a column the view lacks: the list fails closed, so
    // must the row — no read shows anything, whoever asks.
    it.each(
      matrix([
        {
          variant: "declaring a draft column the view lacks",
          access: ownedAccess({ draft: true }),
          columns: ["title", "visibility"],
        },
        {
          variant: "over a view without its visibility column",
          access: ownedAccess(),
          columns: ["title"],
        },
        {
          variant: "declaring an owner column the view lacks",
          access: { ...ownedAccess({ draft: true }), ownerColumn: "authorId" },
          columns: ["title", "visibility", "draft"],
        },
      ]),
    )(
      "$variant reads nothing, $policyName policy, for $viewerName",
      async ({ access, columns, policy, viewer }) => {
        const leaf = await seededLeaf(access, columns, policy, seeds);
        const reads = await leaf.reads(viewer);
        expectAgreement(reads);
        expect(reads.filter((read) => read.listed || read.many || Option.isNone(read.got))).toEqual(
          [],
        );
      },
    );
  });

  describe("a reference leaf: visibility × tombstone, for every viewer", () => {
    const seeds: ReadonlyArray<Seed> = Arr.flatMap(visibilities, (visibility) =>
      Arr.map([false, true], (deleted) => ({
        owner: admin,
        state: { name: "n", visibility },
        deleted,
      })),
    );

    it("is not vacuous: the anonymous read only the live, exactly public row", async () => {
      const leaf = await seededLeaf(
        { kind: "reference" },
        ["name", "visibility"],
        gardeneriaPolicy,
        seeds,
      );
      const open = seeds
        .filter((seed) => seed.state["visibility"] === "public" && !seed.deleted)
        .map(labelOf);
      expect(open).toHaveLength(1);
      expect(listedRows(await leaf.reads(anonymous))).toEqual(open);
      expect(listedRows(await leaf.reads(as(moderator)))).toEqual(seeds.map(labelOf));
    });

    it.each(
      matrix([
        { variant: "with a visibility column", columns: ["name", "visibility"] },
        { variant: "over a view without a visibility column", columns: ["name"] },
      ]),
    )("$variant, $policyName policy, for $viewerName", async ({ columns, policy, viewer }) => {
      const leaf = await seededLeaf({ kind: "reference" }, columns, policy, seeds);
      expectAgreement(await leaf.reads(viewer));
    });
  });
});

describe("subtypeHandlers — the handlers seam", () => {
  it("writes every mutation through the cache inside the write boundary, and evicts on delete", async () => {
    const { ops, actAs, post } = ownedPosts();
    const cached = new Map<string, unknown>();
    const log: Array<string> = [];
    const handlers = subtypeHandlers(ops, {
      transact: (effect) =>
        Effect.andThen(
          Effect.sync(() => log.push("transact")),
          effect,
        ),
      cache: Option.some({
        set: (id, resource) => Effect.sync(() => void cached.set(id, resource)),
        delete: (id) => Effect.sync(() => void cached.delete(id)),
      }),
    });
    const id = await post("public");
    const updated = await run(
      actAs(as(member), handlers.update({ id, patch: { title: "Cached" } })),
    );
    expect(updated).toMatchObject({ id, title: "Cached" });
    expect(cached.get(id)).toEqual(updated);
    const restored = await run(actAs(as(member), handlers.restoreVersion({ id, version: 0n })));
    expect(cached.get(id)).toMatchObject({ title: "A post" });
    expect(restored).toEqual(cached.get(id));
    await run(actAs(as(member), handlers.delete(id)));
    expect(cached.has(id)).toBe(false);
    expect(log).toEqual(["transact", "transact", "transact"]);
  });
});
