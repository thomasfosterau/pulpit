/**
 * **UGC relation patterns** (pulpit#200): reshares (and quotes), accepted
 * answers and multi-author bylines, as small helpers over `./edges`,
 * `./collections` and `./subtype`. None of them adds a read rule: every
 * node is read through its own leaf's gate.
 *
 * The behavioural spec is gardeneria's posts (`sharedId`), questions and
 * answers, and its ordered `blog_post_authors`, with their tests. A `#NNN`
 * here names a gardeneria issue.
 *
 * ## Reshares (owner decision on pulpit#200)
 *
 * A reshare is an edge family `{ sharer, target }` with `maxEdges: 1` at
 * the sharing end, declared with {@link nodeWriteGate} on the sharer (only
 * whoever may write the sharing node may set what it shares). The family
 * itself keeps `EDGE-001`: its `list` and `get` hide an edge whose target
 * the viewer can't read, and its `create` refuses a target the writer can't
 * read.
 *
 * The owner's rule is that **a reshare of a node the viewer can't read
 * still shows, as a placeholder** carrying no target content and no target
 * id. {@link defineReshares} answers that one question: for a sharing node
 * the viewer can read, the target as the target leaf's own `get` serves it
 * ({@link ReshareTarget} `Visible`), or `Unavailable` when that gate hides
 * it (private, a draft, unpublished, tombstoned). It reads the stored edge
 * itself, outside `EDGE-001`, and discloses only that the sharing node
 * reshared *something*, which the sharing node's own readers may know; the
 * target's id never leaves it.
 *
 * ## Accepted answers
 *
 * An edge family `{ question, answer }` with `maxEdges: 1` at the question,
 * declared with {@link acceptedAnswerGate}: the write gate is the
 * question's own (its owner or the moderate rung, as the question leaf's
 * `update` gates), and the answer must belong to the question, as its
 * declared parent column says ({@link AnswerNotOfQuestion} otherwise).
 *
 * ## Bylines
 *
 * An ordered collection (`./collections`) of the node's credited accounts.
 * Credit only (owner decision on pulpit#200): a byline grants no write
 * right, because the node's write gate (`requireWriter`, owner or the
 * moderate rung) never reads it, and the collection's own writes pass the
 * node's write gate. See the package README → `./relations`.
 *
 * @copyright Thomas Foster
 * @module pulpit/relations
 * @since 0.2.0
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { EdgeRow, EdgeStore, EdgeWriteGate, EdgeWriteRequest, EndpointView } from "./edges.ts";
import { anyOf, MAX_SET_VALUES } from "./filter.ts";
import type { SubtypeOps } from "./subtype.ts";
import { NodeNotFound } from "./version-chain.ts";

// ── The write gate on one end's node ──────────────────────────────────

/**
 * An edge write gate that admits whoever may write the node at `column`:
 * the leaf's own write gate (`SubtypeOps.authorize`, as its `update` runs
 * it), so on an owned leaf its owner or the moderate rung, on a reference
 * leaf the corpus-write rung. An edge whose `column` holds no string fails
 * `NodeNotFound`. The reshare family's gate, on the sharing end.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import { nodeWriteGate } from "@thomasfosterau/pulpit/relations";
 *
 * const gate = nodeWriteGate("sharer", "posts", {
 *   authorize: (id) => Effect.succeed({ id: `owner-of-${id}`, role: "user" }),
 * });
 * const answer = Effect.runSync(
 *   Effect.flip(
 *     gate({
 *       viewer: Option.none(),
 *       policy: {
 *         canViewPrivate: () => false,
 *         canViewDeleted: () => false,
 *         canModerate: () => false,
 *         canWriteCorpus: () => false,
 *       },
 *       edge: { sharer: 1 },
 *     }),
 *   ),
 * );
 * strictEqual(answer._tag, "NodeNotFound");
 * ```
 *
 * @since 0.2.0
 */
export const nodeWriteGate =
  <Node, E, R>(
    column: string,
    type: string,
    leaf: Pick<SubtypeOps<Node, E, R>, "authorize">,
  ): EdgeWriteGate<E, R> =>
  (request: EdgeWriteRequest) =>
    Effect.flatMap(nodeAt(request, column, type), leaf.authorize);

