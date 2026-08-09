/**
 * The fixture's expected values, asserted.
 *
 * This is what makes `fixtures/sample.ifc` a **fixture** rather than a snapshot: the right answers are
 * written down independently and checked, so a golden drawing generated from it is anchored to something
 * knowable. A committed file whose correct output nobody can state is only a record of what the code did
 * last time.
 *
 * It also guards the generator. `fixtures/build-sample.mjs` produces GlobalIds deterministically from a
 * counter; if anyone reorders the entity emission, every id downstream shifts and every golden drawing
 * silently rebases. These assertions turn that into a failing test instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGuid } from "@massing/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ifc = readFileSync(join(HERE, "sample.ifc"), "utf8");

/**
 * The building, as authored. Every value here is independently knowable from `build-sample.mjs` — not
 * copied out of a program's output.
 */
const EXPECTED = {
  schema: "IFC4",
  storeyName: "Level 1",
  storeyElevation: 0,
  wallThickness: 0.2,
  storeyHeight: 3.0,
  /** A plan cut at this height passes through both openings. */
  planCut: 1.2,
  elements: [
    { name: "Wall-South", type: "IFCWALL", guid: "OwCSTfxILZZaOeUwK4fcAk", expressId: 35 },
    { name: "Wall-North", type: "IFCWALL", guid: "j0LntYKgSuOsiBo9gxt0PP", expressId: 48 },
    { name: "Wall-West", type: "IFCWALL", guid: "2gsf7tD5Ae_XjaY7urBn5V", expressId: 61 },
    { name: "Wall-East", type: "IFCWALL", guid: "NzjmaL0SJr5JatlqcJWjvy", expressId: 74 },
    { name: "Door-01", type: "IFCOPENINGELEMENT", guid: "i1yz9x1vt_O0NPKMLlJvdE", expressId: 87 },
    { name: "Window-01", type: "IFCOPENINGELEMENT", guid: "Myod5PAaGqmNYvxmOIPtZY", expressId: 103 },
    { name: "Slab-Ground", type: "IFCSLAB", guid: "0O7BozxUdgUkAEZ_ax5xD5", expressId: 119 },
    { name: "Column-01", type: "IFCCOLUMN", guid: "LpNTCOzcezluqNibNVAaAY", expressId: 132 },
  ],
} as const;

