/**
 * The registry's two contracts, on a fixture tree: the **derived wire
 * identity** (the branch and flag projections list exactly the registered
 * leaves, in registry order) and the **construction-time validation** (each
 * invariant throws on the minimal malformed fixture that trips it; an
 * application's own check runs after the generic ones).
 *
 * The fixture cases are gardeneria's `packages/models/tests/registry.test.ts`,
 * with a local `comments` / `gardens` / `taxa` tree standing in for the
 * app's registry.
 *
 * @module tests/registry
 */

import { describe, expect, it } from "vite-plus/test";
import * as Array from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import {
  branchMembers,
  branchOf,
  flaggedMembers,
  identifiersOf,
  indexByKey,
  parent,
  RegistryDeclarationError,
  root,
  registryWireTypes,
  validateRegistry,
  type RegistryCheck,
  type RegistryEntry,
} from "../src/registry.ts";
import { decodes } from "./fixtures.ts";

const UUID = "00000000-0000-4000-8000-000000000000";

// ── The fixture tree ──────────────────────────────────────────────────

const NodeId = Schema.String.pipe(Schema.brand("NodeId"));
const EntityId = NodeId.pipe(Schema.brand("EntityId"));
const ContentId = NodeId.pipe(Schema.brand("ContentId"));
const CommentId = ContentId.pipe(Schema.brand("CommentId"));
const GardenId = EntityId.pipe(Schema.brand("GardenId"));
const TaxonId = EntityId.pipe(Schema.brand("TaxonId"));

const CommentResource = Resource.make("comments", {
  id: CommentId,
  attributes: { body: Schema.String },
});
const GardenResource = Resource.make("gardens", {
  id: GardenId,
  attributes: { name: Schema.String },
});
const TaxonResource = Resource.make("taxa", {
  id: TaxonId,
  attributes: { name: Schema.String },
});

const ROOTS = ["entity", "content"] as const;

const REGISTRY = [
  { key: "node", parent: root, id: NodeId },
  { key: "entity", parent: parent("node"), id: EntityId },
  { key: "content", parent: parent("node"), id: ContentId },
  { key: "place", parent: parent("entity"), id: EntityId },
  {
    key: "gardens",
    parent: parent("place"),
    resource: GardenResource,
    id: GardenId,
    owned: true,
    pageable: true,
    searchable: true,
  },
  {
    key: "taxa",
    parent: parent("entity"),
    resource: TaxonResource,
    id: TaxonId,
    referenceData: true,
    pageable: true,
  },
  {
    key: "comments",
    parent: parent("content"),
    resource: CommentResource,
    id: CommentId,
    owned: true,
  },
] as const satisfies readonly RegistryEntry[];

validateRegistry(REGISTRY);

// ── Derived wire identity ─────────────────────────────────────────────

describe("registry — derived wire identity", () => {
  const wire = registryWireTypes(REGISTRY, ROOTS);

  it("projects each branch from the tree walk, a marker level included", () => {
    // A leaf hanging off the `place` marker is an entity exactly as one
    // hanging off `entity` is.
    expect(wire.branches.entity).toEqual(["gardens", "taxa"]);
    expect(wire.branches.content).toEqual(["comments"]);
  });

  it("projects the capability subsets in registry order", () => {
    expect(wire.owned).toEqual(["gardens", "comments"]);
    expect(wire.referenceData).toEqual(["taxa"]);
    expect(wire.pageable).toEqual(["gardens", "taxa"]);
    expect(wire.searchable).toEqual(["gardens"]);
    expect(wire.agent).toEqual([]);
  });

  it("keeps the two trust-model subsets disjoint", () => {
    expect(Array.intersection(wire.owned, wire.referenceData)).toEqual([]);
  });

  it("flaggedMembers / branchMembers return the resources themselves, typed as the member tuple", () => {
    expect(flaggedMembers(REGISTRY, "owned")).toEqual([GardenResource, CommentResource]);
    const content = branchMembers(REGISTRY, "content", ROOTS);
    expect(content).toEqual([CommentResource]);
    const ContentBranchRef = Schema.Union(identifiersOf(content));
    expect(decodes(ContentBranchRef, { type: "comments", id: UUID })).toBe(true);
    expect(decodes(ContentBranchRef, { type: "gardens", id: UUID })).toBe(false);
  });

  it("branchOf walks the marker levels to the branch root", () => {
    const byKey = indexByKey(REGISTRY);
    expect(branchOf(REGISTRY[4], byKey, ROOTS)).toEqual(parent("entity"));
    expect(branchOf(REGISTRY[6], byKey, ROOTS)).toEqual(parent("content"));
    expect(branchOf(REGISTRY[0], byKey, ROOTS)).toEqual(Option.none());
    // An unknown parent resolves to nothing rather than throwing.
    expect(branchOf({ key: "x", parent: parent("nowhere") }, byKey, ROOTS)).toEqual(Option.none());
    // A root is its own branch.
    expect(branchOf(REGISTRY[2], HashMap.empty(), ROOTS)).toEqual(parent("content"));
  });
});

