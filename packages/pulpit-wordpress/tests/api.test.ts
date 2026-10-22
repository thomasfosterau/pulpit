/**
 * `./api` — the `wp/v2` read API over leaves bound to WordPress's post types,
 * against the kernel's in-memory fakes (pulpit#86, phase 1): the read rule
 * (`SEC-AUTH-ENUM-001`) through `/posts/{id}` and `/posts`, the collection
 * headers, related nodes the viewer can't read, `_embed`'s batching, the
 * cache header, the routes it refuses, and the wire forms WordPress core
 * answers in.
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Visibility } from "@thomasfosterau/pulpit/content";
import {
  defineSubtype,
  ownedAccess,
  type AccessPolicy,
  type LeafRow,
  type Viewer,
  type ViewerAccount,
} from "@thomasfosterau/pulpit/subtype";
import {
  makeInMemoryChainStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "@thomasfosterau/pulpit/testing";
import type { ColumnValue } from "@thomasfosterau/pulpit/version-chain";
import {
  bind,
  defineWordPress,
  MAX_LIST_PARAMETER,
  type Author,
  type PostFields,
  type RenderRequest,
  type WordPressResponse,
} from "../src/api.ts";
import { integerIds } from "../src/ids.ts";
import { makeInMemoryIdCodec } from "../src/testing.ts";
import {
  ATTACHMENT_FORM,
  LINKS_FORM,
  PAGE_FORM,
  POST_FORM,
  type WireForm,
} from "./fixtures/wordpress-forms.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Run `step` over `items` one at a time: the fakes' one viewer is swapped per call. */
const inSequence = async <A, B>(
  items: ReadonlyArray<A>,
  step: (item: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const [first, ...rest] = items;
  if (first === undefined) return [];
  const head = await step(first);
  return [head, ...(await inSequence(rest, step))];
};

const member: ViewerAccount = { id: "u-member", role: "user" };
const stranger: ViewerAccount = { id: "u-stranger", role: "user" };
const moderator: ViewerAccount = { id: "u-moderator", role: "moderator" };
const policy: AccessPolicy = {
  canViewPrivate: (account) => account.role === "moderator",
  canViewDeleted: (account) => account.role === "moderator",
  canModerate: (account) => account.role === "moderator",
  canWriteCorpus: (account) => account.role === "moderator",
};

const at = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));
const PAST = at("2026-01-01T00:00:00.000Z");
const FUTURE = at("2999-01-01T00:00:00.000Z");
const NOW = at("2026-10-22T00:00:00.000Z");
const COLUMNS = [
  "title",
  "content",
  "excerpt",
  "slug",
  "publishedAt",
  "updatedAt",
  "visibility",
  "draft",
  "featuredMediaId",
  "parentId",
  "menuOrder",
  "mimeType",
];

/** A row's string column, or none. */
const stringOf = (row: LeafRow, column: string) =>
  Option.filter(Option.fromNullishOr(row[column]), Predicate.isString);
const textOf = (row: LeafRow, column: string) => Option.getOrElse(stringOf(row, column), () => "");

const fieldsOf = (row: LeafRow): PostFields => ({
  id: row.id,
  slug: textOf(row, "slug"),
  date: Option.liftPredicate(row["publishedAt"], Predicate.isDate),
  modified: Predicate.isDate(row["updatedAt"]) ? row["updatedAt"] : PAST,
  title: textOf(row, "title"),
  content: textOf(row, "content"),
  excerpt: textOf(row, "excerpt"),
  author: stringOf(row, "ownerId"),
  featuredMedia: stringOf(row, "featuredMediaId"),
  parent: stringOf(row, "parentId"),
  menuOrder: Predicate.isNumber(row["menuOrder"]) ? row["menuOrder"] : 0,
  draft: row["draft"] !== false,
  visibility: Schema.is(Visibility)(row["visibility"]) ? row["visibility"] : "private",
  deleted: row.action === "delete",
  media: Predicate.isString(row["mimeType"])
    ? {
        caption: "",
        description: "",
        altText: "",
        mediaType: "image",
        mimeType: row["mimeType"],
        sourceUrl: `https://cdn.example.org/${textOf(row, "slug")}.jpg`,
        mediaDetails: {},
        fileSize: Option.none(),
      }
    : undefined,
});

