/**
 * Units.
 *
 * **Metres are the only internal representation.** Every length that crosses a package boundary, enters
 * a kernel, or is stored in a document is a number of metres. Display units are a presentation concern
 * and conversion happens at exactly two places: parsing user input, and formatting for display.
 *
 * This is stated as a rule because the alternative fails in a specific, expensive way: once two
 * subsystems disagree about whether a number is metres or millimetres, the bug looks like geometry that
 * is off by 1000×, and it surfaces in a plan drawing weeks later rather than at the line that got it
 * wrong. A single internal unit makes the mistake impossible to represent.
 */

export type LengthUnit = "m" | "cm" | "mm" | "ft" | "in";

/** Metres per one of each unit. Exact by definition for the imperial pair (1 in ≡ 25.4 mm). */
const TO_METRES: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
};

export function toMetres(value: number, from: LengthUnit): number {
  return value * TO_METRES[from];
}

export function fromMetres(metres: number, to: LengthUnit): number {
  return metres / TO_METRES[to];
}

export function isImperial(unit: LengthUnit): boolean {
  return unit === "ft" || unit === "in";
}

/**
 * How lengths are shown to this user. Carried as one object so a document, a sheet and a dimension
 * string cannot each hold a different opinion about precision.
 */
export interface UnitSystem {
  readonly length: LengthUnit;
  /** Decimal places for metric display. Ignored when `length` is imperial and `fraction` is set. */
  readonly precision: number;
  /**
   * Imperial denominator: 16 → nearest 1/16". Undefined → decimal feet/inches.
   *
   * Architectural drawings in the US are dimensioned in fractional inches, and rounding
   * `3.9861 ft` to `3.99 ft` produces a number no one on site can measure. Fractions are not
   * decoration here; they are the difference between a usable dimension and an unusable one.
   */
  readonly fraction?: 2 | 4 | 8 | 16 | 32 | 64;
}

export const METRIC: UnitSystem = { length: "m", precision: 3 };
export const METRIC_MM: UnitSystem = { length: "mm", precision: 0 };
export const IMPERIAL: UnitSystem = { length: "ft", precision: 2, fraction: 16 };

/** Reduce a fraction by its greatest common divisor, so 8/16 shows as 1/2. */
function reduce(numerator: number, denominator: number): [number, number] {
  let a = numerator;
  let b = denominator;
  while (b !== 0) [a, b] = [b, a % b];
  const g = a || 1;
  return [numerator / g, denominator / g];
}

/**
 * Format metres for display.
 *
 * Imperial with a `fraction` produces architectural notation: `12'-6 1/2"`. Note the hyphen — that
 * separator is the convention on US construction drawings, and its absence is the first thing a
 * reviewer notices.
 *
 * Built by assembling parts rather than string-concatenating a rounded number, because the carry cases
 * are where naive versions break: `15/16` rounding up must become the next whole inch, and 12 inches
 * must become the next whole foot. Both are tested.
 */
export function formatLength(metres: number, units: UnitSystem): string {
  const sign = metres < 0 ? "-" : "";
  const abs = Math.abs(metres);

  if (!isImperial(units.length) || units.fraction === undefined) {
    const value = fromMetres(abs, units.length);
    return `${sign}${value.toFixed(units.precision)} ${units.length}`;
  }

  const den = units.fraction;
  const totalInches = fromMetres(abs, "in");

  // Round to the nearest 1/den of an inch first, then decompose. Decomposing before rounding lets a
  // rounded-up fraction land as "12 inches" or "16/16", which is how these formatters usually break.
  const totalSixteenths = Math.round(totalInches * den);
  let feet = Math.floor(totalSixteenths / (12 * den));
  const remainder = totalSixteenths - feet * 12 * den;
  let inches = Math.floor(remainder / den);
  const fracUnits = remainder - inches * den;

  if (inches >= 12) {
    feet += 1;
    inches -= 12;
  }

  let out = `${feet}'`;
  if (inches > 0 || fracUnits > 0) {
    out += "-";
    if (inches > 0 || fracUnits === 0) out += `${inches}`;
    if (fracUnits > 0) {
      const [n, d] = reduce(fracUnits, den);
      out += inches > 0 ? ` ${n}/${d}` : `0 ${n}/${d}`;
    }
    out += `"`;
  }
  return sign + out;
}

/**
 * Parse a length written by a human, returning metres, or null if it isn't one.
 *
 * Accepts, in the forms drafters actually type:
 * - `5`, `5.25` — bare number, interpreted in `defaultUnit`
 * - `5m`, `500mm`, `5 cm` — explicit unit suffix, spacing optional
 * - `12'`, `6"`, `12'6`, `12'6"`, `12'-6 1/2"` — feet and inches, including architectural notation
 * - `6 1/2"`, `1/2"` — fractional inches
 *
 * Returns null rather than throwing or guessing, because this runs on every keystroke of a dynamic
 * input field. A partially-typed `12'` must read as a valid 12 feet while `12'-` reads as
 * not-yet-parseable, and neither is an error worth interrupting the user for.
 */
export function parseLength(input: string, defaultUnit: LengthUnit = "m"): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "") return null;

  const negative = s.startsWith("-");
  const body = negative ? s.slice(1).trim() : s;
  const signed = (m: number) => (negative ? -m : m);

  // Feet/inches. The `-` between feet and inches is optional and, when present, is a separator rather
  // than a minus sign — `12'-6"` is twelve feet six, not twelve feet minus six.
  const ftIn = /^(?:(\d+(?:\.\d+)?)')?\s*-?\s*(?:(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?\s*"?)?$/;
  if (body.includes("'") || body.includes('"') || /\d\s*\/\s*\d/.test(body)) {
    const m = ftIn.exec(body);
    if (m && (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined)) {
      const feet = m[1] ? Number(m[1]) : 0;
      const inches = m[2] ? Number(m[2]) : 0;
      const fracNum = m[3] ? Number(m[3]) : 0;
      const fracDen = m[4] ? Number(m[4]) : 1;
      if (fracDen === 0) return null;
      const totalInches = feet * 12 + inches + fracNum / fracDen;
      return signed(toMetres(totalInches, "in"));
    }
    return null;
  }

  // Number with an optional unit suffix.
  const withUnit = /^(\d+(?:\.\d+)?)\s*(m|cm|mm|ft|in)?$/.exec(body);
  if (!withUnit) return null;
  const value = Number(withUnit[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (withUnit[2] as LengthUnit | undefined) ?? defaultUnit;
  return signed(toMetres(value, unit));
}
