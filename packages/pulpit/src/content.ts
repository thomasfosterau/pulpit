/**
 * **The Content model half of the kernel** — the shared Content-axis field
 * spreads and the base `content` resource, defined via
 * `@thomasfosterau/effect-jsonapi`'s `Resource.make`.
 *
 * Ported from gardeneria's `packages/models/src/models/content.ts` (the
 * three-state `Visibility`; website's copy is the older two-state one) and the
 * timestamp / tombstone spreads of its `packages/models/src/utilities.ts`. A
 * `#NNN` here names a gardeneria issue.
 *
 * Every spread is a plain `const` field map a Content subtype spreads into its
 * own `Resource.make({ attributes })`, so one declaration drives the resource
 * object, its documents and the create / update projections (the tri-state
 * rule: a value sets, `null` clears a nullable column, `undefined` carries
 * forward — declared on the descriptor, never re-spelled at a call site).
 *
 * @copyright Thomas Foster
 * @module pulpit/content
 * @since 0.1.0
 */

import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";

/**
 * Visibility — the explicit access axis the publication policy reads,
 * independent of soft-delete and the draft flag. Three states, because the
 * kernel is multi-tenant:
 *
 * - `public` — anyone, signed in or not; the only state the KV read-through
 *   cache may ever hold (`isPubliclyServeable` in `./publication`);
 * - `followers` — the owner, the owner's followers (the follower seam in
 *   `./subtype`), and the privileged rung;
 * - `private` — the owner and the privileged rung only.
 *
 * The predicate lives in ONE place — `canViewOwned` in `./subtype` — and
 * every read of an owned row goes through it. Content carries it on the
 * Content branch's version row; owned Entity / File leaves carry the same
 * column on their own version row, declared with
 * {@link ownedVisibilityResourceFields}.
 *
 * @since 0.1.0
 */
export const Visibility = Schema.Literals(["public", "followers", "private"]);
/**
 * The {@link Visibility} literal union: `"public" | "followers" | "private"`.
 *
 * @since 0.1.0
 */
export type Visibility = typeof Visibility.Type;

/**
 * The two orthogonal Content-branch axes every Content subtype carries on its
 * version row: `visibility` (three-state, above) and the binary `draft` flag
 * (`PUB-009` / `PUB-010`). Both are required on the resource but optional to
 * supply at create / update (a DB default applies, updates carry forward);
 * neither is ever cleared.
 *
 * `Resource.attribute(schema, { create: "optional" })` is the
 * required-on-resource, optional-at-both-inputs, never-cleared descriptor.
 *
 * @since 0.1.0
 */
export const contentVisibilityResourceFields = {
  visibility: Resource.attribute(Visibility, { create: "optional" }),
  draft: Resource.attribute(Schema.Boolean, { create: "optional" }),
} as const;

/**
 * The visibility / draft fields as **create-input** shapes (`Schema.optional`,
 * non-null), for Content subtypes' hand-written `Create` structs — a form
 * adapter passes `value | undefined`, which `createInput`'s strict
 * `optionalKey` rejects, so the create struct is hand-written.
 *
 * @since 0.1.0
 */
export const contentVisibilityCreateFields = {
  visibility: Schema.optional(Visibility),
  draft: Schema.optional(Schema.Boolean),
} as const;

/**
 * The visibility axis alone, for **owned Entity / File leaves** (a garden, an
 * organism, an image): they carry `visibility` on their own version row but
 * no `draft` flag — a garden is not a draft of anything. Same descriptor as
 * the Content pair: required on the resource, optional at both inputs, never
 * cleared.
 *
 * @since 0.1.0
 */
export const ownedVisibilityResourceFields = {
  visibility: Resource.attribute(Visibility, { create: "optional" }),
} as const;

/**
 * The version-chain timestamps every node-family resource carries:
 * `createdAt` (the node's version-0 commit time) and `updatedAt` (its current
 * version's), server-computed and present on the resource only
 * (`readOnlyAttribute`), never accepted as command input.
 *
 * @since 0.1.0
 */
export const nodeTimestampResourceFields = {
  createdAt: Resource.readOnlyAttribute(Schema.Date),
  updatedAt: Resource.readOnlyAttribute(Schema.Date),
} as const;

/**
 * The soft-delete tombstone: `deletedAt` is present only on a tombstoned row
 * (`resource: "optional"` — emitters omit the key entirely while live, #691)
 * and is in no write projection. A tombstone is written by the chain's
 * `delete` operation (`./version-chain`), never by an input.
 *
 * @since 0.1.0
 */
