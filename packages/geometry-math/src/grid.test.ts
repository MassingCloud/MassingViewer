import { describe, expect, it } from "vitest";
import { gridSnaps, resolveSnap } from "./snapEngine.js";

/**
 * The construction grid's snap candidates.
 *
 * M6's acceptance criterion begins *"snap to a grid intersection"*, and this is the half of that which can be
 * tested without a pointer or a renderer.
 */
describe("gridSnaps", () => {
  it("returns the enclosing intersection when the cursor is near one", () => {
    const snaps = gridSnaps({ x: 4.03, z: 5.98 }, 1, 0.2);
    expect(snaps).toEqual([{ x: 4, z: 6, kind: "grid" }]);
  });

  it("offers every corner in range, so resolveSnap decides rather than this function", () => {
    // Dead centre of a cell on a 1 m grid: all four corners are 0.707 m away. A function that returned only its
    // own idea of "nearest" would pre-empt the tie-break rule and make grid snapping behave differently from
    // every other snap kind.
    const snaps = gridSnaps({ x: 0.5, z: 0.5 }, 1, 0.75);
    expect(snaps).toHaveLength(4);
    expect(snaps.map((s) => `${s.x},${s.z}`).sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });

  it("is circular, not square", () => {
    // At radius 0.9 on a 1 m grid the axis-aligned neighbours of (0,0) are 1 m away and out of range, and so is
    // the diagonal at 1.41 m. A square bounds test would include all of them, and the crosshair would jump
    // further than the tolerance the user set.
    const snaps = gridSnaps({ x: 0, z: 0 }, 1, 0.9);
    expect(snaps).toEqual([{ x: 0, z: 0, kind: "grid" }]);
  });

  it("reaches the next intersection out when the radius exceeds one cell", () => {
    // `ceil` rather than `round` on the reach. With `round`, a radius fractionally over one cell would not
    // consider the intersection at exactly that distance, and the snap would blink off at the boundary.
    const snaps = gridSnaps({ x: 0, z: 0 }, 1, 1.05);
    expect(snaps.map((s) => `${s.x},${s.z}`).sort()).toEqual(["-1,0", "0,-1", "0,0", "0,1", "1,0"]);
  });

  it("handles a sub-metre grid without floating-point drift", () => {
    // 0.5 m spacing at x = 12.26 → 12.5, and *not* 12.500000000000002, which is what accumulating `x += spacing`
    // over 25 steps produces. Rounding to a multiple has no accumulation to drift.
    expect(gridSnaps({ x: 12.26, z: 0.03 }, 0.5, 0.25)).toEqual([{ x: 12.5, z: 0, kind: "grid" }]);
  });

  it("refuses a spacing or radius that would poison the comparison", () => {
    // `Math.round(x / 0)` is NaN or Infinity, and NaN fails every `<` test rather than throwing — so a bad
    // spacing would disable snapping silently instead of loudly.
    expect(gridSnaps({ x: 1, z: 1 }, 0, 1)).toEqual([]);
    expect(gridSnaps({ x: 1, z: 1 }, -1, 1)).toEqual([]);
    expect(gridSnaps({ x: 1, z: 1 }, Number.NaN, 1)).toEqual([]);
    expect(gridSnaps({ x: 1, z: 1 }, 1, 0)).toEqual([]);
  });

  it("loses to a model endpoint at the same distance", () => {
    // The priority that matters: a drafter reaching for a corner of the building wants the building, not the
    // paper underneath it. `grid` is the lowest-priority kind and this is what that buys.
    // Equidistant on purpose: the cursor sits at 0.9, the grid intersection is at 1.0 and a model endpoint at
    // 0.8, both 0.1 away. Only then is the tie-break doing the deciding rather than the distance.
    const grid = gridSnaps({ x: 0.9, z: 0 }, 1, 0.2);
    const endpoint = { x: 0.8, z: 0, kind: "endpoint" as const };
    const won = resolveSnap({ x: 0.9, z: 0 }, [...grid, endpoint], 0.2);
    expect(won?.kind).toBe("endpoint");
  });

  it("wins when nothing else is in range", () => {
    const grid = gridSnaps({ x: 3.02, z: 3.02 }, 1, 0.2);
    const won = resolveSnap({ x: 3.02, z: 3.02 }, [...grid, { x: 40, z: 40, kind: "endpoint" }], 0.2);
    expect(won).toMatchObject({ x: 3, z: 3, kind: "grid" });
  });
});
