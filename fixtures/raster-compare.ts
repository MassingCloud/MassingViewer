import { PNG } from "pngjs";
// A named import, not the default. `ssim.js` ships CommonJS with no `module` field and its default export *is* the
// function, so `import pkg from "ssim.js"` yields a callable whose `.ssim` property is undefined — which fails at
// the call site rather than at the import. The named form works under both Node and Vite.
import { ssim } from "ssim.js";

/**
 * The Tier-3 raster comparator.
 *
 * Separate from `raster.test.ts` and covered by `raster-compare.test.ts` on **every PR**, even though the tier it
 * serves runs nightly. The reason is the oldest failure mode in visual testing: *a comparator that returns "same"
 * for everything passes every baseline forever, and reports green while doing it.* The nightly job cannot catch
 * that — its baselines match. So the comparator is tested against known-different images, per-PR, separately from
 * the images it is used on.
 *
 * ## Why the SSIM options are set explicitly, and why that matters more than the threshold
 *
 * `ssim.js` defaults to `{ downsample: "original", maxSize: 256 }` — the automatic downsampling from the original
 * Wang et al. paper, which is right for photographs and **actively wrong for line drawings**. Measured on a
 * 1600×1100 synthetic plan:
 *
 * | Change | ssim.js defaults | `downsample: false` |
 * |---|---|---|
 * | A line shifted 1 px | **1.000000** | 0.988189 |
 * | A line shifted 3 px | **1.000000** | 0.986576 |
 * | A whole line dropped | 0.965241 | 0.990062 |
 *
 * A gate with the default options scores a three-pixel shift of a wall as *perfect*. That is not a threshold
 * problem — no floor below 1.0 catches it — so `raster-compare.test.ts` asserts this specific difference, which
 * makes a future `ssim.js` release that changes its defaults a red test rather than a silently blind gate.
 *
 * ## Why SSIM is the second gate here rather than the first
 *
 * These drawings rasterise **deterministically**: `resvg` is version-pinned, system fonts are switched off, and
 * there is no GPU in the path. So the honest primary assertion is that the pixels are the *same*, with a small
 * per-channel tolerance for anti-aliasing arithmetic that might differ between host architectures.
 *
 * SSIM's weakness on sparse linework is why it cannot be the primary: `mssim` is a mean over the whole image, and
 * a single 1-px line lightened by 30% is 0.06% of a sheet — it scores 0.9994 and sails past a 0.995 floor. Line
 * weight is one of the two things the plan says this tier exists to catch, so a mean-based gate alone would have
 * shipped blind to it. `worstDelta` catches it immediately; `mssim` then says *how structural* a caught difference
 * is, which is what a human reading the failure actually needs.
 */

/** RGBA, 8 bits per channel, row-major. The shape both `pngjs` and `ssim.js` speak. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface Comparison {
  /** Mean structural similarity, full resolution. 1 is identical. */
  readonly ssim: number;
  /** The largest single-channel absolute difference anywhere in the image, 0–255. */
  readonly worstDelta: number;
  /** How many pixels differ by more than `tolerance` on any channel. */
  readonly over: number;
  /** Bounding box of those pixels, or null if there are none. Inclusive. */
  readonly bbox: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null;
}

/**
 * The anti-aliasing tolerance, in 8-bit channel steps.
 *
 * Two, not zero, and **not validated across architectures yet**. The baselines committed with this file were
 * generated on `win32-x64`; `tiny-skia`'s rasterisation is deterministic float arithmetic, so an `x86-64` Linux
 * runner should agree bit-for-bit, but "should" is not a measurement. If the first nightly run on Ubuntu disagrees,
 * the failure prints `worstDelta` and the differing-pixel count, and this number gets set from that data instead of
 * guessed — the same posture `perf/README.md` takes about its budgets.
 *
 * What it must never absorb is a real change: a moved or missing line differs by ~255, two orders of magnitude
 * above this.
 */
export const AA_TOLERANCE = 2;

/** Full-resolution SSIM. See the header — the defaults are unusable for linework. */
const SSIM_OPTIONS = { downsample: false as const };

export function decodePng(bytes: Buffer): RasterImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function encodePng(image: RasterImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png);
}

