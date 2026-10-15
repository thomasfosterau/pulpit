/**
 * A consumer's view of `@thomasfosterau/pulpit-wordpress` through its EMITTED
 * declarations (`paths` in tsconfig.json points the name at `dist/*.d.ts`),
 * as `consumer.ts` is for the kernel. Never executed; type-checked only.
 *
 * The package is a scaffold (pulpit#115) and exports nothing yet, so the one
 * assertion is that its root resolves to declarations with no exports: a
 * missing `dist/index.d.ts` fails to resolve, and a root that degraded to
 * `any` has keys. pulpit#86 phase 1 replaces it with assertions over the API.
 */

import * as WordPress from "@thomasfosterau/pulpit-wordpress";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

export type _Root = Assert<Equals<keyof typeof WordPress, never>>;