const serveable = (row: LeafRow) =>
  row["visibility"] === "public" && row["draft"] === false && row.action !== "delete";

type Target = "posts" | "pages" | "media";

/** A site over three in-memory leaves (posts, pages, media), all owned, with a draft column. */
const site = () => {
  let viewer: Viewer = Option.none();
  const leaf = (type: string) => {
    const chain = makeInMemoryChainStore();
    const leaves = makeInMemoryLeafStore(chain, { columns: COLUMNS, now: NOW });
    return defineSubtype({
      type,
      access: ownedAccess({ draft: true }),
      chain,
      leaves,
      viewer: Effect.sync(() => viewer),
      policy,
      followers: makeInMemoryFollowers([]),
      toResource: (row: LeafRow) => row,
    });
  };
  const ops = { posts: leaf("posts"), pages: leaf("pages"), media: leaf("media") };
  const nodes = makeInMemoryIdCodec();
  const accounts = makeInMemoryIdCodec([member.id, stranger.id, moderator.id]);
  const renders: Array<ReadonlyArray<RenderRequest>> = [];
  const authorReads: Array<ReadonlyArray<string>> = [];
  const mediaReads: Array<ReadonlyArray<string>> = [];
  const columns = {
    slug: "slug",
    date: "publishedAt",
    modified: "updatedAt",
    title: "title",
    author: "ownerId",
    parent: "parentId",
    menuOrder: "menuOrder",
    draft: "draft",
    visibility: "visibility",
    mimeType: "mimeType",
  };
  const api = defineWordPress({
    site: {
      url: "https://example.org",
      name: "Example",
      description: "A site",
      timezone: "Australia/Sydney",
    },
    ids: integerIds(nodes),
    viewer: Effect.sync(() => viewer),
    policy,
    render: (requests) =>
      Effect.sync(() => {
        renders.push(requests);
        return requests.map(
          ({ field, value }) => `<${field}>${Predicate.isString(value) ? value : ""}</${field}>`,
        );
      }),
    link: (type, fields) => `https://example.org/${type}/${fields.slug}`,
    types: {
      post: bind({ ops: ops.posts, columns, fields: fieldsOf, serveable }),
      page: bind({ ops: ops.pages, columns, fields: fieldsOf, serveable }),
      attachment: bind({
        ops: {
          ...ops.media,
          getMany: (ids) => {
            mediaReads.push(ids);
            return ops.media.getMany(ids);
          },
        },
        columns,
        fields: fieldsOf,
        serveable,
      }),
    },
    authors: {
      ids: integerIds(accounts),
      getMany: (accountIds) =>
        Effect.sync(() => {
          authorReads.push(accountIds);
          return HashMap.fromIterable(
            accountIds.map((id): readonly [string, Author] => [
              id,
              { name: id, slug: id, description: "", url: "", avatarUrls: {} },
            ]),
          );
        }),
    },
  });
  const as = <A, E>(who: Viewer, effect: Effect.Effect<A, E>) =>
    Effect.ensuring(
      Effect.suspend(() => {
        viewer = who;
        return effect;
      }),
      Effect.sync(() => {
        viewer = Option.none();
      }),
    );
  const create = async (
    target: Target,
    state: { readonly [column: string]: ColumnValue },
    owner: ViewerAccount = member,
  ) => {
    const { id } = await run(
      as(
        Option.some(owner),
        ops[target].create({
          id: Option.none(),
          state: {
            title: "A title",
            content: "Body",
            excerpt: "Short",
            slug: "a-slug",
            publishedAt: PAST,
            updatedAt: PAST,
            visibility: "public",
            draft: false,
            ...state,
          },
        }),
      ),
    );
    return { id, wireId: nodes.assign(id) };
  };
  const get = (
    path: string,
    query: ReadonlyArray<readonly [string, string]> = [],
    who: Viewer = Option.none(),
    method = "GET",
  ) => run(as(who, api.handle({ method, path: `/wp-json${path}`, query })));
  return { ops, nodes, create, get, renders, authorReads, mediaReads, as };
};

// ── Reading a response ──────────────────────────────────────────────────

