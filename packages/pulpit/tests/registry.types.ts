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

/** Whether two types are identical (not merely mutually assignable). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

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
// @ts-expect-error -- the tuple is exact: no widened `Resource.Any[]`
export const ownedNotWidened: Equals<typeof owned, readonly Resource.Any[]> = true;

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
// @ts-expect-error -- a garden is not in the content branch
export const notInBranch: "gardens" = ContentBranch.Type.type;
