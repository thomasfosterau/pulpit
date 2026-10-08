/**
 * The package README's Taxonomies example (README → `./edges` →
 * Taxonomies), type-checked by the package's `check` task (`tsconfig.json`
 * includes `tests/`). Nothing checks the README's copy itself, so change the
 * two together. The code below is the README's with two changes: the import
 * specifiers name the sources rather than `@thomasfosterau/pulpit/<subpath>`,
 * and each binding is exported, so `noUnusedLocals` can't reject it.
 *
 * @module tests/edges.types
 */

import type * as Effect from "effect/Effect";
import { defineEdgeOps, type EdgeRow, type EdgeStore } from "../src/edges.ts";
import { eq } from "../src/filter.ts";
import {
  ownedAccess,
  requireWriter,
  type AccessPolicy,
  type FollowerSeam,
  type LeafRow,
  type LeafStore,
  type Viewer,
} from "../src/subtype.ts";

export const assignments = <Following, E, R>(seams: {
  readonly terms: LeafStore<LeafRow, Following, E, R>;
  readonly notes: LeafStore<LeafRow, Following, E, R>;
  readonly edges: EdgeStore<EdgeRow, Following, E, R>;
  readonly viewer: Effect.Effect<Viewer, never, R>;
  readonly policy: AccessPolicy;
  readonly followers: FollowerSeam<Following, R>;
}) =>
  defineEdgeOps({
    type: "note-terms",
    ends: {
      term: { column: "termId", type: "terms", access: { kind: "reference" }, nodes: seams.terms },
      note: {
        column: "noteId",
        type: "notes",
        access: ownedAccess({ draft: true }),
        nodes: seams.notes,
        maxEdges: 10, // at most ten terms on one note
      },
    },
    edges: seams.edges,
    viewer: seams.viewer,
    policy: seams.policy,
    followers: seams.followers,
    values: (input: { readonly termId: string; readonly noteId: string }) => ({ ...input }),
    toResource: (row) => ({ id: row.id, termId: row["termId"], noteId: row["noteId"] }),
    onConflict: "ignore",
    // A member classifies their own notes; a moderator anyone's.
    writeGate: ({ viewer, policy, edge }) => {
      const noteId = String(edge["noteId"]);
      return requireWriter(
        ownedAccess(),
        viewer,
        policy,
        { type: "notes", id: noteId },
        seams.notes.ownerOf(noteId),
      );
    },
  });

// A note's terms: the edges at one end, without any the viewer can't read.
export const termsOf = <Following, E, R>(
  ops: ReturnType<typeof assignments<Following, E, R>>,
  noteId: string,
) => ops.list({ limit: 50, offset: 0, where: eq("noteId", noteId) });