const decodeBody =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (response: WordPressResponse): S["Type"] =>
    Schema.decodeUnknownSync(schema)(Option.getOrNull(response.body));

const ErrorBody = Schema.Struct({
  code: Schema.String,
  data: Schema.Struct({
    status: Schema.Number,
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
});
const codeOf = (response: WordPressResponse) => decodeBody(ErrorBody)(response).code;

const Embedded = Schema.Record(Schema.String, Schema.Array(Schema.Struct({ id: Schema.Number })));
const Item = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
  date: Schema.String,
  date_gmt: Schema.NullOr(Schema.String),
  featured_media: Schema.optionalKey(Schema.Number),
  parent: Schema.optionalKey(Schema.Number),
  _links: Schema.Record(Schema.String, Schema.Json),
  _embedded: Schema.optionalKey(Embedded),
});
const itemOf = decodeBody(Item);
const listed = (response: WordPressResponse) =>
  decodeBody(Schema.Array(Item))(response).map(({ id }) => id);
const objectOf = decodeBody(Schema.Record(Schema.String, Schema.Json));

describe("the wp/v2 read API — the read rule (SEC-AUTH-ENUM-001)", () => {
  const states = [
    { visibility: "public", draft: false },
    { visibility: "public", draft: true },
    { visibility: "private", draft: false },
    { visibility: "followers", draft: false },
  ];
  const viewers = [
    ["anonymous", Option.none()],
    ["a stranger", Option.some(stranger)],
    ["the owner", Option.some(member)],
    ["a moderator", Option.some(moderator)],
  ] as const;

  it.each(viewers)(
    "answers a row %s can't read as 404 rest_post_invalid_id and omits it, never 401 or 403",
    async (_, who) => {
      const wp = site();
      const rows = await inSequence(states, (state) => wp.create("posts", state));
      const unknown = await wp.get("/wp/v2/posts/9999", [], who);
      expect([unknown.status, codeOf(unknown)]).toEqual([404, "rest_post_invalid_id"]);
      const reads = await inSequence(
        rows,
        async ({ wireId }) => (await wp.get(`/wp/v2/posts/${wireId}`, [], who)).status,
      );
      // Each row reads exactly when the kernel's own get serves it to this viewer.
      const kernel = await inSequence(rows, ({ id }) =>
        Effect.runPromiseExit(wp.as(who, wp.ops.posts.get(id))).then(Exit.isSuccess),
      );
      expect(reads).toEqual(kernel.map((readable) => (readable ? 200 : 404)));
      // A list never shows a row the item route hides, nor counts it.
      const list = await wp.get("/wp/v2/posts", [["status", "publish"]], who);
      const shown = listed(list);
      const readableIds = Arr.filter(rows, (_, index) => reads[index] === 200).map(
        ({ wireId }) => wireId,
      );
      expect(Arr.every(shown, (id) => Arr.contains(readableIds, id))).toBe(true);
      expect(list.headers["x-wp-total"]).toBe(String(shown.length));
    },
  );

  it("answers a hidden row exactly as a missing one, body and headers", async () => {
    const wp = site();
    const hidden = await wp.create("posts", { visibility: "private" });
    const missing = await wp.get("/wp/v2/posts/9999");
    expect(await wp.get(`/wp/v2/posts/${hidden.wireId}`)).toEqual(missing);
  });

  it("answers a path id that is no integer as rest_no_route, and one the codec doesn't know as the 404", async () => {
    const wp = site();
    expect(codeOf(await wp.get("/wp/v2/posts/abc"))).toBe("rest_no_route");
    expect(codeOf(await wp.get("/wp/v2/posts/0"))).toBe("rest_post_invalid_id");
  });

  it("answers a status beyond the scope with rest_forbidden_status, which names no row", async () => {
    const wp = site();
    const anonymous = await wp.get("/wp/v2/posts", [["status", "draft"]]);
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, "rest_forbidden_status"]);
    const trash = await wp.get("/wp/v2/posts", [["status", "trash"]], Option.some(member));
    expect([trash.status, codeOf(trash)]).toEqual([403, "rest_forbidden_status"]);
    // The owner lists their own drafts; a stranger lists none of them.
    const draft = await wp.create("posts", { draft: true });
    expect(
      listed(await wp.get("/wp/v2/posts", [["status", "draft"]], Option.some(member))),
    ).toEqual([draft.wireId]);
    expect(
      listed(await wp.get("/wp/v2/posts", [["status", "draft"]], Option.some(stranger))),
    ).toEqual([]);
  });

  it("refuses context=edit after the 404, so the refusal never confirms a row", async () => {
    const wp = site();
    const hidden = await wp.create("posts", { visibility: "private" });
    const shown = await wp.create("posts", {});
    expect(codeOf(await wp.get(`/wp/v2/posts/${hidden.wireId}`, [["context", "edit"]]))).toBe(
      "rest_post_invalid_id",
    );
    const refused = await wp.get(`/wp/v2/posts/${shown.wireId}`, [["context", "edit"]]);
    expect([refused.status, codeOf(refused)]).toEqual([401, "rest_forbidden_context"]);
  });

  it("derives status: publish, future, draft, private, and trash for the view-deleted rung", async () => {
    const wp = site();
    const rows = await inSequence(
      [{}, { publishedAt: FUTURE }, { draft: true }, { visibility: "followers" }],
      (state) => wp.create("posts", state),
    );
    const statuses = await inSequence(
      rows,
      async ({ wireId }) =>
        itemOf(await wp.get(`/wp/v2/posts/${wireId}`, [], Option.some(member))).status,
    );
    expect(statuses).toEqual(["publish", "future", "draft", "private"]);
    const deleted = await wp.create("posts", {});
    await run(wp.as(Option.some(member), wp.ops.posts.delete(deleted.id)));
    const trash = await wp.get("/wp/v2/posts", [["status", "trash"]], Option.some(moderator));
    expect(decodeBody(Schema.Array(Item))(trash).map(({ id, status }) => [id, status])).toEqual([
      [deleted.wireId, "trash"],
    ]);
  });
});

