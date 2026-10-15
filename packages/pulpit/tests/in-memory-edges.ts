/**
 * An in-memory {@link EdgeStore}: the reference semantics of the seam, and
 * the fake the edge suites run against. Plus an in-memory {@link EndpointView}
 * whose nodes a test sets directly.
 *
 * It enforces what an edge table's schema enforces — the family's unique key
 * (with `NULLS NOT DISTINCT`, as gardeneria's `page_slugs_unique_variant`)
 * — and nothing the operations are responsible for. `list` joins each end's
 * view the way the SQL store's INNER JOIN does: under the end's alias, and
 * dropping an edge whose end has no row — and reports the unpaged total as
 * the SQL store's window column does (README → Seams).
 *
 * @module tests/in-memory-edges
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import {
  endpointColumn,
  type EdgeEnds,
  type EdgeRow,
  type EdgeStore,
  type EdgeValues,
  type EndpointView,
} from "../src/edges.ts";
import { evaluate, type FilterRow, type ListFilter } from "../src/filter.ts";
import type { LeafRow } from "../src/subtype.ts";
import type { ColumnValue } from "../src/version-chain.ts";
import { NOW } from "./in-memory-leaves.ts";

/** The follower seam's set-shaped answer in the edge suites. */
export type Following = HashSet.HashSet<string>;

const context = {
  now: NOW,
  contains: (set: Following, value: ColumnValue) =>
    Predicate.isString(value) && HashSet.has(set, value),
};

/** An endpoint view a test writes nodes into directly. */
export interface InMemoryNodes extends EndpointView<never, never> {
  /** Store (or replace) a node's current-version row. */
  readonly put: (row: LeafRow) => void;
}

export const makeInMemoryNodes = (columns: ReadonlyArray<string>): InMemoryNodes => {
  let nodes = HashMap.empty<string, LeafRow>();
  return {
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- the seam's column set is a `ReadonlySet`, the type `LeafStore.columns` already has, so a `LeafStore` satisfies `EndpointView`
    columns: new Set(["id", "action", ...columns]),
    get: (id) => Effect.sync(() => HashMap.get(nodes, id)),
    put: (row) => {
      nodes = HashMap.set(nodes, row.id, row);
    },
  };
};

export interface InMemoryEdgeStore extends EdgeStore<EdgeRow, Following, never, never> {
  /** Every stored edge, hidden ones included, in insertion order. */
  readonly rows: () => ReadonlyArray<EdgeRow>;
  /**
   * Simulate a concurrent writer: the next insert finds its unique key just
   * taken by `winner`, which is stored in its place (the racing writer's
   * values, which share the key and may differ elsewhere).
   */
  readonly raceNextInsert: (winner: EdgeValues) => void;
}

/** Two column values the unique key treats as equal: `NULLS NOT DISTINCT`, an absent key read as `NULL`. */
const sameKey = (row: EdgeRow, values: EdgeValues, column: string): boolean =>
  (row[column] ?? null) === (values[column] ?? null);

const byCreation = Order.combine(
  Order.mapInput(Order.Date, (row: EdgeRow) => row.createdAt),
  Order.mapInput(Order.String, (row: EdgeRow) => row.id),
);

export const makeInMemoryEdgeStore = (options: {
  /** The ends the list joins, by alias (the family declaration's `ends`). */
  readonly ends: EdgeEnds<never, never>;
  /** The unique key's columns; empty for a family with none. */
  readonly uniqueKey: ReadonlyArray<string>;
}): InMemoryEdgeStore => {
  let stored: ReadonlyArray<EdgeRow> = [];
  let minted = 0;
  let race = Option.none<EdgeValues>();

  const collides = (values: EdgeValues) =>
    Arr.findFirst(
      stored,
      (row) =>
        Arr.isReadonlyArrayNonEmpty(options.uniqueKey) &&
        options.uniqueKey.every((column) => sameKey(row, values, column)),
    );

  const write = (values: EdgeValues): string => {
    minted += 1;
    const id = `edge-${String(minted).padStart(4, "0")}`;
    // Creation instants one millisecond apart, except every third shares its
    // predecessor's, so the `id` tie-break is exercised.
    const createdAt = DateTime.toDate(
      DateTime.makeUnsafe(NOW.getTime() + minted - (minted % 3 === 0 ? 1 : 0)),
    );
    stored = [...stored, { ...values, id, createdAt }];
    return id;
  };

  /** The edge joined with each end's node under its alias, or none when an end has no row (INNER JOIN). */
  const joined = (row: EdgeRow): Effect.Effect<Option.Option<FilterRow>> =>
    Effect.map(
      Effect.forEach(
        Record.toEntries(options.ends),
        ([alias, end]) => {
          const nodeId = row[end.column];
          return Predicate.isString(nodeId)
            ? Effect.map(
                end.nodes.get(nodeId),
                Option.map((node) =>
                  Record.mapKeys(node, (column): string => endpointColumn(alias, column)),
                ),
              )
            : Effect.succeedNone;
        },
        { concurrency: 1 },
      ),
      (nodes) =>
        Option.map(
          Option.all(nodes),
          Arr.reduce<FilterRow, FilterRow>(row, (acc, node) => ({ ...acc, ...node })),
        ),
    );

  /** The stored edges whose join satisfies `where`, in the list's total order. */
  const matching = (where: ListFilter<Following>) =>
    Effect.filter(Arr.sort(stored, byCreation), (row) =>
      Effect.map(
        joined(row),
        Option.exists((present) => evaluate(where, present, context)),
      ),
    );

  return {
    get: (id) => Effect.sync(() => Arr.findFirst(stored, (row) => row.id === id)),
    // The total as the SQL store's window column reads it: every matching
    // row when the page has one, and 0 for an empty page (past the end too).
    list: ({ where, limit, offset }) =>
      Effect.map(matching(where), (rows) => {
        const page = rows.slice(offset, offset + limit);
        return { rows: page, total: Arr.isReadonlyArrayNonEmpty(page) ? rows.length : 0 };
      }),
    // The count over the list's joins, as the SQL store's `count(*)` reads
    // them: the edges at the node that satisfy `where`.
    countAt: ({ column, nodeId, where }) =>
      Effect.map(matching(where), (rows) => rows.filter((row) => row[column] === nodeId).length),
    existing: (values) => Effect.sync(() => Option.map(collides(values), (row) => row.id)),
    insert: (values) =>
      Effect.sync(() => {
        if (Option.isSome(race)) {
          write(race.value);
          race = Option.none();
          return Option.none();
        }
        return Option.isSome(collides(values)) ? Option.none() : Option.some(write(values));
      }),
    delete: (id) =>
      Effect.sync(() => {
        const before = stored.length;
        stored = stored.filter((row) => row.id !== id);
        return stored.length < before;
      }),
    rows: () => stored,
    raceNextInsert: (winner) => {
      race = Option.some(winner);
    },
  };
};
