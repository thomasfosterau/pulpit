/**
 * A consumer's view of the package: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package name at
 * `dist/*.d.ts`). Each block exercises the types a real consumer depends on,
 * so a declaration that degrades to `any` fails here rather than in an
 * application. Never executed; type-checked only.
 */

import { PULPIT } from "@thomasfosterau/pulpit";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// ── scaffold ─────────────────────────────────────────────────────────────

export type _Scaffold = Assert<Equals<typeof PULPIT, "pulpit">>;
