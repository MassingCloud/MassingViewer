import { describe, expect, it } from "vitest";
import { asGuid, type Guid } from "@massingviewer/core";
import { ARCHITECTURAL, FIRE_SAFETY } from "./theme.js";
import { PAPER_SIZES, fitToPaper } from "./paper.js";
import { generatePlan } from "./plan.js";
import { makeDrawing, type DrawingEntity } from "./model.js";
import { dxfLimitations, toDxf } from "./dxf.js";
import { toSvg } from "./svg.js";
import type { ElementMesh } from "./provider.js";

/**
 * ## What these tests do and do not prove
 *
 * There is **no independent DXF parser available here** — no `ezdxf`, no `dxf-parser` — so unlike the BCF ZIP,
 * which is extracted by CPython's own `zipfile`, this output is not checked by a third-party reader. Saying so
 * matters: the two exporters in this codebase do *not* have equal verification, and assuming they do is how a
 * DXF that no CAD application opens ships.
 *
 * What is checked instead is stronger than a round trip through our own reader, and weaker than a real parser:
 *
 * 1. **The format's own rules**, by a validator written against the R12 spec rather than against this writer —
 *    group codes pair up, sections balance, every referenced layer is declared, EOF terminates.
 * 2. **Semantics that a validator cannot see**: that coordinates measure correctly at the stated scale, that Y is
 *    *not* flipped (DXF is Y-up, SVG is Y-down, and getting it wrong mirrors the drawing), that arc direction
 *    survives the transform, and that layer names obey R12's character rules.
 * 3. **Agreement with the SVG path**, since both are the same function of the same inputs.
 *
 * The check this cannot make is "AutoCAD opens it". That needs a real reader, and it belongs in a nightly job
 * against one rather than in a claim here.
 */

const A3 = PAPER_SIZES.find((p) => p.name === "A3")!;
const guid = (n: number): Guid => asGuid(`0Test${String(n).padStart(17, "0")}`);

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5],
    [2, 6, 7], [2, 7, 3], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  return faces.flatMap(([a, b, c]) => [...v[a!]!, ...v[b!]!, ...v[c!]!]);
}

const mesh = (over: Partial<ElementMesh> & { positions: number[] }): ElementMesh => ({
  guid: guid(1),
  ifcClass: "IfcWall",
  ...over,
});

/** A 5 m × 0.2 m wall, cut at 1.2 m. Known dimensions, so scale assertions can be exact. */
const wall = mesh({ guid: guid(1), ifcClass: "IfcWall", positions: box(0, 0, 0, 5, 3, 0.2) });
const slab = mesh({ guid: guid(2), ifcClass: "IfcSlab", positions: box(-1, -0.2, -1, 6, 0, 4) });
const drawing = generatePlan({ name: "L1", meshes: [wall, slab] }, { kind: "plan", cutHeight: 1.2 });
const paper = fitToPaper(drawing, A3, 10)!;

// ---------------------------------------------------------------------------------------------------
// A validator, written against the R12 format rather than against our writer
// ---------------------------------------------------------------------------------------------------

interface Parsed {
  readonly pairs: readonly { code: number; value: string }[];
  readonly sections: readonly string[];
  readonly declaredLayers: readonly string[];
  readonly entities: readonly { type: string; layer: string; colour: number; groups: Map<number, string[]> }[];
}

/**
 * Parse the group-pair stream and check the structural rules R12 requires.
 *
 * Deliberately not a general DXF reader — it is a *validator*. It fails on the mistakes a hand-written emitter
 * actually makes: an odd number of lines, a non-numeric code, an unbalanced section, an entity on an undeclared
 * layer, a missing EOF.
 */
