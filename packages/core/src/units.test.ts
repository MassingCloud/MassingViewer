import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IMPERIAL,
  METRIC,
  METRIC_MM,
  formatLength,
  fromMetres,
  isImperial,
  parseLength,
  toMetres,
} from "./units";

describe("conversion", () => {
  it("is exact for the imperial definitions", () => {
    // 1 in ≡ 25.4 mm and 1 ft ≡ 304.8 mm are definitions, not measurements. If these drift, every
    // imperial dimension in the product is subtly wrong, and nothing else will report it.
    expect(toMetres(1, "in")).toBe(0.0254);
    expect(toMetres(1, "ft")).toBe(0.3048);
    expect(toMetres(12, "in")).toBeCloseTo(0.3048, 12);
  });

  it("round-trips through every unit", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom("m" as const, "cm" as const, "mm" as const, "ft" as const, "in" as const),
        (value, unit) => Math.abs(fromMetres(toMetres(value, unit), unit) - value) <= 1e-9 * Math.max(1, Math.abs(value)),
      ),
    );
  });

  it("knows which systems are imperial", () => {
    expect(isImperial("ft")).toBe(true);
    expect(isImperial("in")).toBe(true);
    expect(isImperial("m")).toBe(false);
    expect(isImperial("mm")).toBe(false);
  });
});

describe("metric formatting", () => {
  it("honours the configured precision", () => {
    expect(formatLength(1.23456, METRIC)).toBe("1.235 m");
    expect(formatLength(1.23456, METRIC_MM)).toBe("1235 mm");
    expect(formatLength(0, METRIC)).toBe("0.000 m");
  });

  it("keeps the sign", () => {
    expect(formatLength(-2.5, METRIC)).toBe("-2.500 m");
  });
});

describe("imperial formatting — the carry cases", () => {
  // These are the cases naive formatters get wrong, and the reason `formatLength` rounds to the
  // fraction FIRST and decomposes afterwards rather than the other way round.

  it("writes architectural notation with the hyphen", () => {
    // 12'-6" is the convention on US construction drawings. A missing hyphen is the first thing a
    // reviewer notices.
    expect(formatLength(toMetres(12 * 12 + 6, "in"), IMPERIAL)).toBe(`12'-6"`);
  });

  it("omits the inch part when it is exactly zero", () => {
    expect(formatLength(toMetres(12, "ft"), IMPERIAL)).toBe(`12'`);
    expect(formatLength(0, IMPERIAL)).toBe(`0'`);
  });

  it("carries a rounded-up fraction into the next inch", () => {
    // 6 and 63/64 inches, at 1/16 resolution, must become 7 — NOT "6 16/16".
    const metres = toMetres(6 + 63 / 64, "in");
    expect(formatLength(metres, IMPERIAL)).toBe(`0'-7"`);
  });

  it("carries a rounded-up inch into the next foot", () => {
    // 11.98 inches at 1/16 resolution rounds to 12, which must become 1'-0" and not 0'-12".
    const metres = toMetres(11.99, "in");
    expect(formatLength(metres, IMPERIAL)).toBe(`1'`);
  });

  it("reduces the fraction", () => {
    // 8/16 must print as 1/2. An unreduced fraction is readable but wrong-looking on a drawing.
    expect(formatLength(toMetres(6.5, "in"), IMPERIAL)).toBe(`0'-6 1/2"`);
    expect(formatLength(toMetres(6.25, "in"), IMPERIAL)).toBe(`0'-6 1/4"`);
    expect(formatLength(toMetres(6.75, "in"), IMPERIAL)).toBe(`0'-6 3/4"`);
  });

  it("writes a leading zero when there is a fraction but no whole inch", () => {
    // `12'- 1/2"` is ambiguous to read; `12'-0 1/2"` is not.
    expect(formatLength(toMetres(12 * 12 + 0.5, "in"), IMPERIAL)).toBe(`12'-0 1/2"`);
  });

  it("keeps the sign in front of the feet", () => {
    expect(formatLength(-toMetres(12 * 12 + 6, "in"), IMPERIAL)).toBe(`-12'-6"`);
  });

  it("never emits a fraction at or above the whole", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (metres) => {
        const s = formatLength(metres, IMPERIAL);
        const m = /(\d+)\/(\d+)"/.exec(s);
        if (!m) return true;
        return Number(m[1]) < Number(m[2]);
      }),
    );
  });

  it("never emits 12 or more inches", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (metres) => {
        const s = formatLength(metres, IMPERIAL);
        const m = /'-(\d+)/.exec(s);
        return m === null || Number(m[1]) < 12;
      }),
    );
  });
});

