import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * 3D viewport visual regression — silhouette occupancy and luminance, never pixels.
 *
 * ## Why not a screenshot comparison
 *
 * `docs/testing.md` is explicit, and it is the same argument as the golden digests: *"Gate on silhouette occupancy
 * grid + luminance histogram, not pixels."* A pixel diff fails on one driver's antialiasing, so the reflex becomes
 * accepting every new baseline, and then the suite is decoration that still reports green. Risk #11 on the plan's
 * register is exactly this.
 *
 * These two signals are chosen to be **coarse where hardware varies and precise where meaning lives**:
 *
 * - **Occupancy**, quantised to eighths per cell, moves when geometry moves or disappears and does not move when a
 *   handful of edge pixels are shaded differently.
 * - **Luminance**, in 8 buckets, is the half that notices *shading*. A material that lost its light response keeps
 *   its silhouette exactly and collapses its histogram into one bucket — invisible to occupancy alone.
 *
 * ## Nightly, not per-PR
 *
 * Deliberate, and stated in `docs/testing.md`: *"visual/perf **nightly, not per-PR**. One gate people trust beats
 * ten they route around."* A visual failure needs a human to look at it, and a human looking at every PR is how the
 * looking stops.
 *
 * ## Baselines are keyed by renderer
 *
 * A baseline is only comparable within one rasteriser. A mismatched key is a hard failure with a clear message,
 * never a quiet comparison of two different renderers — which would produce a diff nobody could interpret.
 */

const BASELINE_DIR = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "visual");
const UPDATE = process.env.VISUAL === "update";

interface Signature {
  readonly renderer: string;
  readonly cells: number[];
  readonly luminance: number[];
}

/** Slugify a renderer string into a filename component. SwiftShader's includes spaces, parens and commas. */
const slug = (renderer: string): string =>
  renderer.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** Load and settle. Its own helper because both tests need the identical framing to be comparable. */
async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  // Framed identically every run, or the comparison is against a different view.
  await page.locator("#fit").dispatchEvent("click");
  await page.waitForTimeout(400);
}

async function signatureOf(page: Page): Promise<Signature> {
  // Two frames before reading. The first may still be settling the adaptive pixel-ratio governor, which legitimately
  // changes the canvas size — and a signature read mid-resize describes a frame that never existed on screen.
  await page.evaluate(() => window.__massingviewer!.renderNow());
  await page.waitForTimeout(150);
  return await page.evaluate(() => window.__massingviewer!.renderSignature(16));
}

/**
 * Compare against a baseline.
 *
 * Occupancy is allowed to differ by **one eighth in a bounded number of cells**, rather than by a percentage of
 * total difference. That distinction matters: a percentage tolerance lets one cell change enormously as long as the
 * rest are identical, which is precisely the shape of "a wall vanished". A per-cell bound catches that and still
 * absorbs the edge-cell jitter a different rasteriser produces.
 */
function compare(actual: Signature, baseline: Signature): string[] {
  const problems: string[] = [];

  if (actual.cells.length !== baseline.cells.length) {
    problems.push(`grid size changed: ${baseline.cells.length} cells → ${actual.cells.length}`);
    return problems;
  }

  const moved: string[] = [];
  let big = 0;
  for (const [i, value] of actual.cells.entries()) {
    const was = baseline.cells[i]!;
    const delta = Math.abs(value - was);
    if (delta === 0) continue;
    const x = i % 16;
    const y = Math.floor(i / 16);
    moved.push(`(${x},${y}) ${was}→${value}`);
    if (delta > 1) big += 1;
  }

  // A cell that moved by more than one eighth is geometry, not antialiasing. One is tolerated for the boundary
  // case of a silhouette edge sitting exactly on a cell border; two is a change worth a human.
  if (big > 1) {
    problems.push(
      `${big} cell(s) changed occupancy by more than 1/8 — that is geometry, not antialiasing:\n      ` +
        moved.slice(0, 12).join("  ") +
        (moved.length > 12 ? `  …and ${moved.length - 12} more` : ""),
    );
  }
  // And a broad drift: many cells each moving slightly is a camera nudge, which no single cell reveals.
  if (moved.length > actual.cells.length * 0.25) {
    problems.push(
      `${moved.length} of ${actual.cells.length} cells moved. Individually small, collectively a camera or ` +
        `framing change rather than noise.`,
    );
  }

  // Luminance compared as a *distribution*, normalised, because the absolute sample count follows occupancy and
  // would double-report the same finding.
  const norm = (h: number[]): number[] => {
    const total = h.reduce((a, b) => a + b, 0) || 1;
    return h.map((n) => n / total);
  };
  const a = norm(actual.luminance);
  const b = norm(baseline.luminance);
  // Total variation distance. 0.15 absorbs a shading difference between drivers and fails on a lighting change.
  const tvd = a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / 2;
  if (tvd > 0.15) {
    problems.push(
      `luminance distribution moved by ${tvd.toFixed(3)} (limit 0.15) — shading changed even if the silhouette ` +
        `did not:\n      was ${b.map((v) => v.toFixed(2)).join(" ")}\n      now ${a.map((v) => v.toFixed(2)).join(" ")}`,
    );
  }
  return problems;
}

test("the viewport renders the same silhouette and shading as its baseline", async ({ page }) => {
  await ready(page);

  const actual = await signatureOf(page);
  expect(actual.renderer, "no renderer string — the WebGL context is not what this suite assumes").not.toBe("");

  if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });
  const file = join(BASELINE_DIR, `viewport.${slug(actual.renderer)}.json`);

  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    if (!UPDATE) {
      // Written and then failed, never silently accepted — the same rule as the drawing goldens. A baseline nobody
      // looked at is a baseline that blesses whatever was on screen, including an all-black frame.
      // `throw`, not `expect.fail` — that one is Vitest's. Playwright's `expect` has no `.fail`, and calling it
      // threw a TypeError which reported as a crash rather than as the intended message.
      throw new Error(
        `no baseline for renderer "${actual.renderer}" — one has been written to ${file}. ` +
          `Confirm the frame is correct (occupancy should not be all zeros) and commit it.`,
      );
    }
    return;
  }

  const baseline: Signature = JSON.parse(readFileSync(file, "utf8"));
  if (baseline.renderer !== actual.renderer) {
    // Unreachable through the filename, and asserted anyway: a hand-edited baseline could carry the wrong key, and
    // silently comparing two rasterisers produces a diff nobody can act on.
    throw new Error(`baseline is for "${baseline.renderer}" but this run is "${actual.renderer}"`);
  }

  const problems = compare(actual, baseline);
  expect(problems, `visual regression:\n    ${problems.join("\n    ")}`).toEqual([]);
});

test("the frame is not blank, which is the failure a baseline would happily bless", async ({ page }) => {
  /**
   * The guard the plan asks for by name. `preserveDrawingBuffer` is off, so reading pixels after a frame is
   * composited returns black — massing's hero-capture documents this, and a baseline captured that way passes
   * forever while showing nothing.
   *
   * So this asserts a *property* of the frame rather than comparing it: real geometry is on screen. It is
   * independent of any baseline, which is the point — it cannot be blessed away.
   */
  await ready(page);

  const sig = await signatureOf(page);
  const occupied = sig.cells.filter((c) => c > 0).length;
  expect(occupied, "every cell is empty — the frame is blank or the pixel read came back black").toBeGreaterThan(8);

  // And shading exists: a flat-shaded or unlit render puts every sample in one bucket.
  const used = sig.luminance.filter((n) => n > 0).length;
  expect(used, "all luminance in one bucket — the model is rendering unlit or as a silhouette").toBeGreaterThan(1);
});
