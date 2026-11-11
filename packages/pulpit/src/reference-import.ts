/**
 * **External reference import** (pulpit#209) — upserting a reference leaf's
 * nodes from a feed, a dataset or an authority by their external
 * identifiers, with per-field merge modes so an import never clobbers a
 * curated edit unless the family says it may.
 *
 * The behavioural spec is preferenceflow's ingestion writer
 * (`packages/jobs/src/apply/write.ts`: the upsert on an external id and the
 * per-column `UpdateMode`, `coalesce` among them, and an admin's
 * pre-attached id), the reconcile step of gardeneria's ingestion jobs, and
 * website's Wikidata reconciliation.
 *
 * ## The model
 *
 * - **An external identifier** is an `(authority, externalId)` pair (an
 *   authority is the application's name for a source: `wikidata`, `isbn`,
 *   `aec`), linked to one node of the family through an
 *   {@link ExternalIdStore}. Within a family an external id names one node,
 *   and a node carries at most one id per authority. An admin may
 *   **pre-attach** an id to a curated node ({@link ReferenceImportOps.attach}),
 *   so the next import updates that node instead of creating a duplicate.
 * - **An import is ordinary chain writes** through the leaf's own
 *   `defineSubtype` operations, bound to a declared **actor** (a bot account
 *   at the corpus-write rung): a `create` for an id that names no node, an
 *   `update` with the head it read as its expected version for one that
 *   does. The leaf's gates and before hooks run as for any writer, every
 *   version records the actor, and no version is ever rewritten
 *   (`VERSION-CHAIN-001/002`). A tombstoned node is never written over: a
 *   plain update would fail, and only an explicit restore resurrects
 *   (`VERSION-CHAIN-006`), so it is reported as a conflict.
 * - **Merge modes**, per declared field, decide each value. A record's key
 *   the feed omits (or sends as `undefined`) always carries the node's value
 *   forward; otherwise:
 *   - `overwrite` — the feed's value, `null` included;
 *   - `coalesce` — the feed's value, except that `null` keeps the node's;
 *   - `curated-wins` — the feed's value, `null` included, unless the field
 *     is **curated**: its value on the node differs from the value the last
 *     import of this external id sent (the link's *baseline*), so someone
 *     other than the feed changed it since. Without a baseline for the
 *     field (a pre-attached id, or a field the feed never sent), a present,
 *     non-`null` value on the node is curated. The baseline is the feed's
 *     own history, not the chain's: the version chain records who wrote
 *     each version, but its read seam reports no actor, and a field-level
 *     "who last wrote this" would have to replay every version.
 * - **No-op detection.** A record whose merged state equals the head appends
 *   nothing and counts as `unchanged`.
 * - **Batched** (`PERF-DB-001`): one batch holds at most
 *   {@link MAX_IMPORT_BATCH} records, its links are read in one
 *   {@link ExternalIdStore.lookup}, and it answers an {@link ImportSummary}.
 *   A record that loses a race (`StaleVersion`, `VersionConflict`), meets a
 *   tombstone, is refused by a before hook (`WriteRejected`) or repeats an
 *   id earlier in the batch is a conflict entry, never a failed batch.
 *
 * The import writes through the operations, not through `subtypeHandlers`,
 * so it does no cache write-through: an application whose reference leaf is
 * cached evicts each `written` entry's version through its resource cache
 * after the batch's transaction commits.
 *
 * @copyright Thomas Foster
 * @module pulpit/reference-import
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  defineSubtype,
  MAX_PAGE_LIMIT,
  type Forbidden,
  type LeafRow,
  type SubtypeDefinition,
  type SubtypeOps,
  type Unauthorized,
  type ViewerAccount,
  type WriteRejected,
} from "./subtype.ts";
import {
  applyPatch,
  diffStates,
  type ChainPatch,
  type ChainState,
  type ColumnValue,
  type NodeAlreadyExists,
  type NodeNotFound,
  type StaleVersion,
  type VersionNotFound,
  type VersionConflict,
} from "./version-chain.ts";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * How an import decides one field's value (see the module doc):
 * `overwrite`, `coalesce` or `curated-wins`.
 *
 * @since 0.2.0
 */
