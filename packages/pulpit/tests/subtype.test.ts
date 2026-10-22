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
 * - The list order (pulpit#112): one and two keys in each direction, `NULL`s
 *   last in both, the `id` tiebreak across page boundaries, code-point
 *   strings, dates, an undeclared column refused before the store is read,
 *   and membership and the total unchanged under every order × viewer.
 *
 * @module tests/subtype
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Visibility } from "../src/content.ts";
import { always, and, eq, evaluate, isIn, ne, never, or, type ListFilter } from "../src/filter.ts";
import {
  canViewOwned,
  defineSubtype,
  InvalidListOrder,
  nobodyFollows,
  ownedAccess,
  ownedListFilter,
  readScopeFor,
  referencePrivacyFilter,
  requireCreator,
  requireWriter,
  softDeleteFilter,
  SubtypeDeclarationError,
  subtypeHandlers,
  type AccessPolicy,
  type FollowerSeam,
  type LeafAccess,
  type LeafRow,
  type ListOrder,
  type ListRequest,
  type SubtypeDefinition,
  type Viewer,
  type ViewerAccount,
  cacheWriteThrough,
  composeHooks,
  noHooks,
  WriteRejected,
  type AfterWriteHook,
  type BeforeWriteHook,
} from "../src/subtype.ts";
import {
  defineVersionChain,
  VersionNotFound,
  type ChainPatch,
  type ChainState,
  type ColumnValue,
  type Precondition,
} from "../src/version-chain.ts";
import { isPubliclyServeable } from "../src/publication.ts";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  type InMemoryFollowing as Following,
} from "../src/testing.ts";
import {
  ABSENT,
  admin,
  contributor,
  follower,
  gardeneriaPolicy,
  member,
  moderator,
  NOW,
  otherMember,
  websitePolicy,
} from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** A view's column set, with the `id` and `action` every view carries. */
const viewOf = (...columns: ReadonlyArray<string>): ReadonlySet<string> =>
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- a view's column set is the native `ReadonlySet` `LeafStore.columns` names
  new Set(["id", "action", ...columns]);

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
const follows = makeInMemoryFollowers([[follower.id, [member.id]]]);
const nobody = nobodyFollows<Following>(HashSet.empty());

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
      following: () => HashSet.empty<string>(),
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
      following: HashSet.make(member.id),
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
  const rows: ReadonlyArray<
    LeafRow & { readonly visibility: Visibility; readonly draft: boolean; readonly ownerId: string }
  > = Arr.flatMap(["public", "followers", "private"] as const, (visibility) =>
    Arr.flatMap([false, true], (draft) =>
      Arr.map([member.id, otherMember.id], (ownerId) => ({
        id: `${visibility}-${draft}-${ownerId}`,
        action: "create" as const,
        visibility,
        draft,
        ownerId,
      })),
    ),
  );
  const columns = viewOf("ownerId", "visibility", "draft");
  const cases = Arr.flatMap([true, false], (withDraft) =>
    Arr.map(viewers, ([name, viewer]) => ({
      label: `${withDraft ? "with" : "without"} a draft column, for ${name}`,
      withDraft,
      viewer,
    })),
  );

  it.each(cases)("$label", async ({ withDraft, viewer }) => {
    const filter = ownedListFilter(
      ownedAccess({ draft: withDraft }),
      columns,
      readScopeFor(viewer, gardeneriaPolicy, follows),
    );
    const listed = Arr.map(rows, (row) => [
      row.id,
      evaluate(filter, row, {
        now: NOW,
        contains: (set: Following, value) => Predicate.isString(value) && HashSet.has(set, value),
      }),
    ]);
    const seen = await run(
      Effect.forEach(
        rows,
        (row) =>
          Effect.map(
            canViewOwned(viewer, gardeneriaPolicy, follows, {
              ownerId: row.ownerId,
              visibility: row.visibility,
              // A leaf without the axis reads every row as not-a-draft.
              draft: withDraft && row.draft,
            }),
            (visible) => [row.id, visible],
          ),
        { concurrency: 1 },
      ),
    );
    expect(listed).toEqual(seen);
  });

  it("reads an explicitly undefined draft option as no draft column", () => {
    expect(ownedAccess({ draft: undefined })).toEqual(ownedAccess());
    expect(ownedAccess({ draft: undefined }).draftColumn).toEqual(Option.none());
  });

  it("fails closed when the declaration names a column the view lacks", () => {
    const filter = ownedListFilter(ownedAccess({ draft: true }), viewOf("ownerId", "visibility"), {
      kind: "all",
    });
    expect(filter).toEqual(never);
  });
});

// ── The reference two-state predicate (website's matrix) ─────────────

