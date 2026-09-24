/**
 * An in-memory {@link VersionChainStore}: the reference semantics of the
 * seam, and the fake the unit suites run the chain operations against.
 *
 * It enforces what the Drizzle store's schema enforces — the `(id, version)`
 * primary key (a taken pair fails `VersionConflict`) — and nothing the
 * operations are responsible for. `dropState` simulates a partial chain (a
 * level with no row at a version), which a real database reaches through a
 * missing leaf row and the fake reaches by deleting the stored state.
 *
 * @module tests/in-memory-chain
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  VersionConflict,
  type VersionChainEntry,
  type VersionChainStore,
  type VersionRow,
  type VersionSnapshot,
} from "../src/version-chain.ts";

export interface InMemoryChainStore extends VersionChainStore<never, never> {
  /** Every row ever appended, in append order — what the append-only assertions read. */
  readonly rows: () => ReadonlyArray<VersionRow>;
  /** Simulate a partial chain: the state at `(id, version)` is no longer reconstructable. */
  readonly dropState: (id: string, version: bigint) => void;
  /** Simulate a concurrent writer: the next append for `id` finds its version taken. */
  readonly raceNextAppend: (id: string) => void;
}

export const makeInMemoryChainStore = (): InMemoryChainStore => {
  const log: Array<VersionRow> = [];
  const dropped = new Set<string>();
  const raced = new Set<string>();
  let minted = 0;
  const key = (id: string, version: bigint) => `${id}@${version}`;
  const chain = (id: string) => log.filter((row) => row.id === id);

  const entryOf = (row: VersionRow): VersionChainEntry => ({
    version: row.version,
    action: row.action,
    timestamp: row.timestamp,
  });

  return {
    head: (id) =>
      Effect.sync(() => {
        const rows = chain(id);
        return rows.length === 0 ? Option.none() : Option.some(entryOf(rows[rows.length - 1]!));
      }),
    snapshot: (id, version) =>
      Effect.sync(() => {
        if (dropped.has(key(id, version))) return Option.none();
        const row = chain(id).find((candidate) => candidate.version === version);
        if (row === undefined) return Option.none();
        const snapshot: VersionSnapshot = { ...entryOf(row), state: row.state };
        return Option.some(snapshot);
      }),
    append: (row) =>
      Effect.suspend(() => {
        if (raced.delete(row.id) || chain(row.id).some((taken) => taken.version === row.version)) {
          return Effect.fail(new VersionConflict({ id: row.id, version: row.version }));
        }
        log.push(row);
        return Effect.void;
      }),
    entries: (id, limit) => Effect.sync(() => chain(id).slice(0, limit).map(entryOf)),
    mintId: Effect.sync(() => {
      minted += 1;
      return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
    }),
    rows: () => [...log],
    dropState: (id, version) => void dropped.add(key(id, version)),
    raceNextAppend: (id) => void raced.add(id),
  };
};
