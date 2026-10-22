/**
 * A consumer's view of `@thomasfosterau/pulpit/testing`, the in-memory fakes,
 * through its EMITTED declarations (`paths` in tsconfig.json points the name
 * at `dist/*.d.ts`), as `consumer.ts` is for the other subpaths. Each fake is
 * asserted to satisfy the seam it fakes (`Satisfies`, one-way), and each
 * factory's return type, test hook and `Following` parameter is asserted
 * EXACTLY (`Equals`, two-way), because a one-way check passes `any`: a
 * declaration that degraded to `any` or drifted from its seam fails here.
 * Never executed; type-checked only.
 */

import * as Effect from "effect/Effect";
import type * as HashMap from "effect/HashMap";
import type * as HashSet from "effect/HashSet";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { canonicalText, type DocumentStore } from "@thomasfosterau/pulpit/documents";
import type { EdgeRow, EdgeStore, EdgeValues, EndpointView } from "@thomasfosterau/pulpit/edges";
import type { ListFilter } from "@thomasfosterau/pulpit/filter";
import {
  defineSubtype,
  type FollowerSeam,
  type LeafRow,
  type LeafStore,
  type ListOrder,
} from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryChainStore,
  makeInMemoryDocumentStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
  makeInMemoryNodes,
  type InMemoryChainStore,
  type InMemoryDocumentStore,
  type InMemoryEdgeStore,
  type InMemoryEdgeStoreOptions,
  type InMemoryFollowing,
  type InMemoryLeafStore,
  type InMemoryLeafStoreOptions,
  type InMemoryNodes,
} from "@thomasfosterau/pulpit/testing";
import type { VersionChainStore, VersionRow } from "@thomasfosterau/pulpit/version-chain";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
/** Whether `A` is assignable to `B`: a fake satisfies its seam. */
type Satisfies<A, B> = [A] extends [B] ? true : false;

// ── the follower set and seam ────────────────────────────────────────────

export type _Following = Assert<Equals<InMemoryFollowing, HashSet.HashSet<string>>>;
export type _Followers = Assert<
  Equals<ReturnType<typeof makeInMemoryFollowers>, FollowerSeam<InMemoryFollowing, never>>
>;

// ── the version chain ────────────────────────────────────────────────────

export type _Chain = Assert<Equals<ReturnType<typeof makeInMemoryChainStore>, InMemoryChainStore>>;
export type _ChainSeam = Assert<Satisfies<InMemoryChainStore, VersionChainStore<never, never>>>;
export type _ChainRows = Assert<
  Equals<ReturnType<InMemoryChainStore["rows"]>, ReadonlyArray<VersionRow>>
>;
export type _ChainDrop = Assert<
  Equals<InMemoryChainStore["dropState"], (id: string, version: bigint) => void>
>;
export type _ChainRace = Assert<Equals<InMemoryChainStore["raceNextAppend"], (id: string) => void>>;

// ── the leaf view ────────────────────────────────────────────────────────

export type _Leaf = Assert<
  Equals<
    Parameters<typeof makeInMemoryLeafStore>,
    [chain: InMemoryChainStore, options: InMemoryLeafStoreOptions]
  >
>;
export type _LeafReturn = Assert<
  Equals<ReturnType<typeof makeInMemoryLeafStore>, InMemoryLeafStore>
>;
export type _LeafSeam = Assert<
  Satisfies<InMemoryLeafStore, LeafStore<LeafRow, InMemoryFollowing, never, never>>
>;
/** The `Following` parameter exactly: `Satisfies` would pass `LeafStore<LeafRow, any, …>`. */
export type _LeafFollowing = Assert<
  Equals<Parameters<InMemoryLeafStore["list"]>[0]["where"], ListFilter<InMemoryFollowing>>
>;
/** The order arrives checked, so the fake's `orderBy` is required (pulpit#112). */
export type _LeafOrder = Assert<
  Equals<Parameters<InMemoryLeafStore["list"]>[0]["orderBy"], ReadonlyArray<ListOrder>>
>;
export type _LeafDropOwner = Assert<Equals<InMemoryLeafStore["dropOwner"], (id: string) => void>>;
export type _LeafOwners = Assert<
  Equals<ReturnType<InMemoryLeafStore["owners"]>, HashMap.HashMap<string, string>>
>;
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the emitted option exactly, and the workspace's optional fields are `?: T | undefined` */
export type _LeafNow = Assert<Equals<InMemoryLeafStoreOptions["now"], Date | undefined>>;
/* oxlint-enable effect/prefer-option-over-null */

// The fakes compose into the kernel's factory with no services left over.
const chain = makeInMemoryChainStore();
export const notes = defineSubtype({
  type: "notes",
  access: { kind: "reference" },
  chain,
  leaves: makeInMemoryLeafStore(chain, { columns: ["title"] }),
  viewer: Effect.succeedNone,
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: () => true,
  },
  followers: makeInMemoryFollowers([]),
  toResource: (row: LeafRow) => row,
});
export type _NotesServices = Assert<Equals<Effect.Services<ReturnType<typeof notes.get>>, never>>;

// ── documents ────────────────────────────────────────────────────────────

type Prose = { readonly type: "doc"; readonly content: ReadonlyArray<string> };
export type _Documents = Assert<
  Equals<ReturnType<typeof makeInMemoryDocumentStore<Prose>>, InMemoryDocumentStore<Prose>>
>;
export type _DocumentsSeam = Assert<
  Satisfies<InMemoryDocumentStore<Prose>, DocumentStore<Prose, never, never>>
>;
export type _DocumentsPut = Assert<
  Equals<
    ReturnType<InMemoryDocumentStore<Prose>["put"]>,
    Effect.Effect<{ readonly hash: string; readonly inserted: boolean }>
  >
>;
export type _DocumentsGet = Assert<
  Equals<ReturnType<InMemoryDocumentStore<Prose>["get"]>, Effect.Effect<Option.Option<Prose>>>
>;
export type _Canonical = Assert<Equals<typeof canonicalText, (value: Schema.Json) => string>>;

// ── edges ────────────────────────────────────────────────────────────────

export type _Nodes = Assert<Equals<ReturnType<typeof makeInMemoryNodes>, InMemoryNodes>>;
export type _NodesSeam = Assert<Satisfies<InMemoryNodes, EndpointView<never, never>>>;
export type _NodesPut = Assert<Equals<InMemoryNodes["put"], (row: LeafRow) => void>>;
export type _Edges = Assert<
  Equals<Parameters<typeof makeInMemoryEdgeStore>, [options: InMemoryEdgeStoreOptions]>
>;
export type _EdgesReturn = Assert<
  Equals<ReturnType<typeof makeInMemoryEdgeStore>, InMemoryEdgeStore>
>;
export type _EdgesSeam = Assert<
  Satisfies<InMemoryEdgeStore, EdgeStore<EdgeRow, InMemoryFollowing, never, never>>
>;
export type _EdgeRows = Assert<
  Equals<ReturnType<InMemoryEdgeStore["rows"]>, ReadonlyArray<EdgeRow>>
>;
export type _EdgeFollowing = Assert<
  Equals<Parameters<InMemoryEdgeStore["list"]>[0]["where"], ListFilter<InMemoryFollowing>>
>;
export type _EdgeRace = Assert<
  Equals<InMemoryEdgeStore["raceNextInsert"], (winner: EdgeValues) => void>
>;
