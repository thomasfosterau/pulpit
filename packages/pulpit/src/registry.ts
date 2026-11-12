/**
 * **The resource registry's flag vocabulary and construction-time checks** —
 * generic in the tree.
 *
 * An application declares its Node type tree as one ordered list of
 * {@link RegistryEntry}: marker levels (`node`, `entity`, `content`, …) carry
 * no `resource`; concrete leaves carry their `Resource.make` definition, their
 * id brand and their capability flags. Everything else — the branch unions,
 * the per-flag families, the wire-type lists a subtype factory checks its
 * `access` declaration against — derives from that one list. Ported from
 * gardeneria's `packages/models/src/registry.ts` (Website #1011, carried
 * over); the entries there are the app's, the vocabulary and the checks are
 * this module's. A `#NNN` here names a gardeneria issue.
 *
 * **Capability subsets, not tree levels.** The flags:
 *
 * - `pageable` — has a `/type/<id>` route and is a page-family member;
 * - `agent` — an agent-family member (a person, an organisation, a team, a
 *   bot, a group);
 * - `owned` — a multi-tenant leaf: `owner_id` on the stable row, a
 *   `visibility` on the version row, writes gated by owner-or-rung, reads by
 *   the viewer predicate (`./subtype`);
 * - `referenceData` — corpus material: written directly at the corpus-write
 *   rung, proposed by anyone signed in, publicly readable;
 * - `searchable` — a search plane emits it;
 * - `routable` — addressed by a path claim on its root node (`./paths`);
 * - `localised` — carries a locale level in its chain (pulpit#56): its
 *   translated columns per locale, declared beside the entry with
 *   `./subtype`'s `defineLocaleLevel`.
 *
 * `owned` and `referenceData` are mutually exclusive — a leaf sits on one
 * side of the trust model or the other, and the subtype factory reads the
 * same fact from the leaf declaration's `access` (`./subtype`). The flags
 * cross-cut the tree (a garden is `owned` and `pageable`; a comment is
 * `owned` and neither pageable nor searchable), so none can be derived from
 * tree position alone. What IS derived from tree position is branch
 * membership — every resource-bearing leaf whose root is that branch — via
 * {@link branchOf}.
 *
 * **Construction-time checks** ({@link validateRegistry}, thrown at import,
 * the same posture as a subtype factory's coverage check): keys are unique;
 * every `parent` resolves; a capability flag implies a resource; `owned` and
 * `referenceData` never coincide; a leaf's declared brand *is* the resource's
 * own id and its key *is* the resource's wire `type`. An application's
 * tree-specific invariants — gardeneria's `searchType` / `searchViewSchema`
 * pairing, its `dbTable` anchoring lockstep — are passed in as extra checks
 * rather than restated here.
 *
 * Client-safe (no Drizzle) and module-load-time static.
 *
 * @copyright Thomas Foster
 * @module pulpit/registry
 * @since 0.1.0
 */