export const MergeMode = Schema.Literals(["overwrite", "coalesce", "curated-wins"]);
/**
 * The {@link MergeMode} literal union.
 *
 * @since 0.2.0
 */
export type MergeMode = typeof MergeMode.Type;

/**
 * The most records one {@link ReferenceImportOps.run} batch takes
 * (`PERF-DB-001`): the kernel's page cap.
 *
 * @since 0.2.0
 */
export const MAX_IMPORT_BATCH = MAX_PAGE_LIMIT;

/**
 * One stored link: an external id of an authority, the node it names, and
 * the baseline (the declared fields' values the last import of it sent;
 * none until an import has run, as for a pre-attached id).
 *
 * @since 0.2.0
 */
export interface ExternalIdLink {
  readonly authority: string;
  readonly externalId: string;
  readonly nodeId: string;
  readonly baseline: Option.Option<ChainState>;
}

/**
 * The external-identifier table an application supplies, one per family
 * (or one table with a family column): keyed `(authority, external_id)`,
 * with a second unique key on `(authority, node_id)`, the node foreign key
 * cascading, and a nullable `jsonb` baseline. A store seam: no policy, never
 * opens a transaction, fails only with its `E`. See the package README →
 * Seams.
 *
 * @since 0.2.0
 */
export interface ExternalIdStore<E, R> {
  /** The links of `externalIds` under `authority`, by external id: one bounded read (`IN (…)`). */
  readonly lookup: (
    authority: string,
    externalIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ExternalIdLink>, E, R>;
  /**
   * Insert the link (`ON CONFLICT DO NOTHING`): `"linked"` when written,
   * `"present"` when exactly this link is already stored, `"taken"` when
   * either unique key belongs to another link (the external id names another
   * node, or the node already has another id from this authority).
   */
  readonly link: (
    authority: string,
    externalId: string,
    nodeId: string,
  ) => Effect.Effect<"linked" | "present" | "taken", E, R>;
  /** Replace the link's baseline. A link that isn't stored is left absent. */
  readonly recordBaseline: (
    authority: string,
    externalId: string,
    baseline: ChainState,
  ) => Effect.Effect<void, E, R>;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * An authority the family doesn't declare: the wire's 422.
 *
 * @since 0.2.0
 */
export class UnknownAuthority extends Schema.TaggedError<
  UnknownAuthority,
  { readonly brand: unique symbol }
>()("UnknownAuthority", { type: Schema.String, authority: Schema.String }) {}

/**
 * A batch over {@link MAX_IMPORT_BATCH} records, refused whole before
 * anything is read: the wire's 413.
 *
 * @since 0.2.0
 */
export class ImportBatchTooLarge extends Schema.TaggedError<
  ImportBatchTooLarge,
  { readonly brand: unique symbol }
>()("ImportBatchTooLarge", { type: Schema.String, size: Schema.Int, max: Schema.Int }) {}

/**
 * An attach whose external id already names another node, or whose node
 * already carries another id from the authority: the wire's 409.
 *
 * @since 0.2.0
 */
export class ExternalIdTaken extends Schema.TaggedError<
  ExternalIdTaken,
  { readonly brand: unique symbol }
>()("ExternalIdTaken", {
  type: Schema.String,
  authority: Schema.String,
  externalId: Schema.String,
}) {}

/**
 * An import declared against the rules: a leaf that isn't reference data,
 * an actor below the corpus-write rung, no authority or a repeated one, no
 * field, or a field outside the leaf's view columns (or one of `id`,
 * `version`, `action`). Thrown by {@link defineReferenceImport} when it is
 * declared, never an Effect failure, like `./subtype`'s
 * `SubtypeDeclarationError`.
 *
 * @since 0.2.0
 */
export class ReferenceImportDeclarationError extends Schema.TaggedError<
  ReferenceImportDeclarationError,
  { readonly brand: unique symbol }
>()("ReferenceImportDeclarationError", { message: Schema.String }) {}

// ── The declaration and the operations ────────────────────────────────

/**
 * An import's declaration: the reference leaf (its own `defineSubtype`
 * declaration), the external-id store, the authorities it imports from,
 * the actor its writes record, and the fields a feed may write, each with
 * its {@link MergeMode}.
 *
 * @since 0.2.0
 */
export interface ReferenceImportDefinition<Row extends LeafRow, Resource, Following, E, R> {
  readonly leaf: SubtypeDefinition<Row, Resource, Following, E, R>;
  readonly ids: ExternalIdStore<E, R>;
  readonly authorities: ReadonlyArray<string>;
  /** The bot account every import write is made as; it must hold the leaf's corpus-write rung. */
  readonly actor: ViewerAccount;
  /** The columns a feed may write, each with its merge mode. A record's other keys are ignored. */
  readonly fields: Readonly<Record<string, MergeMode>>;
}

/**
 * One record of a feed: its external id and its values, a tri-state
 * {@link ChainPatch} (an absent or `undefined` key says nothing about the
 * field).
 *
 * @since 0.2.0
 */
export interface ImportRecord {
  readonly externalId: string;
  readonly values: ChainPatch;
}

/**
 * One batch: the authority its ids belong to and its records.
 *
 * @since 0.2.0
 */
export interface ImportBatch {
  readonly authority: string;
  readonly records: ReadonlyArray<ImportRecord>;
}

/**
 * Why a record wrote nothing:
 *
 * - `stale` — the node moved between the import's read and its append
 *   (`StaleVersion` or `VersionConflict`);
 * - `taken` — a new link lost a race: the external id was linked to
 *   another node first;
 * - `deleted` — the node is tombstoned (or missing behind a link);
 * - `rejected` — a before hook refused the write (`WriteRejected`);
 * - `duplicate` — the batch named the external id earlier.
 *
 * @since 0.2.0
 */
export type ImportConflictReason = "stale" | "taken" | "deleted" | "rejected" | "duplicate";

/**
 * One record that wrote nothing, and why.
 *
 * @since 0.2.0
 */
export interface ImportConflict {
  readonly externalId: string;
  readonly reason: ImportConflictReason;
}

/**
 * One record that appended a version: its external id, its node and the
 * version written (what a cache evicts at).
 *
 * @since 0.2.0
 */
export interface ImportWrite {
  readonly externalId: string;
  readonly id: string;
  readonly version: bigint;
  readonly action: "created" | "updated";
}

/**
 * What a batch did: how many records created a node, updated one or changed
 * nothing, each write, and each conflict.
 *
 * @since 0.2.0
 */
export interface ImportSummary {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly written: ReadonlyArray<ImportWrite>;
  readonly conflicts: ReadonlyArray<ImportConflict>;
}

/**
 * The operations {@link defineReferenceImport} produces.
 *
 * @since 0.2.0
 */
export interface ReferenceImportOps<E, R> {
  /**
   * Import one batch as the declared actor. Fails {@link UnknownAuthority}
   * and {@link ImportBatchTooLarge} before reading anything; a record's own
   * trouble is a conflict entry in the {@link ImportSummary}.
   */
  readonly run: (
    batch: ImportBatch,
  ) => Effect.Effect<
    ImportSummary,
    UnknownAuthority | ImportBatchTooLarge | Unauthorized | Forbidden | E,
    R
  >;
  /**
   * Pre-attach an external id to an existing node, as the request's viewer:
   * the leaf's write gate for that node (the corpus-write rung, and a node
   * the viewer can read, else `NodeNotFound`). Attaching the same link again
   * changes nothing; an id or node already linked otherwise fails
   * {@link ExternalIdTaken}.
   */
  readonly attach: (link: {
    readonly authority: string;
    readonly externalId: string;
    readonly id: string;
  }) => Effect.Effect<
    { readonly changed: boolean },
    UnknownAuthority | ExternalIdTaken | Unauthorized | Forbidden | NodeNotFound | E,
    R
  >;
}

/** The columns a feed may never write: the view's own. */
const RESERVED = HashSet.make("id", "version", "action");

const declarationError = (message: string) =>
  new ReferenceImportDeclarationError({ message: `reference import: ${message}` });

/** Two column values are the same when their one-column states diff to nothing. */
const sameValue = (a: Option.Option<ColumnValue>, b: Option.Option<ColumnValue>): boolean =>
  R.isEmptyRecord(diffStates(stateOf(a), stateOf(b)));

/** One optional value as a one-column state: absent, the empty state. */
const stateOf = (value: Option.Option<ColumnValue>): ChainState =>
  Option.match(value, { onNone: () => ({}), onSome: (present) => ({ value: present }) });

/** The declared fields of a record, without the keys it leaves unsaid. */
const spoken = (
  fields: Readonly<Record<string, MergeMode>>,
  values: ChainPatch,
): Readonly<Record<string, ColumnValue>> =>
  R.filterMap(fields, (_mode, field) => {
    const value = values[field];
    return value === undefined ? Result.failVoid : Result.succeed(value);
  });

/**
 * The patch an import applies to `state` (see the module doc's merge
 * modes): only the fields whose merged value differs from the node's.
 */
const mergePatch = (
  fields: Readonly<Record<string, MergeMode>>,
  state: ChainState,
  feed: Readonly<Record<string, ColumnValue>>,
  baseline: Option.Option<ChainState>,
): ChainPatch =>
  R.filterMap(feed, (value, field) => {
    const current = R.get(state, field);
    const curated = Option.match(
      Option.flatMap(baseline, (sent) => R.get(sent, field)),
      {
        onNone: () => Option.exists(current, P.isNotNull),
        onSome: (sent) => !sameValue(current, Option.some(sent)),
      },
    );
    const keep =
      fields[field] === "coalesce" ? value === null : fields[field] === "curated-wins" && curated;
    return keep || sameValue(current, Option.some(value)) ? Result.failVoid : Result.succeed(value);
  });

/** What one record came to. */
type Outcome =
  | { readonly kind: "written"; readonly write: ImportWrite }
  | { readonly kind: "unchanged" }
  | { readonly kind: "conflict"; readonly conflict: ImportConflict };

/**
 * Bind an external reference import to a reference leaf (see the module
 * doc). The leaf's operations are rebound to the declared actor for
 * {@link ReferenceImportOps.run}, so its gates and before hooks apply to
 * every import write. Throws {@link ReferenceImportDeclarationError} for a
 * declaration against the rules.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { defineReferenceImport } from "@thomasfosterau/pulpit/reference-import";
 * import { defineSubtype, type LeafRow } from "@thomasfosterau/pulpit/subtype";
 * import {
 *   makeInMemoryChainStore,
 *   makeInMemoryExternalIdStore,
 *   makeInMemoryFollowers,
 *   makeInMemoryLeafStore,
 * } from "@thomasfosterau/pulpit/testing";
 *
 * const chain = makeInMemoryChainStore();
 * const always = () => true;
 * const leaf = {
 *   type: "parties",
 *   access: { kind: "reference" } as const,
 *   chain,
 *   leaves: makeInMemoryLeafStore(chain, { columns: ["name", "abbreviation"] }),
 *   viewer: Effect.succeed(Option.none()),
 *   policy: { canViewPrivate: always, canViewDeleted: always, canModerate: always, canWriteCorpus: always },
 *   followers: makeInMemoryFollowers([]),
 *   toResource: (row: LeafRow) => row,
 * };
 * const parties = defineReferenceImport({
 *   leaf,
 *   ids: makeInMemoryExternalIdStore(),
 *   authorities: ["aec"],
 *   actor: { id: "bot-ingest", role: "contributor" },
 *   fields: { name: "overwrite", abbreviation: "coalesce" },
 * });
 *
 * const batch = { authority: "aec", records: [{ externalId: "36", values: { name: "Greens", abbreviation: "GRN" } }] };
 * const first = Effect.runSync(parties.run(batch));
 * const again = Effect.runSync(parties.run(batch));
 * strictEqual(first.created, 1);
 * strictEqual(again.unchanged, 1); // identical data appends nothing
 * strictEqual(defineSubtype(leaf).type, "parties");
 * ```
 *
 * @since 0.2.0
 */
export const defineReferenceImport = <Row extends LeafRow, Resource, Following, E, R>(
  definition: ReferenceImportDefinition<Row, Resource, Following, E, R>,
): ReferenceImportOps<E, R> => {
  const { leaf, ids, actor, fields } = definition;
  const { type } = leaf;
  if (leaf.access.kind !== "reference") {
    throw declarationError(`${type} is not a reference leaf`);
  }
  if (!leaf.policy.canWriteCorpus(actor)) {
    throw declarationError(`the actor ${actor.id} is below ${type}'s corpus-write rung`);
  }
  const authorities = HashSet.fromIterable(definition.authorities);
  if (
    HashSet.size(authorities) === 0 ||
    HashSet.size(authorities) !== definition.authorities.length
  ) {
    throw declarationError(`${type} declares no authority, or one twice`);
  }
  const fieldNames = R.keys(fields);
  if (Arr.isReadonlyArrayEmpty(fieldNames)) throw declarationError(`${type} declares no field`);
  Arr.forEach(fieldNames, (field) => {
    if (HashSet.has(RESERVED, field) || !leaf.leaves.columns.has(field)) {
      throw declarationError(`${field} is not a writable column of ${type}'s view`);
    }
  });

  const asActor: SubtypeOps<Resource, E, R, Following> = defineSubtype({
    ...leaf,
    viewer: Effect.succeedSome(actor),
  });
  const asViewer: SubtypeOps<Resource, E, R, Following> = defineSubtype(leaf);

  const declared = (authority: string): Effect.Effect<void, UnknownAuthority> =>
    HashSet.has(authorities, authority)
      ? Effect.void
      : Effect.fail(new UnknownAuthority({ type, authority }));

  const conflict = (externalId: string, reason: ImportConflictReason): Outcome => ({
    kind: "conflict",
    conflict: { externalId, reason },
  });

  /** A record's write, with every race, hook refusal and tombstone settled as a conflict. */
  const settled = <X>(externalId: string, write: Effect.Effect<Outcome, X, R>) =>
    write.pipe(
      Effect.catchIf(
        (error): error is Extract<X, Settled> => isSettled(error),
        (error) => Effect.succeed(conflict(externalId, reasonOf(error))),
      ),
    );

  const create = (
    authority: string,
    record: ImportRecord,
    feed: Readonly<Record<string, ColumnValue>>,
    linked: Option.Option<string>,
  ) =>
    Effect.gen(function* () {
      const id = yield* Option.match(linked, {
        onSome: (nodeId) => Effect.succeedSome(nodeId),
        onNone: () =>
          Effect.flatMap(leaf.chain.mintId, (minted) =>
            Effect.map(ids.link(authority, record.externalId, minted), (result) =>
              result === "taken" ? Option.none<string>() : Option.some(minted),
            ),
          ),
      });
      if (Option.isNone(id)) return conflict(record.externalId, "taken");
      const written = yield* settled(
        record.externalId,
        Effect.map(asActor.create({ id, state: feed }), (write): Outcome => ({
          kind: "written",
          write: { externalId: record.externalId, ...write, action: "created" },
        })),
      );
      return written;
    });

  const update = (
    record: ImportRecord,
    feed: Readonly<Record<string, ColumnValue>>,
    link: ExternalIdLink,
  ) =>
    Effect.gen(function* () {
      const head = yield* leaf.chain.head(link.nodeId);
      if (Option.isNone(head)) return Option.none<Outcome>();
      if (head.value.action === "delete") {
        return Option.some(conflict(record.externalId, "deleted"));
      }
      const outcome = yield* settled(
        record.externalId,
        Effect.flatMap(asActor.getVersion(link.nodeId, head.value.version), (snapshot) => {
          const patch = mergePatch(fields, snapshot.state, feed, link.baseline);
          return R.isEmptyRecord(diffStates(snapshot.state, applyPatch(snapshot.state, patch)))
            ? Effect.succeed<Outcome>({ kind: "unchanged" })
            : Effect.map(
                asActor.update({
                  id: link.nodeId,
                  patch,
                  expectedVersion: head.value.version,
                }),
                (write): Outcome => ({
                  kind: "written",
                  write: { externalId: record.externalId, ...write, action: "updated" },
                }),
              );
        }),
      );
      return Option.some(outcome);
    });

  const one = (authority: string, record: ImportRecord, link: Option.Option<ExternalIdLink>) =>
    Effect.gen(function* () {
      const feed = spoken(fields, record.values);
      const updated = yield* Option.match(link, {
        onNone: () => Effect.succeed(Option.none<Outcome>()),
        onSome: (stored) => update(record, feed, stored),
      });
      // A link whose node is gone (a create that failed after its link was
      // written) is completed with the linked id.
      const outcome = Option.isSome(updated)
        ? updated.value
        : yield* create(
            authority,
            record,
            feed,
            Option.map(link, (stored) => stored.nodeId),
          );
      if (outcome.kind !== "conflict") {
        const previous = Option.getOrElse(
          Option.flatMap(link, (stored) => stored.baseline),
          (): ChainState => ({}),
        );
        yield* ids.recordBaseline(authority, record.externalId, { ...previous, ...feed });
      }
      return outcome;
    });

  const run = (batch: ImportBatch) =>
    Effect.gen(function* () {
      yield* declared(batch.authority);
      if (batch.records.length > MAX_IMPORT_BATCH) {
        return yield* new ImportBatchTooLarge({
          type,
          size: batch.records.length,
          max: MAX_IMPORT_BATCH,
        });
      }
      const links = yield* ids.lookup(
        batch.authority,
        Arr.dedupe(Arr.map(batch.records, (record) => record.externalId)),
      );
      // Records run one after another, in the batch's order, so a repeated
      // id is a conflict against the earlier record, never a race with it.
      const firsts = Arr.reduce(
        batch.records,
        HashMap.empty<string, number>(),
        (seen, record, index) =>
          HashMap.has(seen, record.externalId) ? seen : HashMap.set(seen, record.externalId, index),
      );
      const outcomes = yield* Effect.forEach(
        batch.records,
        (record, index) =>
          Option.contains(HashMap.get(firsts, record.externalId), index)
            ? one(batch.authority, record, HashMap.get(links, record.externalId))
            : Effect.succeed(conflict(record.externalId, "duplicate")),
        { concurrency: 1 },
      );
      const written = Arr.filterMap(outcomes, (outcome) =>
        outcome.kind === "written" ? Result.succeed(outcome.write) : Result.failVoid,
      );
      return {
        created: Arr.filter(written, (write) => write.action === "created").length,
        updated: Arr.filter(written, (write) => write.action === "updated").length,
        unchanged: Arr.filter(outcomes, (outcome) => outcome.kind === "unchanged").length,
        written,
        conflicts: Arr.filterMap(outcomes, (outcome) =>
          outcome.kind === "conflict" ? Result.succeed(outcome.conflict) : Result.failVoid,
        ),
      } satisfies ImportSummary;
    });

  const attach: ReferenceImportOps<E, R>["attach"] = ({ authority, externalId, id }) =>
    Effect.gen(function* () {
      yield* declared(authority);
      yield* asViewer.authorize(id);
      const result = yield* ids.link(authority, externalId, id);
      if (result === "taken") return yield* new ExternalIdTaken({ type, authority, externalId });
      return { changed: result === "linked" };
    });

  return { run, attach };
};

/** The chain failures a record settles as a conflict, not a failed batch. */
type Settled =
  | StaleVersion
  | VersionConflict
  | NodeAlreadyExists
  | VersionNotFound
  | WriteRejected
  | NodeNotFound;

const isSettled = <X>(error: X): error is Extract<X, Settled> =>
  P.isTagged(error, "StaleVersion") ||
  P.isTagged(error, "VersionConflict") ||
  P.isTagged(error, "NodeAlreadyExists") ||
  P.isTagged(error, "VersionNotFound") ||
  P.isTagged(error, "WriteRejected") ||
  P.isTagged(error, "NodeNotFound");

/** The reason a settled failure reads as. */
const reasonOf = (error: Settled): ImportConflictReason =>
  P.isTagged(error, "WriteRejected")
    ? "rejected"
    : P.isTagged(error, "NodeNotFound")
      ? "deleted"
      : "stale";
