/**
 * **Node id minting**, shared by `./version-chain` (a hooked create that
 * names no id) and `./reference-import` (the id an external id is linked to
 * before its create).
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** Two hex digits of a random byte. */
const randomByte = Effect.map(Random.nextIntBetween(0, 255), (byte) =>
  byte.toString(16).padStart(2, "0"),
);

/**
 * A fresh RFC 4122 version-4 node id, for a hooked create that names none:
 * the hook is shown the id the version will carry, so it is minted before
 * the append rather than by the port; and for `./reference-import`, which
 * links an external id to the node id before the create.
 *
 * @internal
 */
export const mintNodeId: Effect.Effect<string> = Effect.map(
  Effect.all(
    Arr.makeBy(16, () => randomByte),
    { concurrency: 1 },
  ),
  (bytes) => {
    const hex = [...bytes];
    hex[6] = `4${hex[6]?.[1] ?? "0"}`;
    hex[8] = ((Number.parseInt(hex[8] ?? "0", 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
    const at = (from: number, to: number) => hex.slice(from, to).join("");
    return `${at(0, 4)}-${at(4, 6)}-${at(6, 8)}-${at(8, 10)}-${at(10, 16)}`;
  },
);
