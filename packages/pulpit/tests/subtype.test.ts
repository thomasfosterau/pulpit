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
 *   (pulpit#73), and an owner column holding no string read as no owner
 *   (pulpit#85).
 * - A reference leaf's write and history operations answer every row ×
 *   caller × operation as that caller's `get` implies, and a refused one
 *   writes nothing (pulpit#101).
 * - A reference leaf's `followers` rows, read through its declared
 *   `followersOfColumn` (pulpit#92): the list arm's shape, and `get` /
 *   `getMany` / `list` and the write and history gates agreeing for every
 *   visibility × curator × tombstone × viewer, the named curator reading
 *   its own `followers` rows (never its `private` ones), and a non-string
 *   curator matching no viewer and never reaching the follower seam.
 *
 * @module tests/subtype
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { Visibility } from "../src/content.ts";
import { always, and, eq, evaluate, isIn, ne, never, or } from "../src/filter.ts";
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
  type FollowerSeam,
  type LeafAccess,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "../src/subtype.ts";
import type { ColumnValue, Precondition } from "../src/version-chain.ts";
import { ABSENT } from "./fixtures.ts";
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

  describe("the followers arm (pulpit#92)", () => {
    /** A view's column set, with the `id` and `action` every view carries. */
    const viewOf = (...columns: ReadonlyArray<string>): ReadonlySet<string> =>
      // oxlint-disable-next-line effect/avoid-native-object-helpers -- a view's column set is the native `ReadonlySet` `LeafStore.columns` names
      new Set(["id", "action", ...columns]);
    const curated = viewOf("visibility", "curatorId");
    const declared: Extract<LeafAccess, { kind: "reference" }> = {
      kind: "reference",
      followersOfColumn: "curatorId",
    };
    const privacy = (
      viewer: Viewer,
      columns: ReadonlySet<string> = curated,
      access: Option.Option<Extract<LeafAccess, { kind: "reference" }>> = Option.some(declared),
    ) =>
      referencePrivacyFilter(
        viewer,
        websitePolicy,
        columns,
        Option.map(access, (leaf) => ({ access: leaf, followers: follows })),
      );

    it("a signed-in viewer also lists the followers rows whose column names them or an account they follow", () => {
      expect(privacy(as(follower))).toEqual(
        or(
          eq("visibility", "public"),
          and(
            eq("visibility", "followers"),
            or(eq("curatorId", follower.id), isIn("curatorId", follows.following(follower.id))),
          ),
        ),
      );
    });

    it("the anonymous list only public rows, and the rung everything", () => {
      expect(privacy(anonymous)).toEqual(eq("visibility", "public"));
      expect(privacy(as(admin))).toEqual(always);
    });

    it("no arm without a declared column the view carries, or without the seam", () => {
      expect(privacy(as(follower), viewOf("visibility"))).toEqual(eq("visibility", "public"));
      expect(privacy(as(follower), curated, Option.some({ kind: "reference" }))).toEqual(
        eq("visibility", "public"),
      );
      expect(
        privacy(
          as(follower),
          curated,
          Option.some({ kind: "reference", followersOfColumn: undefined }),
        ),
      ).toEqual(eq("visibility", "public"));
      // No follower seam: a member lists as the anonymous do.
      expect(privacy(as(follower), curated, Option.none())).toEqual(eq("visibility", "public"));
    });

    it("a view with no visibility column still rides no privacy axis", () => {
      expect(privacy(anonymous, viewOf("curatorId"))).toEqual(always);
    });
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

  it("the write and history gates confirm existence: a stranger gets Forbidden on every hidden row, the anonymous Unauthorized (pulpit#24)", async () => {
    const { ops, actAs, post } = ownedPosts();
    const draft = await run(
      actAs(
        as(member),
        ops.create({
          id: Option.none(),
          state: { title: "A draft", visibility: "public", draft: true },
        }),
      ),
    );
    const tombstone = await post("public");
    await run(actAs(as(member), ops.delete(tombstone)));
    const hidden = [await post("private"), await post("followers"), draft.id, tombstone];
    const gated = (
      id: string,
    ): ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> => [
      ops.update({ id, patch: { title: "x" } }),
      ops.restore({ id, patch: {} }),
      ops.delete(id),
      ops.getVersion(id, 0n),
      ops.restoreVersion(id, 0n),
    ];
    /** The failure tag `who` gets from `effect`, as an Effect so the probes run in sequence. */
    const tag = <A, E extends { readonly _tag: string }>(
      who: Viewer,
      effect: Effect.Effect<A, E>,
    ) =>
      Effect.map(Effect.exit(actAs(who, effect)), (exit) =>
        Exit.isFailure(exit)
          ? Option.map(Exit.findErrorOption(exit), (error) => error._tag)
          : Option.none(),
      );
    // The reads hide each row from the stranger (SEC-AUTH-ENUM-001) …
    expect(
      await run(
        Effect.forEach(hidden, (id) => tag(as(otherMember), ops.get(id)), { concurrency: 1 }),
      ),
    ).toEqual(Arr.map(hidden, () => Option.some("NodeNotFound")));
    // … but the write and history gates disclose that it exists, while the
    // anonymous get the same answer as for a missing id.
    const cases = Arr.flatMap([...hidden, "missing"], (id) =>
      Arr.map(gated(id), (op) => [id, op] as const),
    );
    const observed = await run(
      Effect.forEach(
        cases,
        ([id, op]) =>
          Effect.map(
            Effect.all(
              { stranger: tag(as(otherMember), op), anonymous: tag(anonymous, op) },
              { concurrency: 1 },
            ),
            (answers) => ({ id, ...answers }),
          ),
        // One probe at a time: `actAs` sets a shared viewer.
        { concurrency: 1 },
      ),
    );
    expect(observed).toEqual(
      Arr.map(cases, ([id]) => ({
        id,
        stranger: Option.some(id === "missing" ? "NodeNotFound" : "Forbidden"),
        anonymous: Option.some("Unauthorized"),
      })),
    );
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

type Seeded = ColumnValue | typeof ABSENT;

/**
 * One seeded node: its creating account (and so its owner), its state, and
 * whether it is tombstoned. An `unstamped` node loses the factory's owner
 * stamp after it is seeded, so its owner column is whatever its state
 * carries under `ownerId` (no key when absent).
 */
interface Seed {
  readonly owner: ViewerAccount;
  readonly state: { readonly [column: string]: Seeded };
  readonly deleted: boolean;
  // oxlint-disable-next-line effect/prefer-option-over-null -- the workspace's optional-field convention (AGENTS.md → Conventions)
  readonly unstamped?: boolean | undefined;
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
  `visibility ${showColumn(seed, "visibility")}, draft ${showColumn(seed, "draft")}, owner ${seed.unstamped === true ? showColumn(seed, "ownerId") : seed.owner.id}${Record.has(seed.state, "curatorId") ? `, curator ${showColumn(seed, "curatorId")}` : ""}${seed.deleted ? ", deleted" : ""}`;

/** A leaf over the in-memory seams, seeded through the factory's own `create` and `delete`. */
const seededLeaf = (
  access: LeafAccess,
  columns: ReadonlyArray<string>,
  policy: AccessPolicy,
  seeds: ReadonlyArray<Seed>,
  followers: FollowerSeam<Following, never> = follows,
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
    followers,
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
        Effect.tap(({ id }) =>
          Effect.sync(() => {
            if (seed.unstamped === true) leaves.owners.delete(id);
          }),
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

  describe("a reference leaf with a followers column: visibility × curator × tombstone, for every viewer (pulpit#92)", () => {
    const curated: Extract<LeafAccess, { kind: "reference" }> = {
      kind: "reference",
      followersOfColumn: "curatorId",
    };
    /** `member` is followed by `follower`; the rest name nobody anyone follows, or no account at all. */
    const curators: ReadonlyArray<Seeded> = [member.id, otherMember.id, null, ABSENT, 42];
    const seeds: ReadonlyArray<Seed> = Arr.flatMap(visibilities, (visibility) =>
      Arr.flatMap(curators, (curatorId) =>
        Arr.map([false, true], (deleted) => ({
          owner: admin,
          state: { name: "n", visibility, curatorId },
          deleted,
        })),
      ),
    );
    const live = seeds.filter((seed) => !seed.deleted);
    const publicRows = live.filter((seed) => seed.state["visibility"] === "public").map(labelOf);

    it("is not vacuous: the named account and its follower read its live followers rows, and nobody else below the rung does", async () => {
      const leaf = await seededLeaf(
        curated,
        ["name", "visibility", "curatorId"],
        gardeneriaPolicy,
        seeds,
      );
      expect(listedRows(await leaf.reads(as(follower)))).toEqual(
        live
          .filter(
            (seed) =>
              seed.state["visibility"] === "public" ||
              (seed.state["visibility"] === "followers" && seed.state["curatorId"] === member.id),
          )
          .map(labelOf),
      );
      // Each account the column names reads its own followers rows, never its private ones.
      const named = [member, otherMember];
      expect(
        await Promise.all(named.map(async (account) => listedRows(await leaf.reads(as(account))))),
      ).toEqual(
        named.map((account) =>
          live
            .filter(
              (seed) =>
                seed.state["visibility"] === "public" ||
                (seed.state["visibility"] === "followers" &&
                  seed.state["curatorId"] === account.id),
            )
            .map(labelOf),
        ),
      );
      const strangers = [anonymous, as(contributor)];
      expect(
        await Promise.all(strangers.map(async (viewer) => listedRows(await leaf.reads(viewer)))),
      ).toEqual(strangers.map(() => publicRows));
      expect(listedRows(await leaf.reads(as(moderator)))).toEqual(seeds.map(labelOf));
    });

    it("the named account reads its own followers row, not its private row, without following anybody", async () => {
      const leaf = await seededLeaf(
        curated,
        ["name", "visibility", "curatorId"],
        gardeneriaPolicy,
        Arr.map(["followers", "private"] as const, (visibility) => ({
          owner: admin,
          state: { name: "n", visibility, curatorId: otherMember.id },
          deleted: false,
        })),
        nobody,
      );
      const reads = await leaf.reads(as(otherMember));
      expectAgreement(reads);
      expect(await shownTo(leaf, as(otherMember))).toEqual([
        [true, true],
        [false, false],
      ]);
      expect(await shownTo(leaf, as(member))).toEqual([
        [false, false],
        [false, false],
      ]);
    });

    it("a declared column the view lacks opens no followers row, fail closed", async () => {
      const leaf = await seededLeaf(curated, ["name", "visibility"], gardeneriaPolicy, seeds);
      const reads = await leaf.reads(as(follower));
      expectAgreement(reads);
      expect(listedRows(reads)).toEqual(publicRows);
    });

    it("asks the follower seam only about a string", async () => {
      const asked: Array<unknown> = [];
      const recording: FollowerSeam<Following, never> = {
        isFollower: (followerId, ownerId) =>
          Effect.sync(() => {
            asked.push(ownerId);
            return followerId === follower.id && ownerId === member.id;
          }),
        following: follows.following,
      };
      const leaf = await seededLeaf(
        curated,
        ["name", "visibility", "curatorId"],
        gardeneriaPolicy,
        seeds,
        recording,
      );
      expectAgreement(await leaf.reads(as(follower)));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((ownerId) => !Predicate.isString(ownerId))).toEqual([]);
    });

    it.each(
      matrix([
        {
          variant: "declaring a column the view carries",
          access: curated,
          columns: ["name", "visibility", "curatorId"],
        },
        {
          variant: "declaring a column the view lacks",
          access: curated,
          columns: ["name", "visibility"],
        },
        {
          variant: "declaring none",
          access: { kind: "reference" } as const,
          columns: ["name", "visibility", "curatorId"],
        },
        {
          variant: "over a view without a visibility column",
          access: curated,
          columns: ["name", "curatorId"],
        },
      ]),
    )(
      "$variant, $policyName policy, for $viewerName",
      async ({ access, columns, policy, viewer }) => {
        const leaf = await seededLeaf(access, columns, policy, seeds);
        expectAgreement(await leaf.reads(viewer));
      },
    );
  });
});

describe("defineSubtype — an owner column holding no string is no owner (pulpit#85)", () => {
  /** Accounts whose ids are what `String` makes of a `NULL`, an absent key and `42`. */
  const nullId: ViewerAccount = { id: "null", role: "user" };
  const undefinedId: ViewerAccount = { id: "undefined", role: "user" };
  const fortyTwo: ViewerAccount = { id: "42", role: "user" };
  /** A seam under which each of them follows all of those ids, recording what it is asked. */
  const strings = [nullId.id, undefinedId.id, fortyTwo.id];
  const asked: Array<string> = [];
  const fans: FollowerSeam<Following, never> = {
    isFollower: (followerId, ownerId) =>
      Effect.sync(() => {
        asked.push(ownerId);
        return strings.includes(followerId) && strings.includes(ownerId);
      }),
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- the in-memory leaf store's follower set is the native `ReadonlySet` its `Following` type names
    following: (followerId) => new Set(strings.includes(followerId) ? strings : []),
  };

  const owners: ReadonlyArray<Seeded> = [null, ABSENT, 42];
  const seeds: ReadonlyArray<Seed> = Arr.flatMap(owners, (ownerId) =>
    Arr.flatMap(["public", "followers", "private"] as const, (visibility) =>
      Arr.map([false, true], (draft) => ({
        owner: member,
        state: { title: "t", visibility, draft, ownerId },
        deleted: false,
        unstamped: true,
      })),
    ),
  );
  /** The one row each viewer may see: public, published, whoever owns it. */
  const open = seeds
    .filter((seed) => seed.state["visibility"] === "public" && seed.state["draft"] === false)
    .map(labelOf);

  const viewers: ReadonlyArray<readonly [string, Viewer]> = [
    ["anonymous", anonymous],
    ['an account whose id is "null"', as(nullId)],
    ['an account whose id is "undefined"', as(undefinedId)],
    ['an account whose id is "42"', as(fortyTwo)],
    ["a member", as(member)],
  ];

  it.each(
    Arr.flatMap(matrixPolicies, ([policyName, policy]) =>
      Arr.map(viewers, ([viewerName, viewer]) => ({ policyName, policy, viewerName, viewer })),
    ),
  )(
    "matches no viewer and asks no follower, $policyName policy, for $viewerName",
    async ({ policy, viewer }) => {
      asked.length = 0;
      const leaf = await seededLeaf(
        ownedAccess({ draft: true }),
        ["title", "visibility", "draft"],
        policy,
        seeds,
        fans,
      );
      const reads = await leaf.reads(viewer);
      expectAgreement(reads);
      expect(listedRows(reads)).toEqual(open);
      expect(asked).toEqual([]);
    },
  );

  describe("a reference leaf's followers column holding no string names nobody (pulpit#92)", () => {
    const curated: Extract<LeafAccess, { kind: "reference" }> = {
      kind: "reference",
      followersOfColumn: "curatorId",
    };
    const referenceSeeds: ReadonlyArray<Seed> = Arr.flatMap(owners, (curatorId) =>
      Arr.map(["public", "followers", "private"] as const, (visibility) => ({
        owner: admin,
        state: { name: "n", visibility, curatorId },
        deleted: false,
      })),
    );
    const publicRows = referenceSeeds
      .filter((seed) => seed.state["visibility"] === "public")
      .map(labelOf);
    const seams: ReadonlyArray<readonly [string, FollowerSeam<Following, never>]> = [
      ["each follows the coerced ids", fans],
      ["nobody follows anybody", nobody],
    ];

    it.each(
      Arr.flatMap(seams, ([seamName, seam]) =>
        Arr.map(viewers, ([viewerName, viewer]) => ({ seamName, seam, viewerName, viewer })),
      ),
    )(
      "matches no viewer and asks no follower, $seamName, for $viewerName",
      async ({ seam, viewer }) => {
        asked.length = 0;
        const leaf = await seededLeaf(
          curated,
          ["name", "visibility", "curatorId"],
          gardeneriaPolicy,
          referenceSeeds,
          seam,
        );
        const reads = await leaf.reads(viewer);
        expectAgreement(reads);
        expect(listedRows(reads)).toEqual(publicRows);
        expect(asked).toEqual([]);
      },
    );

    it('is not vacuous: a followers column holding the string "null" is that account\'s', async () => {
      const leaf = await seededLeaf(
        curated,
        ["name", "visibility", "curatorId"],
        gardeneriaPolicy,
        [
          {
            owner: admin,
            state: { name: "n", visibility: "followers", curatorId: "null" },
            deleted: false,
          },
        ],
        nobody,
      );
      expect(await shownTo(leaf, as(nullId))).toEqual([[true, true]]);
      expect(await shownTo(leaf, as(undefinedId))).toEqual([[false, false]]);
    });
  });

  it("still shows every row to the view-private rung", async () => {
    const leaf = await seededLeaf(
      ownedAccess({ draft: true }),
      ["title", "visibility", "draft"],
      gardeneriaPolicy,
      seeds,
      fans,
    );
    const reads = await leaf.reads(as(moderator));
    expectAgreement(reads);
    expect(listedRows(reads)).toEqual(seeds.map(labelOf));
  });

  it('is not vacuous: an owner column holding the string "null" is that account\'s', async () => {
    asked.length = 0;
    const leaf = await seededLeaf(
      ownedAccess({ draft: true }),
      ["title", "visibility", "draft"],
      gardeneriaPolicy,
      [
        {
          owner: member,
          state: { title: "t", visibility: "private", draft: true, ownerId: "null" },
          deleted: false,
          unstamped: true,
        },
        {
          owner: member,
          state: { title: "t", visibility: "followers", draft: false, ownerId: "null" },
          deleted: false,
          unstamped: true,
        },
      ],
      fans,
    );
    expect(await shownTo(leaf, as(nullId))).toEqual([
      [true, true],
      [true, true],
    ]);
    // `"42"` follows `"null"`: the seam is asked, and its answer is the read's.
    expect(await shownTo(leaf, as(fortyTwo))).toEqual([
      [false, false],
      [true, true],
    ]);
    expect(asked).toContain("null");
  });
});

// ── A reference row's write and history gates answer as `get` does ────

describe("defineSubtype — a reference leaf's write and history gates answer a hidden row as get does (pulpit#101)", () => {
  /** Roles that split the view rungs apart: each corpus writer holds at most one of them. */
  const curator: ViewerAccount = { id: "u-curator", role: "curator" };
  const archivist: ViewerAccount = { id: "u-archivist", role: "archivist" };
  const roleIn =
    (...roles: ReadonlyArray<string>) =>
    (account: ViewerAccount) =>
      roles.includes(account.role);
  /** The corpus rung without, with view-private only, with view-deleted only, and with both. */
  const splitPolicy: AccessPolicy = {
    canWriteCorpus: roleIn("contributor", "curator", "archivist", "moderator", "admin"),
    canViewPrivate: roleIn("curator", "moderator", "admin"),
    canViewDeleted: roleIn("archivist", "moderator", "admin"),
    canModerate: roleIn("moderator", "admin"),
  };
  const policies: ReadonlyArray<readonly [string, AccessPolicy]> = [
    ["split", splitPolicy],
    ...matrixPolicies,
  ];
  const viewers: ReadonlyArray<readonly [string, Viewer]> = [
    ["anonymous", anonymous],
    ["a member below the corpus rung", as(member)],
    ["a contributor (corpus rung, no view rung)", as(contributor)],
    ["a curator (corpus rung, view-private)", as(curator)],
    ["an archivist (corpus rung, view-deleted)", as(archivist)],
    ["a moderator", as(moderator)],
    ["an admin", as(admin)],
  ];

  /** One reference row: its label, state and whether it is tombstoned. */
  interface RefSeed {
    readonly label: string;
    readonly state: { readonly [column: string]: ColumnValue };
    readonly deleted: boolean;
  }
  const seeds: ReadonlyArray<RefSeed> = [
    { label: "public", state: { name: "n", visibility: "public" }, deleted: false },
    { label: "private", state: { name: "n", visibility: "private" }, deleted: false },
    { label: "followers", state: { name: "n", visibility: "followers" }, deleted: false },
    {
      label: "followers of the member",
      state: { name: "n", visibility: "followers", curatorId: member.id },
      deleted: false,
    },
    {
      label: "followers of another",
      state: { name: "n", visibility: "followers", curatorId: otherMember.id },
      deleted: false,
    },
    {
      label: "private, curated by the member",
      state: { name: "n", visibility: "private", curatorId: member.id },
      deleted: false,
    },
    {
      label: "tombstoned followers of the member",
      state: { name: "n", visibility: "followers", curatorId: member.id },
      deleted: true,
    },
    { label: "out of the enum", state: { name: "n", visibility: "friends" }, deleted: false },
    { label: "null visibility", state: { name: "n", visibility: null }, deleted: false },
    {
      label: "public draft",
      state: { name: "n", visibility: "public", draft: true },
      deleted: false,
    },
    { label: "tombstoned public", state: { name: "n", visibility: "public" }, deleted: true },
    { label: "tombstoned private", state: { name: "n", visibility: "private" }, deleted: true },
  ];

  /**
   * Every gated operation. The history reads run twice: at version `0n`,
   * which every seeded row has, and at {@link ABSENT_VERSION}, which none
   * has, so a chain lookup that ran before the gate would answer a hidden
   * row `VersionNotFound` where a missing id answers `NodeNotFound`.
   */
  const operations = [
    "update",
    "restore",
    "delete",
    "getVersion",
    "restoreVersion",
    "getVersion absent",
    "restoreVersion absent",
  ] as const;
  type Operation = (typeof operations)[number];
  /** A version no seeded row reaches. */
  const ABSENT_VERSION = 99n;
  const absentVersion = (operation: Operation) =>
    operation === "getVersion absent" || operation === "restoreVersion absent";

  /** A leaf declaring the followers column the `curatorId` seeds fill (pulpit#92). */
  const curated: Extract<LeafAccess, { kind: "reference" }> = {
    kind: "reference",
    followersOfColumn: "curatorId",
  };
  /** The corpus writer without a view rung follows `member`: the followers arm is its only way in. */
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- `followersOf` takes the native `ReadonlyMap` table the other seams in this file pass
  const corpusFollowers = followersOf(new Map([[contributor.id, [member.id]]]));

  /** A fresh reference leaf seeded (by an admin) with every row, plus a missing id. */
  const referenceLeaf = (
    policy: AccessPolicy,
    columns: ReadonlyArray<string>,
    access: Extract<LeafAccess, { kind: "reference" }>,
  ) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, columns);
    let viewer: Viewer = anonymous;
    const ops = defineSubtype({
      type: "terms",
      access,
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy,
      followers: corpusFollowers,
      toResource: (row: LeafRow) => ({ id: row.id, name: row["name"] }),
    });
    const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    const seeding = Effect.forEach(
      seeds,
      (seed) =>
        actAs(as(admin), ops.create({ id: Option.none(), state: seed.state })).pipe(
          Effect.tap(({ id }) => (seed.deleted ? actAs(as(admin), ops.delete(id)) : Effect.void)),
          Effect.map(({ id }) => [seed.label, id] as const),
        ),
      { concurrency: 1 },
    );
    return Effect.map(seeding, (ids) => ({
      chain,
      ops,
      actAs,
      ids: [...ids, ["missing", "missing"] as const],
    }));
  };

  type Leaf = Effect.Success<ReturnType<typeof referenceLeaf>>;

  const invoke = (
    leaf: Leaf,
    operation: Operation,
    id: string,
  ): Effect.Effect<unknown, { readonly _tag: string }> =>
    Match.value(operation).pipe(
      Match.when("update", () => leaf.ops.update({ id, patch: { name: "rewritten" } })),
      Match.when("restore", () => leaf.ops.restore({ id, patch: { name: "revived" } })),
      Match.when("delete", () => leaf.ops.delete(id)),
      Match.when("getVersion", () => leaf.ops.getVersion(id, 0n)),
      Match.when("restoreVersion", () => leaf.ops.restoreVersion(id, 0n)),
      Match.when("getVersion absent", () => leaf.ops.getVersion(id, ABSENT_VERSION)),
      Match.when("restoreVersion absent", () => leaf.ops.restoreVersion(id, ABSENT_VERSION)),
      Match.exhaustive,
    );

  const failureTag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
    Effect.match(effect, {
      onFailure: (error) => Option.some(error._tag),
      onSuccess: () => Option.none<string>(),
    });

  /**
   * What `get` implies for `operation` on a row: the gate's answer for a
   * caller below the rung, `get`'s `NodeNotFound` for a row it hides, and
   * otherwise the chain's own answer (only `update` refuses a tombstone,
   * and a history read at an absent version is `VersionNotFound` only for a
   * row `get` serves).
   */
  const implied = (
    viewer: Viewer,
    policy: AccessPolicy,
    got: Option.Option<string>,
    operation: Operation,
    tombstoned: boolean,
  ): Option.Option<string> =>
    Option.match(viewer, {
      onNone: () => Option.some("Unauthorized"),
      onSome: (account) => {
        if (!policy.canWriteCorpus(account)) return Option.some("Forbidden");
        if (Option.isSome(got)) return got;
        if (absentVersion(operation)) return Option.some("VersionNotFound");
        return operation === "update" && tombstoned ? Option.some("NodeNotFound") : Option.none();
      },
    });

  /** Every row × operation as one viewer gets it: `get`'s answer, the operation's, and whether the chain grew. */
  const probe = (
    policy: AccessPolicy,
    columns: ReadonlyArray<string>,
    viewer: Viewer,
    access: Extract<LeafAccess, { kind: "reference" }> = { kind: "reference" },
  ) =>
    Effect.forEach(
      Arr.flatMap(operations, (operation) =>
        Arr.map([...seeds.map((seed) => seed.label), "missing"], (label) => ({
          operation,
          label,
        })),
      ),
      ({ operation, label }) =>
        Effect.gen(function* () {
          // A fresh leaf per probe: a write that lands changes the row.
          const leaf = yield* referenceLeaf(policy, columns, access);
          const id = yield* Option.match(
            Arr.findFirst(leaf.ids, ([seeded]) => seeded === label),
            {
              onNone: () => Effect.die(`no seeded row labelled ${label}`),
              onSome: ([, seededId]) => Effect.succeed(seededId),
            },
          );
          const got = yield* leaf.actAs(viewer, failureTag(leaf.ops.get(id)));
          const before = leaf.chain.rows().length;
          const answer = yield* leaf.actAs(viewer, failureTag(invoke(leaf, operation, id)));
          const tombstoned = seeds.some((seed) => seed.label === label && seed.deleted);
          return {
            operation,
            label,
            answer,
            implied: implied(viewer, policy, got, operation, tombstoned),
            wrote: leaf.chain.rows().length > before,
            got,
          };
        }),
      { concurrency: 1 },
    );

  const columnVariants: ReadonlyArray<
    readonly [string, ReadonlyArray<string>, Extract<LeafAccess, { kind: "reference" }>]
  > = [
    [
      "with a visibility column",
      ["name", "visibility", "draft", "curatorId"],
      { kind: "reference" },
    ],
    [
      "over a view without a visibility column",
      ["name", "draft", "curatorId"],
      { kind: "reference" },
    ],
    ["declaring a followers column", ["name", "visibility", "draft", "curatorId"], curated],
    ["declaring a followers column the view lacks", ["name", "visibility", "draft"], curated],
  ];

  it.each(
    Arr.flatMap(columnVariants, ([variant, columns, access]) =>
      Arr.flatMap(policies, ([policyName, policy]) =>
        Arr.map(viewers, ([viewerName, viewer]) => ({
          variant,
          columns,
          access,
          policyName,
          policy,
          viewerName,
          viewer,
        })),
      ),
    ),
  )(
    "$variant, $policyName policy, for $viewerName",
    async ({ columns, access, policy, viewer }) => {
      const results = await run(probe(policy, columns, viewer, access));
      expect(results.map(({ operation, label, answer }) => ({ operation, label, answer }))).toEqual(
        results.map(({ operation, label, implied }) => ({ operation, label, answer: implied })),
      );
      // A refused operation writes nothing.
      expect(results.filter((result) => Option.isSome(result.answer) && result.wrote)).toEqual([]);
    },
  );

  it("is not vacuous: a corpus writer without the view rungs reaches no hidden row, and the rungs restore access", async () => {
    const answers = async (who: ViewerAccount) =>
      Record.fromEntries(
        (await run(probe(splitPolicy, ["name", "visibility", "draft"], as(who)))).map(
          (result) => [`${result.operation} ${result.label}`, result.answer] as const,
        ),
      );
    const hiddenFromContributor = [
      "private",
      "followers",
      "followers of the member",
      "followers of another",
      "private, curated by the member",
      "tombstoned followers of the member",
      "out of the enum",
      "null visibility",
      "tombstoned public",
      "tombstoned private",
      "missing",
    ];
    // Every operation on every row: only the two rows `get` serves it reach the chain.
    expect(await answers(contributor)).toEqual(
      Record.fromEntries(
        Arr.flatMap(operations, (operation) =>
          Arr.map([...seeds.map((seed) => seed.label), "missing"], (label) => [
            `${operation} ${label}`,
            hiddenFromContributor.includes(label)
              ? Option.some("NodeNotFound")
              : absentVersion(operation)
                ? Option.some("VersionNotFound")
                : Option.none(),
          ]),
        ),
      ),
    );
    // view-private opens the live private rows, but no tombstone …
    const curatorAnswers = await answers(curator);
    expect(curatorAnswers["getVersion private"]).toEqual(Option.none());
    expect(curatorAnswers["update private"]).toEqual(Option.none());
    expect(curatorAnswers["restore tombstoned public"]).toEqual(Option.some("NodeNotFound"));
    expect(curatorAnswers["getVersion tombstoned private"]).toEqual(Option.some("NodeNotFound"));
    // … view-deleted opens the public tombstone, but not a private one …
    const archivistAnswers = await answers(archivist);
    expect(archivistAnswers["restore tombstoned public"]).toEqual(Option.none());
    expect(archivistAnswers["delete tombstoned public"]).toEqual(Option.none());
    expect(archivistAnswers["getVersion tombstoned public"]).toEqual(Option.none());
    expect(archivistAnswers["restore tombstoned private"]).toEqual(Option.some("NodeNotFound"));
    expect(archivistAnswers["getVersion private"]).toEqual(Option.some("NodeNotFound"));
    // … and a moderator, holding both, reaches every existing row.
    const moderatorAnswers = await answers(moderator);
    expect(moderatorAnswers["restore tombstoned private"]).toEqual(Option.none());
    expect(moderatorAnswers["getVersion tombstoned private"]).toEqual(Option.none());
    expect(moderatorAnswers["restoreVersion private"]).toEqual(Option.none());
    expect(moderatorAnswers["getVersion missing"]).toEqual(Option.some("NodeNotFound"));
    // An absent version is no oracle: hidden and missing rows answer alike.
    expect(curatorAnswers["getVersion absent tombstoned public"]).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(curatorAnswers["restoreVersion absent private"]).toEqual(Option.some("VersionNotFound"));
    expect(archivistAnswers["restoreVersion absent private"]).toEqual(Option.some("NodeNotFound"));
    expect(archivistAnswers["getVersion absent missing"]).toEqual(Option.some("NodeNotFound"));
    expect(moderatorAnswers["getVersion absent tombstoned private"]).toEqual(
      Option.some("VersionNotFound"),
    );
  });

  it("is not vacuous: a declared followers column opens its followers rows to a following corpus writer, and nothing else (pulpit#92)", async () => {
    const answers = async (who: ViewerAccount) =>
      Record.fromEntries(
        (
          await run(
            probe(splitPolicy, ["name", "visibility", "draft", "curatorId"], as(who), curated),
          )
        ).map((result) => [`${result.operation} ${result.label}`, result.answer] as const),
      );
    const contributorAnswers = await answers(contributor);
    const rowsByAnswer = [
      ["followers of the member", Option.none()],
      ["followers of another", Option.some("NodeNotFound")],
      ["followers", Option.some("NodeNotFound")],
      ["private, curated by the member", Option.some("NodeNotFound")],
      ["tombstoned followers of the member", Option.some("NodeNotFound")],
    ] as const;
    const gated = ["update", "restore", "delete", "getVersion", "restoreVersion"] as const;
    const pairs = Arr.flatMap(gated, (operation) =>
      Arr.map(rowsByAnswer, ([label, answer]) => [`${operation} ${label}`, answer] as const),
    );
    expect(pairs.map(([key]) => [key, contributorAnswers[key]])).toEqual(pairs);
    // The account the column names, below the corpus rung, still meets the rung first.
    const memberAnswers = await answers(member);
    expect(memberAnswers["update followers of the member"]).toEqual(Option.some("Forbidden"));
    // The same writer without the declaration is shut out, as before pulpit#92.
    const undeclared = Record.fromEntries(
      (
        await run(probe(splitPolicy, ["name", "visibility", "draft", "curatorId"], as(contributor)))
      ).map((result) => [`${result.operation} ${result.label}`, result.answer] as const),
    );
    expect(undeclared["update followers of the member"]).toEqual(Option.some("NodeNotFound"));
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
