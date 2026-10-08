/**
 * An in-memory {@link DocumentStore}: the reference semantics of the seam, and
 * the fake the unit suites run against.
 *
 * It implements the hash contract in the package README → Seams exactly, so
 * that its hashes are the ones a Postgres store produces: SHA-256 over the
 * UTF-8 bytes of the document's canonical text, which is PostgreSQL's `jsonb`
 * text output ({@link canonicalText}). `tests/documents.test.ts` pins it to
 * vectors taken from Postgres. Like a store's primary key on the hash, it
 * keeps the first document stored at a hash and never replaces it.
 *
 * @module tests/in-memory-documents
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import type { DocumentHash, DocumentStore } from "../src/documents.ts";

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
 * The canonical text of a JSON document: PostgreSQL's `jsonb` text output —
 * object keys ordered by {@link keyOrder}, `": "` after a key, `", "` between
 * members and elements, numbers by {@link numericText}.
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

/** SHA-256 over the canonical text's UTF-8 bytes, as 64 lowercase hex characters. */
const hashOf = (document: Schema.Json): Effect.Effect<DocumentHash> =>
  Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", utf8.encode(canonicalText(document))),
  ).pipe(
    // Web Crypto's SHA-256 over bytes has no failure a test could act on.
    Effect.orDie,
    Effect.map((digest) =>
      Arr.map(Arr.fromIterable(new Uint8Array(digest)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

export interface InMemoryDocumentStore<Document extends Schema.Json> extends DocumentStore<
  Document,
  never,
  never
> {
  /** Every stored document by hash — what the never-rewritten assertions read. */
  readonly stored: () => HashMap.HashMap<DocumentHash, Document>;
  /**
   * How many times `put` wrote a row: a real insert counts, a no-op `put` of a
   * stored hash does not. The never-rewritten assertions read it, because
   * `HashMap.set` with a structurally equal value is indistinguishable from no
   * write in {@link stored}.
   */
  readonly writes: () => number;
}

export const makeInMemoryDocumentStore = <
  Document extends Schema.Json,
>(): InMemoryDocumentStore<Document> => {
  let documents = HashMap.empty<DocumentHash, Document>();
  let writes = 0;
  return {
    put: (document) =>
      Effect.map(hashOf(document), (hash) => {
        // `ON CONFLICT DO NOTHING`: the first document at a hash is kept.
        if (!HashMap.has(documents, hash)) {
          documents = HashMap.set(documents, hash, document);
          writes += 1;
        }
        return hash;
      }),
    get: (hash) => Effect.sync(() => HashMap.get(documents, hash)),
    getMany: (hashes) =>
      Effect.sync(() => HashMap.filter(documents, (_document, hash) => hashes.includes(hash))),
    stored: () => documents,
    writes: () => writes,
  };
};
