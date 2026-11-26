/**
 * `./Http` — the read API as an `effect/http` handler: the URL's path and
 * query reach the API, and its answer comes back as the response.
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as HashMap from "effect/HashMap";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as P from "effect/Predicate";
import { defineWordPress, type WordPressConfig, type WordPressRequest } from "../src/Api.ts";
import { wordPressHttp, wordPressRoutes } from "../src/Http.ts";
import { stringIds } from "../src/Ids.ts";

const seen: Array<WordPressRequest> = [];
const config: WordPressConfig<never> = {
  site: { url: "https://example.org", name: "Example", description: "", timezone: "UTC" },
  ids: stringIds(),
  viewer: Effect.succeedNone,
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: () => false,
  },
  render: (requests) =>
    Effect.succeed(
      requests.map(({ value }) => (P.isString(value) ? value : Formatter.format(value))),
    ),
  link: (_, fields) => `https://example.org/${fields.slug}`,
  types: {},
  authors: { ids: stringIds(), getMany: () => Effect.succeed(HashMap.empty()) },
};
const base = defineWordPress(config);
const api = {
  prefix: base.prefix,
  handle: (request: WordPressRequest) =>
    Effect.andThen(
      Effect.sync(() => seen.push(request)),
      base.handle(request),
    ),
};

const serve = (url: string, method = "GET", headers: Record<string, string> = {}) =>
  Effect.provideService(
    wordPressHttp(api),
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request(url, { method, headers })),
  );

describe("wordPressHttp", () => {
  it.effect("hands the API the method, the path and the query pairs in order", () =>
    Effect.gen(function* () {
      yield* serve("https://example.org/wp-json/wp/v2/posts?include[]=1&include[]=2&page=2");
      expect(seen.at(-1)).toEqual({
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        query: [
          ["include[]", "1"],
          ["include[]", "2"],
          ["page", "2"],
        ],
      });
    }),
  );

  it.effect("hands the API the If-None-Match header when the request has one", () =>
    Effect.gen(function* () {
      yield* serve("https://example.org/wp-json/", "GET", { "if-none-match": 'W/"abc"' });
      expect(seen.at(-1)?.ifNoneMatch).toBe('W/"abc"');
      yield* serve("https://example.org/wp-json/");
      expect(seen.at(-1)).not.toHaveProperty("ifNoneMatch");
    }),
  );

  it.effect("answers with the API's status and headers", () =>
    Effect.gen(function* () {
      const index = yield* serve("https://example.org/wp-json/");
      expect(index.status).toBe(200);
      expect(index.headers["link"]).toBe(
        '<https://example.org/wp-json/>; rel="https://api.w.org/"',
      );
      const missing = yield* serve("https://example.org/wp-json/wp/v2/posts", "POST");
      expect(missing.status).toBe(404);
    }),
  );

  it.effect("answers HEAD with the status and headers and an empty body", () =>
    Effect.gen(function* () {
      const head = yield* serve("https://example.org/wp-json/", "HEAD");
      expect([head.status, head.headers["link"], head.body._tag]).toEqual([
        200,
        '<https://example.org/wp-json/>; rel="https://api.w.org/"',
        "Empty",
      ]);
    }),
  );
});

describe("wordPressRoutes", () => {
  const prefixed = defineWordPress({ ...config, prefix: "/api/" });

  /** Serve `url` through the route layer, as the application's router would. */
  const route = (url: string, method = "GET") =>
    Effect.scoped(
      Effect.flatMap(HttpRouter.toHttpEffect(wordPressRoutes(prefixed)), (handler) =>
        Effect.provideService(
          handler,
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url, { method })),
        ),
      ),
    );

  it.effect("mounts the API at its own prefix, without the trailing slash", () =>
    Effect.gen(function* () {
      expect(prefixed.prefix).toBe("/api");
      const answers = yield* Effect.forEach(
        ["https://example.org/api", "https://example.org/api/", "https://example.org/api/wp/v2"],
        (url) => route(url),
        { concurrency: 1 },
      );
      expect(answers.map(({ status }) => status)).toEqual([200, 200, 200]);
    }),
  );

  it.effect("answers a write and an unrouted path under the prefix as rest_no_route", () =>
    Effect.gen(function* () {
      const answers = [
        yield* route("https://example.org/api/wp/v2/posts", "POST"),
        yield* route("https://example.org/api/wp/v2/widgets"),
      ];
      expect(answers).toMatchObject([
        { status: 404, body: { text: expect.stringContaining('"code":"rest_no_route"') } },
        { status: 404, body: { text: expect.stringContaining('"code":"rest_no_route"') } },
      ]);
    }),
  );

  it.effect("leaves paths outside the prefix to the application's router", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.flip(route("https://example.org/apix"));
      expect(outside).toMatchObject({ reason: { _tag: "RouteNotFound" } });
    }),
  );
});