describe("the wp/v2 read API — collections", () => {
  const seed = async (count: number) => {
    const wp = site();
    const rows = await inSequence(Arr.range(0, count - 1), (index) =>
      wp.create("posts", {
        slug: `post-${index}`,
        publishedAt: at(`2026-01-01T00:0${index}:00.000Z`),
      }),
    );
    return { wp, ids: rows.map(({ wireId }) => wireId) };
  };

  it("sets X-WP-Total, X-WP-TotalPages and the prev / next Link for the first, middle and last pages", async () => {
    const { wp } = await seed(5);
    const pages = await inSequence([1, 2, 3], (n) =>
      wp.get("/wp/v2/posts", [
        ["per_page", "2"],
        ["page", String(n)],
      ]),
    );
    expect(
      pages.map((response) => [
        response.headers["x-wp-total"],
        response.headers["x-wp-totalpages"],
      ]),
    ).toEqual([
      ["5", "3"],
      ["5", "3"],
      ["5", "3"],
    ]);
    const api = '<https://example.org/wp-json/>; rel="https://api.w.org/"';
    const href = (n: number) => `<https://example.org/wp-json/wp/v2/posts?per_page=2&page=${n}>`;
    expect(pages.map((response) => response.headers["link"])).toEqual([
      `${api}, ${href(2)}; rel="next"`,
      `${api}, ${href(1)}; rel="prev", ${href(3)}; rel="next"`,
      `${api}, ${href(2)}; rel="prev"`,
    ]);
    expect(pages.map((response) => listed(response).length)).toEqual([2, 2, 1]);
  });

  it("answers a page past the end of a non-empty list as rest_post_invalid_page_number, and an empty list's as []", async () => {
    const { wp } = await seed(3);
    const past = await wp.get("/wp/v2/posts", [
      ["per_page", "2"],
      ["page", "3"],
    ]);
    expect([past.status, codeOf(past)]).toEqual([400, "rest_post_invalid_page_number"]);
    const empty = await site().get("/wp/v2/posts", [["page", "4"]]);
    expect([empty.status, listed(empty), empty.headers["x-wp-total"]]).toEqual([200, [], "0"]);
  });

  it("orders by date descending by default, by slug, and by the include list with orderby=include", async () => {
    const { wp, ids } = await seed(3);
    expect(listed(await wp.get("/wp/v2/posts"))).toEqual(Arr.reverse(ids));
    expect(
      listed(
        await wp.get("/wp/v2/posts", [
          ["order", "asc"],
          ["orderby", "slug"],
        ]),
      ),
    ).toEqual(ids);
    const picked = Arr.getSomes([Arr.get(ids, 2), Arr.get(ids, 0)]);
    expect(
      listed(
        await wp.get("/wp/v2/posts", [
          ["include", picked.join(",")],
          ["orderby", "include"],
        ]),
      ),
    ).toEqual(picked);
    expect(codeOf(await wp.get("/wp/v2/posts", [["orderby", "include"]]))).toBe(
      "rest_orderby_include_missing_include",
    );
  });

  it("filters by include, exclude, slug, after and before", async () => {
    const { wp, ids } = await seed(3);
    const [first = 0, second = 0, third = 0] = ids;
    expect(
      listed(
        await wp.get("/wp/v2/posts", [
          ["include[]", String(first)],
          ["include[]", "9999"],
        ]),
      ),
    ).toEqual([first]);
    expect(listed(await wp.get("/wp/v2/posts", [["exclude", `${first},${second}`]]))).toEqual([
      third,
    ]);
    expect(listed(await wp.get("/wp/v2/posts", [["slug", "post-1"]]))).toEqual([second]);
    // Sydney is UTC+11 in January: 11:00:30 local is 00:00:30 UTC.
    expect(listed(await wp.get("/wp/v2/posts", [["after", "2026-01-01T11:00:30"]]))).toEqual([
      third,
      second,
    ]);
    expect(listed(await wp.get("/wp/v2/posts", [["before", "2026-01-01T00:00:30Z"]]))).toEqual([
      first,
    ]);
  });

  it("refuses an id list past MAX_LIST_PARAMETER before decoding it, and a parameter it can't honour", async () => {
    const { wp } = await seed(1);
    const many = Arr.range(1, MAX_LIST_PARAMETER + 1).join(",");
    const decodesBefore = wp.nodes.decodeCalls().length;
    const exclude = await wp.get("/wp/v2/posts", [["exclude", many]]);
    expect([exclude.status, codeOf(exclude)]).toEqual([400, "rest_invalid_param"]);
    expect(wp.nodes.decodeCalls().length).toBe(decodesBefore);
    const search = decodeBody(ErrorBody)(await wp.get("/wp/v2/posts", [["search", "hello"]]));
    expect([search.code, search.data.params]).toEqual([
      "rest_invalid_param",
      { search: "search is not supported by this API." },
    ]);
    expect(codeOf(await wp.get("/wp/v2/posts", [["per_page", "101"]]))).toBe("rest_invalid_param");
    expect(codeOf(await wp.get("/wp/v2/posts", [["menu_order", "1"]]))).toBe("rest_invalid_param");
  });
});

