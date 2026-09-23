/**
 * A consumer's view of the package: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package name at
 * `dist/*.d.ts`). Each block exercises the types a real consumer depends on,
 * so a declaration that degrades to `any` fails here rather than in an
 * application. Never executed; type-checked only.
 */

import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { Content, Registry } from "@thomasfosterau/pulpit";
import {
  ContentResource,
  contentVisibilityResourceFields,
  makeContentResource,
  ownedContentLeafResourceFields,
  ownerRef,
  Visibility,
} from "@thomasfosterau/pulpit/content";
import {
  flaggedMembers,
  parent,
  registryWireTypes,
  root,
  validateRegistry,
  type RegistryEntry,
} from "@thomasfosterau/pulpit/registry";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// ── content ──────────────────────────────────────────────────────────────

export type _Visibility = Assert<Equals<Visibility, "public" | "followers" | "private">>;
export type _Barrel = Assert<Equals<typeof Content.Visibility, typeof Visibility>>;

const UserResource = Resource.make("users", { attributes: { name: Schema.String } });

export const Post = Resource.make("posts", {
  attributes: {
    ...ownedContentLeafResourceFields,
    ...contentVisibilityResourceFields,
    title: Schema.NonEmptyString,
  },
  relationships: { ...ownerRef(() => UserResource) },
});

// The resource object carries the axes as required, the tombstone as optional.
export type _PostAttributes = Assert<
  Equals<
    typeof Post.Type.attributes,
    {
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly deletedAt?: Date;
      readonly visibility: "public" | "followers" | "private";
      readonly draft: boolean;
      readonly title: string;
    }
  >
>;

// The create input has the axes optional (effect-jsonapi's `"optional"`
// presence: absent, or an explicit `undefined` meaning "not supplied") and
// none of the server-set fields. The `| undefined` members restate what the
// emitted declaration says; they are asserted, not chosen here.
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the upstream projection exactly, and effect-jsonapi's `"optional"` presence is `?: T | undefined` */
export type _PostCreate = Assert<
  Equals<
    typeof Post.createInput.Type,
    {
      readonly visibility?: "public" | "followers" | "private" | undefined;
      readonly draft?: boolean | undefined;
      readonly title: string;
    }
  >
>;
/* oxlint-enable effect/prefer-option-over-null */

// `owner` is a to-one linkage to the supplied family.
export type _Owner = Assert<Equals<typeof Post.relationships.owner.kind, "one">>;

const ContentId = Schema.String.pipe(Schema.brand("ContentId"));
export const Branded = makeContentResource(ContentId);
export type _BrandedId = Assert<Equals<typeof Branded.Id, typeof ContentId>>;
export type _DefaultId = Assert<Equals<typeof ContentResource.type, "content">>;

// ── registry ─────────────────────────────────────────────────────────────

const REGISTRY = [
  { key: "node", parent: root },
  { key: "content", parent: parent("node") },
  { key: "posts", parent: parent("content"), resource: Post, id: Post.Id, owned: true },
] as const satisfies readonly RegistryEntry[];

validateRegistry(REGISTRY);

export const owned = flaggedMembers(REGISTRY, "owned");
export type _Owned = Assert<Equals<typeof owned, readonly [typeof Post]>>;
export type _OwnedBarrel = Assert<
  Equals<ReturnType<typeof Registry.flaggedMembers<typeof REGISTRY, "owned">>, typeof owned>
>;

export const wire = registryWireTypes(REGISTRY, ["content"] as const);
export type _Wire = Assert<
  Equals<typeof wire.branches, { readonly content: ReadonlyArray<string> }>
>;