// ── Construction-time validation ──────────────────────────────────────

describe("registry — construction-time validation", () => {
  // Each fixture is the *minimal* malformed registry that trips one invariant;
  // `validateRegistry` throws on the first violation.
  const run = (entries: readonly RegistryEntry[], checks?: ReadonlyArray<RegistryCheck>) =>
    validateRegistry(entries, checks);

  it("accepts a well-formed minimal registry", () => {
    const entries: readonly RegistryEntry[] = [
      { key: "node", parent: root },
      { key: "content", parent: parent("node") },
      {
        key: "comments",
        parent: parent("content"),
        resource: CommentResource,
        id: CommentId,
        owned: true,
      },
    ];
    expect(() => run(entries)).not.toThrow();
  });

  it("throws the tagged declaration error", () => {
    expect(() =>
      run([
        { key: "node", parent: root },
        { key: "node", parent: root },
      ]),
    ).toThrow(RegistryDeclarationError);
  });

  it("rejects a duplicate key", () => {
    const entries: readonly RegistryEntry[] = [
      { key: "node", parent: root },
      { key: "node", parent: root },
    ];
    expect(() => run(entries)).toThrow(/duplicate key 'node'/);
  });

  it("rejects an unresolved parent", () => {
    const entries: readonly RegistryEntry[] = [{ key: "entity", parent: parent("nowhere") }];
    expect(() => run(entries)).toThrow(/names parent 'nowhere'/);
  });

  it("rejects a capability flag with no resource", () => {
    const entries: readonly RegistryEntry[] = [{ key: "agent", parent: root, agent: true }];
    expect(() => run(entries)).toThrow(/flagged 'agent' but declares no resource/);
  });

  it("rejects a leaf flagged both owned and referenceData", () => {
    const entries: readonly RegistryEntry[] = [
      {
        key: "comments",
        parent: root,
        resource: CommentResource,
        id: CommentId,
        owned: true,
        referenceData: true,
      },
    ];
    expect(() => run(entries)).toThrow(/both 'owned' and 'referenceData'/);
  });

  it("rejects a resource leaf with no ids.ts brand", () => {
    const entries: readonly RegistryEntry[] = [
      { key: "comments", parent: root, resource: CommentResource },
    ];
    expect(() => run(entries)).toThrow(/declares a resource but no ids.ts brand/);
  });

  it("rejects an id brand that is not the resource's own id", () => {
    const entries: readonly RegistryEntry[] = [
      { key: "comments", parent: root, resource: CommentResource, id: EntityId },
    ];
    expect(() => run(entries)).toThrow(/ids.ts drift/);
  });

  it("rejects a key that does not match the resource wire type", () => {
    const entries: readonly RegistryEntry[] = [
      { key: "remarks", parent: root, resource: CommentResource, id: CommentId },
    ];
    expect(() => run(entries)).toThrow(/key does not match its resource wire type 'comments'/);
  });

  it("runs an application's own checks after the generic ones, with the index", () => {
    // gardeneria's `searchType` ⇔ `searchable` pairing, restated as a check.
    const searchPairing: RegistryCheck = (entry, byKey) =>
      entry.searchable === true && !HashMap.has(byKey, `${entry.key}_search_view`)
        ? Option.some(`'${entry.key}' is searchable but declares no search view`)
        : Option.none();
    const entries: readonly RegistryEntry[] = [
      { key: "node", parent: root },
      {
        key: "comments",
        parent: parent("node"),
        resource: CommentResource,
        id: CommentId,
        searchable: true,
      },
    ];
    expect(() => run(entries, [searchPairing])).toThrow(/declares no search view/);
    expect(() =>
      run([...entries, { key: "comments_search_view", parent: parent("node") }], [searchPairing]),
    ).not.toThrow();
    // The generic checks run first: a duplicate key trips before any app check.
    expect(() => run([...entries, ...entries], [searchPairing])).toThrow(/duplicate key/);
  });
});