describe("the reference list predicates", () => {
  const view = viewOf("visibility");
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
    expect(filters(anonymous, false, viewOf())).toEqual(ne("action", "delete"));
  });

  describe("the followers arm (pulpit#92)", () => {
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
    // Another member below the rung: Forbidden, not NotFound. The gate never reads visibility, so it
    // deliberately confirms any owned row with an owner record, hidden or not (pulpit#24; SECURITY.md →
    // "Existence disclosure by the write gates").
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
  const leaves = makeInMemoryLeafStore(chain, {
    columns: ["title", "visibility", "draft"],
    now: NOW,
  });
  let viewer: Viewer = anonymous;
  /** Every version the operations read, logged before it yields: a history read past a refusing gate shows here. */
  const snapshots: Array<readonly [string, bigint]> = [];
  const ops = defineSubtype({
    type: "posts",
    access: ownedAccess({ draft: true }),
    chain: {
      ...chain,
      snapshot: (id, version) =>
        Effect.suspend(() => {
          snapshots.push([id, version]);
          return chain.snapshot(id, version);
        }),
    },
    leaves,
    // Yields first, as a real session lookup does: a history read forked
    // beside the gate would then run before the gate refuses (pulpit#82).
    viewer: Effect.andThen(
      Effect.yieldNow,
      Effect.sync(() => viewer),
    ),
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
  return { chain, leaves, ops, actAs, post, snapshots };
};

describe("defineSubtype — an owned leaf", () => {
  it("create stamps the creating account as owner, and records it as the actor", async () => {
    const { chain, leaves, post } = ownedPosts();
    const id = await post("public");
    expect(HashMap.get(leaves.owners(), id)).toEqual(Option.some(member.id));
    expect(chain.rows()[0]?.actorId).toEqual(Option.some(member.id));
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
    const sorted = Arr.sort(Order.String);
    expect(sorted(await listed(as(follower)))).toEqual(sorted([open, followersOnly]));
    expect(sorted(await listed(as(member)))).toEqual(sorted([open, followersOnly, hidden]));
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
    expect(chain.rows()[2]?.actorId).toEqual(Option.some(moderator.id));
  });

  it("the write and history gates confirm existence: a stranger gets Forbidden on every hidden row, the anonymous Unauthorized (pulpit#24)", async () => {
    const { ops, actAs, post, snapshots } = ownedPosts();
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
      // A version no row has, on either side: the gate answers before the chain could.
      ops.getVersion(id, 99n),
      ops.compare(id, 0n, 0n),
      ops.compare(id, 99n, 0n),
      ops.compare(id, 0n, 99n),
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
    const readBefore = snapshots.length;
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
    // No refused history read reached a version.
    expect(snapshots.slice(readBefore)).toEqual([]);
  });

  describe("compare: getVersion's gate, then the chain's compare (pulpit#82)", () => {
    /** A version no row has. */
    const ABSENT_VERSION = 99n;
    const pairs: ReadonlyArray<readonly [bigint, bigint]> = [
      [0n, 0n],
      [0n, 1n],
      [1n, 0n],
      [0n, ABSENT_VERSION],
      [ABSENT_VERSION, 1n],
      [ABSENT_VERSION, ABSENT_VERSION + 1n],
    ];
    const viewers: ReadonlyArray<readonly [string, Viewer]> = [
      ["anonymous", anonymous],
      ["the owner", as(member)],
      ["a stranger", as(otherMember)],
      ["the owner's follower", as(follower)],
      ["a contributor", as(contributor)],
      ["a moderator", as(moderator)],
      ["an admin", as(admin)],
    ];
    /** An owned leaf with a row per state, each at head 1, plus a missing id and an ownerless row. */
    const seeded = async () => {
      const leaf = ownedPosts();
      const { ops, actAs, post, leaves } = leaf;
      const edited = async (id: string) => {
        await run(actAs(as(member), ops.update({ id, patch: { title: "Second", draft: null } })));
        return id;
      };
      const draft = (
        await run(
          actAs(
            as(member),
            ops.create({
              id: Option.none(),
              state: { title: "A draft", visibility: "public", draft: true },
            }),
          ),
        )
      ).id;
      const tombstone = await post("private");
      await run(actAs(as(member), ops.delete(tombstone)));
      const ownerless = await edited(await post("public"));
      leaves.dropOwner(ownerless);
      const privateId = await edited(await post("private"));
      const rows: ReadonlyArray<readonly [string, string]> = [
        ["public", await edited(await post("public"))],
        ["private", privateId],
        ["followers", await edited(await post("followers"))],
        ["draft", await edited(draft)],
        ["tombstoned private", tombstone],
        ["ownerless", ownerless],
        ["missing", "missing"],
      ];
      return { ...leaf, rows, privateId };
    };
    it("answers every row × caller × version pair as getVersion(from) then getVersion(to) would, reading nothing past a refusing gate", async () => {
      const { ops, actAs, rows, snapshots } = await seeded();
      const cases = Arr.flatMap(rows, ([label, id]) =>
        Arr.flatMap(viewers, ([viewerName, viewer]) =>
          Arr.map(pairs, ([from, to]) => ({ label, id, viewerName, viewer, from, to })),
        ),
      );
      const observed = await run(
        Effect.forEach(
          cases,
          ({ label, id, viewerName, viewer, from, to }) =>
            Effect.gen(function* () {
              const fromAnswer = yield* actAs(viewer, Effect.result(ops.getVersion(id, from)));
              const toAnswer = yield* actAs(viewer, Effect.result(ops.getVersion(id, to)));
              const readBefore = snapshots.length;
              const answer = yield* actAs(viewer, Effect.result(ops.compare(id, from, to)));
              const read = snapshots.slice(readBefore);
              const implied = Result.isFailure(fromAnswer)
                ? Result.fail(fromAnswer.failure)
                : Result.isFailure(toAnswer)
                  ? Result.fail(toAnswer.failure)
                  : Result.succeed({
                      from: fromAnswer.success,
                      to: toAnswer.success,
                    });
              return { label, viewerName, from, to, answer, implied, read };
            }),
          // One probe at a time: `actAs` sets a shared viewer.
          { concurrency: 1 },
        ),
      );
      // The failure itself (tag and fields), or the two snapshots `getVersion` serves.
      expect(
        observed.map(({ answer, implied: _, read: __, ...where }) => ({
          ...where,
          answer: Result.map(answer, ({ from, to }) => ({ from, to })),
        })),
      ).toEqual(
        observed.map(({ answer: _, implied, read: __, ...where }) => ({
          ...where,
          answer: implied,
        })),
      );
      // A compare the gate refuses reads no version.
      expect(
        observed.filter(
          ({ answer, read }) =>
            Result.isFailure(answer) &&
            answer.failure._tag !== "VersionNotFound" &&
            Arr.isReadonlyArrayNonEmpty(read),
        ),
      ).toEqual([]);
      // Not vacuous: every answer occurs, and each where the gate puts it.
      const tags = (label: string, viewerName: string) =>
        observed
          .filter((probe) => probe.label === label && probe.viewerName === viewerName)
          .map(({ answer }) =>
            Result.isFailure(answer) ? answer.failure._tag : Record.keys(answer.success.changes),
          );
      const admitted = [
        [],
        ["title", "draft"],
        ["title", "draft"],
        "VersionNotFound",
        "VersionNotFound",
        "VersionNotFound",
      ];
      expect(tags("private", "the owner")).toEqual(admitted);
      expect(tags("tombstoned private", "a moderator")).toEqual([
        [],
        [],
        [],
        "VersionNotFound",
        "VersionNotFound",
        "VersionNotFound",
      ]);
      expect(tags("public", "a stranger")).toEqual(Arr.map(pairs, () => "Forbidden"));
      expect(tags("draft", "the owner's follower")).toEqual(Arr.map(pairs, () => "Forbidden"));
      expect(tags("followers", "anonymous")).toEqual(Arr.map(pairs, () => "Unauthorized"));
      expect(tags("ownerless", "an admin")).toEqual(Arr.map(pairs, () => "NodeNotFound"));
      expect(tags("missing", "the owner")).toEqual(Arr.map(pairs, () => "NodeNotFound"));
    });

    it("delegates to the chain's compare: the same comparison, and VersionNotFound naming the absent version, from first", async () => {
      const { chain, ops, actAs, privateId: id } = await seeded();
      const direct = defineVersionChain("posts", chain);
      const admitted = pairs.slice(0, 3);
      expect(
        await run(
          Effect.forEach(admitted, ([from, to]) => actAs(as(member), ops.compare(id, from, to)), {
            concurrency: 1,
          }),
        ),
      ).toEqual(
        await run(
          Effect.forEach(admitted, ([from, to]) => direct.compare(id, from, to), {
            concurrency: 1,
          }),
        ),
      );
      const forward = await run(actAs(as(moderator), ops.compare(id, 0n, 1n)));
      expect(forward.from.version).toBe(0n);
      expect(forward.to.version).toBe(1n);
      expect(forward.changes).toEqual({
        title: { _tag: "changed", before: "A post", after: "Second" },
        draft: { _tag: "changed", before: false, after: null },
      });
      const missingVersion = (from: bigint, to: bigint) =>
        run(Effect.flip(actAs(as(member), ops.compare(id, from, to))));
      expect(await missingVersion(0n, ABSENT_VERSION)).toEqual(
        new VersionNotFound({ type: "posts", id, version: ABSENT_VERSION }),
      );
      expect(await missingVersion(ABSENT_VERSION, 0n)).toEqual(
        new VersionNotFound({ type: "posts", id, version: ABSENT_VERSION }),
      );
      expect(await missingVersion(ABSENT_VERSION + 1n, ABSENT_VERSION)).toEqual(
        new VersionNotFound({ type: "posts", id, version: ABSENT_VERSION + 1n }),
      );
    });
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
    const leaves = makeInMemoryLeafStore(chain, { columns: ["name"], now: NOW });
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
    expect(HashMap.size(leaves.owners())).toBe(0);
    viewer = anonymous;
    expect(await tagOf(ops.get(id))).toEqual(Option.none());
  });
});

// ── List ordering (pulpit#112) ────────────────────────────────────────

describe("defineSubtype — list ordering (pulpit#112)", () => {
  type Keys = ReadonlyArray<ListOrder>;
  /** One seeded node: its caller-chosen id, its state and whether it is tombstoned. */
  interface Seed {
    readonly id: string;
    readonly state: ChainState;
    readonly deleted: boolean;
  }
  const seed = (id: string, state: ChainState, deleted = false): Seed => ({ id, state, deleted });
  /** Who lists, whether they asked for tombstones, and the page window. */
  interface Ask {
    readonly who: Viewer;
    readonly includeDeleted: boolean;
    readonly limit: number;
    readonly offset: number;
  }
  const everything: Ask = { who: anonymous, includeDeleted: false, limit: 100, offset: 0 };
  const asc = (column: string): ListOrder => ({ column, direction: "asc" });
  const desc = (column: string): ListOrder => ({ column, direction: "desc" });
  const at = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
  const byText = (ids: ReadonlyArray<string>) => Arr.sort(ids, Order.String);

  /**
   * A reference leaf with a `visibility` column (`public` unless a seed
   * says otherwise), seeded straight through the chain with caller-chosen
   * ids so the `id` tiebreak is checkable, a log of every query the store
   * receives and a count of the viewer's reads. `sortable` is the leaf's
   * allow-list, forwarded as given (`undefined` included).
   */
  const ranked = async (
    seeds: ReadonlyArray<Seed>,
    leaf: Pick<SubtypeDefinition<LeafRow, LeafRow, never, never, never>, "sortable"> = {},
  ) => {
    const chain = makeInMemoryChainStore();
    const store = makeInMemoryLeafStore(chain, {
      columns: ["title", "rank", "publishedAt", "visibility"],
      now: NOW,
    });
    const queries: Array<Parameters<typeof store.list>[0]> = [];
    let viewer: Viewer = anonymous;
    let viewerReads = 0;
    const ops = defineSubtype({
      ...leaf,
      type: "taxa",
      access: { kind: "reference" },
      chain,
      leaves: {
        ...store,
        list: (query) =>
          Effect.suspend(() => {
            queries.push(query);
            return store.list(query);
          }),
      },
      viewer: Effect.sync(() => {
        viewerReads += 1;
        return viewer;
      }),
      policy: gardeneriaPolicy,
      followers: nobody,
      toResource: (row: LeafRow) => row,
    });
    const versions = defineVersionChain("taxa", chain);
    await run(
      Effect.forEach(
        seeds,
        ({ id, state, deleted }) =>
          Effect.andThen(
            versions.create({
              id: Option.some(id),
              state: { visibility: "public", ...state },
              actorId: Option.none(),
            }),
            deleted ? versions.delete(id, Option.none()) : Effect.void,
          ),
        { concurrency: 1, discard: true },
      ),
    );
    /** One page, as `ask.who`; `order` carries `orderBy`, or leaves it out. */
    const page = (order: Pick<ListRequest, "orderBy">, ask: Ask = everything) =>
      Effect.suspend(() => {
        viewer = ask.who;
        return ops.list({
          limit: ask.limit,
          offset: ask.offset,
          includeDeleted: ask.includeDeleted,
          where: always,
          ...order,
        });
      });
    const ids = (orderBy: Keys, who: Viewer = anonymous) =>
      run(
        Effect.map(page({ orderBy }, { ...everything, who }), (listed) =>
          listed.rows.map((row) => row.id),
        ),
      );
    return { page, ids, queries, viewerReads: () => viewerReads };
  };

  it("keeps the default order, id ascending, when the order is absent, null or empty", async () => {
    const { page, queries } = await ranked([
      seed("c", { rank: 1 }),
      seed("a", { rank: 3 }),
      seed("b", { rank: 2 }),
    ]);
    // `null`, as an unchecked caller might send it, is the same as absent.
    const nullOrder: Pick<ListRequest, "orderBy"> = {};
    Reflect.set(nullOrder, "orderBy", null);
    const listed = await run(
      Effect.all([page({}), page(nullOrder), page({ orderBy: [] })], { concurrency: 1 }),
    );
    expect(listed.map((each) => each.rows.map((row) => row.id))).toEqual([
      ["a", "b", "c"],
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    expect(queries.map((query) => query.orderBy)).toEqual([[], [], []]);
  });

  it("orders by one key in either direction, NULL and absent last in both", async () => {
    const { ids } = await ranked([
      seed("a", { rank: 2 }),
      seed("b", { rank: null }),
      seed("c", { rank: 10 }),
      seed("d", {}),
      seed("e", { rank: -1 }),
    ]);
    // Numerically (10 after 2), not as text; NULL and absent tie, so `id` orders them.
    expect(await ids([asc("rank")])).toEqual(["e", "a", "c", "b", "d"]);
    expect(await ids([desc("rank")])).toEqual(["c", "a", "e", "b", "d"]);
  });

  it("sorts NaN after every number, as PostgreSQL's float8 does, and false before true", async () => {
    const { ids } = await ranked([
      seed("a", { rank: Number.NaN, title: true }),
      seed("b", { rank: Number.POSITIVE_INFINITY, title: false }),
      seed("c", { rank: null, title: null }),
      seed("d", { rank: Number.NEGATIVE_INFINITY, title: true }),
      seed("e", { rank: Number.NaN, title: false }),
    ]);
    expect(await ids([asc("rank")])).toEqual(["d", "b", "a", "e", "c"]);
    expect(await ids([desc("rank")])).toEqual(["a", "e", "b", "d", "c"]);
    expect(await ids([asc("title")])).toEqual(["b", "e", "a", "d", "c"]);
    expect(await ids([desc("title")])).toEqual(["a", "d", "b", "e", "c"]);
  });

  it("orders by two keys, the second breaking the first's ties, then id", async () => {
    const { ids } = await ranked([
      seed("a", { title: "Oak", rank: 1 }),
      seed("b", { title: "Ash", rank: 1 }),
      seed("c", { title: "Oak", rank: 2 }),
      seed("d", { title: "Ash", rank: 1 }),
      seed("e", { title: null, rank: 2 }),
    ]);
    expect(await ids([asc("title"), desc("rank")])).toEqual(["b", "d", "c", "a", "e"]);
    expect(await ids([desc("title"), asc("rank")])).toEqual(["a", "c", "b", "d", "e"]);
    expect(await ids([desc("rank"), asc("title")])).toEqual(["c", "e", "b", "d", "a"]);
  });

  it('compares strings by code point, as COLLATE "C" does, astral characters after the BMP', async () => {
    const { ids } = await ranked([
      seed("a", { title: "\u{1F600}" }),
      seed("b", { title: "�" }),
      seed("c", { title: "a" }),
      seed("d", { title: "B" }),
      seed("e", { title: "" }),
    ]);
    // UTF-16's `<` would put U+1F600 (a surrogate pair from U+D83D) before U+FFFD.
    expect(await ids([asc("title")])).toEqual(["e", "d", "c", "b", "a"]);
    expect(await ids([desc("title")])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("compares dates by instant", async () => {
    const { ids } = await ranked([
      seed("a", { publishedAt: at("2026-01-02T00:00:00.000Z") }),
      seed("b", { publishedAt: at("2025-12-31T23:59:59.999Z") }),
      seed("c", { publishedAt: null }),
      seed("d", { publishedAt: at("2026-01-02T00:00:00.001Z") }),
    ]);
    expect(await ids([asc("publishedAt")])).toEqual(["b", "a", "d", "c"]);
    expect(await ids([desc("publishedAt")])).toEqual(["d", "a", "b", "c"]);
  });

  it("closes every order with id, so pages never skip or repeat a row across a tie", async () => {
    const order = ["h", "c", "f", "a", "g", "b", "e", "d", "i"];
    const { page, ids } = await ranked(
      Arr.map(order, (id, index) =>
        seed(id, { rank: index % 3 === 0 ? null : index % 2, title: "same" }),
      ),
    );
    const offsets = Arr.makeBy(Math.ceil(order.length / 2), (index) => index * 2);
    const orders: ReadonlyArray<Keys> = [
      [],
      [asc("rank")],
      [desc("rank")],
      [asc("title"), desc("rank")],
    ];
    const paged = await run(
      Effect.forEach(
        orders,
        (orderBy) =>
          Effect.all(
            {
              whole: page({ orderBy }),
              pages: Effect.forEach(
                offsets,
                (offset) => page({ orderBy }, { ...everything, limit: 2, offset }),
                { concurrency: 1 },
              ),
            },
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      ),
    );
    expect(paged).toHaveLength(orders.length);
    Arr.forEach(paged, ({ whole, pages }) => {
      const stitched = Arr.flatMap(pages, (each) => each.rows.map((row) => row.id));
      expect(stitched).toEqual(whole.rows.map((row) => row.id));
      expect(Arr.dedupe(stitched)).toHaveLength(order.length);
      expect(Arr.map(pages, (each) => each.total)).toEqual(Arr.map(offsets, () => order.length));
    });
    // Within a tie, id ascending: every row has the same title.
    expect(await ids([asc("title")])).toEqual(byText(order));
  });

  it("refuses a column the view does not declare, before the store is read", async () => {
    const { page, queries } = await ranked([seed("a", { rank: 1, secret: "x" })]);
    // A direction outside the type, as an unchecked caller might send it.
    const sideways = asc("rank");
    Reflect.set(sideways, "direction", "sideways");
    const refused = await run(
      Effect.forEach(
        [[asc("secret")], [asc("rank"), desc("rank; DROP TABLE taxa")], [sideways]],
        (orderBy) => Effect.flip(page({ orderBy })),
        { concurrency: 1 },
      ),
    );
    expect(refused).toEqual([
      new InvalidListOrder({ type: "taxa", column: "secret" }),
      new InvalidListOrder({ type: "taxa", column: "rank; DROP TABLE taxa" }),
      new InvalidListOrder({ type: "taxa", column: "rank" }),
    ]);
    expect(queries).toEqual([]);
  });

  it("hands the store each column once, rebuilt to its column and direction", async () => {
    const { ids, queries } = await ranked([seed("a", { rank: 1 })]);
    const extra = { ...desc("rank"), raw: "DESC NULLS FIRST" };
    await ids([extra, asc("title"), asc("rank"), desc("title")]);
    expect(queries.map((query) => query.orderBy)).toEqual([[desc("rank"), asc("title")]]);
  });

  it("compares bigints by value, past a double's precision", async () => {
    const big = 2n ** 64n;
    const { ids } = await ranked([
      seed("a", { rank: big + 1n }),
      seed("b", { rank: big }),
      seed("c", { rank: null }),
      seed("d", { rank: 0n }),
      seed("e", { rank: -1n }),
    ]);
    // As doubles, 2^64 and 2^64 + 1 tie, and `id` would put `a` first.
    expect(await ids([asc("rank")])).toEqual(["e", "d", "b", "a", "c"]);
    expect(await ids([desc("rank")])).toEqual(["a", "b", "d", "e", "c"]);
  });

  it('closes the order with id by code point, as uuid or a COLLATE "C" text id sorts', async () => {
    const { ids } = await ranked([
      seed("\u{1F600}", { title: "same" }),
      seed("�", { title: "same" }),
      seed("z", { title: "same" }),
    ]);
    // UTF-16's `<` would put U+1F600 (a surrogate pair from U+D83D) before U+FFFD.
    const expected = ["z", "�", "\u{1F600}"];
    expect(await ids([])).toEqual(expected);
    expect(await ids([asc("title")])).toEqual(expected);
  });

  it("checks the order before the viewer is read", async () => {
    const { page, queries, viewerReads } = await ranked([seed("a", { rank: 1 })]);
    const refused = await run(Effect.flip(page({ orderBy: [asc("secret")] })));
    expect(refused).toEqual(new InvalidListOrder({ type: "taxa", column: "secret" }));
    expect(viewerReads()).toBe(0);
    expect(queries).toEqual([]);
    await run(page({ orderBy: [asc("rank")] }));
    expect(viewerReads()).toBe(1);
  });

  it("refuses an order not shaped as one with InvalidListOrder, never a defect", async () => {
    const { page, queries, viewerReads } = await ranked([seed("a", { title: "Oak" })]);
    /** A request whose `orderBy` is `value`, as an unchecked caller might send it. */
    const unchecked = (value: Schema.Json) => {
      const order: Pick<ListRequest, "orderBy"> = { orderBy: [] };
      Reflect.set(order, "orderBy", value);
      return order;
    };
    const refused = await run(
      Effect.forEach(
        [
          [{ column: 42, direction: "asc" }],
          // A sortable column with no direction: refused, never defaulted to `asc`.
          [{ column: "title" }],
          [null],
          ["title"],
          "title",
          { column: "title", direction: "asc" },
          42,
        ],
        (orderBy) => Effect.flip(page(unchecked(orderBy))),
        { concurrency: 1 },
      ),
    );
    expect(refused).toEqual([
      new InvalidListOrder({ type: "taxa", column: "" }),
      new InvalidListOrder({ type: "taxa", column: "title" }),
      new InvalidListOrder({ type: "taxa", column: "" }),
      new InvalidListOrder({ type: "taxa", column: "" }),
      new InvalidListOrder({ type: "taxa", column: "" }),
      // An object where an array belongs: the caller's own column, still refused.
      new InvalidListOrder({ type: "taxa", column: "title" }),
      new InvalidListOrder({ type: "taxa", column: "" }),
    ]);
    expect(queries).toEqual([]);
    expect(viewerReads()).toBe(0);
  });

  it("sorts only by a declared sortable allow-list, refusing a declared column outside it", async () => {
    const seeds = [
      seed("a", { title: "Oak", rank: 2 }),
      seed("b", { title: "Ash", rank: 1 }),
      seed("c", { title: "Elm", rank: 3 }),
    ];
    const { ids, page, queries, viewerReads } = await ranked(seeds, {
      sortable: ["title", "id"],
    });
    expect(await ids([asc("title")])).toEqual(["b", "c", "a"]);
    expect(await ids([desc("id")])).toEqual(["c", "b", "a"]);
    const refused = await run(
      Effect.forEach(
        [[asc("rank")], [asc("title"), desc("visibility")], [asc("secret")]],
        (orderBy) => Effect.flip(page({ orderBy })),
        { concurrency: 1 },
      ),
    );
    expect(refused).toEqual([
      new InvalidListOrder({ type: "taxa", column: "rank" }),
      new InvalidListOrder({ type: "taxa", column: "visibility" }),
      new InvalidListOrder({ type: "taxa", column: "secret" }),
    ]);
    // Only the two admitted orders reached the viewer and the store.
    expect(viewerReads()).toBe(2);
    expect(queries.map((query) => query.orderBy)).toEqual([[asc("title")], [desc("id")]]);
  });

  it("throws SubtypeDeclarationError when a sortable entry is not a column of the view", async () => {
    await expect(ranked([], { sortable: ["title", "secret"] })).rejects.toThrow(
      SubtypeDeclarationError,
    );
    await expect(ranked([], { sortable: ["title", "secret"] })).rejects.toThrow(
      "taxa: sortable names 'secret', which is not a column of the view",
    );
    // An empty list is a valid declaration: nothing but the default order.
    const { page } = await ranked([seed("a", {})], { sortable: [] });
    expect(await run(Effect.flip(page({ orderBy: [asc("id")] })))).toEqual(
      new InvalidListOrder({ type: "taxa", column: "id" }),
    );
    expect((await run(page({}))).rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("without a sortable list (omitted or undefined), every declared view column sorts", async () => {
    const columns = ["id", "action", "ownerId", "title", "rank", "publishedAt", "visibility"];
    const listed = await Promise.all(
      Arr.map([{}, { sortable: undefined }], async (leaf) => {
        const { page, queries } = await ranked([seed("a", { rank: 1 })], leaf);
        await run(
          Effect.forEach(columns, (column) => page({ orderBy: [desc(column)] }), {
            concurrency: 1,
          }),
        );
        return queries.map((query) => query.orderBy);
      }),
    );
    expect(listed).toEqual([
      Arr.map(columns, (column) => [desc(column)]),
      Arr.map(columns, (column) => [desc(column)]),
    ]);
  });

  it("never changes membership or the total: the privacy, soft-delete and where filters apply as before (SEC-AUTH-ENUM-001)", async () => {
    const { page, ids } = await ranked([
      seed("a", { rank: 3, title: "Oak", visibility: "public" }),
      seed("b", { rank: 1, title: "Ash", visibility: "private" }),
      seed("c", { rank: null, title: "Elm", visibility: "public" }),
      seed("d", { rank: 2, title: "Yew", visibility: "public" }, true),
      seed("e", { rank: 0, title: "Fir", visibility: "followers" }),
      seed("f", { rank: 4, title: "Box", visibility: "public" }),
    ]);
    const orders: ReadonlyArray<Keys> = [
      [],
      [asc("rank")],
      [desc("rank")],
      [asc("title")],
      [desc("visibility"), asc("rank")],
      [asc("id")],
      [desc("id")],
    ];
    const cases = [
      { who: anonymous, includeDeleted: false, members: ["a", "c", "f"] },
      { who: as(member), includeDeleted: true, members: ["a", "c", "f"] },
      { who: as(moderator), includeDeleted: false, members: ["a", "b", "c", "e", "f"] },
      { who: as(moderator), includeDeleted: true, members: ["a", "b", "c", "d", "e", "f"] },
    ];
    const seen = await run(
      Effect.forEach(
        cases,
        ({ who, includeDeleted }) =>
          Effect.forEach(
            orders,
            (orderBy) =>
              Effect.all(
                {
                  all: page({ orderBy }, { ...everything, who, includeDeleted }),
                  // A one-row page reports the same unpaged total.
                  one: page({ orderBy }, { who, includeDeleted, limit: 1, offset: 1 }),
                },
                { concurrency: 1 },
              ),
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      ),
    );
    expect(
      seen.map((byOrder) =>
        byOrder.map(({ all, one }) => [
          byText(all.rows.map((row) => row.id)),
          all.total,
          one.total,
        ]),
      ),
    ).toEqual(
      cases.map(({ members }) => orders.map(() => [members, members.length, members.length])),
    );
    // The anonymous reader's order sorts only what it may see: the hidden ranks 0–2 leave no gap to probe.
    expect(await ids([asc("rank")])).toEqual(["a", "f", "c"]);
  });

  it("orders inside the caller's own where, and on an owned leaf inside the read scope", async () => {
    const { ops, actAs, post } = ownedPosts();
    const open = await post("public");
    const hidden = await post("private");
    const theirs = await post("public", otherMember);
    const listed = (who: Viewer, orderBy: Keys, where: ListFilter<never> = always) =>
      Effect.map(
        actAs(who, ops.list({ limit: 50, offset: 0, includeDeleted: false, where, orderBy })),
        ({ rows, total }) => ({ ids: byText(rows.map((row) => row.id)), total }),
      );
    const orders: ReadonlyArray<Keys> = [[asc("ownerId")], [desc("ownerId")], [desc("visibility")]];
    const seen = await run(
      Effect.forEach(
        orders,
        (orderBy) =>
          Effect.all(
            [
              listed(anonymous, orderBy),
              listed(as(member), orderBy),
              listed(as(member), orderBy, eq("visibility", "private")),
            ],
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      ),
    );
    expect(seen).toEqual(
      Arr.map(orders, () => [
        { ids: byText([open, theirs]), total: 2 },
        { ids: byText([open, hidden, theirs]), total: 3 },
        { ids: [hidden], total: 1 },
      ]),
    );
    const ordered = await run(
      actAs(
        as(member),
        ops.list({
          limit: 50,
          offset: 0,
          includeDeleted: false,
          where: always,
          orderBy: [desc("ownerId")],
        }),
      ),
    );
    // `u-other` sorts after `u-member`; the member's two rows tie, so `id` orders them.
    expect(ordered.rows.map((row) => row.id)).toEqual([theirs, ...byText([open, hidden])]);
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
  const leaves = makeInMemoryLeafStore(chain, { columns, now: NOW });
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
            if (seed.unstamped === true) leaves.dropOwner(id);
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
    following: (followerId) => HashSet.fromIterable(strings.includes(followerId) ? strings : []),
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
   * `compare` (pulpit#82) runs with the absent version on either side.
   */
  const operations = [
    "update",
    "restore",
    "delete",
    "getVersion",
    "restoreVersion",
    "compare",
    "getVersion absent",
    "restoreVersion absent",
    "compare absent from",
    "compare absent to",
  ] as const;
  type Operation = (typeof operations)[number];
  /** A version no seeded row reaches. */
  const ABSENT_VERSION = 99n;
  const absentVersion = (operation: Operation) =>
    operation === "getVersion absent" ||
    operation === "restoreVersion absent" ||
    operation === "compare absent from" ||
    operation === "compare absent to";
  /** The operations that write nothing: a refusal they answer can only be the gate's. */
  const historyReads: ReadonlyArray<Operation> = [
    "getVersion",
    "compare",
    "getVersion absent",
    "compare absent from",
    "compare absent to",
  ];

  /** A leaf declaring the followers column the `curatorId` seeds fill (pulpit#92). */
  const curated: Extract<LeafAccess, { kind: "reference" }> = {
    kind: "reference",
    followersOfColumn: "curatorId",
  };
  /** The corpus writer without a view rung follows `member`: the followers arm is its only way in. */
  const corpusFollowers = makeInMemoryFollowers([[contributor.id, [member.id]]]);

  /** A fresh reference leaf seeded (by an admin) with every row, plus a missing id. */
  const referenceLeaf = (
    policy: AccessPolicy,
    columns: ReadonlyArray<string>,
    access: Extract<LeafAccess, { kind: "reference" }>,
  ) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns, now: NOW });
    let viewer: Viewer = anonymous;
    /** How many versions the operations have read: a history read past a refusing gate shows here. */
    let snapshotReads = 0;
    const ops = defineSubtype({
      type: "terms",
      access,
      chain: {
        ...chain,
        snapshot: (id, version) =>
          Effect.suspend(() => {
            snapshotReads += 1;
            return chain.snapshot(id, version);
          }),
      },
      leaves,
      // Yields first, as a real session lookup does: a history read forked
      // beside the gate would then run before the gate refuses (pulpit#82).
      viewer: Effect.andThen(
        Effect.yieldNow,
        Effect.sync(() => viewer),
      ),
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
      snapshotReads: () => snapshotReads,
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
      Match.when("compare", () => leaf.ops.compare(id, 0n, 0n)),
      Match.when("getVersion absent", () => leaf.ops.getVersion(id, ABSENT_VERSION)),
      Match.when("restoreVersion absent", () => leaf.ops.restoreVersion(id, ABSENT_VERSION)),
      Match.when("compare absent from", () => leaf.ops.compare(id, ABSENT_VERSION, 0n)),
      Match.when("compare absent to", () => leaf.ops.compare(id, 0n, ABSENT_VERSION)),
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
          const readBefore = leaf.snapshotReads();
          const answer = yield* leaf.actAs(viewer, failureTag(invoke(leaf, operation, id)));
          const tombstoned = seeds.some((seed) => seed.label === label && seed.deleted);
          return {
            operation,
            label,
            answer,
            implied: implied(viewer, policy, got, operation, tombstoned),
            wrote: leaf.chain.rows().length > before,
            read: leaf.snapshotReads() > readBefore,
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
      // A history read the gate refuses reads no version (pulpit#82).
      expect(
        results.filter(
          (result) =>
            historyReads.includes(result.operation) &&
            Option.exists(result.answer, (tag) => tag !== "VersionNotFound") &&
            result.read,
        ),
      ).toEqual([]);
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
    // compare answers each row as getVersion does, whichever side is absent (pulpit#82).
    expect(curatorAnswers["compare private"]).toEqual(Option.none());
    expect(curatorAnswers["compare absent from private"]).toEqual(Option.some("VersionNotFound"));
    expect(curatorAnswers["compare absent to tombstoned public"]).toEqual(
      Option.some("NodeNotFound"),
    );
    expect(archivistAnswers["compare absent from private"]).toEqual(Option.some("NodeNotFound"));
    expect(archivistAnswers["compare tombstoned public"]).toEqual(Option.none());
    expect(moderatorAnswers["compare absent to tombstoned private"]).toEqual(
      Option.some("VersionNotFound"),
    );
    expect(moderatorAnswers["compare absent from missing"]).toEqual(Option.some("NodeNotFound"));
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
    const gated = [
      "update",
      "restore",
      "delete",
      "getVersion",
      "restoreVersion",
      "compare",
    ] as const;
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
    const cached = MutableHashMap.empty<string, unknown>();
    const log: Array<string> = [];
    const handlers = subtypeHandlers(ops, {
      transact: (effect) =>
        Effect.andThen(
          Effect.sync(() => log.push("transact")),
          effect,
        ),
      cache: Option.some({
        set: (id, resource) => Effect.sync(() => void MutableHashMap.set(cached, id, resource)),
        delete: (id) => Effect.sync(() => void MutableHashMap.remove(cached, id)),
      }),
    });
    const id = await post("public");
    const updated = await run(
      actAs(as(member), handlers.update({ id, patch: { title: "Cached" } })),
    );
    expect(updated).toMatchObject({ id, title: "Cached" });
    expect(MutableHashMap.get(cached, id)).toEqual(Option.some(updated));
    const restored = await run(actAs(as(member), handlers.restoreVersion({ id, version: 0n })));
    expect(Option.getOrUndefined(MutableHashMap.get(cached, id))).toMatchObject({
      title: "A post",
    });
    expect(MutableHashMap.get(cached, id)).toEqual(Option.some(restored));
    await run(actAs(as(member), handlers.delete(id)));
    expect(MutableHashMap.has(cached, id)).toBe(false);
    expect(log).toEqual(["transact", "transact", "transact"]);
  });
});

describe("subtypeHandlers — a write that hides the row from its own writer evicts the cached resource (pulpit#107)", () => {
  /** A store failure the re-read can hit after the write committed. */
  class StoreDown extends Schema.TaggedError<StoreDown>()("StoreDown", {}) {}

  /**
   * A cache step held open: it signals `entered`, then waits for `release`
   * before it touches the cache.
   */
  interface Block {
    readonly on: "set" | "delete";
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }

  /** The faults {@link cachedReference} can inject into the next write. */
  interface Faults {
    interruptAfterWrite: boolean;
    retry: boolean;
    reRead: Option.Option<Effect.Effect<never, StoreDown>>;
    block: Option.Option<Block>;
  }

  /**
   * A reference leaf with a `visibility` column, cached, written by a
   * corpus writer below the view-private rung: once a write leaves the row
   * `private`, that writer's re-read fails `NodeNotFound`, and the cache
   * must not go on serving the superseded public resource
   * (`CACHE-AUTH-005`). `faults` makes the boundary interrupt after the
   * chain write or retry it, the re-read fail, or the next cache step of
   * one kind block, from the next write on.
   */
  const cachedReference = () => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["name", "visibility"], now: NOW });
    let viewer: Viewer = as(admin);
    const base = defineSubtype({
      type: "taxa",
      access: { kind: "reference" },
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy: gardeneriaPolicy,
      followers: nobody,
      toResource: (row: LeafRow) => ({ id: row.id, attributes: { visibility: row["visibility"] } }),
    });
    const faults: Faults = {
      interruptAfterWrite: false,
      retry: false,
      reRead: Option.none(),
      block: Option.none(),
    };
    const ops = {
      ...base,
      get: (id: string) => Option.getOrElse(faults.reRead, () => base.get(id)),
    };
    const actAs = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        viewer = who;
        return effect;
      });
    const cached = MutableHashMap.empty<string, unknown>();
    /** Hold the first cache step of this kind open, if one is to block. */
    const blocked = (on: Block["on"]) =>
      Effect.suspend(() => {
        const block = Option.filter(faults.block, (b) => b.on === on);
        if (Option.isNone(block)) return Effect.void;
        faults.block = Option.none();
        return Effect.andThen(
          Deferred.succeed(block.value.entered, undefined),
          Deferred.await(block.value.release),
        );
      });
    const handlers = subtypeHandlers(ops, {
      // An interrupt landing after the chain write ran, before the boundary
      // returned: the write may have committed.
      // A retrying boundary runs the effect twice, as if its first attempt
      // had rolled back (the in-memory store can't roll back, so the first
      // attempt's write stands, and stands in for a racing writer's).
      transact: (effect) =>
        Effect.suspend(() =>
          faults.interruptAfterWrite
            ? Effect.tap(effect, () => Effect.interrupt)
            : faults.retry
              ? Effect.andThen(Effect.exit(effect), effect)
              : effect,
        ),
      cache: Option.some({
        // The cache's serveability policy: a non-serveable resource evicts.
        set: (key, resource) =>
          Effect.andThen(
            blocked("set"),
            Effect.sync(() =>
              isPubliclyServeable(resource)
                ? void MutableHashMap.set(cached, key, resource)
                : void MutableHashMap.remove(cached, key),
            ),
          ),
        delete: (key) =>
          Effect.andThen(
            blocked("delete"),
            Effect.sync(() => void MutableHashMap.remove(cached, key)),
          ),
      }),
    });
    /** A public row the contributor created, cached by the write-through. */
    const publicRow = async () => {
      const { id } = await run(
        actAs(
          as(contributor),
          handlers.create({ id: Option.none(), state: { name: "Quercus", visibility: "public" } }),
        ),
      );
      expect(MutableHashMap.has(cached, id)).toBe(true);
      return id;
    };
    return { chain, handlers, actAs, cached, faults, publicRow };
  };

  it("update: a corpus writer flipping a public row private", async () => {
    const { chain, handlers, actAs, cached } = cachedReference();
    const { id } = await run(
      actAs(
        as(contributor),
        handlers.create({ id: Option.none(), state: { name: "Quercus", visibility: "public" } }),
      ),
    );
    expect(MutableHashMap.has(cached, id)).toBe(true);
    // The writer still gets the re-read's `NodeNotFound` for a committed
    // write it can no longer read: the decided `{ id, version }` response
    // waits on effect-jsonapi's handler contract (pulpit#107).
    expect(
      await tagOf(
        actAs(as(contributor), handlers.update({ id, patch: { visibility: "private" } })),
      ),
    ).toEqual(Option.some("NodeNotFound"));
    expect(chain.rows()).toHaveLength(2);
    expect(MutableHashMap.has(cached, id)).toBe(false);
  });

  it("restoreVersion: a corpus writer restoring a private version", async () => {
    const { chain, handlers, actAs, cached } = cachedReference();
    const { id } = await run(
      actAs(
        as(admin),
        handlers.create({ id: Option.none(), state: { name: "Quercus", visibility: "private" } }),
      ),
    );
    expect(MutableHashMap.has(cached, id)).toBe(false);
    await run(actAs(as(admin), handlers.update({ id, patch: { visibility: "public" } })));
    expect(MutableHashMap.has(cached, id)).toBe(true);
    expect(
      await tagOf(actAs(as(contributor), handlers.restoreVersion({ id, version: 0n }))),
    ).toEqual(Option.some("NodeNotFound"));
    expect(chain.rows()).toHaveLength(3);
    expect(MutableHashMap.has(cached, id)).toBe(false);
  });

  it("a re-read the writer can still make writes the resource through as before", async () => {
    const { handlers, actAs, cached } = cachedReference();
    const { id } = await run(
      actAs(
        as(moderator),
        handlers.create({ id: Option.none(), state: { name: "Quercus", visibility: "public" } }),
      ),
    );
    const hidden = await run(
      actAs(as(moderator), handlers.update({ id, patch: { visibility: "private" } })),
    );
    expect(hidden).toMatchObject({ id, attributes: { visibility: "private" } });
    expect(MutableHashMap.has(cached, id)).toBe(false);
    const shown = await run(
      actAs(as(moderator), handlers.update({ id, patch: { visibility: "public" } })),
    );
    expect(MutableHashMap.get(cached, id)).toEqual(Option.some(shown));
  });

  it("an interrupt after the chain write still evicts, on update and on delete", async () => {
    const { chain, handlers, actAs, cached, faults, publicRow } = cachedReference();
    const updated = await publicRow();
    const deleted = await publicRow();
    faults.interruptAfterWrite = true;
    const interrupted = async <A, E>(effect: Effect.Effect<A, E>) =>
      Exit.hasInterrupts(await Effect.runPromiseExit(effect));
    expect(
      await interrupted(
        actAs(as(contributor), handlers.update({ id: updated, patch: { name: "Quercus robur" } })),
      ),
    ).toBe(true);
    expect(await interrupted(actAs(as(contributor), handlers.delete(deleted)))).toBe(true);
    expect(chain.rows()).toHaveLength(4);
    expect(MutableHashMap.has(cached, updated)).toBe(false);
    expect(MutableHashMap.has(cached, deleted)).toBe(false);
  });

  it("an interrupt during the cache step can't skip it, on update and on delete", async () => {
    const { chain, handlers, actAs, cached, faults, publicRow } = cachedReference();
    const updated = await publicRow();
    const deleted = await publicRow();
    // Hold the handler's cache step open, interrupt the handler while it
    // waits there, then let the step go on: the interrupt must wait for it.
    const interruptedDuring = (on: Block["on"], handler: Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        faults.block = Option.some({ on, entered, release });
        const fiber = yield* Effect.forkChild(handler);
        yield* Deferred.await(entered);
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupter);
      });
    // A moderator's re-read sees the now-private row; its write-through is
    // what evicts the superseded public resource.
    await run(
      interruptedDuring(
        "set",
        actAs(as(moderator), handlers.update({ id: updated, patch: { visibility: "private" } })),
      ),
    );
    await run(interruptedDuring("delete", actAs(as(contributor), handlers.delete(deleted))));
    expect(chain.rows()).toHaveLength(4);
    expect(MutableHashMap.has(cached, updated)).toBe(false);
    expect(MutableHashMap.has(cached, deleted)).toBe(false);
  });

  it("a write the gate refuses never evicts, interrupt or not", async () => {
    const { chain, handlers, actAs, cached, faults, publicRow } = cachedReference();
    const id = await publicRow();
    const refused = async (interruptAfterWrite: boolean) => {
      faults.interruptAfterWrite = interruptAfterWrite;
      expect(
        await tagOf(actAs(anonymous, handlers.update({ id, patch: { name: "Vandal" } }))),
      ).toEqual(Option.some("Unauthorized"));
      expect(await tagOf(actAs(anonymous, handlers.delete(id)))).toEqual(
        Option.some("Unauthorized"),
      );
      // A signed-in caller below the corpus-write rung.
      expect(
        await tagOf(actAs(as(member), handlers.update({ id, patch: { name: "Vandal" } }))),
      ).toEqual(Option.some("Forbidden"));
      expect(await tagOf(actAs(as(member), handlers.delete(id)))).toEqual(Option.some("Forbidden"));
    };
    await refused(false);
    await refused(true);
    expect(chain.rows()).toHaveLength(1);
    expect(MutableHashMap.has(cached, id)).toBe(true);
  });

  it("a write whose retried attempt the precondition refuses never evicts", async () => {
    const { chain, handlers, actAs, cached, faults, publicRow } = cachedReference();
    const id = await publicRow();
    const before = MutableHashMap.get(cached, id);
    faults.retry = true;
    // The first attempt writes (and, in a real store, rolls back); the
    // retry finds the head moved and fails the precondition.
    expect(
      await tagOf(
        actAs(
          as(contributor),
          handlers.update({ id, patch: { name: "Quercus robur" }, expectedVersion: 0n }),
        ),
      ),
    ).toEqual(Option.some("StaleVersion"));
    expect(
      await tagOf(
        actAs(as(contributor), handlers.restoreVersion({ id, version: 0n, expectedVersion: 1n })),
      ),
    ).toEqual(Option.some("StaleVersion"));
    expect(chain.rows()).toHaveLength(3);
    expect(MutableHashMap.get(cached, id)).toEqual(before);
  });

  it("any re-read failure evicts, and the re-read's own failure propagates", async () => {
    const { chain, handlers, actAs, cached, faults, publicRow } = cachedReference();
    const failed = await publicRow();
    faults.reRead = Option.some(Effect.fail(new StoreDown()));
    expect(
      await tagOf(
        actAs(as(contributor), handlers.update({ id: failed, patch: { name: "Quercus robur" } })),
      ),
    ).toEqual(Option.some("StoreDown"));
    expect(MutableHashMap.has(cached, failed)).toBe(false);

    faults.reRead = Option.none();
    const died = await publicRow();
    faults.reRead = Option.some(Effect.die("store gone"));
    const exit = await Effect.runPromiseExit(
      actAs(as(contributor), handlers.restoreVersion({ id: died, version: 0n })),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(MutableHashMap.has(cached, died)).toBe(false);
    expect(chain.rows()).toHaveLength(4);
  });
});

describe("lifecycle hooks — before and after every write (pulpit#45)", () => {
  /** One hook's sight of a write, as the tests record it. */
  type Seen = readonly [hook: string, action: string, detail: string];
  /** The leaf's resource. */
  interface Post {
    readonly id: string;
    readonly title: ColumnValue;
    readonly slug: ColumnValue;
  }

  const hooked = (options: {
    readonly before?: ReadonlyArray<BeforeWriteHook<never, never>>;
    readonly after?: ReadonlyArray<AfterWriteHook<Post, never, never>>;
    readonly afterFailure?: "log" | "defect";
  }) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, {
      columns: ["title", "slug", "visibility", "draft"],
      now: NOW,
    });
    const viewer: Viewer = as(member);
    const ops = defineSubtype<LeafRow, Post, Following, never, never>({
      type: "posts",
      access: ownedAccess({ draft: true }),
      chain,
      leaves,
      viewer: Effect.succeed(viewer),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row) => ({ id: row.id, title: row["title"], slug: row["slug"] }),
      hooks: Effect.succeed({
        before: options.before ?? [],
        after: options.after ?? [],
        afterFailure: options.afterFailure,
      }),
    });
    const cached = MutableHashMap.empty<string, Post>();
    const handlers = subtypeHandlers(ops, {
      transact: (effect) => effect,
      cache: Option.some({
        set: (id, resource) => Effect.sync(() => void MutableHashMap.set(cached, id, resource)),
        delete: (id) => Effect.sync(() => void MutableHashMap.remove(cached, id)),
      }),
    });
    return { chain, ops, handlers, cached };
  };

  const recordBefore = (seen: Array<Seen>, name: string): BeforeWriteHook<never, never> => ({
    name,
    run: (event) =>
      Effect.sync(() => {
        seen.push([name, event.action, `${event.type}:${Option.isSome(event.prior)}`]);
        return event.patch;
      }),
  });

  const recordAfter = (seen: Array<Seen>, name: string): AfterWriteHook<Post, never, never> => ({
    name,
    run: (event) =>
      Effect.sync(() => {
        seen.push([name, event.action, `${event.write.version}:${Option.isSome(event.resource)}`]);
      }),
  });

  const state = { title: "A post", slug: null, visibility: "public", draft: false } as const;

  it("every write operation emits, before and after, in the hooks' order", async () => {
    const seen: Array<Seen> = [];
    const { handlers } = hooked({
      before: [recordBefore(seen, "b1"), recordBefore(seen, "b2")],
      after: [recordAfter(seen, "a1"), recordAfter(seen, "a2")],
    });
    const { id } = await run(handlers.create({ id: Option.none(), state }));
    await run(handlers.update({ id, patch: { title: "Edited" } }));
    await run(handlers.delete(id));
    await run(handlers.restore({ id, patch: {} }));
    await run(handlers.restoreVersion({ id, version: 0n }));
    expect(seen).toEqual([
      ["b1", "create", "posts:false"],
      ["b2", "create", "posts:false"],
      ["a1", "create", "0:true"],
      ["a2", "create", "0:true"],
      ["b1", "update", "posts:true"],
      ["b2", "update", "posts:true"],
      ["a1", "update", "1:true"],
      ["a2", "update", "1:true"],
      ["b1", "delete", "posts:true"],
      ["b2", "delete", "posts:true"],
      ["a1", "delete", "2:false"],
      ["a2", "delete", "2:false"],
      ["b1", "restore", "posts:true"],
      ["b2", "restore", "posts:true"],
      ["a1", "restore", "3:true"],
      ["a2", "restore", "3:true"],
      ["b1", "restoreVersion", "posts:true"],
      ["b2", "restoreVersion", "posts:true"],
      ["a1", "restoreVersion", "4:true"],
      ["a2", "restoreVersion", "4:true"],
    ]);
  });

  it("an already tombstoned node's delete writes nothing and emits nothing", async () => {
    const seen: Array<Seen> = [];
    const { handlers } = hooked({
      before: [recordBefore(seen, "b")],
      after: [recordAfter(seen, "a")],
    });
    const { id } = await run(handlers.create({ id: Option.none(), state }));
    await run(handlers.delete(id));
    seen.length = 0;
    await run(handlers.delete(id));
    expect(seen).toEqual([]);
  });

  it("a before hook transforms the patch: each hook sees the previous one's", async () => {
    const title = (patch: ChainPatch) => Option.liftPredicate(patch["title"], Predicate.isString);
    const slugOf = (patch: ChainPatch): ChainPatch =>
      Option.match(title(patch), {
        onNone: () => patch,
        onSome: (value) => ({ ...patch, slug: value.toLowerCase() }),
      });
    const shout: BeforeWriteHook<never, never> = {
      name: "shout",
      run: (event) =>
        Effect.succeed(
          Option.match(title(event.patch), {
            onNone: () => event.patch,
            onSome: (value) => ({ ...event.patch, title: value.toUpperCase() }),
          }),
        ),
    };
    const slug: BeforeWriteHook<never, never> = {
      name: "slug",
      run: (event) => Effect.succeed(slugOf(event.patch)),
    };
    const { chain, ops } = hooked({ before: [shout, slug] });
    const { id } = await run(ops.create({ id: Option.none(), state }));
    await run(ops.update({ id, patch: { title: "Edited" } }));
    expect(chain.rows().map((row) => [row.state["title"], row.state["slug"]])).toEqual([
      ["A POST", "a post"],
      ["EDITED", "edited"],
    ]);
  });

  it("a before hook that fails rolls the write back: nothing is appended, nothing emitted after", async () => {
    const seen: Array<Seen> = [];
    const refuse: BeforeWriteHook<never, never> = {
      name: "refuse",
      run: (event) =>
        event.action === "create"
          ? Effect.succeed(event.patch)
          : Effect.fail(
              new WriteRejected({
                type: event.type,
                id: event.id,
                action: event.action,
                reason: "no",
              }),
            ),
    };
    const { chain, handlers, cached } = hooked({
      before: [refuse, recordBefore(seen, "later")],
      after: [recordAfter(seen, "a")],
    });
    const { id } = await run(handlers.create({ id: Option.none(), state }));
    seen.length = 0;
    const cachedBefore = MutableHashMap.get(cached, id);
    const refused = await Promise.all([
      tagOf(handlers.update({ id, patch: { title: "x" } })),
      tagOf(handlers.delete(id)),
      tagOf(handlers.restore({ id, patch: {} })),
      tagOf(handlers.restoreVersion({ id, version: 0n })),
    ]);
    expect(refused).toEqual(Arr.replicate(Option.some("WriteRejected"), 4));
    expect(chain.rows()).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(MutableHashMap.get(cached, id)).toEqual(cachedBefore);
  });

  it("a before hook runs after the gate: a refused caller never reaches it", async () => {
    const seen: Array<Seen> = [];
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
    const ops = defineSubtype<LeafRow, unknown, Following, never, never>({
      type: "pages",
      access: { kind: "reference" },
      chain,
      leaves,
      viewer: Effect.succeed(as(member)),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row) => row,
      hooks: Effect.succeed({ before: [recordBefore(seen, "b")], after: [] }),
    });
    expect(await tagOf(ops.create({ id: Option.none(), state: { title: "t" } }))).toEqual(
      Option.some("Forbidden"),
    );
    expect(seen).toEqual([]);
  });

  it("an after hook that fails doesn't fail the write, and the next one still runs", async () => {
    const seen: Array<Seen> = [];
    const broken: AfterWriteHook<Post, never, never> = {
      name: "broken",
      run: () => Effect.die("webhook down"),
    };
    const { chain, handlers, cached } = hooked({
      after: [broken, recordAfter(seen, "next")],
    });
    const created = await run(handlers.create({ id: Option.none(), state }));
    expect(chain.rows()).toHaveLength(1);
    expect(seen).toEqual([["next", "create", "0:true"]]);
    // The cache write-through is the first after hook, and still ran.
    expect(MutableHashMap.get(cached, created.id)).toEqual(Option.some(created));
  });

  it("under afterFailure: defect, an after hook's failure is a defect after the commit", async () => {
    const broken: AfterWriteHook<Post, never, never> = {
      name: "broken",
      run: () => Effect.die("webhook down"),
    };
    const { chain, handlers } = hooked({ after: [broken], afterFailure: "defect" });
    const exit = await Effect.runPromiseExit(handlers.create({ id: Option.none(), state }));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(chain.rows()).toHaveLength(1);
  });

  it("a leaf without hooks reads no head snapshot for restoreVersion beyond the restored one", async () => {
    const chain = makeInMemoryChainStore();
    const snapshots: Array<bigint> = [];
    const leaves = makeInMemoryLeafStore(chain, { columns: ["title"], now: NOW });
    const ops = defineSubtype<LeafRow, unknown, Following, never, never>({
      type: "pages",
      access: { kind: "reference" },
      chain: {
        ...chain,
        snapshot: (id, version) =>
          Effect.suspend(() => {
            snapshots.push(version);
            return chain.snapshot(id, version);
          }),
      },
      leaves,
      viewer: Effect.succeed(as(admin)),
      policy: gardeneriaPolicy,
      followers: follows,
      toResource: (row) => row,
    });
    const { id } = await run(ops.create({ id: Option.none(), state: { title: "t" } }));
    await run(ops.update({ id, patch: { title: "u" } }));
    snapshots.length = 0;
    await run(ops.restoreVersion(id, 0n));
    expect(snapshots).toEqual([0n]);
  });

  it("composeHooks concatenates in order, and the first given afterFailure wins", () => {
    const seen: Array<Seen> = [];
    const composed = composeHooks<Post, never, never>(
      { before: [recordBefore(seen, "x")], after: [] },
      {
        before: [recordBefore(seen, "y")],
        after: [recordAfter(seen, "z")],
        afterFailure: "defect",
      },
      noHooks(),
      { before: [], after: [], afterFailure: "log" },
    );
    expect(composed.before.map((hook) => hook.name)).toEqual(["x", "y"]);
    expect(composed.after.map((hook) => hook.name)).toEqual(["z"]);
    expect(composed.afterFailure).toBe("defect");
    expect(composeHooks().afterFailure).toBeUndefined();
  });

  it("cacheWriteThrough sets a re-read resource and evicts on none", async () => {
    const cached = MutableHashMap.empty<string, unknown>();
    const hook = cacheWriteThrough<unknown, never>({
      set: (id, resource) => Effect.sync(() => void MutableHashMap.set(cached, id, resource)),
      delete: (id) => Effect.sync(() => void MutableHashMap.remove(cached, id)),
    });
    const event = { type: "posts", action: "update", write: { id: "p", version: 1n } } as const;
    await run(hook.run({ ...event, resource: Option.some("r") }));
    expect(MutableHashMap.get(cached, "p")).toEqual(Option.some("r"));
    await run(hook.run({ ...event, resource: Option.none() }));
    expect(MutableHashMap.has(cached, "p")).toBe(false);
  });
});