/**
 * Different dimensions mean the paper size or the render width changed, which is a decision someone made. Comparing
 * a resampled version of one against the other would turn that decision into a similarity number, and a
 * plausible-looking one at that — so every entry point throws instead.
 */
function requireSameSize(a: RasterImage, b: RasterImage): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `raster size changed: baseline is ${b.width}×${b.height}, this render is ${a.width}×${a.height}. ` +
        `The paper size or the render width moved; re-baseline deliberately rather than comparing across sizes.`,
    );
  }
}

/** The largest single-channel difference at one pixel, 0–255. */
function deltaAt(a: RasterImage, b: RasterImage, at: number): number {
  let delta = 0;
  // All four channels, alpha included. These renders are opaque by construction — a white background rect is
  // emitted precisely so nothing is transparent — so a difference in alpha is a real difference, not noise.
  for (let c = 0; c < 4; c++) {
    const d = Math.abs(a.data[at + c] - b.data[at + c]);
    if (d > delta) delta = d;
  }
  return delta;
}

/**
 * `worstDelta` alone, without computing SSIM.
 *
 * Exists because full-resolution SSIM costs the better part of a second on a 1600×1131 sheet, and the
 * view-equivalence checks in `raster.test.ts` compare 28 pairs of images to ask one yes/no question: *are these two
 * renders the same?* Paying 28 seconds of structural-similarity arithmetic to answer that is how a suite acquires a
 * timeout, and then a `testTimeout` override, which hides the next real slowdown.
 */
export function worstDeltaOf(a: RasterImage, b: RasterImage): number {
  requireSameSize(a, b);
  let worst = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = deltaAt(a, b, i);
    if (delta > worst) {
      worst = delta;
      // 255 is the ceiling; nothing later can raise it, and these are megapixel images.
      if (worst === 255) return worst;
    }
  }
  return worst;
}

/** The full comparison: pixel deltas, where they are, and how structural the difference is. */
export function compare(actual: RasterImage, baseline: RasterImage, tolerance = AA_TOLERANCE): Comparison {
  requireSameSize(actual, baseline);

  let worstDelta = 0;
  let over = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < actual.height; y++) {
    for (let x = 0; x < actual.width; x++) {
      const delta = deltaAt(actual, baseline, (y * actual.width + x) * 4);
      if (delta > worstDelta) worstDelta = delta;
      if (delta > tolerance) {
        over++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    ssim: ssim(toSsimImage(actual), toSsimImage(baseline), SSIM_OPTIONS).mssim,
    worstDelta,
    over,
    bbox: over === 0 ? null : { minX, minY, maxX, maxY },
  };
}

/** `ssim.js` wants a mutable `Uint8ClampedArray` in an `ImageData`-shaped object. */
function toSsimImage(image: RasterImage): { data: Uint8ClampedArray; width: number; height: number } {
  return { data: image.data, width: image.width, height: image.height };
}

/**
 * A diff image a human can read at a glance.
 *
 * The baseline's ink is kept as pale grey so the difference has a drawing around it for context — a red-on-white
 * scatter tells you *that* something moved and nothing about *what*. Differences are red; pixels present in the
 * render but not the baseline and vice versa both land in the same red, because at this resolution "which one has
 * the line" is answered by opening the two PNGs, not by a colour legend nobody remembers.
 */
export function diffImage(actual: RasterImage, baseline: RasterImage, tolerance = AA_TOLERANCE): RasterImage {
  requireSameSize(actual, baseline);
  const data = new Uint8ClampedArray(actual.width * actual.height * 4);
  for (let p = 0; p < actual.width * actual.height; p++) {
    const i = p * 4;
    if (deltaAt(actual, baseline, i) > tolerance) {
      data[i] = 220;
      data[i + 1] = 20;
      data[i + 2] = 60;
    } else {
      // Pale wash of the baseline's luminance: black linework becomes light grey, white paper stays white.
      const luma = (baseline.data[i] * 0.299 + baseline.data[i + 1] * 0.587 + baseline.data[i + 2] * 0.114) / 255;
      const v = 255 - Math.round((1 - luma) * 60);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    data[i + 3] = 255;
  }
  return { width: actual.width, height: actual.height, data };
}
