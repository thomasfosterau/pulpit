/**
 * @copyright Thomas Foster
 *
 * The node id the tree's identity table holds: a `uuid`, in PostgreSQL's
 * canonical lower-case text form. A kernel id is any string (a wire id may
 * be anything), so the stores read an id of any other form as one that names
 * no node, before it reaches a `uuid` comparison that would fail the query.
 *
 * @since 0.0.0
 */

import * as Schema from "effect/Schema";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Whether `id` is a node id in the canonical form a `uuid` column reads back.
 *
 * @since 0.0.0
 */
export const isNodeId = Schema.is(Schema.String.check(Schema.isPattern(CANONICAL_UUID)));
