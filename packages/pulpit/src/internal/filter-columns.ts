/**
 * **A list filter's columns, renamed**: `./edges` qualifies a leaf's filter
 * with an end's alias through it, so a store can render that filter against
 * the view it joined under the alias.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Match from "effect/Match";
import type { ListFilter } from "../filter.ts";

/**
 * Every column of `filter` rewritten by `rename`; the tree's shape and every
 * comparand are kept. Exhaustive over the node kinds, so a new kind cannot
 * slip through with its column unrenamed.
 */
export const renameColumns = <Following>(
  filter: ListFilter<Following>,
  rename: (column: string) => string,
): ListFilter<Following> =>
  Match.value(filter).pipe(
    Match.discriminatorsExhaustive("kind")({
      always: (node): ListFilter<Following> => node,
      never: (node): ListFilter<Following> => node,
      eq: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      ne: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      in: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      notIn: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      gt: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      gte: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      lt: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      lte: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      anyOf: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      noneOf: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      isNull: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      published: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      notPublished: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      locale: (node): ListFilter<Following> => ({ ...node, column: rename(node.column) }),
      and: (node): ListFilter<Following> => ({
        kind: "and",
        filters: node.filters.map((part) => renameColumns(part, rename)),
      }),
      or: (node): ListFilter<Following> => ({
        kind: "or",
        filters: node.filters.map((part) => renameColumns(part, rename)),
      }),
    }),
  );
