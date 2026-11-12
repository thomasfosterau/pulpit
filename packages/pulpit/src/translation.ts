/**
 * **Translation lineage and staleness on localised leaves** (pulpit#208),
 * with a translator seam and a sweep that keeps machine translations
 * current. The behavioural spec is website's machine translation
 * (`packages/jobs/src/translation/`, the `derivedFromId` lineage of
 * `pages.localized_document` and the daily `translation-sweep`).
 *
 * ## Lineage lives in the locale level
 *
 * A locale's lineage is three columns of that locale's own row in the
 * leaf's locale level (`./subtype`'s `LocaleLevel`), named by the family's
 * {@link LineageColumns}: the **source locale** it was derived from, the
 * **source version** (the node version whose source text it translates)
 * and the **method** (`human` or `machine`). Because they are ordinary
 * locale columns they travel through every write path unchanged: the
 * `VersionChain` port's `locales` inputs and `getVersion` (so a Drizzle
 * adapter keeps them on the keyed level's rows, README → Seams), a
 * `./proposals` locale patch, `SubtypeOps.update`, `restoreVersion`. No
 * version is ever rewritten (`VERSION-CHAIN-001/002`): new lineage is a new
 * version. The source version is a decimal **string**, not a `bigint`, so
 * it is valid JSON inside a proposal's locale patch. A locale with no
 * lineage (an absent or malformed column) is an original: never stale.
 *
 * Declare the three columns in the leaf's `LocaleLevel` (they are locale
 * columns) and list only the translatable ones in
 * {@link TranslationDeclaration.columns}.
 *
 * ## Staleness
 *
 * A derived locale is **stale** when its source locale's translatable
 * columns at the node's head differ from those at the source version it
 * records, or when that version can no longer be read. A target locale the
 * node lacks while the family's source locale is present is **missing**.
 * {@link TranslationOps.pending} lists both, one keyset page of candidate
 * nodes at a time (`PERF-DB-001`): at most two chain reads per node, plus
 * one per distinct source version.
 *
 * ## A privileged sweep read
 *
 * The sweep reads the chain directly, not through a read gate: it is a
 * server job whose results are never served to a viewer, and its writes go
 * through the leaf's own write path (the hooked `VersionChainOps.update`)
 * or `./proposals`, so every before hook still runs. **What is eligible to
 * leave for a translation model is the application's**: the
 * {@link TranslationCandidates} seam enumerates the nodes the sweep may
 * read, and is where an application excludes owned or private content it
 * must not send to a third-party model.
 *
 * ## Landing a translation (owner decision on pulpit#208)
 *
 * Each family chooses: `direct` writes the translation as a version of the
 * node marked `machine` in its lineage, attributed to a bot actor; `proposal`
 * submits it through `./proposals` (the application binds a proposals
 * instance whose viewer is the bot), so a person reviews it before it
 * lands. A node's pending pairs land as one write or one proposal.
 *
 * ## Human edits
 *
 * {@link humanLineageHook} is the before hook that marks a person's edit of
 * a derived locale `human` (keeping its source and source version, so it
 * still goes stale when the source moves on). The segment-preserving
 * translation of a ProseKit document is not the kernel's: the
 * {@link Translator} seam takes the source locale's translatable column
 * values, opaque, and prosekit-utilities fills it for documents (the
 * owner decision on pulpit#202).
 *
 * @copyright Thomas Foster
 * @module pulpit/translation
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  MAX_PAGE_LIMIT,
  type BeforeWriteEvent,
  type BeforeWriteHook,
  type LocaleLevel,
} from "./subtype.ts";
import {
  diffStates,
  localesOf,
  type ChainPatch,
  type ChainState,
  type ColumnValue,
  type LocalePatch,
  type LocaleStates,
  type UpdateInput,
  type VersionChain,
  type VersionSnapshot,
} from "./version-chain.ts";

// ── Lineage ───────────────────────────────────────────────────────────

/**
 * How a locale's text came to be: written by a person, or by a model.
 *
 * @since 0.2.0
 */
export const TranslationMethod = Schema.Literals(["human", "machine"]);
/**
 * The {@link TranslationMethod} literal union.
 *
 * @since 0.2.0
 */
