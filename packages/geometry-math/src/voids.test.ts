import { describe, expect, it } from "vitest";
import { bandsForVoids, splitProfileByVoid, type Point2, type VoidCut } from "./voids.js";

/**
 * Subtracting openings from walls.
 *
 * The reason this is worth exact tests rather than eyeballing: a wall with no hole *renders perfectly*. There is no
 * error, no missing element, nothing on screen to suggest a door was dropped — which is exactly the failure the
 * whole `DrawingProvenance.incomplete` design exists to make impossible, and it was happening one layer earlier.
 *
 * Every expected value below is derivable from the numbers in the test, not copied from output.
 */

/** An 8 m × 200 mm wall running along +x, centred on z = 0 — the fixture's south wall. */
const WALL: Point2[] = [
  [0, -0.1],
  [8, -0.1],
  [8, 0.1],
  [0, 0.1],
];

/** A door from x = 3 to 3.9, modelled slightly thicker than the wall so the boolean is unambiguous. */
const DOOR: Point2[] = [
  [3, -0.125],
  [3.9, -0.125],
  [3.9, 0.125],
  [3, 0.125],
];

describe("splitProfileByVoid", () => {
  it("leaves a rectangle each side of a door", () => {
    const split = splitProfileByVoid(WALL, DOOR);
    expect(split).not.toBeNull();
    expect(split!.beside).toHaveLength(2);

    // The pieces span [0, 3] and [3.9, 8] along the wall — the wall minus the doorway.
    const spans = split!.beside.map((piece) => {
      const xs = piece.map((p) => p[0]);
      return [Math.min(...xs), Math.max(...xs)].map((n) => +n.toFixed(4));
    });
    expect(spans).toEqual([
      [0, 3],
      [3.9, 8],
    ]);
    // Full thickness kept: the door removes length, not depth.
    for (const piece of split!.beside) {
      const zs = piece.map((p) => p[1]);
      expect(Math.min(...zs)).toBeCloseTo(-0.1, 6);
      expect(Math.max(...zs)).toBeCloseTo(0.1, 6);
    }
  });

  it("reports which axis the void passes through, and the span it removed", () => {
    const split = splitProfileByVoid(WALL, DOOR)!;
    // The wall's `b` edge is its thickness; the door goes through that, so the span is along `a` — the length.
    expect(split.axis).toBe("b");
    expect(split.span[0]).toBeCloseTo(3 / 8, 6);
    expect(split.span[1]).toBeCloseTo(3.9 / 8, 6);
  });

  it("works on a wall at an angle, because it works in the host's own frame", () => {
    // The same wall rotated 45°: a world-axis implementation would produce nonsense here and there is nothing on
    // screen to reveal it — the hole would simply be in the wrong place or absent.
    const c = Math.SQRT1_2;
    const rot = (p: Point2): Point2 => [p[0] * c - p[1] * c, p[0] * c + p[1] * c];
    const split = splitProfileByVoid(WALL.map(rot), DOOR.map(rot));
    expect(split).not.toBeNull();
    expect(split!.beside).toHaveLength(2);
    // Lengths are preserved under rotation: 3 m and 4.1 m.
    const lengthOf = (piece: readonly Point2[]): number =>
      Math.max(...piece.map((p, i) => Math.hypot(p[0] - piece[(i + 1) % 4]![0], p[1] - piece[(i + 1) % 4]![1])));
    expect(lengthOf(split!.beside[0]!)).toBeCloseTo(3, 4);
    expect(lengthOf(split!.beside[1]!)).toBeCloseTo(4.1, 4);
  });

  it("returns no pieces when the opening is as wide as the wall", () => {
    // A real case, not an error: a doorway filling a short wall segment leaves nothing beside it.
    const split = splitProfileByVoid(WALL, [
      [-0.2, -0.2],
      [8.2, -0.2],
      [8.2, 0.2],
      [-0.2, 0.2],
    ]);
    expect(split).not.toBeNull();
    expect(split!.beside).toEqual([]);
  });

  it("keeps only one piece when the opening reaches an end of the wall", () => {
    const split = splitProfileByVoid(WALL, [
      [6, -0.2],
      [8.2, -0.2],
      [8.2, 0.2],
      [6, 0.2],
    ])!;
    expect(split.beside).toHaveLength(1);
    expect(Math.max(...split.beside[0]!.map((p) => p[0]))).toBeCloseTo(6, 4);
  });

  it("refuses a pocket, which needs an inner loop it cannot express", () => {
    // Not through the wall: a recess. `IfcArbitraryClosedProfileDef` has no inner loop, so approximating this
    // would put a hole where there is only a niche.
    const pocket: Point2[] = [
      [3, -0.05],
      [3.9, -0.05],
      [3.9, 0.05],
      [3, 0.05],
    ];
    expect(splitProfileByVoid(WALL, pocket)).toBeNull();
  });

  it("refuses a void that misses the wall", () => {
    const elsewhere: Point2[] = [
      [20, -0.2],
      [21, -0.2],
      [21, 0.2],
      [20, 0.2],
    ];
    expect(splitProfileByVoid(WALL, elsewhere)).toBeNull();
  });

  it("refuses anything that is not a four-point profile", () => {
    // An L-shaped wall needs real CSG. Refusing is what lets the caller *report* it, rather than drawing a wall
    // with no hole and saying nothing.
    const lShape: Point2[] = [
      [0, 0],
      [8, 0],
      [8, 2],
      [4, 2],
      [4, 0.2],
      [0, 0.2],
    ];
    expect(splitProfileByVoid(lShape, DOOR)).toBeNull();
    expect(splitProfileByVoid(WALL, [[0, 0], [1, 0], [1, 1]])).toBeNull();
  });

  it("refuses a degenerate host rather than dividing by zero", () => {
    // Zero-area profiles reach here from corrupt files. `dot(a, a)` of a zero edge is 0, and dividing by it
    // produces NaN that then fails every comparison in silence.
    expect(splitProfileByVoid([[0, 0], [0, 0], [0, 0], [0, 0]], DOOR)).toBeNull();
  });
});

