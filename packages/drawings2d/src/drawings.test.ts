import { describe, expect, it } from "vitest";
import { asGuid, type Guid } from "@massingviewer/core";
import { boundsOf, entitiesFor, guidsIn, layersIn, makeDrawing, type DrawingEntity } from "./model";
import { ARCHITECTURAL, FIRE_SAFETY, matches, paintFor } from "./theme";
import { PAPER_SIZES, fitToPaper, toPaper, transformFor } from "./paper";
import { toSvg } from "./svg";
import { createPlanProvider, generatePlan } from "./plan";
import type { ElementMesh } from "./provider";
import { cutTriangle, nestLoops, ringContains, signedArea, stitch } from "./section";

const A4 = PAPER_SIZES.find((p) => p.name === "A4")!;
const guid = (n: number): Guid => asGuid(`0Test${String(n).padStart(17, "0")}`);

/**
 * An axis-aligned box as a triangle soup, Y up, metres.
 *
 * Written out rather than generated from a library so the fixtures in this file are readable: when a cut test
 * fails, the geometry it failed on should be legible in the same screen as the assertion.
 */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], // bottom
    [4, 6, 5], [4, 7, 6], // top
    [0, 5, 1], [0, 4, 5], // -z
    [2, 6, 7], [2, 7, 3], // +z
    [0, 3, 7], [0, 7, 4], // -x
    [1, 5, 6], [1, 6, 2], // +x
  ];
  return faces.flatMap(([a, b, c]) => [...v[a!]!, ...v[b!]!, ...v[c!]!]);
}

function mesh(over: Partial<ElementMesh> & { positions: number[] }): ElementMesh {
  return { guid: guid(1), ifcClass: "IfcWall", ...over };
}

// ---------------------------------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------------------------------

describe("cutTriangle", () => {
  it("returns nothing when the triangle is entirely on one side", () => {
    expect(cutTriangle(0, 2, 0, 1, 2, 0, 0, 2, 1, 1)).toBeNull();
    expect(cutTriangle(0, 0, 0, 1, 0, 0, 0, 0, 1, 1)).toBeNull();
  });

  it("returns the crossing segment when two vertices are on one side", () => {
    const seg = cutTriangle(0, 0, 0, 0, 2, 0, 2, 0, 0, 1);
    expect(seg).not.toBeNull();
    expect(seg!).toHaveLength(2);
  });

  it("drops a triangle lying IN the plane rather than emitting duplicates", () => {
    // The degenerate case that is the *normal* case in BIM: floors sit at round numbers and people cut at round
    // numbers. Treating "on the plane" as a side produces duplicate and zero-length segments, which corrupt the
    // stitch into open chains — and an open chain becomes a wall with a gap in it.
    expect(cutTriangle(0, 1, 0, 1, 1, 0, 0, 1, 1, 1)).toBeNull();
  });

  it("handles a single vertex exactly on the plane without duplicating it", () => {
    // The vertex is found by both of its edges; without deduplication this yields three points and is discarded.
    const seg = cutTriangle(0, 1, 0, 1, 2, 0, 1, -1, 0, 1);
    expect(seg).not.toBeNull();
  });

  it("is insensitive to vertex order", () => {
    const a = cutTriangle(0, 0, 0, 0, 2, 0, 2, 0, 0, 1);
    const b = cutTriangle(2, 0, 0, 0, 0, 0, 0, 2, 0, 1);
    // The same plane through the same triangle must give the same segment however the vertices are listed —
    // otherwise a drawing depends on mesh winding, which no exporter guarantees.
    const norm = (s: NonNullable<typeof a>) => [...s].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    expect(norm(a!)).toEqual(norm(b!));
  });
});