describe("the wp/v2 read API — related nodes, _embed and _fields", () => {
  const embed = [["_embed", "1"]] as const;

  it("zeroes a featured_media or parent the viewer can't read, and drops it from _links and _embedded", async () => {
    const wp = site();
    const shownMedia = await wp.create("media", { mimeType: "image/jpeg", slug: "shown" });
    const hiddenMedia = await wp.create("media", { mimeType: "image/jpeg", visibility: "private" });
    const hiddenParent = await wp.create("pages", { visibility: "private" });
    const withShown = await wp.create("posts", { featuredMediaId: shownMedia.id });
    const withHidden = await wp.create("posts", { featuredMediaId: hiddenMedia.id });
    const child = await wp.create("pages", { parentId: hiddenParent.id });

    const shown = itemOf(await wp.get(`/wp/v2/posts/${withShown.wireId}`, embed));
    expect(shown.featured_media).toBe(shownMedia.wireId);
    expect(Record.has(shown._links, "wp:featuredmedia")).toBe(true);
    expect(shown._embedded?.["wp:featuredmedia"]?.map(({ id }) => id)).toEqual([shownMedia.wireId]);

    const hidden = itemOf(await wp.get(`/wp/v2/posts/${withHidden.wireId}`, embed));
    expect(hidden.featured_media).toBe(0);
    expect(Record.has(hidden._links, "wp:featuredmedia")).toBe(false);
    expect(Record.has(hidden._embedded ?? {}, "wp:featuredmedia")).toBe(false);

    const page = itemOf(await wp.get(`/wp/v2/pages/${child.wireId}`, embed));
    expect([page.parent, Record.has(page._links, "up")]).toEqual([0, false]);
    // The owner reads the hidden page, so the parent is theirs to see.
    const owned = itemOf(await wp.get(`/wp/v2/pages/${child.wireId}`, embed, Option.some(member)));
    expect([owned.parent, owned._embedded?.["up"]?.map(({ id }) => id)]).toEqual([
      hiddenParent.wireId,
      [hiddenParent.wireId],
    ]);
  });

  it("reads each related kind once per response: one encode, one render, one author read, one media read", async () => {
    const wp = site();
    const media = await wp.create("media", { mimeType: "image/jpeg" });
    await inSequence(Arr.range(0, 3), (n) =>
      wp.create("posts", { slug: `p-${n}`, featuredMediaId: media.id }),
    );
    const encodes = wp.nodes.encodeCalls().length;
    const response = await wp.get("/wp/v2/posts", embed);
    expect(listed(response)).toHaveLength(4);
    expect(wp.nodes.encodeCalls().length - encodes).toBe(1);
    expect([wp.renders.length, wp.authorReads.length, wp.mediaReads.length]).toEqual([1, 1, 1]);
  });

  it("embeds only the rels named, and keeps only the _fields asked for", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    const authorOnly = itemOf(await wp.get(`/wp/v2/posts/${post.wireId}`, [["_embed", "author"]]));
    expect(Record.keys(authorOnly._embedded ?? {})).toEqual(["author"]);
    expect(
      objectOf(
        await wp.get(`/wp/v2/posts/${post.wireId}`, [["_fields", "id,title.rendered,slug"]]),
      ),
    ).toEqual({
      id: post.wireId,
      title: { rendered: "<title>A title</title>" },
      slug: "a-slug",
    });
  });
});

