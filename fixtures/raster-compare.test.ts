import { describe, expect, it } from "vitest";
import { ssim } from "ssim.js";
import {
  AA_TOLERANCE,
  compare,
  decodePng,
  diffImage,
  encodePng,
  worstDeltaOf,
  type RasterImage,
} from "./raster-compare.js";

/**
 * Tests for the Tier-3 comparator itself, run on **every PR** even though Tier 3 runs nightly.
 *
 * The gate this supports compares committed baselines against fresh renders, so on a healthy day every comparison
 * it makes is between identical images. That means the nightly job cannot distinguish a working comparator from one
 * that returns "same" unconditionally — it reports green either way, which is the failure mode that turns a visual
 * suite into decoration. So the comparator is exercised here against differences whose answers are known by
 * construction.
 */

/** A greyscale test image from a function of (x, y). Opaque, like every render this compares. */
function image(width: number, height: number, at: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = at(x, y);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const W = 400;
const H = 300;
/** A plan-shaped image: one horizontal and one vertical hairline on white. */
const plan = image(W, H, (x, y) => (y === 150 || x === 200 ? 0 : 255));

describe("compare", () => {
  it("reports a perfect match for identical images", () => {
    const c = compare(plan, plan);
    expect(c.ssim).toBe(1);
    expect(c.worstDelta).toBe(0);
    expect(c.over).toBe(0);
    expect(c.bbox).toBeNull();
  });

  it("catches a line moved by a single pixel", () => {
    // The difference a rasteriser makes when a coordinate changes in the fourth decimal place, and the one the
    // library's default options score as literally perfect. See the header of `raster-compare.ts`.
    const moved = image(W, H, (x, y) => (y === 151 || x === 200 ? 0 : 255));
    const c = compare(plan, moved);
    expect(c.worstDelta).toBe(255);
    // Both rows differ: the one that lost the line and the one that gained it, minus the pixel they share with the
    // vertical line, which is black in each.
    expect(c.over).toBe(2 * W - 2);
    expect(c.bbox).toEqual({ minX: 0, minY: 150, maxX: W - 1, maxY: 151 });
  });

  it("catches a line that got 30% lighter, which the SSIM mean does not", () => {
    /**
     * The measurement that decided the gate's shape.
     *
     * A single hairline lightened by 30% is 0.06% of the sheet, so `mssim` — a mean over every window — stays
     * *above* the 0.995 floor. Line weight is one of the two things `docs/testing.md` says this tier exists to
     * catch, so an SSIM-only gate would have shipped blind to it. `worstDelta` sees it at once.
     */
    const lighter = image(W, H, (x, y) => (y === 150 ? 77 : x === 200 ? 0 : 255));
    const c = compare(plan, lighter);
    expect(c.ssim).toBeGreaterThan(0.995);
    expect(c.worstDelta).toBe(77);
    expect(c.over).toBeGreaterThan(0);
  });

  it("absorbs anti-aliasing noise at or below the tolerance", () => {
    // Every channel off by exactly the tolerance: not a difference. One step more: a difference.
    const noisy = image(W, H, (x, y) => (y === 150 || x === 200 ? AA_TOLERANCE : 255 - AA_TOLERANCE));
    const at = compare(plan, noisy);
    expect(at.worstDelta).toBe(AA_TOLERANCE);
    expect(at.over).toBe(0);

    const louder = image(W, H, (x, y) => (y === 150 || x === 200 ? AA_TOLERANCE + 1 : 255));
    expect(compare(plan, louder).over).toBeGreaterThan(0);
  });

  it("refuses a size change instead of scoring one", () => {
    const wider = image(W + 1, H, () => 255);
    // A resized sheet compared by resampling would produce a similarity number, and a believable one. It has to be
    // a decision someone makes, not a score someone reads.
    expect(() => compare(wider, plan)).toThrow(/raster size changed/);
    expect(() => compare(wider, plan)).toThrow(/re-baseline deliberately/);
    // Every entry point, not just the one with the message attached to it.
    expect(() => worstDeltaOf(wider, plan)).toThrow(/raster size changed/);
    expect(() => diffImage(wider, plan)).toThrow(/raster size changed/);
  });

  it("counts alpha, because these renders are opaque by construction", () => {
    const transparent = image(W, H, () => 255);
    for (let p = 0; p < W * H; p++) transparent.data[p * 4 + 3] = 0;
    // A drawing that lost its white background rect looks identical on a white page and is a real regression:
    // printed on anything else it loses its lightest lines. That is exactly why `toSvg` emits the rect.
    expect(compare(transparent, image(W, H, () => 255)).over).toBe(W * H);
  });
});

describe("worstDeltaOf", () => {
  it("agrees with compare's worstDelta, which is the only reason it may skip the SSIM", () => {
    // Two implementations of one number is a drift risk. This is the assertion that makes the fast path safe to
    // use for the view-equivalence checks, which turn entirely on "is this zero".
    for (const other of [
      plan,
      image(W, H, (x, y) => (y === 151 || x === 200 ? 0 : 255)),
      image(W, H, (x, y) => (y === 150 ? 77 : x === 200 ? 0 : 255)),
      image(W, H, () => 255),
    ]) {
      expect(worstDeltaOf(plan, other)).toBe(compare(plan, other).worstDelta);
    }
  });
});

describe("the ssim.js defaults, asserted so a library change cannot silently blind the gate", () => {
  // An explicit timeout, at a full sheet's resolution on purpose. Structural similarity over 1.76 M pixels costs
  // 0.4 s with the defaults and 0.7 s without downsampling, and this test runs both — comfortably inside Vitest's
  // 5 s default in isolation, and *not* comfortably when 53 test files are competing for the same cores, which is
  // how it first failed. Shrinking the image would make the number cheaper and the claim weaker: the trap is that
  // the defaults are blind at **the size this repo actually renders**, so that is the size to measure at.
  it("scores a three-pixel line shift as perfect, which is why they are overridden", { timeout: 30_000 }, () => {
    /**
     * Not a test of our code. A test of the assumption our code is built on.
     *
     * `ssim.js` defaults to the original paper's automatic downsampling with `maxSize: 256`, which is right for
     * photographs and destroys linework: a 1600-px-wide plan is reduced past the point where a hairline exists. If
     * a future release changes that default — in either direction — this test says so, and the comment in
     * `raster-compare.ts` explaining the override stops being true silently.
     */
    const base = image(1600, 1100, (x, y) => (y === 350 || x === 600 ? 0 : 255));
    const shifted = image(1600, 1100, (x, y) => (y === 353 || x === 600 ? 0 : 255));

    expect(ssim(base, shifted, {}).mssim).toBe(1);
    // And the configuration the comparator actually uses sees it, well below the 0.995 floor.
    expect(compare(base, shifted).ssim).toBeLessThan(0.995);
  });
});

describe("png round trip", () => {
  it("survives encode and decode unchanged", () => {
    // The baselines are committed as PNG so a reviewer can open them in the diff view. That only holds if the bytes
    // we write decode back to the pixels we compared.
    const back = decodePng(encodePng(plan));
    expect(back.width).toBe(W);
    expect(back.height).toBe(H);
    expect(worstDeltaOf(back, plan)).toBe(0);
  });
});

describe("diffImage", () => {
  it("marks the differing pixels red and washes the rest", () => {
    const moved = image(W, H, (x, y) => (y === 151 || x === 200 ? 0 : 255));
    const diff = diffImage(plan, moved);
    const pixel = (x: number, y: number): number[] => {
      const i = (y * W + x) * 4;
      return [diff.data[i], diff.data[i + 1], diff.data[i + 2], diff.data[i + 3]];
    };
    // On the two rows that disagree: crimson.
    expect(pixel(50, 150)).toEqual([220, 20, 60, 255]);
    expect(pixel(50, 151)).toEqual([220, 20, 60, 255]);
    // Blank paper stays white; the shared vertical line survives as pale grey so there is context around the red.
    expect(pixel(50, 10)).toEqual([255, 255, 255, 255]);
    expect(pixel(200, 10)).toEqual([195, 195, 195, 255]);
  });
});