describe("parseLength", () => {
  it("reads a bare number in the default unit", () => {
    expect(parseLength("5")).toBe(5);
    expect(parseLength("5", "mm")).toBeCloseTo(0.005, 12);
    expect(parseLength("2.5")).toBe(2.5);
  });

  it("reads an explicit unit suffix, with or without a space", () => {
    expect(parseLength("500mm")).toBeCloseTo(0.5, 12);
    expect(parseLength("500 mm")).toBeCloseTo(0.5, 12);
    expect(parseLength("2 ft")).toBeCloseTo(0.6096, 12);
    expect(parseLength("6in")).toBeCloseTo(0.1524, 12);
  });

  it("reads feet and inches in the forms drafters type", () => {
    expect(parseLength("12'")).toBeCloseTo(3.6576, 12);
    expect(parseLength(`6"`)).toBeCloseTo(0.1524, 12);
    expect(parseLength("12'6")).toBeCloseTo(toMetres(150, "in"), 12);
    expect(parseLength(`12'6"`)).toBeCloseTo(toMetres(150, "in"), 12);
    expect(parseLength(`12'-6"`)).toBeCloseTo(toMetres(150, "in"), 12);
  });

  it("treats the hyphen in 12'-6\" as a separator, not a minus", () => {
    // The trap: reading it as subtraction gives 12 ft minus 6 in, which is 11'-6" — a wall half a foot
    // short, placed without complaint.
    expect(parseLength(`12'-6"`)).toBeGreaterThan(parseLength("12'")!);
  });

  it("reads fractional inches", () => {
    expect(parseLength(`6 1/2"`)).toBeCloseTo(toMetres(6.5, "in"), 12);
    expect(parseLength(`1/2"`)).toBeCloseTo(toMetres(0.5, "in"), 12);
    expect(parseLength(`12'-6 1/2"`)).toBeCloseTo(toMetres(150.5, "in"), 12);
  });

  it("handles a leading minus", () => {
    expect(parseLength("-5")).toBe(-5);
    expect(parseLength(`-12'6"`)).toBeCloseTo(-toMetres(150, "in"), 12);
  });

  it("returns null rather than guessing", () => {
    // This runs on every keystroke of a dynamic-input field, so a half-typed value must read as
    // "not yet" rather than as an error worth interrupting the user for.
    expect(parseLength("")).toBeNull();
    expect(parseLength("   ")).toBeNull();
    expect(parseLength("abc")).toBeNull();
    expect(parseLength("5 furlongs")).toBeNull();
    expect(parseLength("1/0\"")).toBeNull(); // division by zero denominator
  });

  it("round-trips metric formatting", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 9999, noNaN: true }), (metres) => {
        const text = formatLength(metres, METRIC);
        const back = parseLength(text);
        return back !== null && Math.abs(back - metres) <= 0.001;
      }),
    );
  });

  it("round-trips imperial architectural notation", () => {
    // The strongest statement about the imperial pair: what the formatter writes, the parser reads back
    // to within the fraction it rounded to. If either side is wrong, this fails — which is why it is
    // worth having on top of the individual carry-case examples.
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 300, noNaN: true }), (metres) => {
        const text = formatLength(metres, IMPERIAL);
        const back = parseLength(text);
        if (back === null) return false;
        const halfStep = toMetres(1 / 16, "in") / 2;
        return Math.abs(back - metres) <= halfStep + 1e-12;
      }),
    );
  });
});