/** The node id an edge holds at `column`, or `NodeNotFound` when it holds no string. */
const nodeAt = (
  request: EdgeWriteRequest,
  column: string,
  type: string,
): Effect.Effect<string, NodeNotFound> => {
  const id = request.edge[column];
  return P.isString(id) ? Effect.succeed(id) : Effect.fail(new NodeNotFound({ type, id: "" }));
};

// ── Reshares ──────────────────────────────────────────────────────────

/**
 * What a reshare shows of its target: the target as its own leaf's `get`
 * serves the viewer, or `Unavailable`, the placeholder for a target the
 * viewer can't read, carrying neither its content nor its id (owner
 * decision on pulpit#200).
 *
 * @since 0.2.0
 */
export type ReshareTarget<Target> =
  | { readonly _tag: "Visible"; readonly target: Target }
  | { readonly _tag: "Unavailable" };

/**
 * A reshare family's declaration: the sharing and target leaves' gated
 * reads, the reshare edge table and its two columns.
 *
 * @since 0.2.0
 */
export interface ReshareDefinition<Sharer, Target, Following, E, R> {
  /** The family's name, traced as `${type}.<operation>`. */
  readonly type: string;
  /** The sharing leaf: its `get` and `getMany` gate the sharing node. */
  readonly sharer: Pick<SubtypeOps<Sharer, E, R>, "get" | "getMany">;
  /** The target leaf: its `getMany` gates the target, so a hidden one is the placeholder. */
  readonly target: Pick<SubtypeOps<Target, E, R>, "getMany">;
  /** The reshare edge table (the family `./edges` declares over it). */
  readonly edges: Pick<EdgeStore<EdgeRow, Following, E, R>, "list">;
  /** The edge column holding the sharing node's id (its end with `maxEdges: 1`). */
  readonly sharerColumn: string;
  /** The edge column holding the target node's id. */
  readonly targetColumn: string;
}

/**
 * The operations {@link defineReshares} produces.
 *
 * @since 0.2.0
 */
export interface ReshareOps<Target, E, R> {
  /**
   * What the sharing node `id` reshares: none when it reshares nothing,
   * `Visible` with the target as its leaf's `get` serves the viewer, or
   * `Unavailable` when that gate hides it. Fails `NodeNotFound` when the
   * sharing node itself is hidden from the viewer, as its own `get` does
   * (`SEC-AUTH-ENUM-001`).
   */
  readonly targetOf: (
    id: string,
  ) => Effect.Effect<Option.Option<ReshareTarget<Target>>, NodeNotFound | E, R>;
  /**
   * {@link ReshareOps.targetOf} for a page of sharing nodes, in three
   * bounded reads (the sharers, their edges, the targets): a key for each
   * id the viewer can read that reshares something, none for the rest. More
   * than `MAX_SET_VALUES` ids (`SEC-INPUT-003`) reads nothing and answers
   * empty.
   */
  readonly targetsOf: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, ReshareTarget<Target>>, E, R>;
}

/** The placeholder: the same value for every hidden target. */
const unavailable: ReshareTarget<never> = { _tag: "Unavailable" };

/**
 * Bind a reshare family's reads. The edge itself is read from the store,
 * outside `EDGE-001`, so a sharing node the viewer can read shows that it
 * reshared something even when the target is hidden; nothing about the
 * target but its own leaf's answer leaves this module.
 *
 * @since 0.2.0
 */