describe("stitch", () => {
  it("closes a square from four segments in any order", () => {
    const segs = [
      [[0, 0], [1, 0]],
      [[1, 1], [0, 1]],
      [[1, 0], [1, 1]],
      [[0, 1], [0, 0]],
    ] as const;
    const { loops, open } = stitch(segs);
    expect(loops).toHaveLength(1);
    expect(open).toHaveLength(0);
  });

  it("reports an open chain rather than discarding it", () => {
    // Silently dropping this is the tempting simplification and it is wrong: an open chain means the mesh was
    // not watertight at the cut, which the caller must be able to report rather than have a user discover.
    const { loops, open } = stitch([
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
    ]);
    expect(loops).toHaveLength(0);
    expect(open).toHaveLength(1);
  });

  it("tolerates endpoints that disagree below the quantum", () => {
    // Plane intersection is not exact, so two segments meeting at a corner rarely produce identical floats.
    const segs = [
      [[0, 0], [1, 0]],
      [[1.000_02, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ] as const;
    expect(stitch(segs).loops).toHaveLength(1);
  });
});

describe("nesting", () => {
  it("computes signed area with a sign that reflects winding", () => {
    const ccw = [[0, 0], [2, 0], [2, 2], [0, 2]] as const;
    expect(signedArea(ccw)).toBeCloseTo(4, 9);
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-4, 9);
  });

  it("detects containment", () => {
    const outer = [[0, 0], [4, 0], [4, 4], [0, 4]] as const;
    expect(ringContains(outer, [[1, 1], [2, 1], [2, 2]])).toBe(true);
    expect(ringContains(outer, [[9, 9], [10, 9], [10, 10]])).toBe(false);
  });

  it("nests a hole inside its outer ring rather than filling it in", () => {
    // A wall with a doorway in the cut plane produces two loops. Drawing them as two filled shapes fills the
    // doorway in, which is the visible symptom of not nesting.
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[2, 2], [4, 2], [4, 4], [2, 4]];
    const regions = nestLoops([hole, outer]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(Math.abs(signedArea(regions[0]!.outer))).toBeCloseTo(100, 6);
  });

  it("keeps disjoint loops as separate regions", () => {
    const a: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const b: [number, number][] = [[5, 5], [6, 5], [6, 6], [5, 6]];
    expect(nestLoops([a, b])).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------------------------------

describe("generatePlan", () => {
  const wall = mesh({ guid: guid(1), ifcClass: "IfcWall", positions: box(0, 0, 0, 5, 3, 0.2) });
  const slab = mesh({ guid: guid(2), ifcClass: "IfcSlab", positions: box(-1, -0.2, -1, 6, 0, 4) });
  const highBeam = mesh({ guid: guid(3), ifcClass: "IfcBeam", positions: box(0, 4, 0, 5, 4.5, 0.3) });

  it("cuts a wall into poché and a cut outline, in that order", () => {
    const drawing = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 1.2 });
    const roles = drawing.entities.map((e) => e.role);
    // Fill under line: SVG paints in document order, so the reverse loses the heaviest line in the drawing.
    expect(roles).toEqual(["poche", "cut"]);
    expect(drawing.entities.every((e) => e.guid === guid(1))).toBe(true);
    expect(drawing.entities.every((e) => e.layer === "A-WALL")).toBe(true);
  });

  it("gives the cut its true plan dimensions", () => {
    const drawing = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 1.2 });
    expect(drawing.bounds.min.x).toBeCloseTo(0, 6);
    expect(drawing.bounds.max.x).toBeCloseTo(5, 6);
    expect(drawing.bounds.max.y - drawing.bounds.min.y).toBeCloseTo(0.2, 6);
  });

  it("draws a slab below the cut as dashed below-linework, not as a cut", () => {
    const drawing = generatePlan({ name: "L1", meshes: [slab] }, { kind: "plan", cutHeight: 1.2 });
    expect(drawing.entities.map((e) => e.role)).toEqual(["below"]);
  });

  it("omits elements above the cut WITHOUT calling them incomplete", () => {
    // On any real model most elements are above any given cut. Reporting them would make `incomplete` a list
    // nobody reads, which would defeat the one mechanism that surfaces a genuinely missing wall.
    const drawing = generatePlan({ name: "L1", meshes: [highBeam] }, { kind: "plan", cutHeight: 1.2 });
    expect(drawing.entities).toHaveLength(0);
    expect(drawing.provenance.incomplete).toEqual([]);
  });

  it("reports an element that straddles the plane but yields nothing closed", () => {
    // A wall missing from a plan looks exactly like a wall that is not there. This is the only signal.
    const openMesh = mesh({
      guid: guid(9),
      // Two loose triangles crossing the plane: they cross it but enclose nothing.
      positions: [0, 0, 0, 0, 2, 0, 1, 0, 0, 3, 0, 0, 3, 2, 0, 4, 0, 0],
    });
    const drawing = generatePlan({ name: "L1", meshes: [openMesh] }, { kind: "plan", cutHeight: 1 });
    expect(drawing.provenance.incomplete).toHaveLength(1);
    expect(drawing.provenance.incomplete[0]!.guid).toBe(guid(9));
    expect(drawing.provenance.incomplete[0]!.reason).toMatch(/cut plane/);
  });

  it("reports 100% guid coverage when every mesh is identified, and less when not", () => {
    const full = generatePlan({ name: "L1", meshes: [wall, slab] }, { kind: "plan", cutHeight: 1.2 });
    expect(full.provenance.guidCoverage).toBe(1);

    const anonymous = mesh({ guid: null, ifcClass: "IfcWall", positions: box(0, 0, 2, 5, 3, 2.2) });
    const partial = generatePlan({ name: "L1", meshes: [wall, anonymous] }, { kind: "plan", cutHeight: 1.2 });
    // Two entities per wall, one wall identified: exactly half.
    expect(partial.provenance.guidCoverage).toBeCloseTo(0.5, 6);
  });

  it("states its approximations rather than leaving them to be noticed", () => {
    const drawing = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 1.2 });
    const text = drawing.provenance.approximations.join(" ");
    expect(text).toMatch(/no hidden-line removal/);
    expect(text).toMatch(/no door swings/);
    expect(text).toMatch(/bounding box/);
  });

  it("cuts cleanly at a datum, which is the normal BIM case", () => {
    // ADR-0004 measured this: our sectioner yielded zero loops at h=3.0 and h=0.0 while ifc-lite yielded 7 and
    // 8, and cutting at a datum is exactly what people do. This asserts the coplanar handling that fixes it —
    // the wall's own top face lies in the plane and must not defeat the cut of the faces below it.
    const atTop = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 3 });
    // At exactly the top, the wall no longer straddles: it is below, and drawn as below-linework rather than
    // silently vanishing.
    expect(atTop.entities.map((e) => e.role)).toEqual(["below"]);

    const justUnder = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 2.999 });
    expect(justUnder.entities.filter((e) => e.role === "cut")).toHaveLength(1);
  });

  it("survives a cut through a wall with a real opening in the plane", () => {
    // Two separate boxes with a gap: the plan must show two cut profiles, not one spanning the doorway.
    const left = mesh({ guid: guid(4), positions: box(0, 0, 0, 2, 3, 0.2) });
    const right = mesh({ guid: guid(5), positions: box(3, 0, 0, 5, 3, 0.2) });
    const drawing = generatePlan({ name: "L1", meshes: [left, right] }, { kind: "plan", cutHeight: 1.2 });
    expect(drawing.entities.filter((e) => e.role === "cut")).toHaveLength(2);
    expect(guidsIn(drawing).sort()).toEqual([guid(4), guid(5)].sort());
  });
});

