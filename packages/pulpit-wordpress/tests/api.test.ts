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
import * as Order from "effect/Order";
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
import { defineEdgeOps, type EdgeRow, type EdgeValues } from "@thomasfosterau/pulpit/edges";
import {
  makeInMemoryChainStore,
  makeInMemoryEdgeStore,
  makeInMemoryFollowers,
  makeInMemoryLeafStore,
} from "@thomasfosterau/pulpit/testing";
import type { ColumnValue } from "@thomasfosterau/pulpit/version-chain";
import {
  bind,
  bindTaxonomy,
  defineWordPress,
  fileMediaFields,
  MAX_LIST_PARAMETER,
  type Author,
  type PostColumns,
  type PostFields,
  type PostType,
  type RenderRequest,
  type Taxonomy,
  type TermFields,
  type WordPressResponse,
} from "../src/api.ts";
import { integerIds } from "../src/ids.ts";
import { makeInMemoryIdCodec } from "../src/testing.ts";
import {
  ATTACHMENT_FORM,
  CATEGORY_FORM,
  LINKS_FORM,
  PAGE_FORM,
  POST_FORM,
  TAG_FORM,
  TERM_LINKS_FORM,
  USER_FORM,
  WP_TERM_LINK_FORM,
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
  "bytesPending",
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
        bytesPending: row["bytesPending"] === true,
      }
    : undefined,
});

const serveable = (row: LeafRow) =>
  row["visibility"] === "public" && row["draft"] === false && row.action !== "delete";

type Target = "posts" | "pages" | "media";

/** What a test may vary about {@link site}: the bound columns, which types are bound, a failing seam. */
interface SiteOptions {
  readonly columns?: PostColumns;
  readonly bound?: ReadonlyArray<PostType>;
  readonly failing?: "render" | "list";
  /** Bind `category` and `post_tag` over two term leaves and their assignment families (phase 2). */
  readonly terms?: boolean;
}

const TERM_COLUMNS = ["name", "slug", "description", "parentId"];

const termFieldsOf = (row: LeafRow): TermFields => ({
  id: row.id,
  name: textOf(row, "name"),
  slug: textOf(row, "slug"),
  description: textOf(row, "description"),
  parent: stringOf(row, "parentId"),
});