export const defineReshares = <Sharer, Target, Following, E, R>(
  definition: ReshareDefinition<Sharer, Target, Following, E, R>,
): ReshareOps<Target, E, R> => {
  const { type, sharer, target, edges, sharerColumn, targetColumn } = definition;

  /** Each readable sharer's stored target id (a store read under no viewer filter). */
  const storedTargets = (sharerIds: ReadonlyArray<string>) =>
    Arr.isReadonlyArrayEmpty(sharerIds)
      ? Effect.succeed(HashMap.empty<string, Option.Option<string>>())
      : Effect.map(
          edges.list({
            where: anyOf(sharerColumn, sharerIds),
            limit: sharerIds.length,
            offset: 0,
          }),
          (page) =>
            HashMap.fromIterable(
              Arr.flatMap(page.rows, (row) => {
                const sharerId = row[sharerColumn];
                return P.isString(sharerId)
                  ? [[sharerId, Option.liftPredicate(row[targetColumn], P.isString)] as const]
                  : [];
              }),
            ),
        );

  const targetsOf = Effect.fn(`${type}.targetsOf`)(function* (ids: ReadonlyArray<string>) {
    const unique = Arr.dedupe(ids);
    if (unique.length > MAX_SET_VALUES) return HashMap.empty<string, ReshareTarget<Target>>();
    const readable = yield* sharer.getMany(unique);
    const stored = yield* storedTargets(Arr.filter(unique, (id) => HashMap.has(readable, id)));
    const targetIds = Arr.dedupe(Arr.getSomes(Arr.fromIterable(HashMap.values(stored))));
    const targets = Arr.isReadonlyArrayEmpty(targetIds)
      ? HashMap.empty<string, Target>()
      : yield* target.getMany(targetIds);
    return HashMap.map(stored, (targetId): ReshareTarget<Target> =>
      Option.match(
        Option.flatMap(targetId, (id) => HashMap.get(targets, id)),
        {
          onNone: () => unavailable,
          onSome: (resource) => ({ _tag: "Visible", target: resource }),
        },
      ),
    );
  });

  const targetOf = Effect.fn(`${type}.targetOf`)(function* (id: string) {
    yield* sharer.get(id);
    return HashMap.get(yield* targetsOf([id]), id);
  });

  return { targetOf, targetsOf };
};

// ── Accepted answers ──────────────────────────────────────────────────

/**
 * An accepted-answer edge whose answer does not belong to its question: the
 * answer's declared parent column names another node, or none. The wire's
 * 422. Raised by {@link acceptedAnswerGate} after the question's write gate,
 * so only a writer of the question learns it.
 *
 * @since 0.2.0
 */
export class AnswerNotOfQuestion extends Schema.TaggedError<
  AnswerNotOfQuestion,
  { readonly brand: unique symbol }
>()("AnswerNotOfQuestion", {
  question: Schema.String,
  answer: Schema.String,
}) {}

/**
 * An accepted-answer family's declaration for {@link acceptedAnswerGate}.
 *
 * @since 0.2.0
 */
export interface AcceptedAnswerDeclaration<Question, E, R> {
  /** The question leaf's wire type, which a malformed edge's `NodeNotFound` names. */
  readonly questionType: string;
  /** The question leaf: its write gate is the edge's. */
  readonly questions: Pick<SubtypeOps<Question, E, R>, "authorize">;
  /** The edge column holding the question's id (its end with `maxEdges: 1`). */
  readonly questionColumn: string;
  /** The edge column holding the answer's id. */
  readonly answerColumn: string;
  /** The answer leaf's current-version view: the answer end's `nodes`. */
  readonly answers: EndpointView<E, R>;
  /** The answer view's column naming the question the answer belongs to. */
  readonly parentColumn: string;
}

/**
 * The accepted-answer family's write gate: the question's own write gate
 * (its owner or the moderate rung on an owned question, as the question
 * leaf's `update` gates), then the constraint that the answer belongs to
 * the question, as the answer's `parentColumn` says
 * ({@link AnswerNotOfQuestion} otherwise). It runs after `./edges` has
 * checked that the viewer can read both ends, so it reads only a readable
 * answer. On a delete (un-accepting) it gates the same way.
 *
 * @since 0.2.0
 */
export const acceptedAnswerGate = <Question, E, R>(
  declaration: AcceptedAnswerDeclaration<Question, E, R>,
): EdgeWriteGate<E | AnswerNotOfQuestion, R> => {
  const { questionType, questions, questionColumn, answerColumn, answers, parentColumn } =
    declaration;
  return (request) =>
    Effect.gen(function* () {
      const question = yield* nodeAt(request, questionColumn, questionType);
      const account = yield* questions.authorize(question);
      const answer = request.edge[answerColumn];
      const row = P.isString(answer) ? yield* answers.get(answer) : Option.none();
      if (!Option.exists(row, (node) => node[parentColumn] === question)) {
        return yield* new AnswerNotOfQuestion({
          question,
          answer: P.isString(answer) ? answer : "",
        });
      }
      return account;
    });
};
