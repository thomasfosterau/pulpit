/**
 * **An HTTP header range's weight**, shared by the `Accept-Language`
 * parser in `./subtype` and the `Accept` negotiation in `./media`, so the
 * two read a `q` parameter one way.
 *
 * Internal: not a package entry point (absent from `package.json`
 * `exports`) and excluded from the generated API docs (`docgen.json`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** An RFC 9110 qvalue: `0`, `1` or `0.` / `1.` with up to three decimals (`1.` only zeros). */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * The weight a range's parameters give it: its `q`, `1` without one, and
 * `NaN` for a `q` that isn't a valid qvalue (the caller drops the range).
 * Never throws.
 *
 * @internal
 */
export const qOf = (parameters: ReadonlyArray<string>): number =>
  Option.match(
    Arr.findFirst(parameters, (parameter) => /^q=/i.test(parameter)),
    {
      onNone: () => 1,
      onSome: (parameter) => {
        const value = parameter.slice(2).trim();
        return QVALUE.test(value) ? Number(value) : Number.NaN;
      },
    },
  );