import type { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// ── Entry shape ───────────────────────────────────────────────────────

/**
 * Any branded-id schema (a UUID string on the wire) an application's ids module declares.
 *
 * @since 0.1.0
 */
export type BrandedId = Schema.Codec<unknown, string>;

/**
 * The capability flags, in the order the derived families list them.
 *
 * @since 0.1.0
 */
export const RESOURCE_FLAGS = [
  "pageable",
  "agent",
  "owned",
  "referenceData",
  "searchable",
  "routable",
  "localised",
] as const;

/**
 * One of {@link RESOURCE_FLAGS}.
 *
 * @since 0.1.0
 */
export type RegistryFlag = (typeof RESOURCE_FLAGS)[number];

/**
 * One node in an application's registry tree. Marker levels carry no
 * `resource`; concrete leaves carry the `Resource.make` definition. A
 * declaration member is plain optional (AGENTS.md → Conventions): a marker
 * level omits `resource` and `id` rather than passing `undefined`. The
 * capability flags are the
 * membership predicates the families / unions filter on; they must be literal
 * `true` (or absent) so the type-level derivation ({@link PickResources}) can
 * select them.
 *
 * @since 0.1.0
 */
export interface RegistryEntry {
  /** Stable key: the JSON:API wire `type` for resource leaves, else a marker / leaf name. */
  readonly key: string;
  /** Parent key in the settled tree — `Option.none()` only for the root. */
  readonly parent: Option.Option<string>;
  /** The `Resource.make` definition; omitted for marker levels. */
  readonly resource?: Resource.Any;
  /** The application's id brand for this level. For resource leaves it must equal `resource.Id`. */
  readonly id?: BrandedId;
  /** Page-able: has a `/type/<id>` route and is a page-family member. */
  readonly pageable?: true;
  /** Agent: an agent-family member. */
  readonly agent?: true;
  /** Owned: `owner_id` + `visibility`, gated per viewer (never `referenceData`). */
  readonly owned?: true;
  /** Reference data: corpus-written, proposable, publicly readable (never `owned`). */
  readonly referenceData?: true;
  /** Searchable: a search plane emits it. */
  readonly searchable?: true;
  /** Routable: addressed by a path claim on its root node (`./paths`). */
  readonly routable?: true;
  /** Localised: a locale level in its chain, its translated columns per locale (pulpit#56). */
  readonly localised?: true;
}

/**
 * An entry's resource: `Option.none()` for a marker level, which omits
 * `resource`. Every reader in this module goes through it,
 * and an application's {@link RegistryCheck} can too.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { Resource } from "@thomasfosterau/effect-jsonapi";
 * import { Registry } from "@thomasfosterau/pulpit";
 * import * as Option from "effect/Option";
 * import * as Schema from "effect/Schema";
 *
 * const PostResource = Resource.make("posts", { attributes: { title: Schema.String } });
 *
 * const marker = { key: "content", parent: Registry.root };
 * const leaf = {
 *   key: "posts",
 *   parent: Registry.parent("content"),
 *   resource: PostResource,
 * };
 *
 * strictEqual(Option.isNone(Registry.resourceOf(marker)), true);
 * strictEqual(Option.contains(Registry.resourceOf(leaf), PostResource), true);
 * ```
 *
 * @since 0.2.0
 */
export const resourceOf = (entry: RegistryEntry): Option.Option<Resource.Any> =>
  Option.fromUndefinedOr(entry.resource);

/** An entry's id brand: `Option.none()` when `id` is omitted. */
const idOf = (entry: RegistryEntry): Option.Option<BrandedId> => Option.fromUndefinedOr(entry.id);

/**
 * Declare an entry's `parent` with its key literal preserved —
 * `parent: parent("place")` rather than `Option.some("place")`, whose `A` is
 * inferred as `string` even under `as const` and would leave every
 * {@link PickChildren} derivation empty. Runtime-identical to `Option.some`.
 *
 * @since 0.1.0
 */
export const parent = <const Key extends string>(key: Key): Option.Option<Key> => Option.some(key);

/**
 * The tree root's `parent`: it has none.
 *
 * @since 0.1.0
 */
export const root: Option.Option<never> = Option.none();

/**
 * A construction-time registry violation — thrown at module load by
 * {@link validateRegistry}, never an Effect failure: no runtime exists yet
 * when a registry is declared, and a malformed tree must stop the module
 * from loading at all rather than surface as a wrong wire contract later.
 *
 * @since 0.1.0
 */
export class RegistryDeclarationError extends Schema.TaggedError<
  RegistryDeclarationError,
  { readonly brand: unique symbol }
>()("RegistryDeclarationError", { message: Schema.String }) {}

/**
 * An application-supplied per-entry invariant, run by {@link validateRegistry}
 * after the generic checks: `Option.some(message)` fails the registry with
 * that message, `Option.none()` passes. `byKey` is the index of every entry
 * so a check can resolve parents.
 *
 * @since 0.1.0
 */
export type RegistryCheck = (
  entry: RegistryEntry,
  byKey: HashMap.HashMap<string, RegistryEntry>,
) => Option.Option<string>;

// ── Construction-time checks ──────────────────────────────────────────

const fail = (message: string): never => {
  throw new RegistryDeclarationError({ message });
};

/**
 * Index entries by key, throwing on a duplicate — the first check, since every
 * other check resolves through the index.
 *
 * @since 0.1.0
 */
export const indexByKey = (
  entries: readonly RegistryEntry[],
): HashMap.HashMap<string, RegistryEntry> =>
  Arr.reduce(entries, HashMap.empty<string, RegistryEntry>(), (map, entry) => {
    if (HashMap.has(map, entry.key)) fail(`registry: duplicate key '${entry.key}'`);
    return HashMap.set(map, entry.key, entry);
  });

/** A capability flag implies a resource: a marker level cannot be pageable / owned / …. */
const checkFlagsHaveResource = (entry: RegistryEntry): void => {
  if (Option.isSome(resourceOf(entry))) return;
  Option.map(
    Arr.findFirst(RESOURCE_FLAGS, (flag) => entry[flag] === true),
    (flag) => fail(`'${entry.key}' is flagged '${flag}' but declares no resource`),
  );
};

/** `owned` ⊕ `referenceData`: a leaf sits on one side of the trust model, never both. */
const checkTrustAxis = (entry: RegistryEntry): void => {
  if (entry.owned === true && entry.referenceData === true) {
    fail(`'${entry.key}' is flagged both 'owned' and 'referenceData' (a leaf is one or the other)`);
  }
};

/** Id lockstep: a leaf's declared brand IS the resource's id, and its key IS the wire type. */
const checkIdLockstep = (entry: RegistryEntry): void => {
  const resource = resourceOf(entry);
  if (Option.isNone(resource)) return;
  const id = idOf(entry);
  if (Option.isNone(id)) {
    fail(`leaf '${entry.key}' declares a resource but no ids.ts brand`);
  } else if (!Object.is(id.value, resource.value.Id)) {
    fail(`'${entry.key}' declares an id brand that is not the resource's own id (ids.ts drift)`);
  } else if (resource.value.type !== entry.key) {
    fail(`'${entry.key}' key does not match its resource wire type '${resource.value.type}'`);
  }
};

/** Per-entry invariants: parent resolves, flags imply a resource, the trust axis, id lockstep. */
const checkEntry = (
  entry: RegistryEntry,
  byKey: HashMap.HashMap<string, RegistryEntry>,
  checks: ReadonlyArray<RegistryCheck>,
): void => {
  if (Option.isSome(entry.parent) && !HashMap.has(byKey, entry.parent.value)) {
    fail(`'${entry.key}' names parent '${entry.parent.value}', which is not a declared entry`);
  }
  checkFlagsHaveResource(entry);
  checkTrustAxis(entry);
  checkIdLockstep(entry);
  Arr.forEach(checks, (check) => Option.map(check(entry, byKey), fail));
};

/**
 * Run every construction-time invariant over `entries`, throwing
 * {@link RegistryDeclarationError} on the first violation. Parametric (rather
 * than closing over an application's registry) so a unit suite can drive
 * each failure path with a malformed fixture — the throws are the contract,
 * not just belt-and-braces. An application calls it once at module load with
 * its real registry, passing its tree-specific `checks`.
 *
 * @example
 * ```ts
 * import { throws } from "node:assert";
 * import { Resource } from "@thomasfosterau/effect-jsonapi";
 * import { Registry } from "@thomasfosterau/pulpit";
 * import * as Option from "effect/Option";
 * import * as Schema from "effect/Schema";
 *
 * const PostResource = Resource.make("posts", { attributes: { title: Schema.String } });
 *
 * const REGISTRY = [
 *   { key: "node", parent: Registry.root },
 *   { key: "content", parent: Registry.parent("node") },
 *   {
 *     key: "posts",
 *     parent: Registry.parent("content"),
 *     resource: PostResource,
 *     id: PostResource.Id,
 *     owned: true,
 *   },
 * ] as const satisfies readonly Registry.RegistryEntry[];
 *
 * // A well-formed tree passes.
 * Registry.validateRegistry(REGISTRY);
 *
 * // A parent that names no declared entry is thrown at load, not returned.
 * throws(
 *   () =>
 *     Registry.validateRegistry([...REGISTRY, { key: "pages", parent: Registry.parent("blog") }]),
 *   Registry.RegistryDeclarationError,
 * );
 *
 * // So is an application's own check: here, every leaf must be pageable.
 * throws(
 *   () =>
 *     Registry.validateRegistry(REGISTRY, [
 *       (entry) =>
 *         Option.isSome(Registry.resourceOf(entry)) && entry.pageable !== true
 *           ? Option.some(`leaf '${entry.key}' is not pageable`)
 *           : Option.none(),
 *     ]),
 *   Registry.RegistryDeclarationError,
 * );
 * ```
 *
 * @since 0.1.0
 */
export const validateRegistry = (
  entries: readonly RegistryEntry[],
  checks: ReadonlyArray<RegistryCheck> = [],
): void => {
  const byKey = indexByKey(entries);
  Arr.forEach(entries, (entry) => checkEntry(entry, byKey, checks));
};

// ── Branch resolution ─────────────────────────────────────────────────

/**
 * The branch root an entry ultimately belongs to — a walk up `parent` until
 * one of the application's `roots` (gardeneria's are `entity`, `content` and
 * `file`). `Option.none()` for the tree root itself, and for an unresolved
 * parent (an unknown parent resolves to nothing rather than throwing —
 * {@link validateRegistry} is where that is an error).
 *
 * @since 0.1.0
 */
export const branchOf = <Root extends string>(
  entry: RegistryEntry,
  byKey: HashMap.HashMap<string, RegistryEntry>,
  roots: ReadonlyArray<Root>,
): Option.Option<Root> => {
  const isRoot = (key: string): key is Root => Arr.some(roots, (root) => root === key);
  const walk = (key: string): Option.Option<Root> =>
    isRoot(key)
      ? Option.some(key)
      : Option.flatMap(HashMap.get(byKey, key), (level) => Option.flatMap(level.parent, walk));
  return isRoot(entry.key) ? Option.some(entry.key) : Option.flatMap(entry.parent, walk);
};

// ── Type-level member selection ───────────────────────────────────────
//
// `Schema.Union` preserves its members as a tuple (the `const Members`
// inference), so a derived union keeps the precise member union types. A
// runtime `.filter().map()` erases that tuple to `Resource.Any[]`, so the
// exact sub-tuple is recovered at the type level and the runtime array is
// bridged onto it with a single cast — the array and the type follow the same
// (registry-declaration) order, which `validateRegistry` guarantees.

/**
 * The resources of every entry whose `Flag` capability is literally `true`, as a tuple.
 *
 * @since 0.1.0
 */
export type PickResources<
  T extends readonly RegistryEntry[],
  Flag extends RegistryFlag,
  Acc extends readonly Resource.Any[] = readonly [],
> = T extends readonly [
  infer Head extends RegistryEntry,
  ...infer Rest extends readonly RegistryEntry[],
]
  ? Head extends Record<Flag, true>
    ? Head extends { readonly resource: infer R extends Resource.Any }
      ? PickResources<Rest, Flag, readonly [...Acc, R]>
      : PickResources<Rest, Flag, Acc>
    : PickResources<Rest, Flag, Acc>
  : Acc;

/**
 * The resources of every entry whose parent key is one of `Parent`, as a
 * tuple — the one-level type-side counterpart of {@link branchOf}. An
 * application types its branch unions from this over the branch root PLUS
 * every marker level beneath it, so a leaf hanging off a marker types into
 * the branch exactly as one hanging off the root does.
 *
 * @since 0.1.0
 */
export type PickChildren<
  T extends readonly RegistryEntry[],
  Parent extends string,
  Acc extends readonly Resource.Any[] = readonly [],
> = T extends readonly [
  infer Head extends RegistryEntry,
  ...infer Rest extends readonly RegistryEntry[],
]
  ? Head extends { readonly parent: Option.Option<Parent> }
    ? Head extends { readonly resource: infer R extends Resource.Any }
      ? PickChildren<Rest, Parent, readonly [...Acc, R]>
      : PickChildren<Rest, Parent, Acc>
    : PickChildren<Rest, Parent, Acc>
  : Acc;

/**
 * The `identifier` (linkage-ref) schema of each resource in a member tuple.
 *
 * @since 0.1.0
 */
export type Identifiers<Members extends readonly Resource.Any[]> = {
  readonly [K in keyof Members]: Members[K]["identifier"];
};

/**
 * Runtime counterpart of {@link PickResources}: the resources flagged `flag`,
 * in registry order, typed as the precise member tuple. A capability flag
 * implies a resource ({@link validateRegistry}, which an application runs
 * first), so the projection is total and the bridge cast is sound.
 *
 * @since 0.1.0
 */
export const flaggedMembers = <const T extends readonly RegistryEntry[], Flag extends RegistryFlag>(
  entries: T,
  flag: Flag,
): PickResources<T, Flag> => {
  const members: ReadonlyArray<Schema.Top> = Arr.filterMap(
    entries,
    (entry): Result.Result<Resource.Any, void> =>
      entry[flag] === true
        ? Result.fromOption(resourceOf(entry), () => undefined)
        : Result.failVoid,
  );
  // SAFETY: `members` filters the same entries the tuple type was derived
  // from, in the same (registry-declaration) order, so the runtime array and
  // the static tuple cannot disagree once `validateRegistry` has run.
  return members as PickResources<T, Flag>;
};

/**
 * Runtime counterpart of {@link PickChildren} over a whole branch: every
 * resource-bearing leaf under `root` (one of `roots`), in registry order.
 *
 * The runtime walk is the whole tree; the static tuple is one level deep, so
 * a caller whose leaves hang off marker levels beneath the root names those
 * levels in `parents` (the root plus every marker under it — gardeneria's
 * `entity` branch names `"entity" | "place" | "agent" | …`). A leaf hanging
 * off a marker the caller forgot to name is in the array but not the tuple,
 * which a wire-identity pin catches. `parents` defaults to the root alone.
 *
 * @since 0.1.0
 */
export const branchMembers = <
  const T extends readonly RegistryEntry[],
  const Root extends string,
  const Parents extends string = Root,
>(
  entries: T,
  root: Root,
  roots: ReadonlyArray<string>,
  _parents?: ReadonlyArray<Parents>,
): PickChildren<T, Parents> => {
  const byKey = indexByKey(entries);
  const members: ReadonlyArray<Schema.Top> = Arr.filterMap(
    entries,
    (entry): Result.Result<Resource.Any, void> =>
      Option.contains(branchOf(entry, byKey, roots), root)
        ? Result.fromOption(resourceOf(entry), () => undefined)
        : Result.failVoid,
  );
  // SAFETY: `members` filters the same entries the tuple type was derived
  // from, in the same (registry-declaration) order, so the runtime array and
  // the static tuple cannot disagree once `validateRegistry` has run.
  return members as PickChildren<T, Parents>;
};

/**
 * The `identifier` schemas of a member tuple, for a branch's linkage-ref union.
 *
 * @since 0.1.0
 */
export const identifiersOf = <const Members extends readonly Resource.Any[]>(
  members: Members,
): Identifiers<Members> => {
  const identifiers = Arr.map(members, (member) => member.identifier);
  // SAFETY: `Arr.map` keeps the tuple's length and order, member for member,
  // which its `Array` return type cannot say.
  return identifiers as Identifiers<Members>;
};

// ── Derived wire identity ─────────────────────────────────────────────

/**
 * The wire `type` literals of the derived families and branches — what a
 * wire-identity pinning test asserts against the frozen contract, and what a
 * subtype factory checks its per-leaf `access` declaration against
 * (`owned` / `referenceData`).
 *
 * @since 0.1.0
 */
export interface RegistryWireTypes<Root extends string> {
  readonly pageable: ReadonlyArray<string>;
  readonly agent: ReadonlyArray<string>;
  readonly owned: ReadonlyArray<string>;
  readonly referenceData: ReadonlyArray<string>;
  readonly searchable: ReadonlyArray<string>;
  readonly routable: ReadonlyArray<string>;
  readonly localised: ReadonlyArray<string>;
  /** Each root's branch, keyed by the root (every one of `roots` is present). */
  readonly branches: HashMap.HashMap<Root, ReadonlyArray<string>>;
}

/**
 * Project the wire types of every flag family and every branch of `roots`.
 * A capability-flagged entry always carries its resource, so the projection
 * never drops one.
 *
 * @since 0.1.0
 */
export const registryWireTypes = <Root extends string>(
  entries: readonly RegistryEntry[],
  roots: ReadonlyArray<Root>,
): RegistryWireTypes<Root> => {
  const byKey = indexByKey(entries);
  const typeOf = (entry: RegistryEntry): Result.Result<string, void> =>
    Result.fromOption(
      Option.map(resourceOf(entry), (resource) => resource.type),
      () => undefined,
    );
  const flagged = (flag: RegistryFlag): ReadonlyArray<string> =>
    Arr.filterMap(entries, (entry) => (entry[flag] === true ? typeOf(entry) : Result.failVoid));
  const branch = (root: Root): ReadonlyArray<string> =>
    Arr.filterMap(entries, (entry) =>
      Option.contains(branchOf(entry, byKey, roots), root) ? typeOf(entry) : Result.failVoid,
    );
  const branches = HashMap.fromIterable(
    Arr.map(roots, (root): readonly [Root, ReadonlyArray<string>] => [root, branch(root)]),
  );
  return {
    pageable: flagged("pageable"),
    agent: flagged("agent"),
    owned: flagged("owned"),
    referenceData: flagged("referenceData"),
    searchable: flagged("searchable"),
    routable: flagged("routable"),
    localised: flagged("localised"),
    branches,
  };
};
