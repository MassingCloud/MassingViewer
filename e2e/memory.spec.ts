import { expect, test, type Page } from "@playwright/test";

/**
 * The memory-leak gate.
 *
 * `docs/testing.md` calls this *"the highest-value and most-neglected gate for a long-lived three.js app"*, and
 * until now it did not exist — it was the one omission on that page with no partial substitute.
 *
 * ## Why it is this shape rather than the plan's
 *
 * The plan specifies mount → load → author 50 → unmount → force GC → assert. Two departures, both deliberate:
 *
 * - **`showModel` is driven directly instead of authoring fifty walls.** It is the *same call* every authoring
 *   round trip makes, and fifty round trips would spend a minute of wall clock to exercise one line of disposal.
 *   The thing under test is `disposeScene`, not the kernel.
 * - **GPU resource counts rather than JS heap.** `renderer.info.memory` is exact and available in every browser;
 *   `performance.memory` is Chromium-only, quantised, and needs `--expose-gc` to be meaningful. A gate that only
 *   works in one browser and needs a launch flag is a gate that gets dropped. The leak that actually threatens
 *   this app is GPU buffers, because three does **not** free them when an object leaves the scene graph.
 *
 * ## What a failure here looks like in production
 *
 * Nothing. No error, no warning, no visual change. Every edit adds a few megabytes of GPU memory until the tab is
 * killed — slow, then gone, and the bug report says "it gets sluggish after a while".
 */

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
}

test("re-showing the model does not accumulate GPU geometry", async ({ page }) => {
  await ready(page);

  // One re-show establishes the steady state: the count after a replace, which is what every later cycle must
  // return to. Reading the count *before* any re-show would compare against a scene that had never been replaced,
  // so a leak of exactly one generation would hide.
  const baseline = await page.evaluate(() => window.__massingviewer!.remount(1));
  expect(baseline.geometries, "no geometry at all — the probe is measuring nothing").toBeGreaterThan(0);

  const after = await page.evaluate(() => window.__massingviewer!.remount(20));

  /**
   * Exactly equal, not "within a margin".
   *
   * `showModel` removes the previous group and calls `disposeScene` on it, so twenty replacements must leave
   * precisely the same number of live buffers as one. A tolerance here would let a slow leak — one buffer per
   * edit — pass for as long as the tolerance lasted, which is the only kind of leak that reaches production.
   */
  expect(after.geometries, `geometry count grew over 20 re-shows: ${baseline.geometries} → ${after.geometries}`).toBe(
    baseline.geometries,
  );
  expect(after.textures).toBe(baseline.textures);
  // The scene graph itself must not grow either: a group removed but not replaced leaves an orphan.
  expect(after.sceneChildren).toBe(baseline.sceneChildren);
});

test("shader programs are reused rather than recompiled per model", async ({ page }) => {
  await ready(page);
  const baseline = await page.evaluate(() => window.__massingviewer!.remount(1));
  const after = await page.evaluate(() => window.__massingviewer!.remount(20));

  /**
   * A separate cache from geometry, and a separate way to leak.
   *
   * Every distinct material configuration compiles a program, and three caches them by configuration — so a
   * `showModel` that built materials with a fresh `uuid`-dependent key each time would recompile twenty times and
   * hold twenty programs. That shows up as a stutter on every edit long before it shows up as memory.
   */
  expect(after.programs, `program count grew: ${baseline.programs} → ${after.programs}`).toBe(baseline.programs);
});

test("THREE.Cache stays empty, because nothing here loads external assets", async ({ page }) => {
  await ready(page);
  const state = await page.evaluate(() => window.__massingviewer!.remount(5));

  /**
   * `THREE.Cache` is a module-level map that loaders populate and **nothing ever clears**.
   *
   * It is empty today because the fixture is inlined at build time and this app loads no textures, fonts or
   * environment maps. Asserting that keeps it true: the first `TextureLoader` added without `Cache.enabled = false`
   * or an explicit clear would start retaining every file it ever fetched, for the life of the tab, and this is the
   * only place that would notice.
   */
  expect(state.cacheSize).toBe(0);
});

test("authoring repeatedly does not accumulate geometry either", async ({ page }) => {
  /**
   * The same invariant through the *real* path, at a size a test can afford.
   *
   * The direct probe above proves `disposeScene` works. This proves the round trip actually reaches it — a
   * re-tessellation that built a scene and then took a different route to display it would pass the first test and
   * leak in production.
   */
  await ready(page);
  await page.evaluate(() => window.__massingviewer!.remount(1));
  const before = await page.evaluate(() => window.__massingviewer!.remount(0));

  for (let i = 0; i < 4; i++) {
    await page.locator("#author").dispatchEvent("click");
    await expect(page.locator("#kernel")).toContainText(`Authored${i + 1}`, { timeout: 30_000 });
  }

  const after = await page.evaluate(() => window.__massingviewer!.remount(0));

  /**
   * Four authored walls, so the count legitimately *rises* — each wall is real new geometry. What must not happen
   * is the previous generations staying resident: with a leak, four edits over a six-element model would roughly
   * quintuple the count rather than add four.
   *
   * Bounded by what the model gained rather than pinned to a number, because the fixture's band count is a
   * different fact that has already changed once (openings) and would make this fail for the wrong reason.
   */
  expect(after.geometries).toBeGreaterThan(before.geometries);
  expect(
    after.geometries,
    `four edits grew geometry from ${before.geometries} to ${after.geometries} — previous generations are resident`,
  ).toBeLessThanOrEqual(before.geometries + 8);
});

test("disposing the viewport releases everything it holds", async ({ page }) => {
  /**
   * The teardown half, which the per-panel error boundary and any host that unmounts the viewer depend on.
   *
   * Asserted through the public `dispose()` rather than a private counter: after it, the renderer must hold no
   * geometry and no texture, and its canvas must be out of the DOM. A `dispose` that removed the canvas and left
   * the buffers is the failure mode — it *looks* completely correct.
   */
  await ready(page);
  const state = await page.evaluate(() => {
    const mv = window.__massingviewer!;
    const canvas = mv.viewport.renderer.domElement;
    const attachedBefore = canvas.parentElement !== null;
    mv.viewport.dispose();
    const info = mv.viewport.renderer.info;
    return {
      attachedBefore,
      attachedAfter: canvas.parentElement !== null,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  });

  expect(state.attachedBefore).toBe(true);
  expect(state.attachedAfter, "dispose() left the canvas in the DOM").toBe(false);
  expect(state.geometries, "dispose() left GPU geometry resident").toBe(0);
  expect(state.textures, "dispose() left textures resident").toBe(0);
});

test("dispose is idempotent, because React strict mode unmounts twice", async ({ page }) => {
  // Stated in the kernel-authoring guide for the same reason: strict mode mounts, unmounts and mounts again, and a
  // second dispose that throws turns a benign double-unmount into a crash the user sees.
  await ready(page);
  const outcome = await page.evaluate(() => {
    const mv = window.__massingviewer!;
    try {
      mv.viewport.dispose();
      mv.viewport.dispose();
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(outcome).toBe("ok");
});