describe("the wp/v2 read API — caching (CACHE-AUTH-005)", () => {
  it("is public only for the anonymous when every item, embeds included, is serveable", async () => {
    const wp = site();
    const hiddenMedia = await wp.create("media", { mimeType: "image/jpeg", visibility: "private" });
    const post = await wp.create("posts", { featuredMediaId: hiddenMedia.id });
    await wp.create("posts", { draft: true });
    const cacheOf = async (
      path: string,
      query: ReadonlyArray<readonly [string, string]>,
      who: Viewer,
    ) => (await wp.get(path, query, who)).headers["cache-control"];
    expect(
      await inSequence(
        [
          [`/wp/v2/posts/${post.wireId}`, [], Option.none()],
          [`/wp/v2/posts/${post.wireId}`, [], Option.some(member)],
          // The owner's embed reaches their private media: never public.
          [`/wp/v2/posts/${post.wireId}`, [["_embed", "1"]], Option.some(member)],
          ["/wp/v2/posts", [["status", "draft"]], Option.some(member)],
        ] as const,
        ([path, query, who]) => cacheOf(path, query, who),
      ),
    ).toEqual(["public", "private, no-store", "private, no-store", "private, no-store"]);
  });
});

describe("the wp/v2 read API — routes", () => {
  it("answers every write method, and an unbound or unknown route, as rest_no_route", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    const answers = await inSequence(["POST", "PUT", "PATCH", "DELETE"], (method) =>
      wp.get(`/wp/v2/posts/${post.wireId}`, [], Option.none(), method),
    );
    expect(answers.map((response) => [response.status, codeOf(response)])).toEqual(
      answers.map(() => [404, "rest_no_route"]),
    );
    expect(codeOf(await wp.get("/wp/v2/comments"))).toBe("rest_no_route");
    expect(codeOf(await wp.get("/wp/v2/users/1"))).toBe("rest_no_route");
  });

  it("serves the discovery index and the namespace, with the api.w.org Link on every response", async () => {
    const wp = site();
    const index = decodeBody(
      Schema.Struct({
        namespaces: Schema.Array(Schema.String),
        routes: Schema.Record(Schema.String, Schema.Json),
        gmt_offset: Schema.String,
      }),
    )(await wp.get("/"));
    expect(index.namespaces).toEqual(["wp/v2"]);
    expect(Record.keys(index.routes)).toEqual([
      "/wp/v2/posts",
      "/wp/v2/posts/(?P<id>[\\d]+)",
      "/wp/v2/pages",
      "/wp/v2/pages/(?P<id>[\\d]+)",
      "/wp/v2/media",
      "/wp/v2/media/(?P<id>[\\d]+)",
    ]);
    expect(["10", "11"]).toContain(index.gmt_offset);
    expect((await wp.get("/wp/v2")).status).toBe(200);
    expect((await wp.get("/wp/v2/nothing")).headers["link"]).toBe(
      '<https://example.org/wp-json/>; rel="https://api.w.org/"',
    );
  });

  it("answers HEAD with GET's status and headers and no body", async () => {
    const wp = site();
    await wp.create("posts", {});
    const head = await wp.get("/wp/v2/posts", [], Option.none(), "HEAD");
    const get = await wp.get("/wp/v2/posts");
    expect([head.status, head.headers, head.body]).toEqual([
      get.status,
      get.headers,
      Option.none(),
    ]);
  });
});