export type TranslationMethod = typeof TranslationMethod.Type;

/**
 * The three locale-level columns a family keeps a locale's lineage in.
 *
 * @since 0.2.0
 */
export interface LineageColumns {
  /** The source locale's tag. */
  readonly source: string;
  /** The node version whose source text was translated, as a decimal string. */
  readonly sourceVersion: string;
  /** The {@link TranslationMethod}. */
  readonly method: string;
}

/**
 * The conventional {@link LineageColumns}: `derivedFrom`,
 * `derivedFromVersion`, `derivation`.
 *
 * @since 0.2.0
 */
export const defaultLineageColumns: LineageColumns = {
  source: "derivedFrom",
  sourceVersion: "derivedFromVersion",
  method: "derivation",
};

/**
 * One locale's lineage: the locale and node version it was derived from, and how.
 *
 * @since 0.2.0
 */
export interface LocaleLineage {
  readonly source: string;
  readonly sourceVersion: bigint;
  readonly method: TranslationMethod;
}

const isMethod = Schema.is(TranslationMethod);
const DECIMAL = /^(0|[1-9]\d*)$/;

/**
 * Read a locale's lineage off its state. Fails closed to none: a lineage is
 * read only when all three columns are present and well-formed (a string
 * source, a decimal-string or `bigint` version, a known method), so a
 * malformed row reads as an original locale, which is never stale.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Option from "effect/Option";
 * import { defaultLineageColumns, lineageOf } from "@thomasfosterau/pulpit/translation";
 *
 * const fr = { title: "Bonjour", derivedFrom: "en", derivedFromVersion: "3", derivation: "machine" };
 * deepStrictEqual(lineageOf(defaultLineageColumns, fr), Option.some({ source: "en", sourceVersion: 3n, method: "machine" }));
 * deepStrictEqual(lineageOf(defaultLineageColumns, { title: "Hello" }), Option.none());
 * ```
 *
 * @since 0.2.0
 */
export const lineageOf = (
  columns: LineageColumns,
  state: ChainState,
): Option.Option<LocaleLineage> => {
  const source = state[columns.source];
  const version = state[columns.sourceVersion];
  const method = state[columns.method];
  if (!P.isString(source) || !isMethod(method)) return Option.none();
  if (P.isBigInt(version)) return Option.some({ source, sourceVersion: version, method });
  if (P.isString(version) && DECIMAL.test(version)) {
    return Option.some({ source, sourceVersion: BigInt(version), method });
  }
  return Option.none();
};

/**
 * The locale patch columns that record `lineage` (the version as a decimal string).
 *
 * @since 0.2.0
 */
export const lineagePatch = (columns: LineageColumns, lineage: LocaleLineage): ChainPatch => ({
  [columns.source]: lineage.source,
  [columns.sourceVersion]: lineage.sourceVersion.toString(),
  [columns.method]: lineage.method,
});

// ── The seams ─────────────────────────────────────────────────────────

/**
 * The model the application runs (website: an Effect `LanguageModel`).
 * Given the source locale's translatable column values, it returns their
 * translations under the same column names; a column it returns that is not
 * one of the family's translatable columns refuses that node's write
 * (`TRANSLATOR_COLUMNS`). Values are opaque to the kernel: a document column
 * (its `DocumentHash`, or inline JSON) is the application's to translate
 * segment by segment (prosekit-utilities, pulpit#202). Its failure `E`
 * stops the sweep, which a re-run resumes.
 *
 * @since 0.2.0
 */
export interface Translator<E, R> {
  readonly translate: (input: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly values: ChainState;
  }) => Effect.Effect<ChainState, E, R>;
}

/**
 * The nodes a sweep may read, in ascending id order after `after`, at most
 * `limit` of them: the application's query over its localised leaf (and
 * where it leaves out what must never reach a model). A store seam: no
 * policy beyond the application's own eligibility.
 *
 * @since 0.2.0
 */