describe("the provider seam", () => {
  it("refuses a kind it cannot make instead of attempting it", async () => {
    const provider = createPlanProvider();
    const result = await provider.generate(
      { name: "x", meshes: [mesh({ positions: box(0, 0, 0, 1, 1, 1) })] },
      { kind: "elevation" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_kind");
  });

  it("refuses an empty model rather than returning an empty drawing", async () => {
    const result = await createPlanProvider().generate({ name: "x", meshes: [] }, { kind: "plan" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_geometry");
  });

  it("reports progress per element", async () => {
    const seen: number[] = [];
    await createPlanProvider().generate(
      {
        name: "x",
        meshes: [mesh({ positions: box(0, 0, 0, 1, 3, 1) }), mesh({ guid: guid(2), positions: box(2, 0, 0, 3, 3, 1) })],
      },
      { kind: "plan", cutHeight: 1 },
      { onProgress: (f) => seen.push(f) },
    );
    expect(seen).toEqual([0.5, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------------

describe("theme", () => {
  const cutWall: DrawingEntity = {
    id: "a",
    role: "cut",
    geometry: { kind: "polyline", points: [{ x: 0, y: 0 }], closed: true },
    layer: "A-WALL",
    ifcClass: "IfcWall",
  };

  it("selects on role, class, layer and attrs", () => {
    expect(matches(cutWall, { role: "cut" })).toBe(true);
    expect(matches(cutWall, { role: "below" })).toBe(false);
    expect(matches(cutWall, { ifcClass: ["IfcWall", "IfcSlab"] })).toBe(true);
    expect(matches(cutWall, { layer: "S-COLS" })).toBe(false);
    expect(matches(cutWall, { attr: { fireRated: "yes" } })).toBe(false);
    expect(matches({ ...cutWall, attrs: { fireRated: "yes" } }, { attr: { fireRated: "yes" } })).toBe(true);
  });

  it("merges paint per property, so a later rule does not discard earlier ones", () => {
    // Whole-object replacement is why theme files grow until every rule restates every property.
    const paint = paintFor(ARCHITECTURAL, cutWall);
    expect(paint.weight).toBe(0.5); // from the cut rule
    expect(paint.stroke).toBe("#111111"); // still from base
    expect(paint.fontSize).toBe(2.5);
  });

  it("gives cut, projection, below and hidden a real weight hierarchy", () => {
    // Getting the hierarchy wrong makes a drawing unreadable even when every line is in the right place.
    const at = (role: DrawingEntity["role"]) => paintFor(ARCHITECTURAL, { ...cutWall, role }).weight!;
    expect(at("cut")).toBeGreaterThan(at("projection"));
    expect(at("projection")).toBeGreaterThan(at("hidden"));
    expect(paintFor(ARCHITECTURAL, { ...cutWall, role: "below" }).dash).toBeDefined();
  });

  it("repaints the same entity differently per theme, with no regeneration", () => {
    // The claim the Semantic Drawing Model exists to make good on.
    const rated: DrawingEntity = { ...cutWall, attrs: { fireRated: "yes" } };
    expect(paintFor(ARCHITECTURAL, rated).stroke).toBe("#111111");
    expect(paintFor(FIRE_SAFETY, rated).stroke).toBe("#cc2200");
    expect(paintFor(FIRE_SAFETY, rated).weight).toBeGreaterThan(paintFor(FIRE_SAFETY, cutWall).weight!);
  });

  it("hides below-cut linework in the fire plan but keeps the building legible", () => {
    expect(paintFor(FIRE_SAFETY, { ...cutWall, role: "below" }).hidden).toBe(true);
    // Context is greyed, not removed — hiding it is what makes discipline drawings unusable on site.
    expect(paintFor(FIRE_SAFETY, cutWall).hidden).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------------------------------

describe("paper", () => {
  const drawing = makeDrawing({
    kind: "plan",
    name: "L1",
    entities: [
      {
        id: "a",
        role: "cut",
        layer: "A-WALL",
        geometry: {
          kind: "polyline",
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }],
          closed: true,
        },
      },
    ],
    view: { kind: "plan", cutHeight: 1.2 },
    provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
  });

  it("converts metres to millimetres at the stated scale", () => {
    const t = transformFor({ size: A4, scale: 100, margin: 10, origin: { x: 0, y: 0 } });
    expect(t.mmPerMetre).toBe(10);
    // 1:50 is twice as large on paper as 1:100 — the direction people get backwards.
    expect(transformFor({ size: A4, scale: 50, margin: 10, origin: { x: 0, y: 0 } }).mmPerMetre).toBe(20);
  });

  it("flips Y, because model space is Y-up and SVG is Y-down", () => {
    // Forgetting this produces a mirrored plan: obvious in hindsight, easy to miss on a symmetric fixture.
    const t = transformFor({ size: A4, scale: 100, margin: 10, origin: { x: 0, y: 0 } });
    const bottom = toPaper(t, { x: 0, y: 0 });
    const top = toPaper(t, { x: 0, y: 5 });
    expect(top.y).toBeLessThan(bottom.y);
  });

  it("fits at the largest scale that works and keeps it inside the margins", () => {
    const paper = fitToPaper(drawing, A4, 10);
    expect(paper).not.toBeNull();
    // 10 m on 277 mm of usable width: 1:50 gives 200 mm and fits; 1:25 would give 400 mm and does not.
    expect(paper!.scale).toBe(50);

    const t = transformFor(paper!);
    const min = toPaper(t, drawing.bounds.min);
    const max = toPaper(t, drawing.bounds.max);
    for (const p of [min, max]) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 0.01);
      expect(p.x).toBeLessThanOrEqual(A4.width - 10 + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(10 - 0.01);
      expect(p.y).toBeLessThanOrEqual(A4.height - 10 + 0.01);
    }
  });

  it("stays on the project's own scale ladder", () => {
    // A first version merged metric and imperial into one sorted list, and this fit chose 1:48 — the exact
    // equivalent of 1/4" = 1'-0". It fits, and it is finer than 1:50, so "largest that fits" picked it
    // correctly. It is also unmeasurable with a metric rule, and an architect handed that sheet would report it
    // as a bug. The reverse holds too: 1:50 on an imperial set is just as unusable.
    expect(fitToPaper(drawing, A4, 10, "metric")!.scale).toBe(50);
    expect(fitToPaper(drawing, A4, 10, "imperial")!.scale).toBe(48);
  });

  it("places a model not authored at the origin correctly", () => {
    // The bug that puts the plan off the sheet: assuming bounds start at 0,0.
    const shifted = makeDrawing({
      ...drawing,
      entities: drawing.entities.map((e) => ({
        ...e,
        geometry: {
          kind: "polyline" as const,
          points: (e.geometry as { points: { x: number; y: number }[] }).points.map((p) => ({
            x: p.x + 500,
            y: p.y + 300,
          })),
          closed: true,
        },
      })),
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const paper = fitToPaper(shifted, A4, 10)!;
    const t = transformFor(paper);
    const min = toPaper(t, shifted.bounds.min);
    expect(min.x).toBeGreaterThanOrEqual(9.99);
    expect(min.x).toBeLessThanOrEqual(A4.width - 9.99);
  });

  it("returns null rather than clipping when nothing fits", () => {
    // A drawing that does not fit has real answers — bigger sheet, smaller extent, split sheets — and all are
    // the caller's to pick. Quietly emitting a clipped drawing is never right, because it looks finished.
    const huge = makeDrawing({
      kind: "plan",
      name: "big",
      entities: [
        {
          id: "a",
          role: "cut",
          layer: "L",
          geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100_000, y: 0 }], closed: false },
        },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    expect(fitToPaper(huge, A4, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------------

describe("toSvg", () => {
  const wall = mesh({ guid: guid(1), ifcClass: "IfcWall", positions: box(0, 0, 0, 5, 3, 0.2) });
  const drawing = generatePlan({ name: "L1", meshes: [wall] }, { kind: "plan", cutHeight: 1.2 });
  const paper = fitToPaper(drawing, A4, 10)!;

  it("emits a sized, titled SVG in millimetres", () => {
    const svg = toSvg(drawing, ARCHITECTURAL, paper);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`width="297mm"`);
    expect(svg).toContain(`<title>L1</title>`);
    expect(svg).toContain(`data-scale="1:${paper.scale}"`);
    // White explicitly: a transparent drawing printed on anything but white loses its lightest lines.
    expect(svg).toContain(`fill="#ffffff"`);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("puts data-guid on every element-derived path", () => {
    // What makes a markup anchor to a wall rather than to a page coordinate.
    const svg = toSvg(drawing, ARCHITECTURAL, paper);
    const paths = svg.match(/<path[^>]*>/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toContain(`data-guid="${guid(1)}"`);
    expect(svg).toContain(`data-class="IfcWall"`);
    expect(svg).toContain(`data-role="cut"`);
  });

  it("emits fat transparent twins only when interactive, and only for identified geometry", () => {
    const plain = toSvg(drawing, ARCHITECTURAL, paper);
    expect(plain).not.toContain("data-hit");

    const interactive = toSvg(drawing, ARCHITECTURAL, paper, { interactive: true });
    // A 0.5 mm line is about one pixel; hit-testing one pixel with a mouse is not something anyone can do.
    expect(interactive).toContain(`stroke="transparent"`);
    expect(interactive).toContain(`stroke-width="8"`);
    expect(interactive).toContain(`data-hit="1"`);
    // Last, so they win the hit test while staying invisible.
    expect(interactive.indexOf("data-hit-layer")).toBeGreaterThan(interactive.indexOf("data-layer"));
  });

  it("groups by layer", () => {
    expect(toSvg(drawing, ARCHITECTURAL, paper)).toContain(`<g data-layer="A-WALL">`);
  });

  it("repaints without regenerating, and the geometry is byte-identical", () => {
    // The headline claim, asserted rather than described: the same Drawing, two themes, same paths.
    const architectural = toSvg(drawing, ARCHITECTURAL, paper);
    const fire = toSvg(drawing, FIRE_SAFETY, paper);
    const paths = (svg: string) => (svg.match(/ d="[^"]+"/g) ?? []).join("|");
    expect(paths(fire)).toBe(paths(architectural));
    expect(fire).not.toBe(architectural);
    expect(fire).toContain(`data-theme="Fire safety"`);
  });

  it("honours hidden and omits the entity entirely", () => {
    const withBelow = generatePlan(
      { name: "L1", meshes: [mesh({ guid: guid(2), ifcClass: "IfcSlab", positions: box(-1, -0.2, -1, 6, 0, 4) })] },
      { kind: "plan", cutHeight: 1.2 },
    );
    const fitted = fitToPaper(withBelow, A4, 10)!;
    expect(toSvg(withBelow, ARCHITECTURAL, fitted)).toContain("data-role=\"below\"");
    // FIRE_SAFETY hides below-linework, and hiding must mean absent rather than invisible-but-clickable.
    expect(toSvg(withBelow, FIRE_SAFETY, fitted)).not.toContain("data-role=\"below\"");
  });

  it("escapes text that would otherwise break the document", () => {
    const nasty = makeDrawing({
      kind: "plan",
      name: `Level "1" & <2>`,
      entities: [
        {
          id: "t",
          role: "annotation",
          layer: "A-ANNO",
          geometry: { kind: "text", at: { x: 0, y: 0 }, text: `<script>alert("x")</script>` },
        },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const svg = toSvg(nasty, ARCHITECTURAL, { size: A4, scale: 100, margin: 10, origin: { x: 100, y: 100 } });
    // This SVG is generated from IFC that arrived from a consultant, and with a local kernel there is no server
    // escaping in front of it. See the sanitiser note in the architecture doc.
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("Level &quot;1&quot; &amp; &lt;2&gt;");
  });

  it("draws a border only when asked", () => {
    expect(toSvg(drawing, ARCHITECTURAL, paper)).not.toContain(`data-role="sheet"`);
    expect(toSvg(drawing, ARCHITECTURAL, paper, { border: true })).toContain(`data-role="sheet"`);
  });
});

// ---------------------------------------------------------------------------------------------------
// Model queries
// ---------------------------------------------------------------------------------------------------

describe("model queries", () => {
  const drawing = generatePlan(
    {
      name: "L1",
      meshes: [
        mesh({ guid: guid(1), positions: box(0, 0, 0, 5, 3, 0.2) }),
        mesh({ guid: guid(2), ifcClass: "IfcColumn", positions: box(1, 0, 1, 1.4, 3, 1.4) }),
      ],
    },
    { kind: "plan", cutHeight: 1.2 },
  );

  it("returns every entity for an element, not just the first", () => {
    // One element produces many loops. A lookup returning the first would light one leg of an L-shaped wall and
    // look like a bug in the model.
    const forWall = entitiesFor(drawing, guid(1));
    expect(forWall.length).toBeGreaterThanOrEqual(2);
    expect(forWall.every((e) => e.guid === guid(1))).toBe(true);
  });

  it("lists distinct guids and layers", () => {
    expect(guidsIn(drawing).sort()).toEqual([guid(1), guid(2)].sort());
    expect(layersIn(drawing).sort()).toEqual(["A-WALL", "S-COLS"]);
  });

  it("returns a degenerate box rather than NaN for an empty drawing", () => {
    expect(boundsOf([])).toEqual({ min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
  });

  it("counts coverage over element-derived entities only", () => {
    // Including grid lines and sheet furniture would make coverage move for reasons unrelated to what it
    // measures, and a number that does that stops being read.
    const withGrid = makeDrawing({
      kind: "plan",
      name: "L1",
      entities: [
        ...drawing.entities,
        { id: "g1", role: "grid", layer: "A-GRID", geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 9, y: 0 }], closed: false } },
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    expect(withGrid.provenance.guidCoverage).toBe(1);
  });
});
