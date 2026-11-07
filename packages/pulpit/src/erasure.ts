/**
 * **Account erasure** (pulpit#207): when a member's account is deleted,
 * everything they own or authored is purged, reassigned or anonymised, and
 * every relationship row naming them goes, in bounded, resumable and
 * idempotent batches.
 *
 * `./purge` (pulpit#58) erases one node. This module erases one account,
 * across every family and every kernel store that records an account id.
 *
 * ## The model (owner decisions on pulpit#207, 2026-10-29)
 *
 * Each family declares a {@link Disposition} for the nodes the account owns
 * and the versions it wrote:
 *
 * - **`purge`**: the account's nodes are erased through `./purge`, whole
 *   chain and all (the one sanctioned exception to the append-only chain,
 *   `VERSION-CHAIN-001/002`). The owner's default for owned leaves.
 * - **`reassign`**: the account's owner records and the version rows it
 *   wrote are pointed at the application's tombstone account. The owner's
 *   default for reference contributions.
 * - **`anonymise`**: the content stays and the attribution goes: the owner
 *   record is removed (an owned row with no owner reads as no one's,
 *   pulpit#85) and the version rows it wrote record no actor. The owner's
 *   default for comments, so a reply keeps the thread it answers.
 *
 * {@link ErasurePresets} names those defaults. On every family, versions
 * the account wrote on someone else's node lose the attribution as the
 * family's disposition says (`purge` anonymises them, since the node isn't
 * the account's to purge), and the `proposedBy` of a version an accepted
 * proposal of theirs produced is cleared (anonymised).
 *
 * The kernel's other stores erase what they hold for the account: pending,
 * rejected and withdrawn proposals are deleted and accepted ones keep their
 * row under the tombstone account (`ProposalStore.eraseAuthor`); reports
 * filed are deleted (`ReportStore.eraseReporter`); reactions, follows,
 * mutes, blocks and working copies are deleted. An application adds its
 * own (memberships, notifications, …) as {@link AccountRelation}s.
 *
 * ## Attribution is the one rewrite
 *
 * A version row's attribution columns, its actor and its `proposedBy`, are
 * the only columns erasure rewrites in place (SECURITY.md →
 * `VERSION-CHAIN-001/002`): a version's state, number, action and timestamp
 * never change, and no version is appended for it, because an appended
 * version would carry the erased account's history forward rather than
 * remove it. No kernel read returns either column, so the rewrite changes
 * no served resource; an owner record does show (`ownerRef`), so a node
 * whose owner record changes is evicted from the cache.
 *
 * ## Batches
 *
 * Every step reads or writes at most `batchSize` rows (`PERF-DB-001`) in
 * its own `transact`, and is repeated until it answers fewer. A step's
 * rows stop matching once written, so a run cut short (`maxBatches`, a
 * crash) resumes where it stopped when it is run again, and a run over an
 * erased account changes nothing.
 *
 * @copyright Thomas Foster
 * @module pulpit/erasure
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BlobStore } from "./blobs.ts";
import { purgeNode } from "./internal/purge-node.ts";
import type { ReportStore } from "./moderation.ts";
import type { ProposalStore } from "./proposals.ts";
import type { PurgeReport, PurgeStore } from "./purge.ts";
import type { ReactionStore } from "./reactions.ts";
import type { SocialStore } from "./social.ts";
import {
  Forbidden,
  MAX_PAGE_LIMIT,
  Unauthorized,
  type ResourceCacheSeam,
  type Viewer,
  type ViewerAccount,
} from "./subtype.ts";
import { NodeNotFound, type VersionChain } from "./version-chain.ts";
import type { WorkingCopyStore } from "./working-copy.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * What erasure does with a family's nodes and versions: see the module doc.
 *
 * @since 0.2.0
 */
export const Disposition = Schema.Literals(["purge", "reassign", "anonymise"]);
/**
 * The {@link Disposition} literal union.
 *
 * @since 0.2.0
 */
export type Disposition = typeof Disposition.Type;

/**
 * The owner's default dispositions (pulpit#207): an owned leaf is purged,
 * a reference leaf's contributions are reassigned to the tombstone account,
 * and comments are anonymised.
 *
 * @since 0.2.0
 */
export const ErasurePresets = {
  ownedLeaf: "purge",
  referenceLeaf: "reassign",
  comments: "anonymise",
} as const satisfies Readonly<Record<string, Disposition>>;