describe("bandsForVoids", () => {
  /** The fixture's south wall: 3 m tall, with a door from the floor to 2.1 m. */
  const doorCut: VoidCut = { sill: 0, head: 2.1, profile: DOOR };
  /** Its north wall: a window from 0.9 m to 2.1 m. */
  const windowCut: VoidCut = {
    sill: 0.9,
    head: 2.1,
    profile: [
      [2, -0.125],
      [3.5, -0.125],
      [3.5, 0.125],
      [2, 0.125],
    ],
  };

  it("leaves one band when there are no voids", () => {
    const { bands, applied } = bandsForVoids(WALL, 3, []);
    expect(bands).toEqual([{ profile: WALL, from: 0, to: 3 }]);
    expect(applied).toBe(0);
  });

  it("splits a door into two side pieces and a lintel", () => {
    const { bands, applied, refused } = bandsForVoids(WALL, 3, [doorCut]);
    expect({ applied, refused }).toEqual({ applied: 1, refused: 0 });

    // The door reaches the floor, so there is no band below it: two sides from 0 to 2.1, and the lintel above.
    expect(bands).toHaveLength(3);
    const lintel = bands.filter((b) => b.from === 2.1);
    expect(lintel).toHaveLength(1);
    expect(lintel[0]!.to).toBe(3);
    expect(lintel[0]!.profile).toEqual(WALL);

    const sides = bands.filter((b) => b.from === 0);
    expect(sides).toHaveLength(2);
    for (const side of sides) expect(side.to).toBeCloseTo(2.1, 6);
  });

  it("splits a window into a sill band, two side pieces, and a head band", () => {
    const { bands } = bandsForVoids(WALL, 3, [windowCut]);
    // Four: below 0.9, two beside from 0.9 to 2.1, and above 2.1. This is the shape a plan cut at 1.2 m needs, and
    // it is why a cut there must produce two loops for this wall rather than one.
    expect(bands).toHaveLength(4);
    expect(bands.filter((b) => b.from === 0 && b.to === 0.9)).toHaveLength(1);
    expect(bands.filter((b) => b.from === 2.1 && b.to === 3)).toHaveLength(1);
    expect(bands.filter((b) => b.from === 0.9 && b.to === 2.1)).toHaveLength(2);
  });

  it("the total volume of the bands equals the wall minus the opening", () => {
    /**
     * The check that makes the decomposition trustworthy rather than plausible.
     *
     * Counting bands proves the shape of the answer; conserving volume proves the arithmetic. A split that
     * double-counted an overlap, or dropped a sliver, passes the count and fails this.
     */
    const area = (poly: readonly Point2[]): number => {
      let sum = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!;
        const q = poly[(i + 1) % poly.length]!;
        sum += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(sum) / 2;
    };
    const { bands } = bandsForVoids(WALL, 3, [windowCut]);
    const volume = bands.reduce((sum, b) => sum + area(b.profile) * (b.to - b.from), 0);

    // Wall: 8 × 0.2 × 3 = 4.8 m³. Window: 1.5 m wide × 0.2 thick × 1.2 tall = 0.36 m³ — the *wall's* thickness,
    // not the opening's oversized 0.25, because only the part inside the wall is removed.
    expect(volume).toBeCloseTo(4.8 - 0.36, 6);
  });

  it("applies two openings in one wall", () => {
    const { bands, applied, refused } = bandsForVoids(WALL, 3, [
      doorCut,
      { sill: 0.9, head: 2.1, profile: [[6, -0.125], [7, -0.125], [7, 0.125], [6, 0.125]] },
    ]);
    expect({ applied, refused }).toEqual({ applied: 2, refused: 0 });
    // Every band is within the wall and non-empty.
    for (const band of bands) {
      expect(band.to).toBeGreaterThan(band.from);
      expect(band.to).toBeLessThanOrEqual(3);
    }
    expect(bands.length).toBeGreaterThan(4);
  });

  it("counts a refused void instead of pretending it applied", () => {
    // The number a caller turns into a `DrawingProvenance.incomplete` entry. Reporting `applied: 1` here would be
    // the exact dishonesty this whole design is built to prevent.
    const { bands, applied, refused } = bandsForVoids(WALL, 3, [
      { sill: 0, head: 2, profile: [[0, 0], [1, 0], [1, 1]] },
    ]);
    expect({ applied, refused }).toEqual({ applied: 0, refused: 1 });
    // And the host is unchanged rather than mangled.
    expect(bands).toEqual([{ profile: WALL, from: 0, to: 3 }]);
  });

  it("ignores a void entirely outside the host's height", () => {
    // An opening recorded against the wrong storey. It removes nothing here, and must not remove anything.
    const { bands } = bandsForVoids(WALL, 3, [{ sill: 5, head: 7, profile: DOOR }]);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.profile).toEqual(WALL);
  });

  it("refuses to work on a zero-depth host", () => {
    const { bands } = bandsForVoids(WALL, 0, [doorCut]);
    expect(bands).toEqual([{ profile: WALL, from: 0, to: 0 }]);
  });
});
