import { describe, expect, it } from "vitest";
import { generatePlan } from "./plan.js";
import type { ElementMesh } from "./provider.js";

/**
 * **Coplanar cuts — the regression test for a bug that silently deleted walls.**
 *
 * This file was written asserting the *defect*, on the precedent the openings work set: when the tessellator
 * ignored `IfcRelVoidsElement`, the golden suite carried a test asserting the wrong count deliberately, and
 * deleting it was how the fix announced itself. The fix has landed, so the expectations here have inverted — and
 * the measurements that motivated it are kept, because they are the reason the fix is shaped the way it is.
 *
 * ## The defect that was
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
 * ## What fixed it, and what it did not fix
 *
 * `generatePlan` detects a plane coincident with any face and moves it **up by 100 µm**, declaring it in
 * `provenance.approximations`. Two details were found the hard way and are worth keeping:
 *
 * - **The size is forced, not chosen.** The straddle test reads `extent.min < h - 1e-6`, so nudging by exactly that
 *   epsilon leaves `0 < 0` and changes nothing. A sweep found the sectioner *non-monotonic* below 0.1 mm — 50 µm is
 *   worse than 10 µm, and accuses a watertight cube of not being watertight. 100 µm was the first clean value.
 * - **Coincidence has to be detected at float32 precision.** Tessellated positions are `Float32Array`, so a datum
 *   authored as 2.1 arrives as `2.09999990463256836`. A 1e-9 window missed it, and the first version of this fix
 *   silently did nothing at the two datums that mattered most.
 *
 * **It is a mitigation, not a cure.** After the fix every datum yields the same loop count as 1 mm above it, which
 * is what "nudged up" should mean — but at the nudged height the sectioner still discards some open chains where
 * 1 mm above it discards none. Those are now *reported* in `incomplete[]` instead of vanishing, which is the whole
 * difference from the bug, and they are still losses.
 *
 * The cure is a watertight boolean — `manifold-3d` (Apache-2.0, permitted by both licence gates) intersecting the
 * solid with a thin slab. The sweep is independent evidence for it: an epsilon that has to be found by sweeping is
 * an epsilon that will be wrong on somebody's model.
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

describe("coplanar cuts", () => {
  it("cuts a solid correctly anywhere strictly inside it", () => {
    // The control. Away from a datum the sectioner is fine, which is why this defect survived: every test that
    // cuts at 1.2 m through a 2.4 m wall passes.
    expect(cuts(0.5)).toBe(1);
    expect(cuts(0.001)).toBe(1);
    expect(cuts(0.999)).toBe(1);
  });

  it("sections at the bottom face, where it used to emit nothing at all", () => {
    // A slab top on a storey elevation — the case that used to produce an empty drawing. The plane is nudged up,
    // so the cut lands just inside the solid and yields the loop it should have all along.
    expect(cuts(0)).toBe(1);
  });

  it("shows the storey ABOVE when cut exactly at the top face, which is now a decision rather than an accident", () => {
    // Nudging up means a plane exactly on the top face lands outside the solid, so nothing is cut. That is the
    // same answer as before — but for a stated reason instead of a discarded triangle, and it is the correct one:
    // a plan cut at the top of a wall is looking at the storey above it, where that wall is not.
    expect(cuts(1)).toBe(0);
    // And 10 µm below the top face there IS a solid to cut. That bounds the nudge from the other side: 100 µm is
    // small enough that a plane this close to a face is still treated as inside the solid rather than skipped.
    expect(cuts(1 - 1e-5)).toBe(1);
  });

  it("declares the nudge, because a silent correction is its own kind of wrong", () => {
    // The old bug was dangerous because it was invisible. A fix that quietly moved the plane instead would be the
    // same failure with a better outcome — the reviewer still would not know the plane they asked for is not the
    // plane that was cut.
    const drawing = generatePlan({ name: "cube", meshes: [cube("0aBcDeFgHiJkLmNoPqRsTu")], skipped: [] }, {
      kind: "plan",
      cutHeight: 0,
    });
    expect(drawing.entities.filter((e) => e.role === "cut")).toHaveLength(1);
    const said = drawing.provenance.approximations.join(" ");
    expect(said).toContain("coincident with a face");
    expect(said).toContain("storey above");
    // Nothing was lost, so nothing is reported lost.
    expect(drawing.provenance.incomplete).toEqual([]);
  });

  it("says nothing when the plane was not coincident, so the caveat means something when it appears", () => {
    // A caveat printed on every drawing is a caveat nobody reads.
    const drawing = generatePlan({ name: "cube", meshes: [cube("0aBcDeFgHiJkLmNoPqRsTu")], skipped: [] }, {
      kind: "plan",
      cutHeight: 0.5,
    });
    expect(drawing.provenance.approximations.join(" ")).not.toContain("coincident with a face");
  });
});
