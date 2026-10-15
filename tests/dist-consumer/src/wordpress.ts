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
  type WireIds,
} from "@thomasfosterau/pulpit-wordpress/ids";
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

export type _Root = Assert<Equals<keyof typeof WordPress, "Ids">>;
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
  Equals<Integers, WireIds<number, CodecError | UnencodableNodeId, CodecDb>>
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
    ) => Effect.Effect<
      ReadonlyArray<Option.Option<string>>,
      CodecError | UnencodableNodeId,
      CodecDb
    >
  >
>;
export type _WireIdsMode = Assert<Equals<Integers["mode"], "integer" | "string">>;

/* oxlint-disable effect/prefer-option-over-null -- the assertion must spell the emitted option exactly, and the workspace's optional fields are `?: T | undefined` (AGENTS.md → Conventions) */
export type _StringIds = Assert<
  Equals<
    typeof stringIds,
    (options?: StringIdsOptions | undefined) => WireIds<string, never, never>
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
    { readonly nodeId: string; readonly reason: "unmapped" | "invalid-integer" }
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
