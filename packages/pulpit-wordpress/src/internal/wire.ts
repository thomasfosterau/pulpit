/**
 * The WordPress REST wire's own vocabulary, checked against
 * `WordPress/wordpress-develop` trunk at `9063498`
 * (`rest-api/endpoints/class-wp-rest-{posts,controller}.php`,
 * `class-wp-rest-server.php`): the error envelope, the date format, the
 * query string's list parameters, the `Link` header and `_fields`. Internal:
 * the `./api` module is its only reader.
 *
 * @internal
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// ── Errors ────────────────────────────────────────────────────────────

/**
 * A WordPress REST error, answered as `{ code, message, data: { status } }`
 * (plus `data.params` for `rest_invalid_param`), as `WP_REST_Server` does.
 */
export class WpRestError extends Schema.TaggedError<WpRestError>()("WpRestError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}) {}

/** `rest_no_route` (404): no GET route matches. */
export const noRoute = (): WpRestError =>
  new WpRestError({
    code: "rest_no_route",
    message: "No route was found matching the URL and request method.",
    status: 404,
  });

/** `rest_invalid_param` (400), naming each bad parameter. */
export const invalidParams = (params: Readonly<Record<string, string>>): WpRestError =>
  new WpRestError({
    code: "rest_invalid_param",
    message: `Invalid parameter(s): ${Record.keys(params).join(", ")}`,
    status: 400,
    params,
  });

/** The 401 an anonymous caller gets, the 403 a signed-in one does (`rest_authorization_required_code`). */
export const authorizationStatus = (signedIn: boolean): number => (signedIn ? 403 : 401);

/** The error's response body. */
export const errorBody = (error: WpRestError): Schema.JsonObject => ({
  code: error.code,
  message: error.message,
  data:
    error.params === undefined
      ? { status: error.status }
      : { status: error.status, params: error.params, details: {} },
});

// ── Dates ─────────────────────────────────────────────────────────────

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

const formatParts = (parts: DateTime.DateTime.Parts): string =>
  `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;

/** WordPress's `date`: the site's wall-clock time, `YYYY-MM-DDTHH:MM:SS`, with no offset. */
export const formatLocal = (date: Date, timeZone: string): string =>
  formatParts(DateTime.toParts(DateTime.makeZonedUnsafe(date, { timeZone })));

/** WordPress's `date_gmt`: UTC, `YYYY-MM-DDTHH:MM:SS`. */
export const formatGmt = (date: Date): string =>
  formatParts(DateTime.toPartsUtc(DateTime.makeUnsafe(date)));

/** The site's UTC offset now, in hours, as WordPress's `gmt_offset` string. */
export const gmtOffset = (now: Date, timeZone: string): string =>
  String(DateTime.zonedOffset(DateTime.makeZonedUnsafe(now, { timeZone })) / 3_600_000);

const offsetSuffix = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const dateTimeSyntax = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A `date-time` query value (`after`, `before`, …), as `rest_parse_date`
 * reads it: RFC 3339, its offset optional, and a value without one is the
 * site's wall-clock time. None when it is no such value.
 */
export const parseDateTime = (value: string, timeZone: string): Option.Option<Date> => {
  if (!dateTimeSyntax.test(value)) return Option.none();
  return offsetSuffix.test(value)
    ? Option.map(DateTime.make(value), DateTime.toDateUtc)
    : Option.map(
        DateTime.makeZoned(`${value}Z`, { timeZone, adjustForTimeZone: true }),
        DateTime.toDateUtc,
      );
};

// ── The query string ──────────────────────────────────────────────────

/**
 * A request's query, as WordPress reads it: a key spelled `name[]` adds to a
 * list, a repeated plain key keeps its last value, and a list parameter also
 * splits a plain value on commas (`include=1,2`, `wp_parse_list`).
 */
export interface Query {
  /** The last value of a scalar parameter. */
  readonly scalar: (name: string) => Option.Option<string>;
  /** Every value of a list parameter, comma lists split; none when absent. */
  readonly list: (name: string) => Option.Option<ReadonlyArray<string>>;
  /** The parameters present, by name (`[]` dropped). */
  readonly names: ReadonlyArray<string>;
  /** The query as given, for the collection's `Link` headers. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
}

/** Read a query string's pairs as {@link Query}. */
export const readQuery = (pairs: ReadonlyArray<readonly [string, string]>): Query => {
  const bare = (key: string) => (key.endsWith("[]") ? key.slice(0, -2) : key);
  const valuesOf = (name: string) =>
    Arr.filter(pairs, ([key]) => bare(key) === name).map(([key, value]) => ({
      listed: key.endsWith("[]"),
      value,
    }));
  return {
    scalar: (name) => Option.map(Arr.last(valuesOf(name)), ({ value }) => value),
    list: (name) => {
      const values = valuesOf(name);
      if (!Arr.isReadonlyArrayNonEmpty(values)) return Option.none();
      return Option.some(
        Arr.flatMap(values, ({ listed, value }) =>
          listed ? [value] : Arr.filter(value.split(","), (part) => part.trim() !== ""),
        ).map((value) => value.trim()),
      );
    },
    names: Arr.dedupe(pairs.map(([key]) => bare(key))),
    pairs,
  };
};

/** `href` with `pairs` as its query, each value encoded, and `page` set (WordPress's `add_query_arg`). */
export const withQuery = (
  href: string,
  pairs: ReadonlyArray<readonly [string, string]>,
  page: Option.Option<number>,
): string => {
  const kept = Option.match(page, {
    onNone: () => pairs,
    onSome: (value) => [
      ...Arr.filter(pairs, ([key]) => key !== "page"),
      ["page", String(value)] as const,
    ],
  });
  if (!Arr.isReadonlyArrayNonEmpty(kept)) return href;
  return `${href}?${kept.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
};

/** One `Link` header value: `<href>; rel="rel"`. */
export const linkValue = (href: string, rel: string): string => `<${href}>; rel="${rel}"`;

// ── `_fields` ─────────────────────────────────────────────────────────

/** A requested-field tree: a leaf keeps a whole value, a node keeps the listed sub-fields. */
export interface FieldTree {
  readonly [key: string]: FieldTree | true;
}

const addPath = (tree: FieldTree, path: ReadonlyArray<string>): FieldTree => {
  const [head, ...rest] = path;
  if (head === undefined) return tree;
  const current = tree[head];
  if (current === true) return tree;
  const next: FieldTree | true = Arr.isReadonlyArrayNonEmpty(rest)
    ? addPath(current ?? {}, rest)
    : true;
  return { ...tree, [head]: next };
};

/** The `_fields` request (`title.rendered,id`) as a tree. */
export const fieldTree = (fields: ReadonlyArray<string>): FieldTree =>
  Arr.reduce(fields, {}, (tree: FieldTree, field) => addPath(tree, field.split(".")));

/** A JSON object: not `null`, not an array, not a scalar. */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** Keep only the requested fields of a response object, as `rest_filter_response_fields` does. */
export const projectFields = (value: Schema.Json, tree: FieldTree): Schema.Json => {
  if (!isJsonObject(value)) return value;
  const source = value;
  return Record.fromEntries(
    Arr.flatMap(Record.toEntries(tree), ([key, sub]) => {
      const field = source[key];
      if (field === undefined) return [];
      return [[key, sub === true ? field : projectFields(field, sub)] as const];
    }),
  );
};
