/**
 * @copyright Thomas Foster
 *
 * One `-pg/chain` `LeafChain` as the kernel's `VersionChain` port
 * (pulpit#246, pulpit#247): the kernel's inputs mapped onto the chain's, and
 * the chain's tagged errors mapped one to one onto the kernel's. Off the
 * public surface: `makeVersionChains` (`../version-chain.ts`) builds every
 * leaf's port through it, and the unit suite drives it over a fake chain.
 *
 * @since 0.0.0
 */

import {
  NodeAlreadyExists,
  NodeNotFound,
  StaleVersion,
  VersionConflict,
  VersionNotFound,
  type ChainPatch,
  type ChainState,
  type LocalePatch,
  type LocaleStates,
  type Precondition,
  type UpdateInput,
  type VersionChain,
  type VersionSnapshot,
} from "@thomasfosterau/pulpit/version-chain";
import * as Pg from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * The root version table's injected extras the port writes: the contributor
 * whose accepted proposal a version applies (`versionColumns: { proposedBy }`
 * in the tree's `makeTreeTables` config, README → `./version-chain`).
 *
 * @since 0.0.0
 */
export interface ProposedByExtra {
  readonly proposedBy: string;
}

/**
 * A leaf's `-pg/chain` operations with the leaf's own state types erased to
 * the kernel's: a state is a {@link ChainState} keyed by Drizzle field, a
 * patch a {@link ChainPatch}, the keyed level the kernel's locale level. The
 * kernel's state is untyped by design (a leaf's `Resource` schema validates
 * it above the port), so this is the shape the port hands the chain.
 *
 * @since 0.0.0
 */
export type ErasedLeafChain<E, I> = Pg.LeafChain<
  ChainState,
  ChainState,
  ChainPatch,
  never,
  ProposedByExtra,
  E,
  I,
  LocaleStates,
  LocalePatch
>;

/**
 * A `proposedBy` the tree's root version table has no column for: recording
 * it would drop the contributor silently, so it is a defect (the
 * application's tree is missing `versionColumns: { proposedBy }`).
 *
 * @since 0.0.0
 */
export class ProposedByUnrecorded extends Schema.TaggedError<
  ProposedByUnrecorded,
  { readonly brand: unique symbol }
>()("ProposedByUnrecorded", { type: Schema.String, id: Schema.String }) {
  override get message(): string {
    return `${this.type} ${this.id}: an update carries proposedBy, but the tree's root version table has no proposedBy column (makeTreeTables' root.versionColumns)`;
  }
}

/**
 * What {@link fromLeafChain} needs beside the chain itself.
 *
 * @since 0.0.0
 */
export interface LeafChainOptions<E, I> {
  /** The leaf's wire type, which a defect this adapter raises names. */
  readonly type: string;
  /** Hard-delete the node's identity row (cascading through its chain); a no-op for an unknown id. */
  readonly purge: (id: string) => Effect.Effect<void, E, I>;
  /** Whether the root version table carries a `proposedBy` column. */
  readonly recordsProposedBy: boolean;
}

/**
 * The chain's write options from the kernel's actor and precondition: the
 * actor is required (`undefined` for no session), and an absent
 * `expectedVersion` is forwarded as absent.
 */
const writeOptions = (actorId: Option.Option<string>, precondition: Precondition) => ({
  actor: Option.getOrUndefined(actorId),
  expectedVersion: precondition.expectedVersion,
});

/** A snapshot in the kernel's shape: the keyed level as `locales`, omitted when it carries none. */
const toSnapshot = (snapshot: Pg.ChainSnapshot<ChainState, LocaleStates>): VersionSnapshot => {
  const entry = {
    version: snapshot.version,
    action: snapshot.action,
    timestamp: snapshot.timestamp,
    state: snapshot.state,
  };
  return R.isEmptyRecord(snapshot.keyed) ? entry : { ...entry, locales: snapshot.keyed };
};

// The chain's errors carry the kernel's names and fields (effect-drizzle-ext
// `-pg/chain`), so each maps onto the kernel's class of the same name. The
// mapping narrows by class, since the driver's own error `E` stays generic.
const nodeNotFound = (error: Pg.NodeNotFound) =>
  new NodeNotFound({ type: error.type, id: error.id });
const versionNotFound = (error: Pg.VersionNotFound) =>
  new VersionNotFound({ type: error.type, id: error.id, version: error.version });
const nodeAlreadyExists = (error: Pg.NodeAlreadyExists) =>
  new NodeAlreadyExists({ type: error.type, id: error.id });
const staleVersion = (error: Pg.StaleVersion) =>
  new StaleVersion({
    type: error.type,
    id: error.id,
    expected: error.expected,
    current: error.current,
  });
const versionConflict = (error: Pg.VersionConflict) =>
  new VersionConflict({ id: error.id, version: error.version });

/** A write's errors: not found, stale or raced. */
const writeError = <E>(error: E | Pg.NodeNotFound | Pg.StaleVersion | Pg.VersionConflict) =>
  Schema.is(Pg.NodeNotFound)(error)
    ? nodeNotFound(error)
    : Schema.is(Pg.StaleVersion)(error)
      ? staleVersion(error)
      : Schema.is(Pg.VersionConflict)(error)
        ? versionConflict(error)
        : error;

/**
 * One leaf's `-pg/chain` operations as the kernel's {@link VersionChain}
 * port. `actorId` becomes the chain's `actor`, `proposedBy` the root version
 * row's `proposedBy` extra, `locales` the chain's keyed level (`keyed`), and
 * each of the chain's tagged errors the kernel's of the same name
 * (`NodeAlreadyExists`, `NodeNotFound`, `VersionNotFound`, `StaleVersion`,
 * `VersionConflict`; `BrokenChain` stays a defect). `purge` is the
 * caller's identity delete. A `proposedBy` the root version table cannot
 * record dies {@link ProposedByUnrecorded}.
 *
 * @since 0.0.0
 */
export const fromLeafChain = <E, I>(
  chain: ErasedLeafChain<E, I>,
  options: LeafChainOptions<E, I>,
): VersionChain<E, I> => {
  /** The root extras an update records: the proposal's contributor, when there is one. */
  const rootOf = (
    input: UpdateInput,
  ): Effect.Effect<Pick<Pg.ChainActor<ProposedByExtra>, "root">> =>
    Option.match(input.proposedBy ?? Option.none(), {
      onNone: () => Effect.succeed({ root: undefined }),
      onSome: (proposedBy) =>
        options.recordsProposedBy
          ? Effect.succeed({ root: { proposedBy } })
          : Effect.die(new ProposedByUnrecorded({ type: options.type, id: input.id })),
    });

  const merge =
    (write: ErasedLeafChain<E, I>["update"]): VersionChain<E, I>["update"] =>
    (input) =>
      Effect.flatMap(rootOf(input), ({ root }) =>
        write({
          id: input.id,
          patch: input.patch,
          keyed: input.locales,
          root,
          ...writeOptions(input.actorId, input),
        }),
      ).pipe(Effect.mapError(writeError));

  return {
    create: (input) =>
      chain
        .create({
          id: Option.getOrUndefined(input.id),
          state: input.state,
          keyed: input.locales,
          actor: Option.getOrUndefined(input.actorId),
        })
        .pipe(
          Effect.mapError((error) =>
            Schema.is(Pg.NodeAlreadyExists)(error)
              ? nodeAlreadyExists(error)
              : Schema.is(Pg.VersionConflict)(error)
                ? versionConflict(error)
                : error,
          ),
        ),
    update: merge(chain.update),
    restore: merge(chain.restore),
    delete: (id, actorId, precondition = {}) =>
      chain.delete(id, writeOptions(actorId, precondition)).pipe(Effect.mapError(writeError)),
    restoreVersion: (id, version, actorId, precondition = {}) =>
      chain
        .restoreVersion(id, version, writeOptions(actorId, precondition))
        .pipe(
          Effect.mapError((error) =>
            Schema.is(Pg.VersionNotFound)(error)
              ? versionNotFound(error)
              : Schema.is(Pg.StaleVersion)(error)
                ? staleVersion(error)
                : Schema.is(Pg.VersionConflict)(error)
                  ? versionConflict(error)
                  : error,
          ),
        ),
    getVersion: (id, version) =>
      chain.getVersion(id, version).pipe(
        Effect.map(toSnapshot),
        Effect.mapError((error) =>
          Schema.is(Pg.VersionNotFound)(error) ? versionNotFound(error) : error,
        ),
      ),
    history: (id, limit) =>
      chain
        .history(id, limit)
        .pipe(
          Effect.mapError((error) =>
            Schema.is(Pg.NodeNotFound)(error) ? nodeNotFound(error) : error,
          ),
        ),
    head: chain.head,
    purge: options.purge,
  };
};