export interface TranslationCandidates<E, R> {
  readonly nodes: (request: {
    readonly after: Option.Option<string>;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, E, R>;
}

/**
 * How a family lands a translation (owner decision on pulpit#208).
 *
 * - `direct`: one `update` per node through the leaf's hooked
 *   `VersionChainOps.update`, attributed to `actorId` and pinned to the head
 *   the sweep read (`expectedVersion`), so a concurrent edit is a conflict,
 *   never overwritten.
 * - `proposal`: one `./proposals` `submit` per node, from an instance whose
 *   viewer is the bot; `hasPending`, when given, skips a locale that already
 *   has a pending bot proposal, so a re-run doesn't propose it twice.
 *
 * @since 0.2.0
 */
export type TranslationLanding<E, R, LE = unknown> =
  | {
      readonly kind: "direct";
      readonly update: (input: UpdateInput) => Effect.Effect<unknown, LE, R>;
      readonly actorId: Option.Option<string>;
    }
  | {
      readonly kind: "proposal";
      readonly submit: (input: {
        readonly targetId: string;
        readonly patch: Schema.Json;
        readonly locales: Schema.Json;
        readonly rationale: Option.Option<string>;
      }) => Effect.Effect<unknown, LE, R>;
      readonly hasPending?: (id: string, locale: string) => Effect.Effect<boolean, E, R>;
    };

// ── The declaration ───────────────────────────────────────────────────

/**
 * A localised family's translation declaration.
 *
 * @since 0.2.0
 */
export interface TranslationDeclaration {
  /** The leaf's wire type, for the conflict entries. */
  readonly type: string;
  /** The translatable columns: the leaf's locale-level columns minus the lineage ones. */
  readonly columns: LocaleLevel["columns"];
  /** The lineage columns; omitted, {@link defaultLineageColumns}. */
  readonly lineage?: LineageColumns;
  /** The locale missing targets are translated from (the family's default). */
  readonly sourceLocale: string;
  /** The locales the family keeps a translation in; a node lacking one has a `missing` pair. */
  readonly targets: ReadonlyArray<string>;
}

/**
 * One locale the sweep would translate.
 *
 * @since 0.2.0
 */
export interface TranslationPair {
  readonly id: string;
  readonly locale: string;
  /** The locale it is translated from. */
  readonly source: string;
  /** `stale`: its source moved on since it was derived; `missing`: a target the node lacks. */
  readonly reason: "stale" | "missing";
  /** The head the pair was read at, which a translation records as its source version. */
  readonly headVersion: bigint;
}

/**
 * A page request: at most `limit` candidate nodes (clamped to `[1, MAX_PAGE_LIMIT]`) after `after`.
 *
 * @since 0.2.0
 */
export interface TranslationPageRequest {
  readonly after: Option.Option<string>;
  readonly limit: number;
}

/**
 * One page of {@link TranslationOps.pending}: the pairs found and the
 * cursor after the last node read (none once the candidates ran out).
 *
 * @since 0.2.0
 */
export interface PendingPage {
  readonly pairs: ReadonlyArray<TranslationPair>;
  readonly next: Option.Option<string>;
}

/**
 * A node the sweep read but did not land: a concurrent edit (`CONFLICT`),
 * a landing that failed (`REJECTED`, its error's `_tag` when it has one),
 * or a translator that returned columns outside the family's
 * (`TRANSLATOR_COLUMNS`).
 *
 * @since 0.2.0
 */
export interface SweepConflict {
  readonly id: string;
  readonly locales: ReadonlyArray<string>;
  readonly reason: string;
}

/**
 * What one {@link TranslationOps.sweep} page did.
 *
 * @since 0.2.0
 */
export interface SweepSummary {
  /** The pairs translated and landed (written, or proposed). */
  readonly landed: ReadonlyArray<TranslationPair>;
  /** Pairs skipped because a bot proposal for them is already pending. */
  readonly skipped: ReadonlyArray<TranslationPair>;
  readonly conflicts: ReadonlyArray<SweepConflict>;
  readonly next: Option.Option<string>;
}

/**
 * The operations {@link defineTranslation} produces.
 *
 * @since 0.2.0
 */
export interface TranslationOps<E, R> {
  /** The stale and missing pairs among one page of candidate nodes. Fails only with the seams' `E`. */
  readonly pending: (request: TranslationPageRequest) => Effect.Effect<PendingPage, E, R>;
  /**
   * Translate and land one page's pending pairs, a node at a time. A
   * landing failure is a {@link SweepConflict}, never a failed page; the
   * translator's or a seam's `E` fails it, and a re-run from the same
   * cursor resumes.
   */
  readonly sweep: (request: TranslationPageRequest) => Effect.Effect<SweepSummary, E, R>;
}

/**
 * A family's translation sweep over its chain (`head` and `getVersion`, the
 * privileged sweep read), its candidates, its translator and its landing.
 *
 * @since 0.2.0
 */
export const defineTranslation = <E, R, LE>(
  definition: TranslationDeclaration & {
    readonly chain: Pick<VersionChain<E, R>, "head" | "getVersion">;
    readonly candidates: TranslationCandidates<E, R>;
    readonly translator: Translator<E, R>;
    readonly landing: TranslationLanding<E, R, LE>;
  },
): TranslationOps<E, R> => {
  const { chain, candidates, translator, landing, sourceLocale, targets } = definition;
  const lineage = definition.lineage ?? defaultLineageColumns;
  const translatable = HashSet.fromIterable(definition.columns);
  /** The snapshot at `(id, version)`, none when it can't be reconstructed; the chain's own `E` propagates. */
  const readVersion = (id: string, version: bigint) =>
    Effect.catchTag(
      Effect.asSome(chain.getVersion(id, version)),
      "VersionNotFound",
      () => Effect.succeedNone,
    );
  const pick = (state: ChainState): ChainState =>
    R.filter(state, (_, column) => HashSet.has(translatable, column));

  /** The node's head snapshot, or none for an unknown or tombstoned node. */
  const headOf = (id: string): Effect.Effect<Option.Option<VersionSnapshot>, E, R> =>
    Effect.flatMap(chain.head(id), (head) =>
      Option.match(
        Option.filter(head, (entry) => entry.action !== "delete"),
        {
          onNone: () => Effect.succeedNone,
          onSome: (entry) => readVersion(id, entry.version),
        },
      ),
    );

  /** A node's pending pairs, from its head snapshot. */
  const pairsOf = (id: string, head: VersionSnapshot) =>
    Effect.gen(function* () {
      const locales = localesOf(head);
      const derived = Arr.getSomes(
        Arr.map(R.toEntries(locales), ([locale, state]) =>
          Option.match(lineageOf(lineage, state), {
            onNone: () => Option.none(),
            onSome: (found) =>
              found.source === locale || !R.has(locales, found.source)
                ? Option.none()
                : Option.some({ locale, lineage: found }),
          }),
        ),
      );
      const versions = Arr.dedupe(Arr.map(derived, ({ lineage: found }) => found.sourceVersion));
      const then = yield* Effect.forEach(
        versions,
        (version) =>
          Effect.map(readVersion(id, version), (snapshot) => [version, snapshot] as const),
        { concurrency: 1 },
      );
      const at = (version: bigint) =>
        Option.flatten(
          Option.map(
            Arr.findFirst(then, ([v]) => v === version),
            ([, snapshot]) => snapshot,
          ),
        );
      const stale = Arr.getSomes(
        Arr.map(derived, ({ locale, lineage: found }) => {
          const now = pick(locales[found.source] ?? {});
          const isStale = Option.match(at(found.sourceVersion), {
            onNone: () => true,
            onSome: (snapshot) =>
              !R.isEmptyRecord(diffStates(pick(localesOf(snapshot)[found.source] ?? {}), now)),
          });
          return isStale
            ? Option.some<TranslationPair>({
                id,
                locale,
                source: found.source,
                reason: "stale",
                headVersion: head.version,
              })
            : Option.none();
        }),
      );
      const missing = R.has(locales, sourceLocale)
        ? Arr.getSomes(
            Arr.map(targets, (locale) =>
              locale === sourceLocale || R.has(locales, locale)
                ? Option.none()
                : Option.some<TranslationPair>({
                    id,
                    locale,
                    source: sourceLocale,
                    reason: "missing",
                    headVersion: head.version,
                  }),
            ),
          )
        : [];
      return [...stale, ...missing];
    });

  const page = (request: TranslationPageRequest) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(Math.trunc(request.limit) || 1, 1), MAX_PAGE_LIMIT);
      const ids = yield* candidates.nodes({ after: request.after, limit });
      const empty: ReadonlyArray<TranslationPair> = [];
      const nodes = yield* Effect.forEach(
        ids,
        (id) =>
          Effect.flatMap(headOf(id), (head) =>
            Option.match(head, {
              onNone: () => Effect.succeed({ id, head, pairs: empty }),
              onSome: (snapshot) =>
                Effect.map(pairsOf(id, snapshot), (pairs) => ({ id, head, pairs })),
            }),
          ),
        { concurrency: 1 },
      );
      const next = ids.length < limit ? Option.none() : Arr.last(ids);
      return { nodes, next };
    });

  /** Translate a node's pairs into one locale patch, or the conflict that stops it. */
  const translateNode = (head: VersionSnapshot, pairs: ReadonlyArray<TranslationPair>) =>
    Effect.gen(function* () {
      const locales = localesOf(head);
      const translated = yield* Effect.forEach(
        pairs,
        (pair) =>
          Effect.map(
            translator.translate({
              id: pair.id,
              from: pair.source,
              to: pair.locale,
              values: pick(locales[pair.source] ?? {}),
            }),
            (values) => [pair, values] as const,
          ),
        { concurrency: 1 },
      );
      const outside = Arr.some(translated, ([, values]) =>
        Arr.some(R.keys(values), (column) => !HashSet.has(translatable, column)),
      );
      if (outside) return Option.none<LocalePatch>();
      return Option.some<LocalePatch>(
        R.fromEntries(
          Arr.map(translated, ([pair, values]) => [
            pair.locale,
            {
              ...values,
              ...lineagePatch(lineage, {
                source: pair.source,
                sourceVersion: pair.headVersion,
                method: "machine",
              }),
            },
          ]),
        ),
      );
    });

  const land = (
    id: string,
    head: VersionSnapshot,
    patch: LocalePatch,
  ): Effect.Effect<Option.Option<string>, never, R> => {
    const attempt: Effect.Effect<unknown, LE, R> =
      landing.kind === "direct"
        ? landing.update({
            id,
            patch: {},
            locales: patch,
            actorId: landing.actorId,
            expectedVersion: head.version,
          })
        : landing.submit({
            targetId: id,
            patch: {},
            // SAFETY: a translation's locale patch is JSON — the translator's
            // values (ColumnValue, JSON on a proposal's path) and string
            // lineage columns; a bigint value would fail the proposal's own decode.
            locales: patch as Schema.Json,
            rationale: Option.some("machine translation"),
          });
    return Effect.match(attempt, {
      onFailure: (error) => {
        const tag =
          P.hasProperty(error, "_tag") && P.isString(error._tag) ? error._tag : "REJECTED";
        return Option.some(
          tag === "StaleVersion" || tag === "VersionConflict" || tag === "NodeNotFound"
            ? "CONFLICT"
            : tag,
        );
      },
      onSuccess: () => Option.none(),
    });
  };

  /** The pairs to land and the ones a pending bot proposal already covers. */
  const pendingOf = (pairs: ReadonlyArray<TranslationPair>) => {
    if (landing.kind !== "proposal" || landing.hasPending === undefined)
      return Effect.succeed([pairs, []] as const);
    const { hasPending } = landing;
    return Effect.map(
      Effect.forEach(
        pairs,
        (pair) =>
          Effect.map(hasPending(pair.id, pair.locale), (pending) => [pair, pending] as const),
        { concurrency: 1 },
      ),
      (checked) =>
        [
          Arr.map(
            Arr.filter(checked, ([, pending]) => !pending),
            ([pair]) => pair,
          ),
          Arr.map(
            Arr.filter(checked, ([, pending]) => pending),
            ([pair]) => pair,
          ),
        ] as const,
    );
  };

  return {
    pending: (request) =>
      Effect.map(page(request), ({ nodes, next }) => ({
        pairs: Arr.flatMap(nodes, ({ pairs }) => pairs),
        next,
      })),
    sweep: (request) =>
      Effect.gen(function* () {
        const { nodes, next } = yield* page(request);
        const none: ReadonlyArray<TranslationPair> = [];
        const noConflicts: ReadonlyArray<SweepConflict> = [];
        const outcomes = yield* Effect.forEach(
          nodes,
          ({ id, head, pairs }) =>
            Effect.gen(function* () {
              if (Option.isNone(head) || Arr.isReadonlyArrayEmpty(pairs)) {
                return { landed: none, skipped: none, conflicts: noConflicts };
              }
              const [todo, skipped] = yield* pendingOf(pairs);
              if (Arr.isReadonlyArrayEmpty(todo))
                return { landed: none, skipped, conflicts: noConflicts };
              const patch = yield* translateNode(head.value, todo);
              const locales = Arr.map(todo, (pair) => pair.locale);
              if (Option.isNone(patch)) {
                return {
                  landed: none,
                  skipped,
                  conflicts: [{ id, locales, reason: "TRANSLATOR_COLUMNS" }],
                };
              }
              const refused = yield* land(id, head.value, patch.value);
              return Option.match(refused, {
                onNone: () => ({ landed: todo, skipped, conflicts: noConflicts }),
                onSome: (reason) => ({
                  landed: none,
                  skipped,
                  conflicts: [{ id, locales, reason }],
                }),
              });
            }),
          { concurrency: 1 },
        );
        return {
          landed: Arr.flatMap(outcomes, (outcome) => outcome.landed),
          skipped: Arr.flatMap(outcomes, (outcome) => outcome.skipped),
          conflicts: Arr.flatMap(outcomes, (outcome) => outcome.conflicts),
          next,
        };
      }),
  };
};

