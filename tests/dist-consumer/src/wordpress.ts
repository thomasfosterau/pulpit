/**
 * A consumer's view of `@thomasfosterau/pulpit-wordpress` through its EMITTED
 * declarations (`paths` in tsconfig.json points the name at `dist/*.d.ts`),
 * as `consumer.ts` and `testing.ts` are for the kernel. Each export is
 * asserted EXACTLY (`Equals`, two-way), because a one-way check passes `any`:
 * a declaration that degraded to `any` or drifted fails here. Never executed;
 * type-checked only.
 */

import type * as Effect from "effect/Effect";
import type * as HashMap from "effect/HashMap";
import type * as Option from "effect/Option";
import * as WordPress from "@thomasfosterau/pulpit-wordpress";
import {
  integerIds,
  stringIds,
  UnencodableNodeId,
  type IdCodec,
  type StringIdsOptions,
  type WireId,
  type WireIdMode,
  type WireIds,
} from "@thomasfosterau/pulpit-wordpress/ids";
import {
  bind,
  defineWordPress,
  fileMediaFields,
  MAX_LIST_PARAMETER,
  type MediaFields,
  type BoundPostType,
  type PostFields,
  type PostTypeBinding,
  bindTaxonomy,
  type BoundTaxonomy,
  type TaxonomyBinding,
  type Taxonomy,
  type WordPressApi,
  type WordPressConfig,
  type WordPressRequest,
  type WordPressResponse,
} from "@thomasfosterau/pulpit-wordpress/api";
import { wordPressHttp } from "@thomasfosterau/pulpit-wordpress/http";
import type { ListFilter } from "@thomasfosterau/pulpit/filter";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Schema from "effect/Schema";
import {
  makeInMemoryIdCodec,
  type InMemoryIdCodec,
} from "@thomasfosterau/pulpit-wordpress/testing";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
/** Whether `A` is assignable to `B`: a fake satisfies its seam. */
type Satisfies<A, B> = [A] extends [B] ? true : false;

// ── the root barrel ──────────────────────────────────────────────────────

export type _Root = Assert<Equals<keyof typeof WordPress, "Ids" | "Api" | "Http">>;
export type _RootIds = Assert<Equals<typeof WordPress.Ids.integerIds, typeof integerIds>>;

// ── ./ids ────────────────────────────────────────────────────────────────

class CodecError {
  readonly _tag = "CodecError";
}
interface CodecDb {
  readonly db: true;
}

export type _WireId = Assert<Equals<WireId, number | string>>;
export type _CodecEncode = Assert<
  Equals<
    IdCodec<CodecError, CodecDb>["encode"],
    (
      nodeIds: ReadonlyArray<string>,
    ) => Effect.Effect<HashMap.HashMap<string, number>, CodecError, CodecDb>
  >
>;
export type _CodecDecode = Assert<
  Equals<
    IdCodec<CodecError, CodecDb>["decode"],
    (
      integers: ReadonlyArray<number>,
    ) => Effect.Effect<HashMap.HashMap<number, string>, CodecError, CodecDb>
  >
>;

type Integers = ReturnType<typeof integerIds<CodecError, CodecDb>>;
export type _IntegerIds = Assert<
  Equals<Integers, WireIds<number, CodecError | UnencodableNodeId, CodecError, CodecDb>>
