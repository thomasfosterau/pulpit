/**
 * **The `effect/http` adapter** — a `wp/v2` read API ({@link WordPressApi})
 * as an `HttpServerRequest` → `HttpServerResponse` effect, for an
 * application to mount on its router under the API's prefix
 * (`HttpRouter.add("*", "/wp-json/*", wordPressHttp(api))`).
 *
 * `./api` is framework-free: it reads a method, a path and the query pairs,
 * and answers a status, headers and a JSON body. This module is the one
 * place that reads `effect/http`.
 *
 * @copyright Thomas Foster
 * @module pulpit-wordpress/http
 * @since 0.1.0
 */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { WordPressApi } from "./api.ts";

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
 * import { defineWordPress } from "@thomasfosterau/pulpit-wordpress/api";
 * import { wordPressHttp } from "@thomasfosterau/pulpit-wordpress/http";
 * import { stringIds } from "@thomasfosterau/pulpit-wordpress/ids";
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
    return Effect.map(
      api.handle({
        method: request.method,
        path: url.pathname,
        query: Array.from(url.searchParams),
      }),
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
