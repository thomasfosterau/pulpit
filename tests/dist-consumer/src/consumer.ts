/**
 * A consumer's view of the package: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package name at
 * `dist/*.d.ts`). Each block exercises the types a real consumer depends on,
 * so a declaration that degrades to `any` fails here rather than in an
 * application. Never executed; type-checked only.
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { Content, Documents, Registry } from "@thomasfosterau/pulpit";
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
import {
  defineVersionChain,
  type ChainWrite,
  type NodeAlreadyExists,
  type NodeNotFound,
  type Precondition,
  type StaleVersion,
  type VersionChainOps,
  type VersionChainStore,
  type VersionConflict,
} from "@thomasfosterau/pulpit/version-chain";
import { and, eq, type ListFilter } from "@thomasfosterau/pulpit/filter";
import {
  defineSubtype,
  ownedAccess,
  type LeafRow,
  type LeafStore,
} from "@thomasfosterau/pulpit/subtype";
import { isPubliclyServeable, serveablePolicy } from "@thomasfosterau/pulpit/publication";
import { DocumentHash, documentRef, type DocumentStore } from "@thomasfosterau/pulpit/documents";

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

// ── version-chain ────────────────────────────────────────────────────────

class StoreFailure {
  readonly _tag = "StoreFailure";
}
interface Transaction {
  readonly _tag: "Transaction";
}
declare const store: VersionChainStore<StoreFailure, Transaction>;
export const chain = defineVersionChain("posts", store);
export type _Chain = Assert<Equals<typeof chain, VersionChainOps<StoreFailure, Transaction>>>;
export type _Create = Assert<
  Equals<
    ReturnType<typeof chain.create>,
    Effect.Effect<ChainWrite, StoreFailure | NodeAlreadyExists | VersionConflict, Transaction>
  >
>;
export type _Update = Assert<
  Equals<
    ReturnType<typeof chain.update>,
    Effect.Effect<
      ChainWrite,
      StoreFailure | NodeNotFound | StaleVersion | VersionConflict,
      Transaction
    >
  >
>;
export type _Precondition = Assert<
  // oxlint-disable-next-line effect/prefer-option-over-null -- asserts the emitted declaration keeps the workspace's `?: T | undefined` optional-field convention (AGENTS.md → Conventions)
  Equals<Precondition, { readonly expectedVersion?: bigint | undefined }>
>;
// The whole parameter list, read off a reference signature so the
// precondition is pinned as an optional trailing parameter.
export type _DeletePrecondition = Assert<
  Equals<
    Parameters<typeof chain.delete>,
    Parameters<(id: string, actorId: Option.Option<string>, precondition?: Precondition) => void>
  >
>;
export type _RestoreVersionPrecondition = Assert<
  Equals<
    Parameters<typeof chain.restoreVersion>,
    Parameters<
      (
        id: string,
        version: bigint,
        actorId: Option.Option<string>,
        precondition?: Precondition,
      ) => void
    >
  >
>;
export type _StaleVersionTag = Assert<Equals<StaleVersion["_tag"], "StaleVersion">>;
export type _StaleVersionExpected = Assert<Equals<StaleVersion["expected"], bigint>>;
export type _StaleVersion = Assert<Equals<StaleVersion["current"], bigint>>;

// ── filter + subtype ─────────────────────────────────────────────────────

interface Subquery {
  readonly _tag: "Subquery";
}
export const filter = and<Subquery>(eq("visibility", "public"));
export type _Filter = Assert<Equals<typeof filter, ListFilter<Subquery>>>;

declare const leaves: LeafStore<LeafRow, Subquery, StoreFailure, Transaction>;
interface PostDoc {
  readonly id: string;
}
export const posts = defineSubtype({
  type: "posts",
  access: ownedAccess({ draft: true }),
  chain: store,
  leaves,
  viewer: Effect.succeed(Option.none()),
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: () => false,
  },
  followers: {
    isFollower: () => Effect.succeed(false),
    following: (): Subquery => ({ _tag: "Subquery" }),
  },
  toResource: (row): PostDoc => ({ id: row.id }),
});
export type _Get = Assert<
  Equals<
    ReturnType<typeof posts.get>,
    Effect.Effect<PostDoc, NodeNotFound | StoreFailure, Transaction>
  >
>;

// ── publication ──────────────────────────────────────────────────────────

export const hook = serveablePolicy({ owned: true });
export type _Hook = Assert<Equals<ReturnType<typeof hook>, boolean>>;
export type _HookInput = Assert<Equals<Parameters<typeof hook>, [resource: unknown]>>;
export type _Gate = Assert<Equals<ReturnType<typeof isPubliclyServeable>, boolean>>;

// ── documents ────────────────────────────────────────────────────────────

export type _Hash = Assert<Equals<DocumentHash, string>>;
export type _HashBarrel = Assert<Equals<typeof Documents.DocumentHash, typeof DocumentHash>>;

interface ProseDocument {
  readonly type: "doc";
}
declare const documents: DocumentStore<ProseDocument, StoreFailure, Transaction>;
export type _Put = Assert<
  Equals<ReturnType<typeof documents.put>, Effect.Effect<string, StoreFailure, Transaction>>
>;
export type _GetDocument = Assert<
  Equals<
    ReturnType<typeof documents.get>,
    Effect.Effect<Option.Option<ProseDocument>, StoreFailure, Transaction>
  >
>;

// A version row's document reference: the hash, required on the resource
// and at create, optional (carried forward) at update.
export const Note = Resource.make("notes", {
  attributes: { ...documentRef("title"), ...documentRef("body") },
});
export type _NoteAttributes = Assert<
  Equals<typeof Note.Type.attributes, { readonly title: string; readonly body: string }>
>;
/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the upstream projection exactly, and effect-jsonapi's update presence is `?: T | undefined` */
export type _NoteUpdate = Assert<
  Equals<
    Omit<typeof Note.updateInput.Type, "id">,
    { readonly title?: string | undefined; readonly body?: string | undefined }
  >
>;
/* oxlint-enable effect/prefer-option-over-null */
