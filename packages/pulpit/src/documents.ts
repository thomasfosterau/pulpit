/**
 * **Content-addressed documents** — the store seam a version row's document
 * reference resolves through, the hash it is keyed by, and the field spread
 * that carries the reference.
 *
 * A document (a ProseKit tree, in the apps) is stored once, keyed by a hash of
 * its content, and a version row carries the hash rather than another full
 * copy. Under an append-only chain that matters: history is never pruned
 * (`VERSION-CHAIN-001`), so without content addressing every version of a long
 * document would store the whole document again. The behavioural spec is
 * `packages/database/src/documents.ts` in gardeneria and website (the
 * `inline_documents` / `block_documents` writers) and the generated `hash_id`
 * column of those tables.
 *
 * ## The invariant
 *
 * - **A stored document is never rewritten** (`DOC-001`). `put` stores a
 *   document only when its hash is unseen and otherwise writes nothing; a
 *   changed document is a new hash. So a hash a version row recorded always
 *   reads back the exact document it was written with, and `restoreVersion`
 *   restores the reference, never a copy.
 *
 * ## The seam
 *
 * Hashing is the store's job, not the kernel's: the apps derive the hash in
 * Postgres and never re-derive it in JavaScript. The algorithm and the
 * canonical serialisation a store must use are stated in the package README →
 * Seams. The document type is a parameter; its schema and validation are the
 * application's (prosekit-utilities), and pulpit never imports them.
 *
 * @copyright Thomas Foster
 * @module pulpit/documents
 * @since 0.1.0
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import type * as Effect from "effect/Effect";
import type * as HashMap from "effect/HashMap";
import type * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * A document's content hash as the kernel exchanges it: the 32-byte SHA-256
 * digest as 64 lowercase hexadecimal characters (what gardeneria's
 * `byteaToHex` renders a `bytea` hash as). A Postgres store keeps the 32 bytes
 * in a `bytea` column and converts at its edge. The algorithm and the bytes it
 * is taken over are the contract in the package README → Seams.
 *
 * @since 0.1.0
 */
export const DocumentHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/, {
    description: "a SHA-256 document hash as 64 lowercase hexadecimal characters",
  }),
);
/**
 * The {@link DocumentHash} string: 64 lowercase hexadecimal characters.
 *
 * @since 0.1.0
 */
export type DocumentHash = typeof DocumentHash.Type;

// ── The seam ──────────────────────────────────────────────────────────

/**
 * The content-addressed document store an application supplies (in
 * production, a table per document family, keyed by the hash). `Document`
 * is the application's document type; `E` is the store's own failure and `R`
 * its requirements (a Drizzle store's `EffectDrizzleQueryError` and
 * `CurrentTransaction`: like the chain store, it never opens a transaction).
 *
 * Every method fails only with the store's `E`, and applies no policy: a
 * document is validated against the application's schema before it reaches
 * `put`. Honours `DOC-001`: `put` never rewrites a stored document.
 *
 * @since 0.1.0
 */
export interface DocumentStore<Document, E, R> {
  /**
   * Store `document` if its hash is unseen and return the hash either way
   * (`INSERT … ON CONFLICT DO NOTHING`, then the hash). Idempotent: a
   * document already stored, or one equal to it under the canonical
   * serialisation, writes nothing and returns the same hash. The hash is the
   * store's to derive (README → Seams).
   */
  readonly put: (document: Document) => Effect.Effect<DocumentHash, E, R>;
  /** The document stored at `hash`, or none. */
  readonly get: (hash: DocumentHash) => Effect.Effect<Option.Option<Document>, E, R>;
  /**
   * One `hash = ANY($hashes)` read, never `hashes.length` sequential gets: the
   * documents found, keyed by hash. A hash with no document is absent from
   * the map.
   */
  readonly getMany: (
    hashes: ReadonlyArray<DocumentHash>,
  ) => Effect.Effect<HashMap.HashMap<DocumentHash, Document>, E, R>;
}

// ── The field spread ──────────────────────────────────────────────────

/**
 * The attribute spread for a version row's document reference: `key` carries
 * the {@link DocumentHash} a {@link DocumentStore} returned from `put`.
 * Required on the resource and at create; optional at update, where an absent
 * key carries the previous version's reference forward (the tri-state rule),
 * and never cleared. Spread into a leaf's `Resource.make({ attributes })`,
 * once per document column (`...documentRef("title")`,
 * `...documentRef("body")`).
 *
 * A document the leaf may omit is declared directly, as
 * `Resource.attribute(Schema.NullOr(DocumentHash), { create: "optional" })`,
 * so that `null` clears it.
 *
 * @since 0.1.0
 */
export const documentRef = <const Key extends string>(key: Key) =>
  Record.singleton(key, Resource.attribute(DocumentHash));
