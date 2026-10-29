/**
 * Hybrid search (pulpit#204).
 *
 * - RRF fusion on fixed rankings: website's and gardeneria's `search.ts`
 *   fuse their branches as `Σ weight / (60 + rank)`.
 * - The reranker may reorder the fused candidates, never add or drop one.
 * - Every branch is handed the same scope, and a branch that ranks a row
 *   outside it fails `SearchScopeLeak` under `scopeCheckedBranch`.
 * - The embedding pipeline: enqueue on first insert, one batch per
 *   `embedPending`, and the sweep.
 *
 * @module tests/search
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { always, eq, never, type FilterRow, type ListFilter } from "../src/filter.ts";
import {
  applyReranking,
  embedPending,
  enqueueEmbeddings,
  fuseRankings,
  hybridSearch,
  RRF_K,
  sweepEmbeddings,
  type FusedHit,
  type SearchBranch,
} from "../src/search.ts";
import {
  makeInMemoryDocumentStore,
  makeInMemoryEmbeddingStore,
  makeInMemorySearchBranch,
  scopeCheckedBranch,
  type InMemoryFollowing,
} from "../src/testing.ts";
import { NOW } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const ids = (hits: ReadonlyArray<{ readonly id: string }>) => hits.map((hit) => hit.id);
const hitsOf = (...names: ReadonlyArray<string>) => names.map((id) => ({ id }));

describe("fuseRankings", () => {
  it("scores each hit Σ weight / (k + rank) and orders by score, then id", () => {
    const fused = fuseRankings([
      { name: "text", hits: hitsOf("a", "b", "c") },
      { name: "vector", hits: hitsOf("c", "b") },
    ]);
    // c: 1/63 + 1/61 beats b: 1/62 + 1/62, and both beat a's lone first place.
    expect(ids(fused)).toEqual(["c", "b", "a"]);
    const [c, b, a] = fused;
    expect(b).toEqual({
      id: "b",
      score: 1 / (RRF_K + 2) + 1 / (RRF_K + 2),
      ranks: { text: 2, vector: 2 },
    });
    expect(c?.score).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1));
    expect(a).toEqual({ id: "a", score: 1 / (RRF_K + 1), ranks: { text: 1 } });
  });

  it("breaks a tie by id in code-point order", () => {
    const fused = fuseRankings([
      { name: "one", hits: hitsOf("b") },
      { name: "two", hits: hitsOf("a") },
    ]);
    expect(ids(fused)).toEqual(["a", "b"]);
  });

  it("weights a branch, and scores nothing for a weight that is not a finite non-negative number", () => {
    const branches = (weight: number) => [
      { name: "text", hits: hitsOf("a") },
      { name: "vector", weight, hits: hitsOf("b") },
    ];
    expect(ids(fuseRankings(branches(2)))).toEqual(["b", "a"]);
    Arr.forEach([Number.NaN, -1, Number.POSITIVE_INFINITY], (weight) =>
      expect(fuseRankings(branches(weight)).find((hit) => hit.id === "b")?.score).toBe(0),
    );
  });

  it("keeps a repeated id's first rank, counts only perBranch hits, and caps at limit", () => {
    const fused = fuseRankings([{ name: "text", hits: hitsOf("a", "a", "b", "c") }], {
      perBranch: 2,
    });
    expect(fused).toEqual([
      { id: "a", score: 1 / (RRF_K + 1), ranks: { text: 1 } },
      { id: "b", score: 1 / (RRF_K + 2), ranks: { text: 2 } },
    ]);
    expect(ids(fuseRankings([{ name: "text", hits: hitsOf("a", "b") }], { limit: 1 }))).toEqual([
      "a",
    ]);
  });

  it("takes k, and falls back to RRF_K for a k that is not finite and positive", () => {
    const one = [{ name: "text", hits: hitsOf("a") }];
    expect(fuseRankings(one, { k: 1 })[0]?.score).toBe(1 / 2);
    expect(fuseRankings(one, { k: 0 })[0]?.score).toBe(1 / (RRF_K + 1));
  });

  it("fuses nothing to nothing", () => {
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([{ name: "text", hits: [] }])).toEqual([]);
  });
});

describe("applyReranking", () => {
  const candidates: ReadonlyArray<FusedHit> = ["a", "b", "c"].map((id, index) => ({
    id,
    score: 3 - index,
    ranks: {},
  }));

  it("puts the reranker's order first, then what it omitted in fused order", () => {
    expect(ids(applyReranking(candidates, ["c", "a"]))).toEqual(["c", "a", "b"]);
  });

  it("never adds an unknown id and never repeats one", () => {
    expect(ids(applyReranking(candidates, ["x", "b", "b"]))).toEqual(["b", "a", "c"]);
  });
});

describe("hybridSearch", () => {
  type Row = FilterRow & { readonly id: string };
  const rows: ReadonlyArray<Row> = [
    { id: "p-public", visibility: "public", title: "tomato soup", tag: "tomato" },
    { id: "p-private", visibility: "private", title: "tomato secret", tag: "tomato" },
    { id: "p-other", visibility: "public", title: "basil", tag: "tomato" },
  ];
  const text = makeInMemorySearchBranch({
    name: "text",
    rows: () => rows,
    score: (row, query) =>
      Option.filter(Option.liftPredicate(row["title"] ?? null, Predicate.isString), (title) =>
        title.includes(query),
      ).pipe(Option.map((title) => title.length)),
    now: NOW,
  });
  const tags = makeInMemorySearchBranch({
    name: "tags",
    rows: () => rows,
    score: (row, query) => (row["tag"] === query ? Option.some(1) : Option.none()),
    now: NOW,
  });
  const publicOnly: ListFilter<InMemoryFollowing> = eq("visibility", "public");

  it("hands every branch the same scope, so no branch ranks a hidden row", async () => {
    const asked: Array<unknown> = [];
    const spy = (branch: SearchBranch<InMemoryFollowing, never, never>) => ({
      ...branch,
      search: (request: Parameters<typeof branch.search>[0]) => {
        asked.push(request.scope);
        return branch.search(request);
      },
    });
    const search = hybridSearch({ branches: [spy(text), spy(tags)] });
    const hits = await run(search({ query: "tomato", scope: publicOnly, limit: 10 }));
    expect(asked).toEqual([publicOnly, publicOnly]);
    expect(ids(hits)).toEqual(["p-public", "p-other"]);
    expect(ids(await run(search({ query: "tomato", scope: always, limit: 10 })))).toContain(
      "p-private",
    );
    expect(await run(search({ query: "tomato", scope: never, limit: 10 }))).toEqual([]);
  });

  it("asks no branch for an empty query, and caps the result at the limit", async () => {
    let called = 0;
    const counting: SearchBranch<InMemoryFollowing, never, never> = {
      ...text,
      search: (request) => Effect.suspend(() => ((called += 1), text.search(request))),
    };
    const search = hybridSearch({ branches: [counting, tags] });
    expect(await run(search({ query: "  ", scope: always, limit: 10 }))).toEqual([]);
    expect(called).toBe(0);
    expect(await run(search({ query: "tomato", scope: always, limit: 1 }))).toHaveLength(1);
  });

  it("lets a reranker reorder the fused candidates and nothing more", async () => {
    let shown: ReadonlyArray<string> = [];
    const search = hybridSearch({
      branches: [text, tags],
      reranker: {
        rerank: (_, candidates) =>
          Effect.sync(() => {
            shown = ids(candidates);
            return ["p-other", "p-intruder"];
          }),
      },
    });
    const hits = await run(search({ query: "tomato", scope: publicOnly, limit: 10 }));
    expect(shown).toEqual(["p-public", "p-other"]);
    expect(ids(hits)).toEqual(["p-other", "p-public"]);
  });

  it("scopeCheckedBranch fails a branch that ranks a row outside its scope", async () => {
    const leaky: SearchBranch<InMemoryFollowing, never, never> = {
      name: "leaky",
      search: () => Effect.succeed(hitsOf("p-private")),
    };
    const checked = scopeCheckedBranch(leaky, { rows: () => rows, now: NOW });
    const exit = await Effect.runPromiseExit(
      hybridSearch({ branches: [checked] })({ query: "tomato", scope: publicOnly, limit: 10 }),
    );
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject(
      { _tag: "SearchScopeLeak", branch: "leaky", id: "p-private" },
    );
    // An unknown id fails too; an honest branch passes.
    const unknown = scopeCheckedBranch(
      { name: "ghost", search: () => Effect.succeed(hitsOf("nope")) },
      { rows: () => rows, now: NOW },
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(unknown.search({ query: "x", scope: always, limit: 10 })),
      ),
    ).toBe(true);
    const honest = scopeCheckedBranch(text, { rows: () => rows, now: NOW });
    expect(
      ids(await run(honest.search({ query: "tomato", scope: publicOnly, limit: 10 }))),
    ).toEqual(["p-public"]);
  });

  it("the in-memory branch reads the follower set through the scope", async () => {
    const following = HashSet.make("u-1");
    const followed: ReadonlyArray<Row> = [
      { id: "f-1", owner: "u-1", title: "tomato" },
      { id: "f-2", owner: "u-2", title: "tomato" },
    ];
    const branch = makeInMemorySearchBranch({
      name: "text",
      rows: () => followed,
      score: () => Option.some(1),
      now: NOW,
    });
    const scope = { kind: "in", column: "owner", set: following } as const;
    expect(ids(await run(branch.search({ query: "tomato", scope, limit: 10 })))).toEqual(["f-1"]);
  });
});

describe("the embedding pipeline", () => {
  type Doc = { readonly text: string };
  const setup = (batchSize = 2) => {
    const embeddings = makeInMemoryEmbeddingStore();
    const raw = makeInMemoryDocumentStore<Doc>();
    const documents = enqueueEmbeddings(raw, embeddings);
    const calls: Array<ReadonlyArray<string>> = [];
    const pipeline = {
      embeddings,
      documents,
      embedder: {
        embed: (texts: ReadonlyArray<string>) =>
          Effect.sync(() => {
            calls.push(texts);
            return texts.map((text) => [text.length]);
          }),
      },
      text: (document: Doc) => (document.text === "" ? Option.none() : Option.some(document.text)),
      batchSize,
    };
    return { embeddings, documents, calls, pipeline };
  };

  it("queues a document on its first insert only", async () => {
    const { embeddings, documents } = setup();
    const first = await run(documents.put({ text: "hello" }));
    await run(documents.put({ text: "hello" }));
    expect(embeddings.queued()).toEqual([first.hash]);
  });

  it("embeds one batch in one embedder call, and writes and dequeues it", async () => {
    const { embeddings, documents, calls, pipeline } = setup(2);
    const [a, b] = await run(
      Effect.forEach(["one", "three", "fifteen"], (text) => documents.put({ text }), {
        concurrency: 1,
      }),
    );
    const batch = await run(embedPending(pipeline));
    expect(batch).toEqual({ embedded: 2, discarded: 0 });
    expect(calls).toEqual([["one", "three"]]);
    expect(HashMap.get(embeddings.vectors(), a?.hash ?? "")).toEqual(Option.some([3]));
    expect(HashMap.has(embeddings.vectors(), b?.hash ?? "")).toBe(true);
    expect(embeddings.queued()).toHaveLength(1);
  });

  it("discards a pending document with no text rather than retrying it forever", async () => {
    const { embeddings, documents, calls, pipeline } = setup();
    await run(documents.put({ text: "" }));
    expect(await run(embedPending(pipeline))).toEqual({ embedded: 0, discarded: 1 });
    expect(calls).toEqual([]);
    expect(embeddings.queued()).toEqual([]);
  });

  it("fails EmbeddingMismatch and writes nothing when the embedder answers short", async () => {
    const { embeddings, documents, pipeline } = setup();
    await run(documents.put({ text: "one" }));
    const exit = await Effect.runPromiseExit(
      embedPending({ ...pipeline, embedder: { embed: () => Effect.succeed([]) } }),
    );
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject(
      { _tag: "EmbeddingMismatch", expected: 1, received: 0 },
    );
    expect(HashMap.size(embeddings.vectors())).toBe(0);
  });

  it("sweeps batch by batch until the queue drains, or stops at maxBatches", async () => {
    const { embeddings, documents, calls, pipeline } = setup(2);
    await run(
      Effect.forEach(["a", "bb", "ccc", "dddd", "eeeee"], (text) => documents.put({ text }), {
        concurrency: 1,
      }),
    );
    expect(await run(sweepEmbeddings(pipeline, 2))).toEqual({ embedded: 4, discarded: 0 });
    expect(embeddings.queued()).toHaveLength(1);
    expect(await run(sweepEmbeddings(pipeline, 10))).toEqual({ embedded: 1, discarded: 0 });
    expect(calls).toHaveLength(3);
    expect(await run(sweepEmbeddings(pipeline, 10))).toEqual({ embedded: 0, discarded: 0 });
  });
});
