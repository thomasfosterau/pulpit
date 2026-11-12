/**
 * Type-level tests for the registry's member derivation: `flaggedMembers` /
 * `branchMembers` narrow to the registered resources' precise tuple, so a
 * `Schema.Union` over them keeps its `type`-literal discriminant.
 *
 * Type-checked by the package's `check` task (`tsconfig.json` includes
 * `tests/`); the expected-error directives are the assertions, each paired
 * with the positive control that shows the error is the declaration's and
 * not the expression's. Every binding is exported so an unused-local error
 * can never stand in for the assertion an expected-error directive expects.
 *
 * @module tests/registry.types
 */

import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import {
  branchMembers,
  flaggedMembers,
  parent,
  root,
  type RegistryEntry,
} from "../src/registry.ts";

/** Whether `A` is assignable to `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;

/** Whether two types are identical (not merely mutually assignable). */
type Equals<A, B> =
  (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2
    ? true
    : false;

const CommentId = Schema.String.pipe(Schema.brand("CommentId"));
const GardenId = Schema.String.pipe(Schema.brand("GardenId"));

const CommentResource = Resource.make("comments", { id: CommentId, attributes: {} });
const GardenResource = Resource.make("gardens", { id: GardenId, attributes: {} });

const REGISTRY = [
  { key: "node", parent: root },
  { key: "entity", parent: parent("node") },
  { key: "content", parent: parent("node") },
  {
    key: "gardens",
    parent: parent("entity"),
    resource: GardenResource,
    id: GardenId,
    owned: true,
  },
  {
    key: "comments",
    parent: parent("content"),
    resource: CommentResource,
    id: CommentId,
    owned: true,
  },
] as const satisfies readonly RegistryEntry[];

const ROOTS = ["entity", "content"] as const;

// ── flaggedMembers narrows to the flagged resources, in registry order ──

export const owned = flaggedMembers(REGISTRY, "owned");
export const ownedIsTuple: Equals<
  typeof owned,
  readonly [typeof GardenResource, typeof CommentResource]
> = true;
// The tuple is exact: no widened `Resource.Any[]`.
export const ownedNotWidened: Equals<typeof owned, readonly Resource.Any[]> = false;

export const referenceData = flaggedMembers(REGISTRY, "referenceData");
export const nothingFlagged: Equals<typeof referenceData, readonly []> = true;

// ── branchMembers narrows to the root's direct resource children ──

export const content = branchMembers(REGISTRY, "content", ROOTS);
export const contentIsTuple: Equals<typeof content, readonly [typeof CommentResource]> = true;

// Naming the marker levels under a root widens the tuple to the leaves beneath them.
export const entity = branchMembers(REGISTRY, "entity", ROOTS, ["entity", "place"]);
export const entityIsTuple: Equals<typeof entity, readonly [typeof GardenResource]> = true;

// The union over the tuple keeps the literal discriminant.
export const ContentBranch = Schema.Union(content);
export type ContentBranch = typeof ContentBranch.Type;
export const discriminated: "comments" = ContentBranch.Type.type;
// A garden is not in the content branch.
export const notInBranch: Assignable<ContentBranch["type"], "gardens"> = false;

// ── An absent member is omitted ──
//
// The workspace compiles with `exactOptionalPropertyTypes`, and an optional
// `RegistryEntry` member is plain `?: T` (a flag `?: true`), so an explicit
// `undefined` is rejected: a caller holding `undefined` omits the key
// (AGENTS.md → Conventions).

export const marker: RegistryEntry = { key: "node", parent: root };
/** A registry entry whose `Key` member holds exactly `Value`. */
type With<Key extends keyof RegistryEntry, Value> = Omit<RegistryEntry, Key> & {
  readonly [K in Key]: Value;
};
// A flag is literally `true` or absent, never `false`.
export const trueFlag: Assignable<With<"pageable", true>, RegistryEntry> = true;
export const falseFlag: Assignable<With<"pageable", false>, RegistryEntry> = false;
// An absent resource is omitted, never `undefined`.
export const undefinedResource: Assignable<With<"resource", undefined>, RegistryEntry> = false;
// An absent id is omitted, never `undefined`.
export const undefinedId: Assignable<With<"id", undefined>, RegistryEntry> = false;

const EXPLICIT = [
  { key: "node", parent: root },
  {
    key: "gardens",
    parent: parent("node"),
    resource: GardenResource,
    id: GardenId,
    owned: true,
  },
  { key: "tags", parent: parent("node"), owned: true },
] as const satisfies readonly RegistryEntry[];

// `PickResources` / `PickChildren` select only a declared resource: an entry
// that omits `resource` is a marker level, even when flagged.
export const explicitOwned = flaggedMembers(EXPLICIT, "owned");
export const explicitOwnedIsTuple: Equals<typeof explicitOwned, readonly [typeof GardenResource]> =
  true;
export const explicitPageable = flaggedMembers(EXPLICIT, "pageable");
export const explicitPageableIsEmpty: Equals<typeof explicitPageable, readonly []> = true;
export const explicitChildren = branchMembers(EXPLICIT, "node", ["node"]);
export const explicitChildrenIsTuple: Equals<
  typeof explicitChildren,
  readonly [typeof GardenResource]
> = true;