// ── The wire forms WordPress core answers in (golden) ───────────────────

const isJsonList = Schema.is(Schema.Array(Schema.Json));
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
const isFormObject = (form: WireForm): form is { readonly [key: string]: WireForm } =>
  Predicate.isObject(form) && !isJsonList(form);

/** A value's wire form, as `tests/fixtures/wordpress-forms.ts` records WordPress's. */
const formOf = (value: Schema.Json): WireForm => {
  if (Predicate.isNull(value)) return "null";
  if (Predicate.isString(value)) return "string";
  if (Predicate.isNumber(value)) return "number";
  if (Predicate.isBoolean(value)) return "boolean";
  if (isJsonList(value)) {
    return Arr.fromOption(Option.map(Arr.head(value), formOf));
  }
  return isJsonObject(value) ? Record.map(value, formOf) : "unknown";
};

/**
 * The deliberate differences from the fixture: core's `meta` carries the
 * fixture's registered meta key where a site with none registered answers
 * `[]`, and phase 1 has no terms, so `categories` is empty.
 */
const ADJUSTED: Record.ReadonlyRecord<string, WireForm> = { meta: [], categories: [] };
const adjusted = (form: WireForm): WireForm =>
  isFormObject(form)
    ? Record.map(form, (field, key) => Option.getOrElse(Record.get(ADJUSTED, key), () => field))
    : form;

const withoutLinks = (response: WordPressResponse) => Record.remove(objectOf(response), "_links");

describe("the wp/v2 read API — the wire forms WordPress core answers in (golden)", () => {
  it("answers /posts and /posts/{id} in core's post form", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    const [first] = decodeBody(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
      await wp.get("/wp/v2/posts"),
    );
    expect(formOf(Record.remove(first ?? {}, "_links"))).toEqual(adjusted(POST_FORM));
    const item = await wp.get(`/wp/v2/posts/${post.wireId}`);
    expect(formOf(withoutLinks(item))).toEqual(adjusted(POST_FORM));
    const links = itemOf(item)._links;
    expect(
      formOf(
        Record.filter(links, (_, rel) =>
          Arr.contains(["self", "collection", "about", "curies"], rel),
        ),
      ),
    ).toEqual(LINKS_FORM);
  });

  it("answers /pages/{id} in core's page form", async () => {
    const wp = site();
    const page = await wp.create("pages", {});
    expect(formOf(withoutLinks(await wp.get(`/wp/v2/pages/${page.wireId}`)))).toEqual(
      adjusted(PAGE_FORM),
    );
  });

  it("answers /media/{id} in core's attachment form", async () => {
    const wp = site();
    const media = await wp.create("media", { mimeType: "image/jpeg" });
    expect(formOf(withoutLinks(await wp.get(`/wp/v2/media/${media.wireId}`)))).toEqual(
      adjusted(ATTACHMENT_FORM),
    );
  });

  it("formats date in the site's time zone and date_gmt in UTC, as core does", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    const item = itemOf(await wp.get(`/wp/v2/posts/${post.wireId}`));
    expect([item.date, item.date_gmt]).toEqual(["2026-01-01T11:00:00", "2026-01-01T00:00:00"]);
  });
});
