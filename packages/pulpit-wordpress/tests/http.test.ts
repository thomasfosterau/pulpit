/**
 * `./http` — the read API as an `effect/http` handler: the URL's path and
 * query reach the API, and its answer comes back as the response.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { defineWordPress, type WordPressRequest } from "../src/api.ts";
import { wordPressHttp } from "../src/http.ts";
import { stringIds } from "../src/ids.ts";

const seen: Array<WordPressRequest> = [];
const base = defineWordPress({
  site: { url: "https://example.org", name: "Example", description: "", timezone: "UTC" },
  ids: stringIds(),
  viewer: Effect.succeed(Option.none()),
  policy: {
    canViewPrivate: () => false,
    canViewDeleted: () => false,
    canModerate: () => false,
    canWriteCorpus: () => false,
  },
  render: (requests) => Effect.succeed(requests.map(({ value }) => String(value))),
  link: (_, fields) => `https://example.org/${fields.slug}`,
  types: {},
  authors: { ids: stringIds(), getMany: () => Effect.succeed(HashMap.empty()) },
});
const api = {
  handle: (request: WordPressRequest) =>
    Effect.andThen(
      Effect.sync(() => seen.push(request)),
      base.handle(request),
    ),
};

const serve = (url: string, method = "GET") =>
  Effect.runPromise(
    Effect.provideService(
      wordPressHttp(api),
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(url, { method })),
    ),
  );

describe("wordPressHttp", () => {
  it("hands the API the method, the path and the query pairs in order", async () => {
    await serve("https://example.org/wp-json/wp/v2/posts?include[]=1&include[]=2&page=2");
    expect(seen.at(-1)).toEqual({
      method: "GET",
      path: "/wp-json/wp/v2/posts",
      query: [
        ["include[]", "1"],
        ["include[]", "2"],
        ["page", "2"],
      ],
    });
  });

  it("answers with the API's status and headers", async () => {
    const index = await serve("https://example.org/wp-json/");
    expect(index.status).toBe(200);
    expect(index.headers["link"]).toBe('<https://example.org/wp-json/>; rel="https://api.w.org/"');
    const missing = await serve("https://example.org/wp-json/wp/v2/posts", "POST");
    expect(missing.status).toBe(404);
  });

  it("answers HEAD with the status and headers and an empty body", async () => {
    const head = await serve("https://example.org/wp-json/", "HEAD");
    expect([head.status, head.headers["link"], head.body._tag]).toEqual([
      200,
      '<https://example.org/wp-json/>; rel="https://api.w.org/"',
      "Empty",
    ]);
  });
});
