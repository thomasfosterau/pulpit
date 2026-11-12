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
 * - **`reassign`**: the account's owner records point at the application's
 *   tombstone account, and each node it wrote gets a redacting version
 *   attributed to the tombstone account. The owner's default for reference
 *   contributions.
 * - **`anonymise`**: the content stays and the attribution goes: the owner
 *   record is removed (an owned row with no owner reads as no one's,
 *   pulpit#85) and each node it wrote gets a redacting version with no
 *   actor. The owner's default for comments, so a reply keeps the thread it
 *   answers.
 *
 * {@link ErasurePresets} names those defaults. On every family, a node the
 * account wrote a version of, its own or someone else's, or a version of
 * which an accepted proposal of theirs produced (`proposedBy`), gets one
 * redacting version attributed as the family's disposition says (`purge`
 * anonymises, since another member's node isn't the account's to purge).
 *
 * The kernel's other stores erase what they hold for the account: pending,
 * rejected and withdrawn proposals are deleted and accepted ones keep their
 * row under the tombstone account (`ProposalStore.eraseAuthor`); reports
 * filed are deleted (`ReportStore.eraseReporter`); reactions, follows,
 * mutes, blocks, group memberships and working copies are deleted. An application adds its
 * own (memberships, notifications, …) as {@link AccountRelation}s.
 *
 * ## A redacting version, never a rewrite
 *
 * The chain stays strictly append-only (`VERSION-CHAIN-001/002`, owner
 * decision on pulpit#207, 2026-11-11): erasure rewrites no version row.
 * For each node that needs it, it appends one **redacting version**
 * through the family's `VersionChain` port, as a plain `update` with
 * `expectedVersion` pinned to the head it read: the head's state carried
 * forward, attributed to the tombstone account (`reassign`) or to no one
 * (`anonymise`, `purge`), and with no `proposedBy`. Where the family
 * declares `accountColumns`, state columns holding an account id, each one
 * naming the account is set to the tombstone account (`reassign`) or
 * `null` in that version; erasure knows no other field. **Earlier versions
 * keep their original attribution by design**: the history of who wrote
 * what is not rewritten, and the current version no longer names the
 * account. Removing history is `./purge`'s job, and a family whose history
 * must go is a `purge` family.
 *
 * The append goes through the port, not `defineVersionChain`'s hooks: a
 * redacting version is not an edit, and runs no lifecycle hook. A node
 * whose head is a tombstone gets none, since no port operation appends
 * over a tombstone without resurrecting it (`VERSION-CHAIN-006`): its
 * versions keep their attribution, as every earlier version does, and the
 * tombstone stays hidden below the view-deleted rung (owner decision on
 * pulpit#303). It is redacted on restore: once an application restores
 * such a node its head is live again and still matches the marker, so the
 * application re-runs erasure for the account after the restore, and that
 * run appends the redacting version. A family whose history must go is a
 * `purge` family.
 *
 * **The marker.** A node needs a redacting version when some version names
 * the account (as actor or `proposedBy`) and no later version is attributed
 * the way its redacting version would be (the disposition's actor, no
 * `proposedBy`): {@link AccountErasureStore.unredactedNodes} reads exactly
 * that off the version rows. Once the redacting version lands, the node
 * stops matching, so a re-run appends nothing and a run cut short resumes.
 * A version written after it by another account keeps it redacted; only a
 * later version by the account itself makes it match again. An unattributed
 * write that already followed the account's last version counts as the
 * marker for an anonymising family, since that head names no one.
 *
 * The node is evicted from the family's cache at the redacting version
 * (`CACHE-AUTH-005`), and a node whose owner record changes past its head,
 * since an owner record shows (`ownerRef`).
 *
 * ## Batches
 *
 * Every step reads or writes at most `batchSize` rows or nodes
 * (`PERF-DB-001`) in its own `transact`, and is repeated until it answers
 * fewer. A step's rows stop matching once written, so a run cut short
 * (`maxBatches`, a crash) resumes where it stopped when it is run again,
 * and a run over an erased account changes nothing.
 *
 * @copyright Thomas Foster
 * @module pulpit/erasure
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type { MembershipStore } from "./audience.ts";
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
import {
  NodeNotFound,
  type ChainPatch,
  type ChainWrite,
  type StaleVersion,
  type VersionChain,
  type VersionConflict,
  VersionNotFound,
} from "./version-chain.ts";
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
 * (`core.node_owner`) and its version tables, which it only reads: every
 * version erasure writes goes through the family's `VersionChain`. Like
 * every store it applies no policy, fails only with its `E`, and never
 * opens a transaction: each call runs in one of `transact`'s. See the
 * package README → Seams.
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
   * At most `limit` ids, by id, of leaf `type`'s nodes that still need a
   * redacting version: the head is not a tombstone, some version names the
   * account as its actor or `proposedBy`, and no later version has actor
   * `redactedAs` and no `proposedBy` (the module doc's marker). Read-only.
   */
  readonly unredactedNodes: (query: {
    readonly accountId: string;
    readonly type: string;
    readonly redactedAs: Option.Option<string>;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, E, R>;
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
 * chain (which the redacting versions are appended through), the state
 * columns that hold an account id, and its resource cache.
 *
 * @since 0.2.0
 */
export interface ErasureFamily<E, R> {
  readonly type: string;
  readonly disposition: Disposition;
  readonly chain: VersionChain<E, R>;
  /**
   * The leaf's state columns that hold an account id (a credited author the
   * leaf keeps in its own state, say). In a redacting version, each one
   * naming the account is set to the tombstone account (`reassign`) or
   * `null` (`anonymise`, `purge`). Omitted, the state is carried forward
   * unchanged: erasure knows no field a family doesn't declare.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "no state column names an account"
  readonly accountColumns?: ReadonlyArray<string> | undefined;
  /** The family's resource cache, evicted for every node erasure appends to or whose owner record changes. */
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
  /** The owner-record seam, and the read that finds the nodes still to redact. */
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
  /** Group memberships (`./audience`): every membership and pending invitation of the account, and every pending invitation it sent, is deleted in bounded batches. */
  readonly memberships?: Pick<MembershipStore<unknown, E, R>, "eraseAccount"> | undefined;
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
   * changed something: run it again to resume. A redacting version that
   * loses a race to a concurrent writer fails `StaleVersion` or
   * `VersionConflict`, its batch's transaction rolls back, and a re-run
   * resumes.
   */
  readonly erase: (
    accountId: string,
    // oxlint-disable-next-line effect/prefer-option-over-null -- an optional field is `?: T | undefined` (AGENTS.md → Conventions); the omitted key is "run until done"
    options?: { readonly maxBatches?: number | undefined },
  ) => Effect.Effect<
    ErasureSummary,
    Unauthorized | Forbidden | TombstoneErasure | StaleVersion | VersionConflict | E,
    R
  >;
}

/** A run's progress so far: {@link ErasureSummary} without the account, and the batches that changed rows. */
interface Progress extends Omit<ErasureSummary, "accountId"> {
  readonly spent: number;
}

const isNodeNotFound = Schema.is(NodeNotFound);
const isVersionNotFound = Schema.is(VersionNotFound);

/** What a step may fail with: the stores' `E`, and a redacting append's lost race. */
type ErasureError<E> = E | StaleVersion | VersionConflict;

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
 * eviction); then per family, one redacting version on each node the
 * account wrote (the module doc's marker keeps it to one); then the kernel
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
 * // The comment stays, owned by no one. Version 0 keeps its attribution;
 * // the appended redacting version 1 carries its state and names no one.
 * strictEqual(HashMap.size(leaves.owners()), 0);
 * deepStrictEqual(
 *   chain.rows().map((row) => [row.version, row.actorId, row.state["body"]]),
 *   [
 *     [0n, Option.some("u-1"), "hello"],
 *     [1n, Option.none(), "hello"],
 *   ],
 * );
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
  /** The actor a family's redacting version records. */
  const redactedAs = (family: ErasureFamily<E, R>) =>
    family.disposition === "reassign" ? tombstone : Option.none<string>();
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

  /**
   * The redacting patch over the head's state: each declared account
   * column naming the account, set to the tombstone account or `null`.
   */
  const redactingPatch = (
    family: ErasureFamily<E, R>,
    accountId: string,
    id: string,
    version: bigint,
  ): Effect.Effect<ChainPatch, E, R> => {
    const columns = family.accountColumns ?? [];
    if (!Arr.isReadonlyArrayNonEmpty(columns)) return Effect.succeed({});
    const replacement = family.disposition === "reassign" ? tombstoneAccountId : null;
    // The head the store just reported must be readable: a broken chain is a defect.
    return Effect.map(
      Effect.catchIf(family.chain.getVersion(id, version), isVersionNotFound, Effect.die),
      (head) =>
        R.fromEntries(
          Arr.map(
            Arr.filter(columns, (column) => head.state[column] === accountId),
            (column) => [column, replacement] as const,
          ),
        ),
    );
  };

  /**
   * Append node `id`'s redacting version: an `update` pinned to the head
   * just read, carrying its state (with the redacting patch), attributed
   * as the disposition says and with no `proposedBy`. A node with no
   * head, or a tombstone, gets none.
   */
  const redactNode = (family: ErasureFamily<E, R>, accountId: string, id: string) =>
    Effect.gen(function* () {
      const head = yield* family.chain.head(id);
      if (Option.isNone(head) || head.value.action === "delete") return Option.none<ChainWrite>();
      const patch = yield* redactingPatch(family, accountId, id, head.value.version);
      const write = yield* family.chain.update({
        id,
        patch,
        actorId: redactedAs(family),
        expectedVersion: head.value.version,
      });
      return Option.some(write);
    }).pipe(Effect.catchIf(isNodeNotFound, () => Effect.succeedNone));

  /**
   * One batch of the family's nodes still to redact (the store's marker
   * query), each given its redacting version in one transaction, then
   * evicted at that version after the commit (`CACHE-AUTH-005`).
   */
  const redactStep = (family: ErasureFamily<E, R>): Step<ErasureError<E>, R> => ({
    name: `${family.type}.redact`,
    run: (accountId, limit) =>
      Effect.gen(function* () {
        const { found, writes } = yield* transact(
          Effect.flatMap(
            store.unredactedNodes({
              accountId,
              type: family.type,
              redactedAs: redactedAs(family),
              limit,
            }),
            (ids) =>
              Effect.map(
                Effect.forEach(ids, (id) => redactNode(family, accountId, id), {
                  concurrency: 1,
                }),
                (written) => ({ found: ids.length, writes: Arr.getSomes(written) }),
              ),
          ),
        );
        const cache = family.cache;
        if (cache !== undefined) {
          yield* Effect.forEach(writes, (write) => cache.delete(write.id, write.version), {
            concurrency: 1,
            discard: true,
          });
        }
        return { changed: found, purged: nothingPurged };
      }),
  });

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
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(definition.memberships), (memberships) =>
        counted("memberships", memberships.eraseAccount),
      ),
    ),
    ...Arr.map(definition.relations ?? [], (relation) =>
      counted(relation.name, (accountId, limit) => relation.erase(replaced(accountId, limit))),
    ),
  ];

  const steps: ReadonlyArray<Step<ErasureError<E>, R>> = [
    ...Arr.map(definition.families, ownedStep),
    ...Arr.map(definition.families, redactStep),
    ...storeSteps,
  ];

  /**
   * Run `step` until a batch changes fewer rows than a batch holds, or the
   * run has spent its budget of batches that change rows (then
   * `complete: false`, for a re-run to resume).
   */
  const drain = (
    step: Step<ErasureError<E>, R>,
    accountId: string,
    budget: number,
    progress: Progress,
  ): Effect.Effect<Progress, ErasureError<E>, R> =>
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