/**
 * A version row's attribution column: the acting account (`actorId`) or the
 * contributor whose accepted proposal it applies (`proposedBy`).
 *
 * @since 0.2.0
 */
export type AttributionColumn = "actorId" | "proposedBy";

/**
 * The batch size when the definition names none.
 *
 * @since 0.2.0
 */
export const DEFAULT_ERASURE_BATCH = 100;

// ── Errors ────────────────────────────────────────────────────────────

/**
 * An erasure of the tombstone account itself, which every reassigned row
 * now names: refused, with nothing read or written. The wire's 422.
 *
 * @since 0.2.0
 */
export class TombstoneErasure extends Schema.TaggedError<
  TombstoneErasure,
  { readonly brand: unique symbol }
>()("TombstoneErasure", { accountId: Schema.String }) {}

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The erasure seam an application supplies, over its owner records
 * (`core.node_owner`) and its version tables. Like every store it applies
 * no policy, fails only with its `E`, and never opens a transaction: each
 * call runs in one of `transact`'s. See the package README → Seams.
 *
 * @since 0.2.0
 */
export interface AccountErasureStore<E, R> {
  /** At most `limit` ids of leaf `type`'s nodes whose owner record names the account, by id. */
  readonly ownedNodes: (query: {
    readonly accountId: string;
    readonly type: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, E, R>;
  /** Replace node `id`'s owner record with `ownerId`, or delete it for none. */
  readonly setOwner: (query: {
    readonly type: string;
    readonly id: string;
    readonly ownerId: Option.Option<string>;
  }) => Effect.Effect<void, E, R>;
  /**
   * Rewrite `column` to `to` on at most `limit` of leaf `type`'s version
   * rows where it names the account, every level of the chain alike, and
   * nothing else on those rows; how many it rewrote.
   */
  readonly reattribute: (query: {
    readonly accountId: string;
    readonly type: string;
    readonly column: AttributionColumn;
    readonly to: Option.Option<string>;
    readonly limit: number;
  }) => Effect.Effect<number, E, R>;
}

/**
 * An application-owned relationship to erase with the account: a name for
 * the summary and a bounded erase that answers how many rows it deleted or
 * rewrote (at most `limit`). `replacement` is the tombstone account, for a
 * column that must keep naming someone.
 *
 * @since 0.2.0
 */
export interface AccountRelation<E, R> {
  readonly name: string;
  readonly erase: (query: {
    readonly accountId: string;
    readonly replacement: string;
    readonly limit: number;
  }) => Effect.Effect<number, E, R>;
}

/**
 * One family's erasure declaration: its leaf type, its disposition, its
 * chain (read for the head an eviction names) and its resource cache.
 *
 * @since 0.2.0
 */
export interface ErasureFamily<E, R> {
  readonly type: string;
  readonly disposition: Disposition;
  readonly chain: VersionChain<E, R>;
  /** The family's resource cache, evicted for every node whose owner record changes. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "the family is not cached"
  readonly cache?: ResourceCacheSeam<unknown, R> | undefined;
}

// ── The operation ─────────────────────────────────────────────────────

/**
 * What {@link defineAccountErasure} binds.
 *
 * @since 0.2.0
 */
export interface AccountErasureDefinition<E, EB, R> {
  /** The request's viewer. */
  readonly viewer: Effect.Effect<Viewer, never, R>;
  /**
   * Whether `actor` may erase `accountId`: the application's rung (an
   * admin, a data-protection officer) and, if it allows one, a member's
   * own account. Fails closed on an unknown role.
   */
  readonly canErase: (actor: ViewerAccount, accountId: string) => boolean;
  /** The account every reassigned row names instead. */
  readonly tombstoneAccountId: string;
  /** The caller's write boundary; each batch runs inside one. */
  readonly transact: <A, E2>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>;
  /** The owner and attribution seam. */
  readonly store: AccountErasureStore<E, R>;
  /** The erasure seam a `purge` family's nodes go through (`./purge`). */
  readonly purge: PurgeStore<E, R>;
  /** The byte store a purge deletes unreferenced bytes from, after each commit. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no blob store", and the purge reports the bytes left
  readonly blobs?: BlobStore<EB, R> | undefined;
  /** Every family whose nodes or versions may name the account. */
  readonly families: ReadonlyArray<ErasureFamily<E, R>>;
  /* oxlint-disable effect/prefer-option-over-null -- optional fields are `?: T | undefined` (AGENTS.md → Conventions); each omitted key is "the application keeps no such store" */
  readonly proposals?: Pick<ProposalStore<E, R>, "eraseAuthor"> | undefined;
  readonly reports?: Pick<ReportStore<E, R>, "eraseReporter"> | undefined;
  readonly reactions?: Pick<ReactionStore<E, R>, "eraseAccount"> | undefined;
  readonly social?: Pick<SocialStore<unknown, E, R>, "eraseAccount"> | undefined;
  readonly workingCopies?: Pick<WorkingCopyStore<E, R>, "eraseAccount"> | undefined;
  /** The application's own relationships to erase. */
  readonly relations?: ReadonlyArray<AccountRelation<E, R>> | undefined;
  /** Rows per batch, clamped to `[1, MAX_PAGE_LIMIT]`; {@link DEFAULT_ERASURE_BATCH} when omitted. */
  readonly batchSize?: number | undefined;
  /* oxlint-enable effect/prefer-option-over-null */
}

/**
 * What one erasure run did.
 *
 * @since 0.2.0
 */
export interface ErasureSummary {
  readonly accountId: string;
  /** Whether every step ran dry; `false` when `maxBatches` stopped the run, which a re-run resumes. */
  readonly complete: boolean;
  /** How many batches ran. */
  readonly batches: number;
  /** Rows changed per step, keyed `<type>.<step>` or by relation name; a step that changed nothing is absent. */
  readonly changed: Readonly<Record<string, number>>;
  /** Every node purged, with what its purge deleted. */
  readonly purged: ReadonlyArray<PurgeReport>;
}

/**
 * The operation {@link defineAccountErasure} produces.
 *
 * @since 0.2.0
 */
export interface AccountErasureOps<E, R> {
  /**
   * Erase `accountId`. Fails `Unauthorized` when anonymous, `Forbidden`
   * when `canErase` refuses, and {@link TombstoneErasure} for the tombstone
   * account, before anything is read. `maxBatches` (omitted: no limit)
   * bounds the batches one run spends changing rows (a batch that finds a
   * step dry, one per step, is free), so every run that stops short has
   * changed something: run it again to resume.
   */
  readonly erase: (
    accountId: string,
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "run until done"
    options?: { readonly maxBatches?: number | undefined },
  ) => Effect.Effect<ErasureSummary, Unauthorized | Forbidden | TombstoneErasure | E, R>;
}

/** A run's progress so far: {@link ErasureSummary} without the account, and the batches that changed rows. */
interface Progress extends Omit<ErasureSummary, "accountId"> {
  readonly spent: number;
}

const isNodeNotFound = Schema.is(NodeNotFound);

const emptyChanges: Readonly<Record<string, number>> = {};

/** One step: a bounded batch that answers how many rows it changed and what it purged. */
interface Step<E, R> {
  readonly name: string;
  readonly run: (
    accountId: string,
    limit: number,
  ) => Effect.Effect<
    { readonly changed: number; readonly purged: ReadonlyArray<PurgeReport> },
    E,
    R
  >;
}

/**
 * Bind account erasure. `erase(accountId)` checks the rung, then runs each
 * step until it changes fewer rows than a batch: per family, its owned
 * nodes (purged, or their owner record reassigned or removed, with a cache
 * eviction), then the attribution on its version rows; then the kernel
 * stores given, then the application's relations.
 *
 * @example
 * ```ts
 * import { deepStrictEqual, strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import { defineAccountErasure, ErasurePresets } from "@thomasfosterau/pulpit/erasure";
 * import { defineVersionChain } from "@thomasfosterau/pulpit/version-chain";
 * import {
 *   makeInMemoryAccountErasureStore,
 *   makeInMemoryLeafStore,
 *   makeInMemoryPurgeStore,
 *   makeInMemoryVersionChain,
 * } from "@thomasfosterau/pulpit/testing";
 *
 * const chain = makeInMemoryVersionChain("comments");
 * const leaves = makeInMemoryLeafStore(chain, { columns: ["body"] });
 * const comments = defineVersionChain("comments", chain);
 * const erasure = defineAccountErasure({
 *   viewer: Effect.succeed(Option.some({ id: "u-admin", role: "admin" })),
 *   canErase: (actor) => actor.role === "admin",
 *   tombstoneAccountId: "u-deleted",
 *   transact: (effect) => effect,
 *   store: makeInMemoryAccountErasureStore([{ type: "comments", chain, leaves }]),
 *   purge: makeInMemoryPurgeStore({ chains: [chain] }),
 *   families: [{ type: "comments", disposition: ErasurePresets.comments, chain }],
 * });
 *
 * const summary = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const { id } = yield* comments.create({
 *       id: Option.none(),
 *       state: { body: "hello" },
 *       actorId: Option.some("u-1"),
 *     });
 *     yield* leaves.stampOwner(id, "u-1");
 *     return yield* erasure.erase("u-1");
 *   }),
 * );
 *
 * // The comment stays, owned by no one, and no version names the account.
 * strictEqual(HashMap.size(leaves.owners()), 0);
 * deepStrictEqual(chain.rows()[0]?.actorId, Option.none());
 * strictEqual(summary.complete, true);
 * ```
 *
 * @since 0.2.0
 */
export const defineAccountErasure = <E, EB, R>(
  definition: AccountErasureDefinition<E, EB, R>,
): AccountErasureOps<E, R> => {
  const { store, transact, tombstoneAccountId } = definition;
  const batch = Math.max(
    1,
    Math.min(Math.trunc(definition.batchSize ?? DEFAULT_ERASURE_BATCH), MAX_PAGE_LIMIT),
  );
  const tombstone = Option.some(tombstoneAccountId);
  const nothingPurged: ReadonlyArray<PurgeReport> = [];

  /** A step that changes rows inside one transaction and purges nothing. */
  const counted = (
    name: string,
    run: (accountId: string, limit: number) => Effect.Effect<number, E, R>,
  ): Step<E, R> => ({
    name,
    run: (accountId, limit) =>
      Effect.map(transact(run(accountId, limit)), (changed) => ({
        changed,
        purged: nothingPurged,
      })),
  });

  /** Evict a node whose owner record changed, past its head, after the commit (`CACHE-AUTH-005`). */
  const evict = (family: ErasureFamily<E, R>, id: string) =>
    family.cache === undefined
      ? Effect.void
      : Effect.flatMap(family.chain.head(id), (head) =>
          Option.match(head, {
            onNone: () => Effect.void,
            onSome: (entry) => (family.cache ?? noCache).delete(id, entry.version + 1n),
          }),
        );

  /** The family's owned nodes: purged one by one, or their owner record replaced in one batch. */
  const ownedStep = (family: ErasureFamily<E, R>): Step<E, R> => ({
    name: `${family.type}.${family.disposition}`,
    run: (accountId, limit) =>
      family.disposition === "purge"
        ? purgeOwned(family, accountId, limit)
        : Effect.gen(function* () {
            const ids = yield* transact(
              Effect.tap(store.ownedNodes({ accountId, type: family.type, limit }), (owned) =>
                Effect.forEach(
                  owned,
                  (id) =>
                    store.setOwner({
                      type: family.type,
                      id,
                      ownerId: family.disposition === "reassign" ? tombstone : Option.none(),
                    }),
                  { concurrency: 1, discard: true },
                ),
              ),
            );
            yield* Effect.forEach(ids, (id) => evict(family, id), {
              concurrency: 1,
              discard: true,
            });
            return { changed: ids.length, purged: nothingPurged };
          }),
  });

  /**
   * Purge a batch of the family's owned nodes. A node whose owner record
   * outlived its chain has nothing to purge: its owner record is removed,
   * so the next batch moves past it.
   */
  const purgeOwned = (family: ErasureFamily<E, R>, accountId: string, limit: number) =>
    Effect.gen(function* () {
      const purge = purgeNode<E, EB, R>({
        type: family.type,
        chain: family.chain,
        store: definition.purge,
        transact,
        blobs: definition.blobs,
        cache: family.cache,
      });
      const ids = yield* transact(store.ownedNodes({ accountId, type: family.type, limit }));
      const reports = yield* Effect.forEach(
        ids,
        (id) =>
          Effect.catchIf(Effect.asSome(purge(id)), isNodeNotFound, () =>
            Effect.as(
              transact(store.setOwner({ type: family.type, id, ownerId: Option.none() })),
              Option.none<PurgeReport>(),
            ),
          ),
        { concurrency: 1 },
      );
      return { changed: ids.length, purged: Arr.getSomes(reports) };
    });

  /** The family's attribution: the actor as its disposition says, and `proposedBy` cleared. */
  const attributionSteps = (family: ErasureFamily<E, R>): ReadonlyArray<Step<E, R>> => [
    counted(`${family.type}.actor`, (accountId, limit) =>
      store.reattribute({
        accountId,
        type: family.type,
        column: "actorId",
        to: family.disposition === "reassign" ? tombstone : Option.none(),
        limit,
      }),
    ),
    counted(`${family.type}.proposedBy`, (accountId, limit) =>
      store.reattribute({
        accountId,
        type: family.type,
        column: "proposedBy",
        to: Option.none(),
        limit,
      }),
    ),
  ];

  const replaced = (accountId: string, limit: number) => ({
    accountId,
    replacement: tombstoneAccountId,
    limit,
  });
  const storeSteps: ReadonlyArray<Step<E, R>> = [
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.proposals), (proposals) =>
        counted("proposals", (accountId, limit) =>
          proposals.eraseAuthor(replaced(accountId, limit)),
        ),
      ),
    ),
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.reports), (reports) =>
        counted("reports", (accountId, limit) => reports.eraseReporter(replaced(accountId, limit))),
      ),
    ),
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.reactions), (reactions) =>
        counted("reactions", reactions.eraseAccount),
      ),
    ),
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.social), (social) =>
        counted("social", social.eraseAccount),
      ),
    ),
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.workingCopies), (copies) =>
        counted("workingCopies", copies.eraseAccount),
      ),
    ),
    ...Arr.map(definition.relations ?? [], (relation) =>
      counted(relation.name, (accountId, limit) => relation.erase(replaced(accountId, limit))),
    ),
  ];

  const steps: ReadonlyArray<Step<E, R>> = [
    ...Arr.map(definition.families, ownedStep),
    ...Arr.flatMap(definition.families, attributionSteps),
    ...storeSteps,
  ];

  /**
   * Run `step` until a batch changes fewer rows than a batch holds, or the
   * run has spent its budget of batches that change rows (then
   * `complete: false`, for a re-run to resume).
   */
  const drain = (
    step: Step<E, R>,
    accountId: string,
    budget: number,
    progress: Progress,
  ): Effect.Effect<Progress, E, R> =>
    progress.spent >= budget
      ? Effect.succeed({ ...progress, complete: false })
      : Effect.flatMap(step.run(accountId, batch), (result) => {
          const next: Progress = {
            complete: true,
            batches: progress.batches + 1,
            spent: result.changed > 0 ? progress.spent + 1 : progress.spent,
            changed:
              result.changed > 0
                ? {
                    ...progress.changed,
                    [step.name]: (progress.changed[step.name] ?? 0) + result.changed,
                  }
                : progress.changed,
            purged: [...progress.purged, ...result.purged],
          };
          return result.changed >= batch
            ? drain(step, accountId, budget, next)
            : Effect.succeed(next);
        });

  /** The rung, checked before anything is read. */
  const gate = (accountId: string) =>
    Effect.flatMap(
      definition.viewer,
      (viewer): Effect.Effect<void, Unauthorized | Forbidden | TombstoneErasure> =>
        Option.match(viewer, {
          onNone: () => Effect.fail(new Unauthorized()),
          onSome: (actor) => {
            if (!definition.canErase(actor, accountId)) return Effect.fail(new Forbidden());
            return accountId === tombstoneAccountId
              ? Effect.fail(new TombstoneErasure({ accountId }))
              : Effect.void;
          },
        }),
    );

  const erase = Effect.fn("account.erase")(function* (
    accountId: string,
    // oxlint-disable-next-line effect/prefer-option-over-null -- mirrors `AccountErasureOps.erase`'s optional field
    options: { readonly maxBatches?: number | undefined } = {},
  ) {
    yield* gate(accountId);
    const budget = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const done = yield* Effect.reduce(
      steps,
      (): Progress => ({
        complete: true,
        batches: 0,
        spent: 0,
        changed: emptyChanges,
        purged: nothingPurged,
      }),
      (progress, step) =>
        progress.complete ? drain(step, accountId, budget, progress) : Effect.succeed(progress),
    );
    const summary: ErasureSummary = {
      accountId,
      complete: done.complete,
      batches: done.batches,
      changed: done.changed,
      purged: done.purged,
    };
    return summary;
  });

  return { erase };
};

/** The cache that holds nothing: `evict`'s fallback, never reached once `cache` is checked. */
const noCache: ResourceCacheSeam<unknown, never> = {
  set: () => Effect.void,
  delete: () => Effect.void,
};