/** A site over three in-memory leaves (posts, pages, media), all owned, with a draft column. */
const site = (options: SiteOptions = {}) => {
  let viewer: Viewer = Option.none();
  const followers = makeInMemoryFollowers([]);
  const viewerSeam = Effect.sync(() => viewer);
  /** A chain and the current-version view over it. */
  const store = (columns: ReadonlyArray<string>) => {
    const chain = makeInMemoryChainStore();
    return { chain, leaves: makeInMemoryLeafStore(chain, { columns, now: NOW }) };
  };
  const leafStores = {
    posts: store(COLUMNS),
    pages: store(COLUMNS),
    media: store(COLUMNS),
  };
  const leaf = (type: Target) =>
    defineSubtype({
      type,
      access: ownedAccess({ draft: true }),
      chain: leafStores[type].chain,
      leaves: leafStores[type].leaves,
      viewer: viewerSeam,
      policy,
      followers,
      toResource: (row: LeafRow) => row,
    });
  const ops = { posts: leaf("posts"), pages: leaf("pages"), media: leaf("media") };
  const termStores = {
    category: store(TERM_COLUMNS),
    post_tag: store(TERM_COLUMNS),
  };
  const termOps = (taxonomy: Taxonomy) =>
    defineSubtype({
      type: taxonomy,
      access: { kind: "reference" },
      chain: termStores[taxonomy].chain,
      leaves: termStores[taxonomy].leaves,
      viewer: viewerSeam,
      policy,
      followers,
      toResource: (row: LeafRow) => row,
    });
  const terms = { category: termOps("category"), post_tag: termOps("post_tag") };
  const assignmentOps = (taxonomy: Taxonomy) => {
    const ends = {
      post: {
        column: "postId",
        type: "posts",
        access: ownedAccess({ draft: true }),
        nodes: leafStores.posts.leaves,
      },
      term: {
        column: "termId",
        type: taxonomy,
        access: { kind: "reference" } as const,
        nodes: termStores[taxonomy].leaves,
      },
    };
    return defineEdgeOps({
      type: `post_${taxonomy}`,
      ends,
      edges: makeInMemoryEdgeStore({ ends, uniqueKey: ["postId", "termId"], now: NOW }),
      viewer: viewerSeam,
      policy,
      followers,
      values: (input: EdgeValues) => input,
      toResource: (row: EdgeRow) => row,
    });
  };
  const assignments = { category: assignmentOps("category"), post_tag: assignmentOps("post_tag") };
  const termReads: Array<readonly [Taxonomy, ReadonlyArray<string>]> = [];
  const bindTerms = (taxonomy: Taxonomy) =>
    bindTaxonomy({
      terms: {
        ...terms[taxonomy],
        getMany: (ids) => {
          termReads.push([taxonomy, ids]);
          return terms[taxonomy].getMany(ids);
        },
      },
      columns:
        taxonomy === "category"
          ? { name: "name", slug: "slug", parent: "parentId" }
          : { name: "name", slug: "slug" },
      fields: termFieldsOf,
      serveable: () => true,
      link: (fields) => `https://example.org/${taxonomy}/${fields.slug}`,
      assignments: assignments[taxonomy],
      ends: {
        post: { alias: "post", column: "postId" },
        term: { alias: "term", column: "termId" },
      },
      assignment: (edge: EdgeRow) => ({
        post: Predicate.isString(edge["postId"]) ? edge["postId"] : "",
        term: Predicate.isString(edge["termId"]) ? edge["termId"] : "",
      }),
    });
  const nodes = makeInMemoryIdCodec();
  const accounts = makeInMemoryIdCodec([member.id, stranger.id, moderator.id]);
  const renders: Array<ReadonlyArray<RenderRequest>> = [];
  const authorReads: Array<ReadonlyArray<string>> = [];
  const mediaReads: Array<ReadonlyArray<string>> = [];
  const columns = options.columns ?? {
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
    viewer: viewerSeam,
    policy,
    render: (requests) =>
      options.failing === "render"
        ? Effect.fail("the renderer is down")
        : Effect.sync(() => {
            renders.push(requests);
            return requests.map(
              ({ field, value }) =>
                `<${field}>${Predicate.isString(value) ? value : ""}</${field}>`,
            );
          }),
    link: (type, fields) => `https://example.org/${type}/${fields.slug}`,
    types: Record.filter(
      {
        post: bind({
          ops:
            options.failing === "list"
              ? { ...ops.posts, list: () => Effect.fail("the store is down") }
              : ops.posts,
          columns,
          fields: fieldsOf,
          serveable,
        }),
        page: bind({ ops: ops.pages, columns, fields: fieldsOf, serveable }),
        attachment: bind({
          ops: {
            ...ops.media,
            getMany: (ids) => {
              mediaReads.push(ids);
              return ops.media.getMany(ids);
            },
          },
          // A file leaf's bytesPending column: lists read confirmed files only (pulpit#221).
          columns: { ...columns, bytesPending: "bytesPending" },
          fields: fieldsOf,
          serveable,
        }),
      },
      (_, type) => options.bound === undefined || Arr.contains(options.bound, type),
    ),
    taxonomies:
      options.terms === true
        ? { category: bindTerms("category"), post_tag: bindTerms("post_tag") }
        : undefined,
    authors: {
      ids: integerIds(accounts),
      getMany: (accountIds) =>
        Effect.sync(() => {
          authorReads.push(accountIds);
          return HashMap.fromIterable(
            accountIds.map((id): readonly [string, Author] => [
              id,
              {
                name: id,
                slug: id,
                description: "",
                url: "",
                avatarUrls: { "24": `https://example.org/${id}-24.png`, "48": "", "96": "" },
              },
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
            bytesPending: false,
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
  /** A term, created by a moderator (a reference leaf's writer). */
  const createTerm = async (
    taxonomy: Taxonomy,
    state: { readonly [column: string]: ColumnValue } = {},
  ) => {
    const { id } = await run(
      as(
        Option.some(moderator),
        terms[taxonomy].create({
          id: Option.none(),
          state: { name: "A term", slug: "a-term", description: "", ...state },
        }),
      ),
    );
    return { id, wireId: nodes.assign(id) };
  };
  /** Assign a post a term, as a moderator. */
  const assign = (taxonomy: Taxonomy, postId: string, termId: string) =>
    run(as(Option.some(moderator), assignments[taxonomy].create({ postId, termId })));
  return {
    api,
    ops,
    nodes,
    accounts,
    create,
    createTerm,
    assign,
    get,
    renders,
    authorReads,
    mediaReads,
    termReads,
    as,
  };
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
    expect(codeOf(await wp.get("/wp/v2/settings"))).toBe("rest_no_route");
    // A taxonomy the site doesn't bind has no route.
    expect(codeOf(await wp.get("/wp/v2/categories"))).toBe("rest_no_route");
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
      "/wp/v2/users",
      "/wp/v2/users/(?P<id>[\\d]+)",
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

describe("the wp/v2 read API — every parameter's check", () => {
  /** The names `rest_invalid_param` lists for a query, or none for another answer. */
  const refused = async (
    path: string,
    query: ReadonlyArray<readonly [string, string]>,
    wp = site(),
  ) => {
    const body = decodeBody(ErrorBody)(await wp.get(path, query));
    return [body.code, Record.keys(body.data.params ?? {})];
  };

  it("names each bad value: a non-integer, an out-of-range one, an unknown enum, a bad date, context and status", async () => {
    expect(
      await refused("/wp/v2/posts", [
        ["page", "two"],
        ["per_page", "0"],
        ["offset", "-1"],
        ["order", "sideways"],
        ["orderby", "parent"],
        ["after", "yesterday"],
        ["modified_before", "2026-13-45T99:00:00"],
        ["context", "print"],
        ["status", "publish,unknown"],
      ]),
    ).toEqual([
      "rest_invalid_param",
      [
        "context",
        "status",
        "page",
        "per_page",
        "offset",
        "order",
        "orderby",
        "after",
        "modified_before",
      ],
    ]);
    const bounds = decodeBody(ErrorBody)(
      await site().get("/wp/v2/posts", [
        ["page", "0"],
        ["per_page", "500"],
      ]),
    );
    expect(bounds.data.params).toEqual({
      page: "page must be greater than or equal to 1",
      per_page: "per_page must be between 1 (inclusive) and 100 (inclusive)",
    });
  });

  it("refuses a parameter the post type doesn't take, or whose column the binding leaves out", async () => {
    expect(await refused("/wp/v2/posts", [["parent", "1"]])).toEqual([
      "rest_invalid_param",
      ["parent"],
    ]);
    expect(
      await refused("/wp/v2/media", [
        ["media_type", "hologram"],
        ["menu_order", "1"],
      ]),
    ).toEqual(["rest_invalid_param", ["menu_order", "media_type"]]);
    const narrow = site({ columns: { slug: "slug", date: "publishedAt", modified: "updatedAt" } });
    expect(
      await refused(
        "/wp/v2/pages",
        [
          ["author", "1"],
          ["parent", "1"],
        ],
        narrow,
      ),
    ).toEqual(["rest_invalid_param", ["author", "parent"]]);
  });

  it("refuses context=edit on a collection, as core does for a caller who can't edit", async () => {
    const wp = site();
    const anonymous = await wp.get("/wp/v2/posts", [["context", "edit"]]);
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, "rest_forbidden_context"]);
    const member_ = await wp.get("/wp/v2/posts", [["context", "edit"]], Option.some(member));
    expect([member_.status, codeOf(member_)]).toEqual([403, "rest_forbidden_context"]);
  });

  it("answers an orderby whose column is unbound or unsortable as rest_invalid_param", async () => {
    const narrow = site({ columns: { slug: "slug", date: "publishedAt", modified: "updatedAt" } });
    expect(
      decodeBody(ErrorBody)(await narrow.get("/wp/v2/posts", [["orderby", "title"]])).data.params,
    ).toEqual({ orderby: "orderby title is not supported for this post type." });
    const unsortable = site({
      columns: { slug: "slug", date: "publishedAt", modified: "updatedAt", title: "subtitle" },
    });
    expect(
      decodeBody(ErrorBody)(await unsortable.get("/wp/v2/posts", [["orderby", "title"]])).data
        .params,
    ).toEqual({ orderby: "orderby title is not sortable for this post type." });
  });
});

describe("the wp/v2 read API — every filter and order", () => {
  it("lists media under the inherit default, and filters it by mime_type and media_type", async () => {
    const wp = site();
    const jpeg = await wp.create("media", { mimeType: "image/jpeg" });
    await wp.create("media", { mimeType: "image/png" });
    expect(listed(await wp.get("/wp/v2/media", [["mime_type", "image/jpeg"]]))).toEqual([
      jpeg.wireId,
    ]);
    // The in-memory leaf has no media-type column; a binding that names one filters on it.
    const typed = site({
      columns: { slug: "slug", date: "publishedAt", modified: "updatedAt", mediaType: "mimeType" },
    });
    const image = await typed.create("media", { mimeType: "image" });
    expect(listed(await typed.get("/wp/v2/media", [["media_type", "image"]]))).toEqual([
      image.wireId,
    ]);
    // An attachment is never `publish` or `future`, and a post is never `inherit`.
    expect(
      listed(await wp.get("/wp/v2/media", [["status", "publish,future"]], Option.some(member))),
    ).toEqual([]);
    expect(
      listed(await wp.get("/wp/v2/posts", [["status", "inherit"]], Option.some(member))),
    ).toEqual([]);
  });

  it("filters pages by author, author_exclude, parent, parent_exclude and menu_order", async () => {
    const wp = site();
    const top = await wp.create("pages", { slug: "top", menuOrder: 1 });
    const child = await wp.create("pages", { slug: "child", parentId: top.id, menuOrder: 2 });
    const theirs = await wp.create("pages", { slug: "theirs", parentId: child.id }, stranger);
    const memberWire = 1;
    const strangerWire = 2;
    const of = (query: ReadonlyArray<readonly [string, string]>) =>
      wp.get("/wp/v2/pages", [["orderby", "slug"], ["order", "asc"], ...query]).then(listed);
    expect(await of([["author", String(memberWire)]])).toEqual([child.wireId, top.wireId]);
    expect(await of([["author_exclude", String(memberWire)]])).toEqual([theirs.wireId]);
    expect(await of([["author", String(strangerWire)]])).toEqual([theirs.wireId]);
    expect(await of([["parent", String(top.wireId)]])).toEqual([child.wireId]);
    // `top` has no parent, which WordPress stores as `post_parent = 0` and keeps (pulpit#170).
    expect(await of([["parent_exclude", String(top.wireId)]])).toEqual([theirs.wireId, top.wireId]);
    expect(await of([["menu_order", "2"]])).toEqual([child.wireId]);
  });

  it("keeps every top-level page under parent_exclude, as WordPress does (pulpit#170)", async () => {
    const wp = site();
    const top = await wp.create("pages", { slug: "top" });
    const child = await wp.create("pages", { slug: "child", parentId: top.id });
    const theirs = await wp.create("pages", { slug: "theirs" }, stranger);
    const of = (query: ReadonlyArray<readonly [string, string]>) =>
      wp.get("/wp/v2/pages", [["orderby", "slug"], ["order", "asc"], ...query]).then(listed);
    expect(await of([["parent_exclude", String(top.wireId)]])).toEqual([theirs.wireId, top.wireId]);
    expect(await of([["parent_exclude", String(child.wireId)]])).toEqual([
      child.wireId,
      theirs.wireId,
      top.wireId,
    ]);
  });

  it("filters by modified_after and modified_before, and skips offset rows", async () => {
    const wp = site();
    const old = await wp.create("posts", { slug: "old", updatedAt: PAST });
    const recent = await wp.create("posts", { slug: "recent", updatedAt: NOW });
    expect(
      listed(await wp.get("/wp/v2/posts", [["modified_after", "2026-06-01T00:00:00Z"]])),
    ).toEqual([recent.wireId]);
    expect(
      listed(await wp.get("/wp/v2/posts", [["modified_before", "2026-06-01T00:00:00Z"]])),
    ).toEqual([old.wireId]);
    expect(
      listed(
        await wp.get("/wp/v2/posts", [
          ["orderby", "slug"],
          ["offset", "1"],
        ]),
      ),
    ).toEqual([old.wireId]);
  });

  it("orders by author, id, modified, title, parent and menu_order", async () => {
    const wp = site();
    const first = await wp.create("pages", {
      slug: "b",
      title: "Beta",
      menuOrder: 2,
      updatedAt: NOW,
    });
    const second = await wp.create("pages", {
      slug: "a",
      title: "Alpha",
      menuOrder: 1,
      parentId: first.id,
      updatedAt: PAST,
    });
    const orderedBy = (orderby: string) =>
      wp
        .get("/wp/v2/pages", [
          ["orderby", orderby],
          ["order", "asc"],
        ])
        .then(listed);
    const sorted = await inSequence(
      ["author", "id", "modified", "title", "parent", "menu_order"],
      async (orderby) => [orderby, (await orderedBy(orderby)).length],
    );
    expect(sorted).toEqual([
      ["author", 2],
      ["id", 2],
      ["modified", 2],
      ["title", 2],
      ["parent", 2],
      ["menu_order", 2],
    ]);
    expect(await orderedBy("title")).toEqual([second.wireId, first.wireId]);
    expect(await orderedBy("menu_order")).toEqual([second.wireId, first.wireId]);
    expect(await orderedBy("modified")).toEqual([second.wireId, first.wireId]);
  });

  it("lists status=any and status=private for the owner, and pending as nothing", async () => {
    const wp = site();
    const shown = await wp.create("posts", { slug: "shown" });
    const drafted = await wp.create("posts", { slug: "drafted", draft: true });
    const hidden = await wp.create("posts", { slug: "hidden", visibility: "private" });
    const owner = Option.some(member);
    const asc = [
      ["orderby", "slug"],
      ["order", "asc"],
    ] as const;
    expect(listed(await wp.get("/wp/v2/posts", [...asc, ["status", "any"]], owner))).toEqual([
      drafted.wireId,
      hidden.wireId,
      shown.wireId,
    ]);
    expect(listed(await wp.get("/wp/v2/posts", [["status", "private"]], owner))).toEqual([
      hidden.wireId,
    ]);
    expect(listed(await wp.get("/wp/v2/posts", [["status", "pending"]], owner))).toEqual([]);
  });

  it("selects nothing by draft or private, and everything live by publish, without those columns", async () => {
    const wp = site({ columns: { slug: "slug", date: "publishedAt", modified: "updatedAt" } });
    const post = await wp.create("posts", {});
    const owner = Option.some(member);
    expect(listed(await wp.get("/wp/v2/posts", [["status", "draft,private"]], owner))).toEqual([]);
    expect(listed(await wp.get("/wp/v2/posts", [], owner))).toEqual([post.wireId]);
  });
});

describe("the wp/v2 read API — item forms and failures", () => {
  it("answers context=embed for an item and a list, with an attachment's media fields only when it has media", async () => {
    const wp = site();
    const bare = await wp.create("media", { slug: "bare" });
    const withMedia = await wp.create("media", { mimeType: "image/jpeg", slug: "photo" });
    const embedOf = async (wireId: number) =>
      Record.keys(objectOf(await wp.get(`/wp/v2/media/${wireId}`, [["context", "embed"]])));
    expect(await embedOf(bare.wireId)).not.toContain("source_url");
    expect(await embedOf(withMedia.wireId)).toContain("source_url");
    const embedded = decodeBody(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
      await wp.get("/wp/v2/media", [["context", "embed"]]),
    );
    expect(embedded.map((item) => Record.has(item, "description"))).toEqual([false, false]);
    const post = await wp.create("posts", {});
    expect(
      Record.keys(objectOf(await wp.get(`/wp/v2/posts/${post.wireId}`, [["context", "embed"]]))),
    ).not.toContain("content");
  });

  it("answers an attachment without media with empty file fields, and its post as post", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    const media = await wp.create("media", { slug: "bare", parentId: post.id });
    const body = objectOf(await wp.get(`/wp/v2/media/${media.wireId}`));
    expect([body["source_url"], body["filename"], body["filesize"], body["post"]]).toEqual([
      "",
      "",
      null,
      post.wireId,
    ]);
  });

  it("falls back to the modified date for an item with no published date", async () => {
    const wp = site();
    const post = await wp.create("posts", { publishedAt: null, updatedAt: NOW });
    expect(objectOf(await wp.get(`/wp/v2/posts/${post.wireId}`))["date"]).toBe(
      "2026-10-22T11:00:00",
    );
  });

  it("keeps a whole field asked for twice, a scalar asked for by a sub-field, and skips a missing one", async () => {
    const wp = site();
    const post = await wp.create("posts", {});
    expect(
      objectOf(
        await wp.get(`/wp/v2/posts/${post.wireId}`, [
          ["_fields", "title,title.rendered,slug.part,nothing"],
        ]),
      ),
    ).toEqual({ title: { rendered: "<title>A title</title>" }, slug: "a-slug" });
  });

  it("is public for the anonymous when an embedded parent is serveable", async () => {
    const wp = site();
    const parent = await wp.create("pages", { slug: "parent" });
    const child = await wp.create("pages", { slug: "child", parentId: parent.id });
    const response = await wp.get(`/wp/v2/pages/${child.wireId}`, [["_embed", "up"]]);
    expect(response.headers["cache-control"]).toBe("public");
  });

  it("reads no related node of an unbound type", async () => {
    const wp = site({ bound: ["post"] });
    const media = await wp.create("media", { mimeType: "image/jpeg" });
    const post = await wp.create("posts", { featuredMediaId: media.id });
    expect(itemOf(await wp.get(`/wp/v2/posts/${post.wireId}`)).featured_media).toBe(0);
    expect(codeOf(await wp.get(`/wp/v2/media/${media.wireId}`))).toBe("rest_no_route");
  });

  it("answers a failing renderer, store or codec as 500 internal_server_error", async () => {
    const rendering = site({ failing: "render" });
    const post = await rendering.create("posts", {});
    const failed = await rendering.get(`/wp/v2/posts/${post.wireId}`);
    expect([failed.status, codeOf(failed)]).toEqual([500, "internal_server_error"]);
    const listing = await site({ failing: "list" }).get("/wp/v2/posts");
    expect([listing.status, codeOf(listing)]).toEqual([500, "internal_server_error"]);
    // The author codec knows only the accounts assigned it, as a real codec's table does.
    const wp = site();
    const outsider: ViewerAccount = { id: "u-outsider", role: "user" };
    const theirs = await wp.create("posts", {}, outsider);
    expect(codeOf(await wp.get(`/wp/v2/posts/${theirs.wireId}`))).toBe("internal_server_error");
  });

  it("answers a path outside the prefix as rest_no_route", async () => {
    const wp = site();
    const response = await run(wp.api.handle({ method: "GET", path: "/elsewhere", query: [] }));
    expect(codeOf(response)).toBe("rest_no_route");
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

// ── Phase 2: taxonomies and authors ─────────────────────────────────────

const Term = Schema.Struct({
  id: Schema.Number,
  count: Schema.optionalKey(Schema.Number),
  parent: Schema.optionalKey(Schema.Number),
  slug: Schema.String,
  _links: Schema.Record(Schema.String, Schema.Json),
});
const termOf = decodeBody(Term);
const termsOf = decodeBody(Schema.Array(Term));
const User = Schema.Struct({ id: Schema.Number, slug: Schema.String });
const usersOf = decodeBody(Schema.Array(User));
const sorted = (values: ReadonlyArray<number>) => Arr.sort(values, Order.Number);

/**
 * A site with both taxonomies bound: `news` and its child `sport`
 * (categories), `hot` (a tag); the member's public `open` post in `news`,
 * their draft in `news` and `sport`, and a stranger's public post tagged
 * `hot`; a moderator owns only a draft.
 */
const taxonomySite = async () => {
  const wp = site({ terms: true });
  const news = await wp.createTerm("category", { name: "News", slug: "news" });
  const sport = await wp.createTerm("category", {
    name: "Sport",
    slug: "sport",
    parentId: news.id,
  });
  const hot = await wp.createTerm("post_tag", { name: "Hot", slug: "hot" });
  const open = await wp.create("posts", { slug: "open" });
  const draft = await wp.create("posts", { slug: "draft", draft: true });
  const theirs = await wp.create("posts", { slug: "theirs" }, stranger);
  await wp.create("posts", { slug: "moderated", draft: true }, moderator);
  await wp.assign("category", open.id, news.id);
  await wp.assign("category", draft.id, news.id);
  await wp.assign("category", draft.id, sport.id);
  await wp.assign("post_tag", theirs.id, hot.id);
  return { wp, news, sport, hot, open, draft, theirs };
};

describe("the wp/v2 read API — taxonomies (phase 2)", () => {
  it("counts only the assignments the viewer can read (EDGE-001), and hide_empty drops the rest", async () => {
    const { wp, news, sport } = await taxonomySite();
    const counts = async (who: Viewer, query: ReadonlyArray<readonly [string, string]> = []) =>
      termsOf(await wp.get("/wp/v2/categories", query, who)).map(({ id, count }) => [id, count]);
    expect(await counts(Option.none())).toEqual([
      [news.wireId, 1],
      [sport.wireId, 0],
    ]);
    expect(await counts(Option.some(member))).toEqual([
      [news.wireId, 2],
      [sport.wireId, 1],
    ]);
    expect(await counts(Option.none(), [["hide_empty", "true"]])).toEqual([[news.wireId, 1]]);
    expect(await counts(Option.some(member), [["hide_empty", "1"]])).toHaveLength(2);
    expect(
      await counts(Option.some(member), [
        ["orderby", "count"],
        ["order", "asc"],
      ]),
    ).toEqual([
      [sport.wireId, 1],
      [news.wireId, 2],
    ]);
  });

  it("answers the total and the paging headers, with an empty page past the end as core does", async () => {
    const { wp } = await taxonomySite();
    const first = await wp.get("/wp/v2/categories", [["per_page", "1"]]);
    expect([first.headers["x-wp-total"], first.headers["x-wp-totalpages"]]).toEqual(["2", "2"]);
    expect(first.headers["link"]).toContain('rel="next"');
    const past = await wp.get("/wp/v2/categories", [["page", "9"]]);
    expect([past.status, termsOf(past)]).toEqual([200, []]);
  });

  it("filters terms by include, exclude, slug, parent and post", async () => {
    const { wp, news, sport, open, draft } = await taxonomySite();
    const ids = async (
      query: ReadonlyArray<readonly [string, string]>,
      who: Viewer = Option.none(),
    ) => termsOf(await wp.get("/wp/v2/categories", query, who)).map(({ id }) => id);
    expect(await ids([["slug", "sport"]])).toEqual([sport.wireId]);
    expect(await ids([["exclude", String(news.wireId)]])).toEqual([sport.wireId]);
    expect(await ids([["parent", "0"]])).toEqual([news.wireId]);
    expect(await ids([["parent", String(news.wireId)]])).toEqual([sport.wireId]);
    expect(await ids([["post", String(open.wireId)]])).toEqual([news.wireId]);
    expect(await ids([["post", String(draft.wireId)]], Option.some(member))).toEqual([
      news.wireId,
      sport.wireId,
    ]);
    expect(
      await ids([
        ["include", `${sport.wireId},${news.wireId}`],
        ["orderby", "include"],
      ]),
    ).toEqual([sport.wireId, news.wireId]);
  });

  it("answers post= for a post the viewer can't read as an unknown post (SEC-AUTH-ENUM-001)", async () => {
    const { wp, draft } = await taxonomySite();
    const hidden = await wp.get("/wp/v2/categories", [["post", String(draft.wireId)]]);
    const unknown = await wp.get("/wp/v2/categories", [["post", "999"]]);
    expect([hidden.status, codeOf(hidden)]).toEqual([400, "rest_post_invalid_id"]);
    expect([unknown.status, codeOf(unknown)]).toEqual([400, "rest_post_invalid_id"]);
  });

  it("answers one term, its readable parent, and 404 rest_term_invalid for an unknown id", async () => {
    const { wp, news, sport, hot } = await taxonomySite();
    const child = termOf(await wp.get(`/wp/v2/categories/${sport.wireId}`));
    expect(child.parent).toBe(news.wireId);
    expect(Record.has(child._links, "up")).toBe(true);
    expect(termOf(await wp.get(`/wp/v2/tags/${hot.wireId}`)).parent).toBeUndefined();
    const missing = await wp.get("/wp/v2/categories/999");
    expect([missing.status, codeOf(missing)]).toEqual([404, "rest_term_invalid"]);
    const edit = await wp.get(`/wp/v2/tags/${hot.wireId}`, [["context", "edit"]]);
    expect([edit.status, codeOf(edit)]).toEqual([401, "rest_forbidden_context"]);
  });

  it("refuses the term parameters it can't honour", async () => {
    const { wp } = await taxonomySite();
    const refused = await inSequence(
      [
        ["/wp/v2/categories", "search", "news"],
        ["/wp/v2/categories", "orderby", "term_group"],
        ["/wp/v2/tags", "parent", "1"],
        ["/wp/v2/tags", "hide_empty", "maybe"],
      ] as const,
      ([path, name, value]) => wp.get(path, [[name, value]]),
    );
    expect(refused.map(codeOf)).toEqual(refused.map(() => "rest_invalid_param"));
  });
});

describe("the wp/v2 read API — items and their terms (phase 2)", () => {
  it("lists the members of a term through memberFilter, joined by tax_relation", async () => {
    const { wp, news, sport, hot, open, theirs } = await taxonomySite();
    const ids = async (query: ReadonlyArray<readonly [string, string]>) =>
      sorted(listed(await wp.get("/wp/v2/posts", query)));
    expect(await ids([["categories", String(news.wireId)]])).toEqual([open.wireId]);
    // The only post in `sport` is a draft: nothing an anonymous viewer can read.
    expect(await ids([["categories", String(sport.wireId)]])).toEqual([]);
    expect(await ids([["tags", String(hot.wireId)]])).toEqual([theirs.wireId]);
    expect(
      await ids([
        ["categories", String(news.wireId)],
        ["tags", String(hot.wireId)],
      ]),
    ).toEqual([]);
    expect(
      await ids([
        ["categories", String(news.wireId)],
        ["tags", String(hot.wireId)],
        ["tax_relation", "OR"],
      ]),
    ).toEqual(sorted([open.wireId, theirs.wireId]));
    expect(await ids([["categories", "999"]])).toEqual([]);
  });

  it("refuses the _exclude forms (pulpit#191) and a taxonomy the post type doesn't take", async () => {
    const { wp, news } = await taxonomySite();
    const exclude = await wp.get("/wp/v2/posts", [["categories_exclude", String(news.wireId)]]);
    const onPages = await wp.get("/wp/v2/pages", [["categories", String(news.wireId)]]);
    expect([codeOf(exclude), codeOf(onPages)]).toEqual([
      "rest_invalid_param",
      "rest_invalid_param",
    ]);
  });

  it("shows an item's readable terms, its wp:term link and its embedded terms, one read per taxonomy", async () => {
    const { wp, news, hot, open, theirs } = await taxonomySite();
    const Shown = Schema.Struct({
      id: Schema.Number,
      categories: Schema.Array(Schema.Number),
      tags: Schema.Array(Schema.Number),
      _links: Schema.Struct({
        "wp:term": Schema.Array(Schema.Struct({ taxonomy: Schema.String })),
      }),
      _embedded: Schema.Struct({
        "wp:term": Schema.Array(Schema.Array(Schema.Struct({ id: Schema.Number }))),
      }),
    });
    const before = wp.termReads.length;
    const items = decodeBody(Schema.Array(Shown))(
      await wp.get("/wp/v2/posts", [["_embed", "wp:term"]]),
    );
    const byId = (id: number) => items.find((item) => item.id === id);
    expect([byId(open.wireId)?.categories, byId(open.wireId)?.tags]).toEqual([[news.wireId], []]);
    expect([byId(theirs.wireId)?.categories, byId(theirs.wireId)?.tags]).toEqual([
      [],
      [hot.wireId],
    ]);
    expect(byId(open.wireId)?._links["wp:term"].map(({ taxonomy }) => taxonomy)).toEqual([
      "category",
      "post_tag",
    ]);
    expect(
      byId(open.wireId)?._embedded["wp:term"].map((terms) => terms.map(({ id }) => id)),
    ).toEqual([[news.wireId], []]);
    expect(wp.termReads.slice(before).map(([taxonomy]) => taxonomy)).toEqual([
      "category",
      "post_tag",
    ]);
  });

  it("never shows a term through an item the viewer can't read", async () => {
    const { wp, draft } = await taxonomySite();
    expect(codeOf(await wp.get(`/wp/v2/posts/${draft.wireId}`))).toBe("rest_post_invalid_id");
    const own = decodeBody(Schema.Struct({ categories: Schema.Array(Schema.Number) }))(
      await wp.get(`/wp/v2/posts/${draft.wireId}`, [], Option.some(member)),
    );
    expect(own.categories).toHaveLength(2);
  });
});

describe("the wp/v2 read API — authors (phase 2)", () => {
  it("lists only the authors of an item the viewer can read (SEC-AUTH-ENUM-001)", async () => {
    const { wp } = await taxonomySite();
    const slugs = async (who: Viewer, query: ReadonlyArray<readonly [string, string]> = []) =>
      usersOf(await wp.get("/wp/v2/users", query, who)).map(({ slug }) => slug);
    expect(await slugs(Option.none())).toEqual([member.id, stranger.id]);
    expect(await slugs(Option.some(moderator))).toEqual([member.id, moderator.id, stranger.id]);
    expect(await slugs(Option.none(), [["slug", stranger.id]])).toEqual([stranger.id]);
    expect(
      await slugs(Option.none(), [["exclude", String(wp.accounts.assign(member.id))]]),
    ).toEqual([stranger.id]);
    expect(await slugs(Option.none(), [["order", "desc"]])).toEqual([stranger.id, member.id]);
    const response = await wp.get("/wp/v2/users");
    expect([response.headers["x-wp-total"], response.headers["cache-control"]]).toEqual([
      "2",
      "private, no-store",
    ]);
  });

  it("answers an account with no readable item as 404 rest_user_invalid_id, exactly as an unknown one", async () => {
    const { wp } = await taxonomySite();
    const hidden = await wp.get(`/wp/v2/users/${wp.accounts.assign(moderator.id)}`);
    const unknown = await wp.get("/wp/v2/users/999");
    expect([hidden.status, codeOf(hidden)]).toEqual([404, "rest_user_invalid_id"]);
    expect([unknown.status, codeOf(unknown)]).toEqual([404, "rest_user_invalid_id"]);
    const shown = await wp.get(
      `/wp/v2/users/${wp.accounts.assign(moderator.id)}`,
      [],
      Option.some(moderator),
    );
    expect(shown.status).toBe(200);
  });

  it("answers an order core reserves for list_users as rest_forbidden_orderby, and refuses search", async () => {
    const { wp } = await taxonomySite();
    const email = await wp.get("/wp/v2/users", [["orderby", "email"]]);
    expect([email.status, codeOf(email)]).toEqual([401, "rest_forbidden_orderby"]);
    expect(codeOf(await wp.get("/wp/v2/users", [["search", "a"]]))).toBe("rest_invalid_param");
  });
});

describe("the wp/v2 read API — phase 2 wire forms (golden)", () => {
  it("answers terms and users in core's forms", async () => {
    const { wp, news, hot, open } = await taxonomySite();
    const category = await wp.get(`/wp/v2/categories/${news.wireId}`);
    expect(formOf(withoutLinks(category))).toEqual(adjusted(CATEGORY_FORM));
    expect(formOf(termOf(category)._links)).toEqual(TERM_LINKS_FORM);
    expect(formOf(withoutLinks(await wp.get(`/wp/v2/tags/${hot.wireId}`)))).toEqual(
      adjusted(TAG_FORM),
    );
    expect(
      formOf(withoutLinks(await wp.get(`/wp/v2/users/${wp.accounts.assign(member.id)}`))),
    ).toEqual(adjusted(USER_FORM));
    const links = itemOf(await wp.get(`/wp/v2/posts/${open.wireId}`))._links;
    expect(formOf(links["wp:term"] ?? null)).toEqual(WP_TERM_LINK_FORM);
  });

  it("lists the bound taxonomies in the discovery index", async () => {
    const { wp } = await taxonomySite();
    const index = decodeBody(Schema.Struct({ routes: Schema.Record(Schema.String, Schema.Json) }))(
      await wp.get("/"),
    );
    expect(Record.keys(index.routes)).toEqual(
      expect.arrayContaining(["/wp/v2/categories", "/wp/v2/tags/(?P<id>[\\d]+)", "/wp/v2/users"]),
    );
  });
});

describe("the wp/v2 read API — media from a file leaf (pulpit#221)", () => {
  it("reads a file whose bytes are pending as missing: 404, out of lists and totals, never featured", async () => {
    const wp = site();
    const ready = await wp.create("media", { mimeType: "image/jpeg", slug: "ready" });
    const pending = await wp.create("media", { mimeType: "image/jpeg", bytesPending: true });
    const post = await wp.create("posts", { featuredMediaId: pending.id });

    expect(codeOf(await wp.get(`/wp/v2/media/${pending.wireId}`))).toBe("rest_post_invalid_id");
    const list = await wp.get("/wp/v2/media");
    expect(listed(list)).toEqual([ready.wireId]);
    expect(list.headers["x-wp-total"]).toBe("1");
    const item = itemOf(await wp.get(`/wp/v2/posts/${post.wireId}`, [["_embed", "1"]]));
    expect(item.featured_media).toBe(0);
    expect(Record.has(item._embedded ?? {}, "wp:featuredmedia")).toBe(false);
    // Its owner, too, reads it as missing until the bytes are there.
    expect(codeOf(await wp.get(`/wp/v2/media/${pending.wireId}`, [], Option.some(member)))).toBe(
      "rest_post_invalid_id",
    );
  });

  it("maps a file version onto the media fields", () => {
    const file = {
      contentHash: "a".repeat(64),
      byteSize: 2048,
      mediaType: "image/png",
      filename: "fern.png",
      bytesPending: false,
    };
    const blobs = { publicUrl: (key: string) => Option.some(`https://cdn.example.org/${key}`) };
    const described = { caption: "c", description: "d", altText: "A fern" };
    const media = fileMediaFields(file, blobs, described);
    expect(media).toMatchObject({
      mediaType: "image",
      mimeType: "image/png",
      altText: "A fern",
      fileSize: Option.some(2048),
      bytesPending: false,
      mediaDetails: {},
    });
    expect(media.sourceUrl).toMatch(/^https:\/\/cdn\.example\.org\//);
    // Pending bytes: no URL, and the item is marked pending.
    const pendingMedia = fileMediaFields({ ...file, bytesPending: true }, blobs, described);
    expect([pendingMedia.sourceUrl, pendingMedia.bytesPending]).toEqual(["", true]);
    // A top-level type WordPress doesn't name is `application`.
    expect(fileMediaFields({ ...file, mediaType: "model/gltf" }, blobs, described).mediaType).toBe(
      "application",
    );
    expect(
      fileMediaFields(file, blobs, { ...described, mediaDetails: { width: 10 } }).mediaDetails,
    ).toEqual({ width: 10 });
  });
});
