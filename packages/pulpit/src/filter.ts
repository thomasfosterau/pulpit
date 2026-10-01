/**
 * **The list-filter vocabulary** — the kernel's read predicates as data.
 *
 * Every visibility, soft-delete and publication rule the kernel owns has two
 * readings: a per-row answer (may this viewer see this row?) and a set-shaped
 * answer a LIST turns into its `WHERE`. In the apps the second is Drizzle SQL
 * built inline (`ownedListFilterE`, `loadListVisibilityFilters`,
 * `publishedFilter`), which ties the rule to one database layer and makes the
 * two readings impossible to compare. Here the set-shaped answer is a small
 * predicate tree, {@link ListFilter}: a Drizzle renderer (the seam
 * effect-drizzle-ext / effect-auth-drizzle fill, see the package README →
 * Seams) turns it into SQL, and
 * {@link evaluate} runs it against an in-memory row — which is what lets the
 * unit suite prove the list filter and the row predicate never disagree.
 *
 * `Following` is whatever the follower seam hands the `in` node: a subquery
 * (`SQLWrapper`) for SQL, a set for the in-memory evaluator.
 *
 * Rendering contract a SQL renderer must honour:
 *
 * | node | SQL |
 * | --- | --- |
 * | `always` | no predicate (`undefined` to Drizzle's `.where`) |
 * | `never` | a predicate no row satisfies (the apps: `id = '00000000-…'`) |
 * | `eq` / `ne` | `col = $v` / `col <> $v` |
 * | `in` | `col IN (<following subquery>)` — a subquery, never a materialised array (#1107) |
 * | `published` | `(col IS NOT NULL AND col <= now())` — the database's clock, one per query |
 * | `notPublished` | `(col IS NULL OR col > now())` — parenthesised, so it cannot bind to a surrounding `AND` |
 * | `and` / `or` | `AND` / `OR` over the parts |
 *
 * @copyright Thomas Foster
 * @module pulpit/filter
 */

import * as Array from "effect/Array";
import * as Match from "effect/Match";
import type { ColumnValue } from "./version-chain.ts";

/**
 * A value an `eq` / `ne` node compares against. No `null`: `col = NULL` is
 * never true in SQL, so a null comparison would read differently in the
 * renderer and the evaluator.
 */
export type Scalar = string | number | boolean;

/** A row as {@link evaluate} reads it: the view's columns by name. */
export type FilterRow = { readonly [column: string]: ColumnValue };

/** A read predicate over a current-version view's columns. */
export type ListFilter<Following> =
  | { readonly kind: "always" }
  | { readonly kind: "never" }
  | { readonly kind: "eq"; readonly column: string; readonly value: Scalar }
  | { readonly kind: "ne"; readonly column: string; readonly value: Scalar }
  | { readonly kind: "in"; readonly column: string; readonly set: Following }
  | { readonly kind: "published"; readonly column: string }
  | { readonly kind: "notPublished"; readonly column: string }
  | { readonly kind: "and"; readonly filters: ReadonlyArray<ListFilter<Following>> }
  | { readonly kind: "or"; readonly filters: ReadonlyArray<ListFilter<Following>> };

/** No predicate: every row. */
export const always = { kind: "always" } as const;

/** Fail closed: no row. */
export const never = { kind: "never" } as const;

/** `column = value`. */
export const eq = (column: string, value: Scalar) => ({ kind: "eq", column, value }) as const;

/** `column <> value`. */
export const ne = (column: string, value: Scalar) => ({ kind: "ne", column, value }) as const;

/** `column IN (following)`. */
export const isIn = <Following>(column: string, set: Following) =>
  ({ kind: "in", column, set }) as const;

/** Stamped, and the stamp has arrived. */
export const published = (column: string) => ({ kind: "published", column }) as const;

/** Not out: unstamped, or stamped in the future — the exact complement of {@link published}. */
export const notPublished = (column: string) => ({ kind: "notPublished", column }) as const;

/** No parts → the identity; one part → that part, bare; more → the combined node. */
const collapse = <Following>(
  parts: ReadonlyArray<ListFilter<Following>>,
  identity: ListFilter<Following>,
  combine: (parts: ReadonlyArray<ListFilter<Following>>) => ListFilter<Following>,
): ListFilter<Following> =>
  Array.match(parts, {
    onEmpty: () => identity,
    onNonEmpty: (nonEmpty) =>
      Array.isReadonlyArrayNonEmpty(Array.tailNonEmpty(nonEmpty))
        ? combine(nonEmpty)
        : Array.headNonEmpty(nonEmpty),
  });

/**
 * Conjunction. `always` parts drop out, a `never` part makes the whole
 * `never`, and a single remaining part is returned bare — so composing
 * optional filters reads as one call, the shape the apps' `combine` had.
 */
export const and = <Following>(
  ...filters: ReadonlyArray<ListFilter<Following>>
): ListFilter<Following> => {
  if (filters.some((filter) => filter.kind === "never")) return never;
  return collapse(
    Array.filter(filters, (filter) => filter.kind !== "always"),
    always,
    (parts) => ({ kind: "and", filters: parts }),
  );
};

/**
 * Disjunction. `never` parts drop out, an `always` part makes the whole
 * `always`, and a single remaining part is returned bare.
 */
export const or = <Following>(
  ...filters: ReadonlyArray<ListFilter<Following>>
): ListFilter<Following> => {
  if (filters.some((filter) => filter.kind === "always")) return always;
  return collapse(
    Array.filter(filters, (filter) => filter.kind !== "never"),
    never,
    (parts) => ({ kind: "or", filters: parts }),
  );
};

/** What {@link evaluate} needs besides the row: the query's clock and the `in` test. */
export interface EvaluationContext<Following> {
  /** The instant `published` / `notPublished` compare against — the query's `now()`. */
  readonly now: Date;
  /** Whether `value` is a member of the follower seam's `set`. */
  readonly contains: (set: Following, value: ColumnValue) => boolean;
}

/** Read a timestamp column the way the publication axis does: a `Date`, or nothing. */
const instantOf = (value: ColumnValue): number =>
  value instanceof Date ? value.getTime() : Number.NaN;

/**
 * Run a filter against one row — the in-memory reading of the rendering
 * contract above. A column the row lacks matches no `eq`, satisfies every
 * `ne`, and is unpublished.
 */
export const evaluate = <Following>(
  filter: ListFilter<Following>,
  row: FilterRow,
  context: EvaluationContext<Following>,
): boolean => {
  const arrived = (column: string) => instantOf(row[column] ?? null) <= context.now.getTime();
  return Match.value(filter).pipe(
    Match.discriminatorsExhaustive("kind")({
      always: () => true,
      never: () => false,
      eq: (node) => row[node.column] === node.value,
      ne: (node) => row[node.column] !== node.value,
      in: (node) => context.contains(node.set, row[node.column] ?? null),
      published: (node) => arrived(node.column),
      notPublished: (node) => !arrived(node.column),
      and: (node) => node.filters.every((part) => evaluate(part, row, context)),
      or: (node) => node.filters.some((part) => evaluate(part, row, context)),
    }),
  );
};
