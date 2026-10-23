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
 *   restores the reference, never a copy. Only erasure (`./purge`) deletes a
 *   document, once no version of any node references its hash.
 *
 * ## The seam
 *
 * Hashing is the store's job, not the kernel's: the apps derive the hash in
 * Postgres and never re-derive it in JavaScript. The algorithm and the
 * canonical serialisation a store must use are stated in the package README →
 * Seams; {@link canonicalText} is that serialisation in JavaScript, for a
 * store that doesn't run on Postgres. The kernel itself never hashes. The
 * document type is a parameter; its schema and validation are the
 * application's (prosekit-utilities), and pulpit never imports them.
 *
 * @copyright Thomas Foster
 * @module pulpit/documents
 * @since 0.1.0
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as HashMap from "effect/HashMap";
import type * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
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
 * What {@link DocumentStore.put} returns: the document's hash, and whether
 * this call inserted it (`false` for a document already stored).
 *
 * @since 0.1.0
 */
export interface DocumentPut {
  readonly hash: DocumentHash;
  readonly inserted: boolean;
}

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
   * (`INSERT … ON CONFLICT DO NOTHING RETURNING`, then the hash), with
   * `inserted: true` only when this call wrote the row (the `RETURNING`
   * gave one back). Idempotent: a document already stored, or one equal to
   * it under the canonical serialisation, writes nothing and returns the
   * same hash with `inserted: false`. The hash is the store's to derive
   * (README → Seams).
   */
  readonly put: (document: Document) => Effect.Effect<DocumentPut, E, R>;
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

// ── The first-insert event ────────────────────────────────────────────

/**
 * What an {@link onDocumentInsert} hook is shown: a document this `put`
 * stored for the first time, and its hash.
 *
 * @since 0.1.0
 */
export interface DocumentInserted<Document> {
  readonly hash: DocumentHash;
  readonly document: Document;
}

/**
 * The document store with a first-insert hook: its `put` runs `hook` after
 * a `put` that inserted (`inserted: true`), and never after one that found
 * the document already stored, so the hook runs once per document (an
 * embedding job, in the apps). The hook runs in the `put`'s own
 * transaction, so a failure (the store's `E`) fails the `put` and rolls
 * the insert back with the caller's transaction; enqueue durable work as a
 * row the same transaction writes (an outbox). `get` and `getMany` are the
 * store's own.
 *
 * @example
 * ```ts
 * import { deepStrictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import { onDocumentInsert } from "@thomasfosterau/pulpit/documents";
 * import { makeInMemoryDocumentStore } from "@thomasfosterau/pulpit/testing";
 *
 * const inserted: Array<string> = [];
 * const store = onDocumentInsert(makeInMemoryDocumentStore<{ readonly text: string }>(), (event) =>
 *   Effect.sync(() => {
 *     inserted.push(event.document.text);
 *   }),
 * );
 * await Effect.runPromise(Effect.andThen(store.put({ text: "hello" }), store.put({ text: "hello" })));
 * deepStrictEqual(inserted, ["hello"]);
 * ```
 *
 * @since 0.1.0
 */
export const onDocumentInsert = <Document, E, R>(
  store: DocumentStore<Document, E, R>,
  hook: (event: DocumentInserted<Document>) => Effect.Effect<void, E, R>,
): DocumentStore<Document, E, R> => ({
  ...store,
  put: (document) =>
    Effect.tap(store.put(document), ({ hash, inserted }) =>
      inserted ? hook({ hash, document }) : Effect.void,
    ),
});

// ── The hash contract ─────────────────────────────────────────────────

const utf8 = new TextEncoder();

/** A string's UTF-8 bytes as one character per byte, so that string order is byte order. */
const byteString = (value: string): string => String.fromCharCode(...utf8.encode(value));

/** jsonb's key order: shorter UTF-8 byte length first, then bytewise. */
const keyOrder: Order.Order<string> = Order.combine(
  Order.mapInput(Order.Number, (key: string) => utf8.encode(key).length),
  Order.mapInput(Order.String, byteString),
);

/**
 * A number as Postgres `numeric` prints it: JavaScript's shortest round-trip
 * digits, written positionally (`1e+21` → `1000000000000000000000`,
 * `1.5e-7` → `0.00000015`), since `numeric` has no exponent form.
 */
const numericText = (value: number): string => {
  const shortest = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
  if (match === null) return shortest;
  const [, sign = "", lead = "", fraction = "", exponent = "0"] = match;
  const digits = lead + fraction;
  const point = 1 + Number(exponent);
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** The short escapes jsonb's `escape_json` writes; every other control character is `\u00xx`. */
const SHORT_ESCAPES: Record.ReadonlyRecord<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** One character as jsonb's `escape_json` writes it: a short escape, `\u00xx` below U+0020, else itself. */
const escapeCharacter = (character: string): string => {
  const code = character.charCodeAt(0);
  return (
    SHORT_ESCAPES[character] ??
    (code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character)
  );
};

/** A string literal as jsonb prints it: `"`, `\` and the control characters escaped, nothing else. */
const stringText = (value: string): string =>
  `"${Arr.map(Arr.fromIterable(value), escapeCharacter).join("")}"`;

/**
 * The canonical text of a JSON document, the bytes the {@link DocumentStore}
 * hash contract (README → Seams → `DocumentStore`) takes SHA-256 over:
 * PostgreSQL's `jsonb` text output, with object keys ordered shorter-first by
 * UTF-8 byte length and then bytewise, `": "` after a key, `", "` between
 * members and elements, only `"`, `\` and the control characters escaped, and
 * numbers as `numeric` prints them (never with an exponent). A Postgres store
 * never needs it (the database derives the hash from `document_jsonb::text`);
 * a store that doesn't run on Postgres hashes the UTF-8 bytes of this text to
 * reproduce the contract's hashes. The kernel's suite pins it to text and
 * hashes taken from Postgres. Pure and total.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { canonicalText } from "@thomasfosterau/pulpit/documents";
 *
 * strictEqual(
 *   canonicalText({ b: 1e21, aa: [true, null], a: "é" }),
 *   '{"a": "é", "b": 1000000000000000000000, "aa": [true, null]}',
 * );
 * ```
 *
 * @since 0.1.0
 */
export const canonicalText = (value: Schema.Json): string => {
  if (value === null) return "null";
  if (Predicate.isBoolean(value)) return value ? "true" : "false";
  if (Predicate.isNumber(value)) return numericText(value);
  if (Predicate.isString(value)) return stringText(value);
  if (Arr.isArray<Schema.Json>(value)) return `[${value.map(canonicalText).join(", ")}]`;
  const members = Arr.sort(
    Record.toEntries(value),
    Order.mapInput(keyOrder, ([key]: readonly [string, Schema.Json]) => key),
  );
  return `{${members.map(([key, member]) => `${stringText(key)}: ${canonicalText(member)}`).join(", ")}}`;
};

// ── The field spread ──────────────────────────────────────────────────

/**
 * The attribute spread for a version row's document reference: `key` carries
 * the {@link DocumentHash} a {@link DocumentStore} returned from `put` (its `hash`).
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