function validateDxf(text: string): Parsed {
  const lines = text.split("\n");
  // Every DXF is a sequence of (code, value) line pairs. A trailing newline leaves one empty line.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length % 2 !== 0) {
    throw new Error(`DXF has ${lines.length} lines — group codes and values must pair, so it must be even`);
  }

  const pairs: { code: number; value: string }[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const raw = lines[i]!.trim();
    if (!/^-?\d+$/.test(raw)) throw new Error(`line ${i + 1}: "${raw}" is not a group code`);
    pairs.push({ code: Number(raw), value: lines[i + 1]! });
  }

  const sections: string[] = [];
  const declaredLayers: string[] = [];
  const entities: { type: string; layer: string; colour: number; groups: Map<number, string[]> }[] = [];

  let depth = 0;
  let inTables = false;
  let inEntities = false;
  let current: { type: string; layer: string; colour: number; groups: Map<number, string[]> } | null = null;
  let sawEof = false;

  for (const [i, pair] of pairs.entries()) {
    if (pair.code === 0) {
      if (pair.value === "SECTION") {
        depth += 1;
        const name = pairs[i + 1];
        if (name === undefined || name.code !== 2) throw new Error("SECTION is not followed by a (2, name) pair");
        sections.push(name.value);
        inTables = name.value === "TABLES";
        inEntities = name.value === "ENTITIES";
      } else if (pair.value === "ENDSEC") {
        depth -= 1;
        if (depth < 0) throw new Error("ENDSEC without a matching SECTION");
        inTables = false;
        inEntities = false;
      } else if (pair.value === "EOF") {
        sawEof = true;
      } else if (inTables && pair.value === "LAYER") {
        const name = pairs[i + 1];
        // The LAYER *table header* is also `(0, TABLE)(2, LAYER)`, so only entries with a following (2, name) that
        // is not the table declaration count.
        if (name !== undefined && name.code === 2) declaredLayers.push(name.value);
      } else if (inEntities) {
        current = { type: pair.value, layer: "0", colour: 7, groups: new Map() };
        entities.push(current);
      }
      continue;
    }
    if (current !== null && inEntities) {
      if (pair.code === 8) current.layer = pair.value;
      if (pair.code === 62) current.colour = Number(pair.value);
      const bucket = current.groups.get(pair.code);
      if (bucket) bucket.push(pair.value);
      else current.groups.set(pair.code, [pair.value]);
    }
  }

  if (depth !== 0) throw new Error(`${depth} section(s) left unclosed`);
  if (!sawEof) throw new Error("no EOF");

  // The rule that actually bites: several readers reject an entity referencing an undeclared layer, and AutoCAD
  // silently accepts it — so this passes in the one tool people test with and fails everywhere else.
  const known = new Set(declaredLayers);
  for (const entity of entities) {
    if (entity.layer !== "" && !known.has(entity.layer)) {
      throw new Error(`entity ${entity.type} is on layer "${entity.layer}", which the LAYER table does not declare`);
    }
  }

  return { pairs, sections, declaredLayers, entities };
}

// ---------------------------------------------------------------------------------------------------