export const tombstoneResourceFields = {
  deletedAt: Resource.attribute(Schema.Date, {
    resource: "optional",
    create: false,
    update: false,
  }),
} as const;

/**
 * The attribute spread every **reference-data** leaf carries: the two
 * timestamps and the tombstone. Reference data has no visibility axis of its
 * own — the corpus is publicly readable; a Content-branch reference leaf reads
 * `private` off the branch row like every other Content subtype.
 *
 * @since 0.1.0
 */
export const referenceLeafResourceFields = {
  ...nodeTimestampResourceFields,
  ...tombstoneResourceFields,
} as const;

/**
 * The attribute spread every **owned Content leaf** opens its attributes with:
 * the timestamps, the tombstone, and the access axis —
 * {@link referenceLeafResourceFields} plus {@link ownedVisibilityResourceFields}.
 *
 * `draft` is deliberately absent from THIS shared spread. The family that
 * actually wants a bare boolean "come back and finish this later" flag
 * declares it directly through {@link contentVisibilityResourceFields};
 * folding it in here would put an unused, always-`false` `draft` attribute on
 * every other owned Content leaf's wire contract. A leaf gated by a
 * publication *stamp* (`publishedAt`, the axis `./publication` reads) carries
 * that on its own row instead — a different axis from `draft`'s hard gate
 * (#1118).
 *
 * @since 0.1.0
 */
export const ownedContentLeafResourceFields = {
  ...referenceLeafResourceFields,
  ...ownedVisibilityResourceFields,
} as const;

/**
 * The `owner` relationship every **owned** leaf carries — the account family
 * the application supplies (its `users` resource) that owns the row.
 *
 * Server-assigned from the authenticated caller at creation and never
 * re-parented: the operation layer stamps the owner from the viewer rather
 * than from the payload (`stampOwner` in `./subtype`), so an application's
 * hand-written create / update structs omit it. Spread into a leaf's
 * `Resource.make({ relationships })` to opt in — the registry flags the same
 * leaf `owned`, and the subtype factory's `access: { kind: "owned", … }`
 * names the column the linkage reads.
 *
 * `Relationship.one`: every owned row has an owner. The target may still fail
 * to resolve (deleting an account does not cascade to its rows); consumers
 * degrade to a neutral label rather than erroring.
 *
 * Note that effect-jsonapi lists a `one` relationship as **required** in
 * the generated `createPayload`; an application serving the generated payload
 * strips the linkage at its handler seam. effect-jsonapi has no read-only
 * linkage descriptor (effect-jsonapi#172 closed without one; 0.16.3 has
 * none), and `tests/content.test.ts` pins the required linkage so the day one
 * ships is visible.
 *
 * @since 0.1.0
 */
export const ownerRef = <Owner extends Resource.Any>(owner: () => Owner) => ({
  owner: Relationship.one(owner),
});

/**
 * The base Content resource's attributes: the timestamps and the tombstone —
 * exactly {@link referenceLeafResourceFields}, named for the resource that
 * carries them so a subtype extending the base and a leaf spreading the
 * fields declare the same wire shape.
 *
 * @since 0.1.0
 */
export const contentResourceAttributeFields = referenceLeafResourceFields;

/**
 * Build the base `content` resource with the application's own id brand
 * (`makeContentResource(ContentId)`) — the shape {@link ContentResource}
 * carries with the auto-derived `Resource.Id<"content">`. An application whose
 * ids are branded hierarchically (a `PostId` that is also a `ContentId` and a
 * `NodeId`) declares the base with its own brand so the two agree.
 *
 * @since 0.1.0
 */
export const makeContentResource = <IdSchema extends Schema.Codec<any, string>>(id: IdSchema) =>
  Resource.make("content", { id, attributes: contentResourceAttributeFields });

/**
 * The base Content resource with the auto-derived id (timestamps + soft-delete tombstone).
 *
 * @since 0.1.0
 */
export const ContentResource = Resource.make("content", {
  attributes: contentResourceAttributeFields,
});

/**
 * Inferred type for a base content resource.
 *
 * @since 0.1.0
 */
export type Content = typeof ContentResource.Type;

/**
 * Lightweight `{ type, id }` reference to content.
 *
 * @since 0.1.0
 */
export const ContentRef = ContentResource.identifier;

/**
 * Inferred type for a content reference.
 *
 * @since 0.1.0
 */
export type ContentRef = typeof ContentRef.Type;
