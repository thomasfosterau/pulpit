/**
 * **Two reads over a leaf's `VersionChain`** (pulpit#246) in the shapes the
 * kernel's modules ask them: a version's state as an `Option` (a version the
 * chain cannot reconstruct is none, not a failure) and a chain's entries as
 * a possibly empty list (an unknown node has none). Every other failure of
 * the port passes through.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { VersionChain, VersionChainEntry, VersionSnapshot } from "../version-chain.ts";

/**
 * The full state at `(id, version)`, or none when the chain has no
 * reconstructable version there (`VersionNotFound`).
 *
 * @internal
 */
export const snapshotOf = <E, R>(
  chain: Pick<VersionChain<E, R>, "getVersion">,
  id: string,
  version: bigint,
): Effect.Effect<Option.Option<VersionSnapshot>, E, R> =>
  chain.getVersion(id, version).pipe(
    Effect.asSome,
    Effect.catchTag("VersionNotFound", () => Effect.succeedNone),
  );

/**
 * The chain's entries, oldest first, at most `limit` of them; none for an id
 * with no versions (`NodeNotFound`).
 *
 * @internal
 */
export const entriesOf = <E, R>(
  chain: Pick<VersionChain<E, R>, "history">,
  id: string,
  limit: number,
): Effect.Effect<ReadonlyArray<VersionChainEntry>, E, R> =>
  chain
    .history(id, limit)
    .pipe(
      Effect.catchTag("NodeNotFound", () => Effect.succeed<ReadonlyArray<VersionChainEntry>>([])),
    );