// ── Human edits ───────────────────────────────────────────────────────

/** Whether a locale patch sets any lineage column. */
const setsLineage = (columns: LineageColumns, patch: ChainPatch): boolean =>
  Arr.some(
    [columns.source, columns.sourceVersion, columns.method],
    (column) => patch[column] !== undefined,
  );

/**
 * A write's locale patch with every person's edit of a derived locale
 * marked `human`: a locale whose patch sets a translatable column but no
 * lineage column, and whose prior state carries a lineage, gets `method:
 * human` (its source and source version kept, so it still goes stale when
 * the source moves on). A patch that sets lineage itself (the sweep's own
 * `machine` writes) is left as given. Pure.
 *
 * @since 0.2.0
 */
export const stampHumanLineage = (
  declaration: Pick<TranslationDeclaration, "columns" | "lineage">,
  event: Pick<BeforeWriteEvent, "prior" | "locales">,
): LocalePatch => {
  const columns = declaration.lineage ?? defaultLineageColumns;
  const translatable = HashSet.fromIterable(declaration.columns);
  const prior = Option.match(event.prior, { onNone: (): LocaleStates => ({}), onSome: localesOf });
  // oxlint-disable-next-line effect/prefer-option-over-null -- a LocalePatch entry is tri-state (`null` drops the locale, `undefined` carries it), and this passes each through unchanged
  return R.map(event.locales ?? {}, (change, locale): ChainPatch | null | undefined => {
    if (change === null || change === undefined) return change;
    if (setsLineage(columns, change)) return change;
    const edits = Arr.some(
      R.keys(change),
      (column) => HashSet.has(translatable, column) && change[column] !== undefined,
    );
    if (!edits) return change;
    return Option.match(lineageOf(columns, prior[locale] ?? {}), {
      onNone: () => change,
      onSome: (found): ChainPatch =>
        found.method === "human"
          ? change
          : { ...change, [columns.method]: "human" satisfies ColumnValue },
    });
  });
};

/**
 * {@link stampHumanLineage} as a `./subtype` before hook: add it to the
 * leaf's `LifecycleHooks.before` so a person's edit of a machine
 * translation is recorded as theirs. Its shared-column pass passes the
 * patch through.
 *
 * @since 0.2.0
 */
export const humanLineageHook = (
  declaration: Pick<TranslationDeclaration, "columns" | "lineage">,
): BeforeWriteHook<never, never> => ({
  name: "translation-lineage",
  run: (event) => Effect.succeed(event.patch),
  locales: (event) => Effect.succeed(stampHumanLineage(declaration, event)),
});