>;
export type _WireIdsEncode = Assert<
  Equals<
    Integers["encode"],
    (
      nodeIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<number>, CodecError | UnencodableNodeId, CodecDb>
  >
>;
export type _WireIdsDecode = Assert<
  Equals<
    Integers["decode"],
    (
      wireIds: ReadonlyArray<WireId>,
    ) => Effect.Effect<ReadonlyArray<Option.Option<string>>, CodecError, CodecDb>
  >
>;
export type _WireIdsMode = Assert<Equals<Integers["mode"], "integer">>;
export type _StringIdsMode = Assert<Equals<ReturnType<typeof stringIds>["mode"], "string">>;
export type _WireIdMode = Assert<
  Equals<
    [WireIdMode<number>, WireIdMode<string>, WireIdMode<WireId>],
    ["integer", "string", "integer" | "string"]
  >
>;

/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the emitted option exactly, and the workspace's optional fields are `?: T | undefined` (AGENTS.md → Conventions) */
export type _StringIds = Assert<
  Equals<
    typeof stringIds,
    (options?: StringIdsOptions | undefined) => WireIds<string, never, never, never>
  >
>;
export type _StringIdsOptions = Assert<
  Equals<StringIdsOptions["isNodeId"], ((wireId: string) => boolean) | undefined>
>;
/* oxlint-enable effect/prefer-option-over-null */

export type _UnencodableTag = Assert<Equals<UnencodableNodeId["_tag"], "UnencodableNodeId">>;
export type _UnencodableFields = Assert<
  Equals<
    Pick<UnencodableNodeId, "nodeId" | "reason">,
    {
      readonly nodeId: string;
      readonly reason: "unmapped" | "invalid-integer" | "duplicate-integer";
    }
  >
>;

// ── ./testing ────────────────────────────────────────────────────────────

export type _InMemoryIdCodec = Assert<Satisfies<InMemoryIdCodec, IdCodec<never, never>>>;
export type _MakeInMemoryIdCodec = Assert<
  Equals<typeof makeInMemoryIdCodec, (nodeIds?: Iterable<string>) => InMemoryIdCodec>
>;
export type _InMemoryIdCodecHooks = Assert<
  Equals<
    Pick<InMemoryIdCodec, "assign" | "encodeCalls" | "decodeCalls">,
    {
      readonly assign: (nodeId: string) => number;
      readonly encodeCalls: () => ReadonlyArray<ReadonlyArray<string>>;
      readonly decodeCalls: () => ReadonlyArray<ReadonlyArray<number>>;
    }
  >
>;

// ── ./api and ./http (pulpit#86 phase 1) ─────────────────────────────────

export type _RootApi = Assert<Equals<typeof WordPress.Api.defineWordPress, typeof defineWordPress>>;
export type _RootHttp = Assert<Equals<typeof WordPress.Http.wordPressHttp, typeof wordPressHttp>>;
export type _MaxListParameter = Assert<Equals<typeof MAX_LIST_PARAMETER, 100>>;
export type _DefineWordPress = Assert<
  Equals<
    typeof defineWordPress,
    <R, Following = never>(config: WordPressConfig<R, Following>) => WordPressApi<R>
  >
>;
export type _Handle = Assert<
  Equals<
    WordPressApi<CodecDb>["handle"],
    (request: WordPressRequest) => Effect.Effect<WordPressResponse, never, CodecDb>
  >
>;
export type _Request = Assert<
  Equals<
    WordPressRequest,
    {
      readonly method: string;
      readonly path: string;
      readonly query: ReadonlyArray<readonly [string, string]>;
    }
  >
>;
export type _Response = Assert<
  Equals<
    WordPressResponse,
    {
      readonly status: number;
      readonly headers: { readonly [name: string]: string };
      readonly body: Option.Option<Schema.Json>;
    }
  >
>;
export type _Bind = Assert<
  Equals<
    typeof bind,
    <Resource, E, R, Following = never>(
      binding: PostTypeBinding<Resource, E, R, Following>,
    ) => BoundPostType<R, Following>
  >
>;
// ── phase 2: taxonomies and authors ─────────────────────────────────────

export type _Taxonomy = Assert<Equals<Taxonomy, "category" | "post_tag">>;
export type _BindTaxonomy = Assert<
  Equals<
    typeof bindTaxonomy,
    <Term, Edge, E, R, Following = never>(
      binding: TaxonomyBinding<Term, Edge, E, R, Following>,
    ) => BoundTaxonomy<R, Following>
  >
>;
export type _TaxonomyMembers = Assert<
  Equals<
    BoundTaxonomy<CodecDb, CodecError>["members"],
    (termIds: ReadonlyArray<string>) => Effect.Effect<ListFilter<CodecError>, unknown, CodecDb>
  >
>;
export type _PostFieldsAuthor = Assert<Equals<PostFields["author"], Option.Option<string>>>;
export type _PostFieldsDate = Assert<Equals<PostFields["date"], Option.Option<Date>>>;
export type _WordPressHttp = Assert<
  Equals<
    ReturnType<typeof wordPressHttp<CodecDb>>,
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | CodecDb
    >
  >
>;

// ── phase 3: media from a file leaf (pulpit#221) ────────────────────────

export type _FileMediaFields = Assert<Equals<ReturnType<typeof fileMediaFields>, MediaFields>>;
