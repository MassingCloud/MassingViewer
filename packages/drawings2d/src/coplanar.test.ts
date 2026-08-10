import { describe, expect, it } from "vitest";
import { generatePlan } from "./plan.js";
import type { ElementMesh } from "./provider.js";

/**
 * **A known defect, asserted on purpose so it cannot be forgotten.**
 *
 * This file follows the precedent the openings work set: when the tessellator ignored `IfcRelVoidsElement`, the
 * golden suite carried a test asserting the *wrong* count deliberately, and deleting that test was how the fix
 * announced itself. Same idea here.
 *
 * ## The defect
 *
 * `section.ts` drops coplanar triangles by design and says so. `docs/adr/0004-2d-drawing-engine.md` records the
 * consequence, and calls it *"the normal case in BIM, not an edge case — a slab top sitting precisely on a storey
 * elevation is ubiquitous"*.
 *
 * Measured on `fixtures/sample.ifc` at every distinct vertical extent in the model, comparing a cut exactly at the
 * datum against one 1 mm either side:
 *
 * | Datum (m) | 1 mm below | **exactly at** | 1 mm above |
 * |---|---|---|---|
 * | 0.000 | 1 | **0** | 6 |
 * | 0.900 | 6 | **5** | 7 |
 * | 2.100 | 7 | **3** | 5 |
 * | 3.000 | 5 | **0** | 0 |
 *
 * Every datum loses loops at the exact height. **2.100 is the one that matters most**: seven cut loops one
 * millimetre below, three exactly at it. Four loops — walls — disappear from the drawing.
 *
 * ## Why this is worse than a missing feature
 *
 * It is silent. `DrawingProvenance.incomplete` exists precisely so *"a plan that is silently missing a wall"*
 * reports itself, and it cannot help here: the sectioner does not know it dropped anything, so `incomplete` stays
 * empty and `guidCoverage` stays high while the drawing is wrong. A plan missing a wall renders perfectly and the
 * person who finds out is on site.
 *
 * ## What replaces it
 *
 * Robust coplanar handling is most of the difficulty in a sectioner, which is why ADR-0004 did not want to write
 * one. The fix is to cut with a watertight boolean — `manifold-3d` (Apache-2.0, permitted by both licence gates)
 * intersecting the solid with a thin slab — so coplanar faces stop being a special case rather than being dropped.
 * When that lands, **these expectations invert**: the exact cut should match the millimetre either side, and this
 * file becomes the regression test for the fix instead of the record of the bug.
 */

/** A 1 m cube from (0,0,0) to (1,1,1), as two triangles per face. Datums at y = 0 and y = 1 by construction. */
function cube(guid: string): ElementMesh {
  const v: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], // bottom, y = 0
    [4, 6, 5], [4, 7, 6], // top, y = 1
    [0, 4, 5], [0, 5, 1], // -z
    [3, 2, 6], [3, 6, 7], // +z
    [0, 3, 7], [0, 7, 4], // -x
    [1, 5, 6], [1, 6, 2], // +x
  ];
  const positions: number[] = [];
  for (const [a, b, c] of faces) {
    for (const i of [a, b, c]) positions.push(v[i]![0], v[i]![1], v[i]![2]);
  }
  return { guid: guid as never, ifcClass: "IfcWall", positions };
}

const cuts = (height: number): number => {
  const drawing = generatePlan({ name: "cube", meshes: [cube("0aBcDeFgHiJkLmNoPqRsTu")], skipped: [] }, {
    kind: "plan",
    cutHeight: height,
  });
  return drawing.entities.filter((e) => e.role === "cut").length;
};

describe("coplanar cuts — CURRENT BEHAVIOUR IS WRONG, asserted so the fix has a target", () => {
  it("cuts a solid correctly anywhere strictly inside it", () => {
    // The control. Away from a datum the sectioner is fine, which is why this defect survived: every test that
    // cuts at 1.2 m through a 2.4 m wall passes.
    expect(cuts(0.5)).toBe(1);
    expect(cuts(0.001)).toBe(1);
    expect(cuts(0.999)).toBe(1);
  });

  it("DROPS the section entirely at the bottom face — should be 1, is 0", () => {
    // A slab top on a storey elevation. The cut plane is coincident with a face, every triangle on it is
    // coplanar, and coplanar triangles are discarded — so nothing is emitted at all.
    expect(cuts(0)).toBe(0);
  });

  it("DROPS the section entirely at the top face — should be 1 or 0 by policy, is 0 by accident", () => {
    // Ambiguous on purpose: whether a cut exactly at the top of a solid should show it is a *decision*. Right now
    // it is not a decision, it is the same coplanar discard, and the two cases are indistinguishable from outside.
    expect(cuts(1)).toBe(0);
  });

  it("reports nothing as incomplete, which is the part that makes it dangerous", () => {
    // The provenance field that exists so a missing wall announces itself cannot see this: the sectioner does not
    // know it dropped anything. So the drawing is wrong AND claims to be complete.
    const drawing = generatePlan({ name: "cube", meshes: [cube("0aBcDeFgHiJkLmNoPqRsTu")], skipped: [] }, {
      kind: "plan",
      cutHeight: 0,
    });
    expect(drawing.entities.filter((e) => e.role === "cut")).toHaveLength(0);
    // Empty — no warning of any kind. When the fix lands this may legitimately stay empty *because the cut
    // succeeds*; today it is empty because the failure is invisible.
    expect(drawing.provenance.incomplete).toEqual([]);
  });
});