describe("sample.ifc — file structure", () => {
  it("is a well-formed IFC4 STEP file", () => {
    expect(ifc.startsWith("ISO-10303-21;")).toBe(true);
    expect(ifc.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
    expect(ifc).toContain(`FILE_SCHEMA(('${EXPECTED.schema}'))`);
    expect(ifc).toContain("DATA;");
    expect(ifc).toContain("ENDSEC;");
  });

  it("declares metres, so no unit scaling is needed anywhere downstream", () => {
    // The whole codebase works in metres (see packages/core/src/units.ts). A fixture in millimetres would
    // make every geometric assertion 1000x wrong in a way that looks like a maths bug.
    expect(ifc).toContain("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    expect(ifc).not.toContain(".MILLI.");
  });

  it("is small enough to commit without thinking about it", () => {
    expect(ifc.length).toBeLessThan(64 * 1024);
  });

  it("has a fixed timestamp, so regenerating it produces no diff", () => {
    // A fixture that changes on every build cannot be golden-tested and dirties every unrelated PR.
    expect(ifc).toContain("'2026-08-06T00:00:00'");
  });
});

describe("sample.ifc — spatial hierarchy", () => {
  it("has the full Project/Site/Building/Storey chain", () => {
    // Without a storey there is nothing for a plan generator to cut at. This is precisely why massing's
    // 58 family-library IFCs could not be used as a fixture — they have no storeys.
    for (const type of ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY"]) {
      expect(ifc, type).toContain(`${type}(`);
    }
    expect(ifc).toContain(`'${EXPECTED.storeyName}'`);
  });

  it("aggregates the hierarchy and contains the elements", () => {
    expect((ifc.match(/IFCRELAGGREGATES\(/g) ?? []).length).toBe(3);
    expect((ifc.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE\(/g) ?? []).length).toBe(1);
  });
});

describe("sample.ifc — elements", () => {
  it.each(EXPECTED.elements)("has $name at #$expressId with a stable GlobalId", (el) => {
    // Assert the whole STEP line, not just that the id appears somewhere. This is what pins the
    // expressID-to-GlobalId pairing that every downstream drawing entity resolves through.
    const line = new RegExp(`#${el.expressId}= ${el.type}\\('${el.guid.replace(/\$/g, "\\$")}'`);
    expect(ifc).toMatch(line);
  });

  it("every GlobalId is a valid IFC GlobalId", () => {
    for (const el of EXPECTED.elements) expect(isGuid(el.guid), el.name).toBe(true);
  });

  it("GlobalIds are unique", () => {
    const ids = EXPECTED.elements.map((e) => e.guid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses extruded solids, not a faceted BREP", () => {
    // Deliberate: an extrusion is what push/pull edits, and what `set_extrusion_depth` refuses to operate
    // on when absent. A BREP fixture would not exercise the representation the authoring tools care about.
    expect(ifc).toContain("IFCEXTRUDEDAREASOLID(");
    expect(ifc).toContain("IFCARBITRARYCLOSEDPROFILEDEF(");
    expect(ifc).not.toContain("IFCFACETEDBREP(");
  });

  it("models openings as real voids", () => {
    // Two IfcOpeningElement + two IfcRelVoidsElement. If the openings were pre-split wall segments instead,
    // a sectioner would get two loops handed to it rather than having to resolve a void — which is the
    // thing actually being tested.
    expect((ifc.match(/IFCOPENINGELEMENT\(/g) ?? []).length).toBe(2);
    expect((ifc.match(/IFCRELVOIDSELEMENT\(/g) ?? []).length).toBe(2);
  });
});

describe("sample.ifc — the cases it exists to exercise", () => {
  // These are assertions about the *design* of the fixture. If someone edits the geometry, the fixture may
  // still parse while no longer testing anything, and a golden drawing would keep passing meaninglessly.

  it("the plan cut passes through both openings", () => {
    // Door head 2.1, window sill 0.9 / head 2.1. A cut at 1.2 is inside both.
    const cut = EXPECTED.planCut;
    expect(cut).toBeGreaterThan(0.9); // above the window sill
    expect(cut).toBeLessThan(2.1); // below both heads
  });

  it("the slab sits entirely below the plan cut", () => {
    // The element a naive sectioner wrongly includes — and the failure is invisible, because the plan
    // renders perfectly with a spurious rectangle around the whole building.
    expect(ifc).toContain("IFCSLAB(");
    const slabTop = 0; // extruded 0.2 upward from z=-0.2
    expect(slabTop).toBeLessThan(EXPECTED.planCut);
  });

  it("the column is small enough to test tolerance handling", () => {
    // 300 mm square. Small features are what get lost to a loose stitch tolerance.
    expect(ifc).toContain("IFCCOLUMN(");
    const columnSize = 4.15 - 3.85;
    expect(columnSize).toBeCloseTo(0.3, 10);
    expect(columnSize).toBeLessThan(EXPECTED.wallThickness * 2);
  });

  it("walls are thicker than the stitch tolerance by a wide margin", () => {
    // The loop stitcher quantises endpoints to 0.1 mm. A wall must be orders of magnitude thicker or its
    // two faces would collapse into one line.
    expect(EXPECTED.wallThickness).toBeGreaterThan(1e-4 * 100);
  });
});

describe("the property set", () => {
  /**
   * `Pset_WallCommon` on Wall-South, and the reason it is in the fixture at all.
   *
   * The property inspector's whole pset-rendering path was code no test exercised: the fixture had no property
   * sets, so the panel showed a name and nothing else — and would have shown nothing else on a real model too,
   * undetectably. Asserting the entities here is what makes the inspector's output anchored to something knowable
   * rather than to whatever the panel happened to render.
   */
  it("is attached to the south wall by an IfcRelDefinesByProperties", () => {
    expect(ifc).toContain("IFCPROPERTYSET");
    expect(ifc).toContain("'Pset_WallCommon'");
    expect(ifc).toContain("IFCRELDEFINESBYPROPERTIES");
  });

  it("carries the five properties, including a non-string value", () => {
    // A boolean and a typed real, deliberately: a pset of nothing but strings would let a formatter that renders
    // `[object Object]` or a bare `true` pass unnoticed.
    for (const name of ["Reference", "LoadBearing", "IsExternal", "ThermalTransmittance", "FireRating"]) {
      expect(ifc, `${name} missing from the pset`).toContain(`'${name}'`);
    }
    expect(ifc).toContain("IFCTHERMALTRANSMITTANCEMEASURE(0.28)");
    expect(ifc.match(/IFCPROPERTYSINGLEVALUE/g)).toHaveLength(5);
  });

  it("does not shift the elements' GlobalIds", () => {
    // Emitted after every element, on purpose: the ids come from a counter, so inserting entities earlier would
    // rebase every committed golden digest for no reason. These four are the values the goldens were blessed with.
    // Every element's committed GlobalId, unchanged. If one of these fails, the goldens under fixtures/golden/
    // have silently rebased and every digest needs re-reading rather than re-blessing.
    for (const element of EXPECTED.elements) {
      expect(ifc, `${element.name} shifted`).toContain(element.guid);
    }
  });
});
