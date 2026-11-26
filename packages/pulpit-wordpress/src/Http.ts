/**
 * **The `effect/http` adapter** — a `wp/v2` read API ({@link WordPressApi})
 * as an `HttpRouter` route under the API's prefix ({@link wordPressRoutes}),
 * or as the bare `HttpServerRequest` → `HttpServerResponse` effect it serves
 * ({@link wordPressHttp}).
 *
 * `./Api` is framework-free: it reads a method, a path and the query pairs,
 * and answers a status, headers and a JSON body. It keeps its own dispatch,
 * because which routes exist and what an id may look like depend on the
 * bindings, and every miss under the prefix must answer WordPress's
 * `rest_no_route` envelope. This module is the one place that reads
 * `effect/http`.
 *
 * The module guide: https://github.com/thomasfosterau/pulpit/blob/trunk/docs/wordpress.md#http.
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress/http
 * @since 0.1.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { WordPressApi } from "./Api.ts";

/**
 * Serve the request in context through `api`: its path and query are read
 * from the request URL, and the answer becomes a JSON response (an empty one
 * for `HEAD`) with the API's status and headers. Never fails: every error is
 * already a WordPress error response ({@link WordPressApi.handle}).
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import * as HttpServerRequest from "effect/http/HttpServerRequest";
 * import { defineWordPress } from "@thomasfosterau/pulpit-wordpress/Api";
 * import { wordPressHttp } from "@thomasfosterau/pulpit-wordpress/Http";
 * import { stringIds } from "@thomasfosterau/pulpit-wordpress/Ids";
 *
 * const api = defineWordPress({
 *   site: { url: "https://example.org", name: "Example", description: "", timezone: "UTC" },
 *   ids: stringIds(),
 *   viewer: Effect.succeed(Option.none()),
 *   policy: {
 *     canViewPrivate: () => false,
 *     canViewDeleted: () => false,
 *     canModerate: () => false,
 *     canWriteCorpus: () => false,
 *   },
 *   render: (requests) => Effect.succeed(requests.map(({ value }) => String(value))),
 *   link: (_, fields) => `https://example.org/${fields.slug}`,
 *   types: {},
 *   authors: { ids: stringIds(), getMany: () => Effect.succeed(HashMap.empty()) },
 * });
 * const request = HttpServerRequest.fromWeb(new Request("https://example.org/wp-json/"));
 * const response = Effect.runSync(
 *   Effect.provideService(wordPressHttp(api), HttpServerRequest.HttpServerRequest, request),
 * );
 * strictEqual(response.status, 200);
 * ```
 *
 * @since 0.1.0
 */
export const wordPressHttp = <R>(
  api: WordPressApi<R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    // The request URL may be a path alone; the base only fills in the origin, never read.
    const url = new URL(request.url, "http://localhost");
    const ifNoneMatch = request.headers["if-none-match"];
    const asked = {
      method: request.method,
      path: url.pathname,
      query: Array.from(url.searchParams),
    };
    return Effect.map(
      api.handle(ifNoneMatch === undefined ? asked : { ...asked, ifNoneMatch }),
      (response) =>
        Option.match(response.body, {
          onNone: () =>
            HttpServerResponse.empty({ status: response.status, headers: response.headers }),
          onSome: (body) =>
            HttpServerResponse.jsonUnsafe(body, {
              status: response.status,
              headers: response.headers,
            }),
        }),
    );
  });

/**
 * The API as one `HttpRouter` route: every method on its prefix and every
 * path below it is served by {@link wordPressHttp}, so a write, or a path the
 * bindings don't route, answers WordPress's `404 rest_no_route` rather than
 * the router's own 404. The prefix is the API's, so the mount can't drift
 * from the config's `prefix`. Merge the layer into the
 * application's routes.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as HashMap from "effect/HashMap";
 * import * as Option from "effect/Option";
 * import * as HttpRouter from "effect/http/HttpRouter";
 * import { defineWordPress } from "@thomasfosterau/pulpit-wordpress/Api";
 * import { wordPressRoutes } from "@thomasfosterau/pulpit-wordpress/Http";
 * import { stringIds } from "@thomasfosterau/pulpit-wordpress/Ids";
 *
 * const api = defineWordPress({
 *   site: { url: "https://example.org", name: "Example", description: "", timezone: "UTC" },
 *   prefix: "/api",
 *   ids: stringIds(),
 *   viewer: Effect.succeed(Option.none()),
 *   policy: {
 *     canViewPrivate: () => false,
 *     canViewDeleted: () => false,
 *     canModerate: () => false,
 *     canWriteCorpus: () => false,
 *   },
 *   render: (requests) => Effect.succeed(requests.map(({ value }) => String(value))),
 *   link: (_, fields) => `https://example.org/${fields.slug}`,
 *   types: {},
 *   authors: { ids: stringIds(), getMany: () => Effect.succeed(HashMap.empty()) },
 * });
 * const { handler, dispose } = HttpRouter.toWebHandler(wordPressRoutes(api), {
 *   disableLogger: true,
 * });
 * const program = Effect.gen(function* () {
 *   const index = yield* Effect.promise(() => handler(new Request("https://example.org/api")));
 *   strictEqual(index.status, 200);
 *   const write = yield* Effect.promise(() =>
 *     handler(new Request("https://example.org/api/wp/v2/posts", { method: "POST" })),
 *   );
 *   strictEqual(write.status, 404); // `rest_no_route`, as WordPress answers
 *   yield* Effect.promise(dispose);
 * });
 * await Effect.runPromise(program);
 * ```
 *
 * @since 0.1.0
 */
export const wordPressRoutes = <R>(api: WordPressApi<R>) =>
  HttpRouter.add(
    "*",
    // `/*` matches the prefix itself as well as every path below it.
    `/${Arr.join([...Arr.filter(Str.split(api.prefix, "/"), Str.isNonEmpty), "*"], "/")}`,
    wordPressHttp(api),
  );