describe("toDxf — structure", () => {
  it("is a well-formed R12 file", () => {
    const parsed = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    expect(parsed.sections).toEqual(["HEADER", "TABLES", "ENTITIES"]);
    const version = parsed.pairs.findIndex((p) => p.code === 9 && p.value === "$ACADVER");
    // AC1009 is R12. Claiming a later revision while emitting R12 entities is how a file half-opens.
    expect(parsed.pairs[version + 1]!.value).toBe("AC1009");
  });

  it("declares every layer its entities reference", () => {
    // The rule AutoCAD forgives and other readers do not, so a file that works in the tool you tested with fails
    // everywhere else. `validateDxf` throws on violation, so reaching the assertion is the check.
    const parsed = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    expect(parsed.declaredLayers).toContain("A-WALL");
    expect(parsed.declaredLayers).toContain("0");
  });

  it("emits POLYLINE rather than LWPOLYLINE", () => {
    // LWPOLYLINE is R2000+, and would be silently ignored by exactly the old readers R12 exists to serve.
    const text = toDxf(drawing, ARCHITECTURAL, paper);
    expect(text).toContain("POLYLINE");
    expect(text).not.toContain("LWPOLYLINE");
    expect(text).toContain("SEQEND");
  });

  it("sanitises layer names to what R12 permits", () => {
    // R12 allows only A-Z 0-9 $ - _ and mangles the rest unpredictably — and the layer structure is the main
    // thing a consultant opens a DXF for.
    const odd = makeDrawing({
      kind: "plan",
      name: "x",
      entities: [
        {
          id: "a",
          role: "cut",
          layer: "A-Wall (new) #2",
          geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
        },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const parsed = validateDxf(toDxf(odd, ARCHITECTURAL, fitToPaper(odd, A3, 10)!));
    expect(parsed.declaredLayers).toContain("A-WALL-NEW-2");
    for (const layer of parsed.declaredLayers) expect(layer).toMatch(/^[A-Z0-9$\-_]+$/);
  });
});

describe("toDxf — geometry", () => {
  it("measures correctly at the stated scale", () => {
    // A consultant scaling off a DXF expects it to measure at its stated scale. Derived from the paper rather
    // than hardcoded: `fitToPaper` picks the scale, and a test that restates its answer breaks whenever the
    // fixture's extent changes for an unrelated reason — which is exactly what happened to a first version that
    // asserted 1:25 and got the correct 1:20.
    const mmPerMetre = 1000 / paper.scale;
    const modelWidth = drawing.bounds.max.x - drawing.bounds.min.x;

    const parsed = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    // VERTEX only. R12 requires a POLYLINE header to carry a dummy `(10,20,30)` point, conventionally zero — and
    // reading group 10 across every entity picked those zeros up, making the measured extent 385 mm instead of
    // 350. The zeros are correct output; the measurement was wrong.
    const xs = parsed.entities
      .filter((e) => e.type === "VERTEX")
      .flatMap((e) => (e.groups.get(10) ?? []).map(Number))
      .filter((v) => Number.isFinite(v));
    expect(xs.length).toBeGreaterThan(0);
    const spread = Math.max(...xs) - Math.min(...xs);
    expect(spread).toBeCloseTo(modelWidth * mmPerMetre, 0);
  });

  it("does NOT flip Y, unlike the SVG path", () => {
    // DXF is Y-up like the model; SVG is Y-down. Flipping here would mirror the drawing, which is obvious in
    // hindsight and easy to miss on a symmetric fixture.
    const twoBars = makeDrawing({
      kind: "plan",
      name: "x",
      entities: [
        {
          id: "low",
          role: "cut",
          layer: "L",
          geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
        },
        {
          id: "high",
          role: "cut",
          layer: "L",
          geometry: { kind: "polyline", points: [{ x: 0, y: 4 }, { x: 1, y: 4 }], closed: false },
        },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const fitted = fitToPaper(twoBars, A3, 10)!;
    const parsed = validateDxf(toDxf(twoBars, ARCHITECTURAL, fitted));
    const yOf = (id: string): number => {
      const index = twoBars.entities.findIndex((e) => e.id === id);
      // Entities are emitted in order; each polyline contributes one POLYLINE plus its VERTEXes.
      const vertices = parsed.entities.filter((e) => e.type === "VERTEX");
      return Number(vertices[index * 2]!.groups.get(20)![0]);
    };
    // The model-space-higher bar must be numerically higher in the DXF.
    expect(yOf("high")).toBeGreaterThan(yOf("low"));

    // And the SVG must be the other way round, which is what makes the two agree visually.
    const svg = toSvg(twoBars, ARCHITECTURAL, fitted);
    const svgYs = [...svg.matchAll(/M[\d.-]+,([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(svgYs[1]!).toBeLessThan(svgYs[0]!);
  });

  it("reverses arc direction to match the Y convention", () => {
    // A door swing arced the wrong way is the visible symptom, and a symmetric fixture hides it.
    const arc = makeDrawing({
      kind: "plan",
      name: "x",
      entities: [
        {
          id: "swing",
          role: "projection",
          layer: "A-DOOR",
          geometry: { kind: "arc", centre: { x: 1, y: 1 }, radius: 0.9, from: 0, to: Math.PI / 2 },
        },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const arcPaper = fitToPaper(arc, A3, 10)!;
    const parsed = validateDxf(toDxf(arc, ARCHITECTURAL, arcPaper));
    const entity = parsed.entities.find((e) => e.type === "ARC")!;
    // DXF arcs sweep counter-clockwise from start (50) to end (51). Model 0 → 90° becomes 270° → 0 once Y flips.
    expect(Number(entity.groups.get(50)![0])).toBeCloseTo(270, 0);
    expect(Number(entity.groups.get(51)![0])).toBeCloseTo(0, 0);
    // Radius from the paper's own scale, not a hardcoded one.
    expect(Number(entity.groups.get(40)![0])).toBeCloseTo(0.9 * (1000 / arcPaper.scale), 1);
  });

  it("exports a region as its rings, since R12 has no HATCH", () => {
    const parsed = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    // Poché is a region; it becomes a closed polyline. The fill is lost, and `dxfLimitations` says so.
    const closed = parsed.entities.filter((e) => e.type === "POLYLINE" && e.groups.get(70)?.[0] === "1");
    expect(closed.length).toBeGreaterThan(0);
    expect(parsed.entities.some((e) => e.type === "HATCH")).toBe(false);
  });
});

describe("toDxf — theming", () => {
  it("maps stroke colours to the nearest AutoCAD Color Index", () => {
    // R12 has no true colour. Approximating keeps the line hierarchy; writing 7 for everything would lose it.
    const parsed = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    for (const entity of parsed.entities.filter((e) => e.type !== "VERTEX" && e.type !== "SEQEND")) {
      expect(entity.colour).toBeGreaterThan(0);
      expect(entity.colour).toBeLessThanOrEqual(255);
    }
  });

  it("respects the theme's hidden entities by default, and can be told not to", () => {
    // Silently exporting hidden linework is how a fire-safety plan arrives with the whole building's below-cut
    // geometry in it — so including it is a choice the caller makes, not a default.
    const withoutHidden = validateDxf(toDxf(drawing, FIRE_SAFETY, paper));
    const withHidden = validateDxf(toDxf(drawing, FIRE_SAFETY, paper, { includeHidden: true }));
    expect(withHidden.entities.length).toBeGreaterThan(withoutHidden.entities.length);

    // And the architectural theme, which hides nothing, matches the include-hidden count.
    const architectural = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    expect(architectural.entities.length).toBe(withHidden.entities.length);
  });

  it("is the same function of the same inputs as toSvg", () => {
    // The claim `drawings2d` exists to make: one Drawing, two serialisers, no parallel generation path. massing
    // has plan_svg and plan_dxf as separate paths, which is why they disagree.
    const dxf = validateDxf(toDxf(drawing, ARCHITECTURAL, paper));
    const svgPaths = (toSvg(drawing, ARCHITECTURAL, paper).match(/<path /g) ?? []).length;
    // Every SVG path is one DXF entity, except a region with holes, which becomes one polyline per ring.
    const dxfShapes = dxf.entities.filter((e) => e.type !== "VERTEX" && e.type !== "SEQEND").length;
    expect(dxfShapes).toBeGreaterThanOrEqual(svgPaths);
  });
});

describe("toDxf — honesty about what is lost", () => {
  it("states its limitations, including that GlobalIds do not survive", () => {
    // A DXF is a delivery format, not a round trip — a markup placed on one cannot come back, and that is the
    // single most important thing for a user to know before choosing this export over SVG.
    const limits = dxfLimitations().join(" ");
    expect(limits).toMatch(/GlobalIds are not carried/);
    expect(limits).toMatch(/no fills/);
    expect(limits).toMatch(/no lineweights/);
    expect(limits).toMatch(/Color Index/);
  });

  it("really does not contain the GlobalIds, so the limitation is not just documentation", () => {
    // Asserting the stated loss actually happens. A limitation list that disagrees with the output is worse than
    // no list, because it is the thing a user trusts.
    const text = toDxf(drawing, ARCHITECTURAL, paper);
    expect(text).not.toContain(guid(1));
    expect(text).not.toContain(guid(2));
  });
});

describe("toDxf — degenerate input", () => {
  it("produces a valid empty drawing rather than a malformed one", () => {
    const empty = makeDrawing({
      kind: "plan",
      name: "empty",
      entities: [],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const parsed = validateDxf(
      toDxf(empty, ARCHITECTURAL, { size: A3, scale: 100, margin: 10, origin: { x: 0, y: 0 } }),
    );
    expect(parsed.entities).toEqual([]);
    expect(parsed.declaredLayers).toEqual(["0"]);
  });

  it("skips a polyline with fewer than two points instead of emitting a broken one", () => {
    const degenerate: DrawingEntity = {
      id: "d",
      role: "cut",
      layer: "L",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }], closed: false },
    };
    const d = makeDrawing({
      kind: "plan",
      name: "x",
      entities: [degenerate],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const parsed = validateDxf(toDxf(d, ARCHITECTURAL, { size: A3, scale: 100, margin: 10, origin: { x: 0, y: 0 } }));
    expect(parsed.entities).toEqual([]);
  });
});
