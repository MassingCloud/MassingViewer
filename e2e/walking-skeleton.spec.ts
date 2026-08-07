import { expect, test, type Page } from "@playwright/test";

/**
 * The walking-skeleton acceptance test: load a real IFC, render it, orbit it, pick an element.
 *
 * ## Why it drives `window.__massingviewer` rather than only clicking
 *
 * `requestAnimationFrame` is suspended in a headless or backgrounded page, so the frame loop does not run.
 * Without a handle to drive one frame and read the framebuffer, a test **cannot distinguish "rendered
 * correctly" from "never rendered"** — and that exact ambiguity is what had massing's zero-width canvas
 * misfiled as a stalled loader for weeks, cited as an environment limitation in eight changelog entries.
 *
 * So the hook exists for this, not merely for debugging. Interaction is still driven through real mouse events
 * where the point is the interaction; the hook is used where the point is *what got drawn*.
 */

interface Handle {
  elements: { expressId: number; guid: string | null; ifcType: string }[];
  triangles: number;
  sample: { sampled: number; nonBackground: number; coverage: number };
  canvas: { w: number; h: number };
  container: { w: number; h: number };
  pixelRatio: number;
}

/** Read the app's state, forcing one synchronous frame first. */
async function readHandle(page: Page): Promise<Handle> {
  return page.evaluate(() => {
    const mv = window.__massingviewer;
    if (!mv) throw new Error("__massingviewer hook missing — the app did not finish initialising");
    const canvas = mv.viewport.renderer.domElement;
    const container = canvas.parentElement!;
    return {
      elements: mv.elements.map((e) => ({
        expressId: e.expressId,
        guid: e.guid,
        ifcType: e.ifcType,
      })),
      triangles: mv.triangles,
      sample: mv.sampleFramebuffer(24),
      canvas: { w: canvas.width, h: canvas.height },
      container: { w: container.clientWidth, h: container.clientHeight },
      pixelRatio: mv.viewport.renderer.getPixelRatio(),
    };
  });
}

/**
 * Pinch the viewport by dispatching synthetic pointer events.
 *
 * Playwright has no pinch primitive, and `mouse.wheel` throws outright on mobile WebKit — which is how the
 * missing pinch support was found. Synthesised `PointerEvent`s go through the viewport's real handler, so this
 * tests the actual gesture code rather than a mock of it, and it runs on every project including desktop.
 *
 * `scale` < 1 brings the fingers together, which zooms out.
 */
async function pinch(page: Page, scale: number): Promise<void> {
  await page.evaluate((s) => {
    const el = document.querySelector("#viewport canvas")!;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const send = (type: string, id: number, x: number, y: number): void => {
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          isPrimary: id === 1,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    };
    const from = Math.min(box.width, box.height) * 0.25;
    const to = from * s;
    send("pointerdown", 1, cx - from, cy);
    send("pointerdown", 2, cx + from, cy);
    for (let i = 1; i <= 10; i++) {
      const r = from + ((to - from) * i) / 10;
      send("pointermove", 1, cx - r, cy);
      send("pointermove", 2, cx + r, cy);
    }
    send("pointerup", 1, cx - to, cy);
    send("pointerup", 2, cx + to, cy);
  }, scale);
}

/** Zoom out using whatever gesture the platform actually has. */
async function zoomOut(page: Page, isMobile: boolean | undefined): Promise<void> {
  if (isMobile) {
    await pinch(page, 0.3);
    return;
  }
  const box = (await page.locator("#viewport canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__massingviewer !== undefined, undefined, { timeout: 30_000 });
  // Asserted per-test rather than at the end: an exception during init leaves the app in a state where every
  // later assertion fails confusingly, and the console error is the real finding.
  expect(errors, "console errors during load").toEqual([]);
});

test("loads the sample building and reports it", async ({ page }) => {
  await expect(page.locator("#viewport canvas")).toBeVisible();

  const h = await readHandle(page);
  // The fixture's known content — 4 walls, a slab, a column. Openings are voids, not drawn elements.
  expect(h.elements).toHaveLength(6);
  expect(h.triangles).toBe(72);

  const classes = h.elements.map((e) => e.ifcType).sort();
  expect(classes).toEqual(["IFCCOLUMN", "IFCSLAB", "IFCWALL", "IFCWALL", "IFCWALL", "IFCWALL"]);
});

test("every element resolves to an IFC GlobalId", async ({ page }) => {
  // The property everything else depends on. Without it, markup anchoring, plan-to-3D sync and every persisted
  // reference are anchored to nothing — and the failure is silent, appearing only after a reload.
  const h = await readHandle(page);
  const unresolved = h.elements.filter((e) => e.guid === null);
  expect(unresolved, "elements with no GlobalId").toEqual([]);

  for (const el of h.elements) {
    expect(el.guid, `${el.ifcType} #${el.expressId}`).toMatch(/^[0-9A-Za-z_$]{22}$/);
  }
  // And they are distinct — a resolver returning one id for everything would pass a per-element check.
  expect(new Set(h.elements.map((e) => e.guid)).size).toBe(6);
});

test("the panel shows 100% GlobalId coverage", async ({ page }) => {
  // Displayed rather than assumed: if this is not 100% the resolver is broken, and the user should be able to
  // see that without reading a console.
  await expect(page.locator("#model")).toContainText("6/6 (100%)");
  await expect(page.locator("#model .ok")).toBeVisible();
});

test("the canvas tracks its container — no zero-width render", async ({ page }) => {
  // The regression that was reported for weeks as "the geometry loader stalls". The model parses perfectly
  // into a canvas nothing can be seen in, and from outside that is indistinguishable from a load that never
  // finished. See packages/viewport/src/resize.ts.
  const h = await readHandle(page);

  // Comfortably above the 64px implausibility floor in `decideResize`.
  expect(h.canvas.w).toBeGreaterThan(256);
  expect(h.canvas.h).toBeGreaterThan(256);

  // The buffer is `container * pixelRatio`, and the pixel governor legitimately REDUCES that ratio when frame
  // times rise — which is exactly what happens under software WebGL. A first version of this asserted the
  // buffer was >= 90% of the container and failed at 495 vs 990: the governor had correctly stepped down to
  // 0.5. The test was asserting against a working feature.
  //
  // So the real invariant is that the buffer tracks the container *at whatever ratio is currently in force*,
  // and that the ratio is a legal step rather than an arbitrary number.
  expect(h.canvas.w / h.container.w).toBeCloseTo(h.pixelRatio, 1);
  expect([0.5, 0.75, 1, 1.5, 2]).toContain(h.pixelRatio);
});

test("the building actually renders pixels", async ({ page }) => {
  // Drives one frame and reads the framebuffer, because rAF is suspended headless. Asserting a *range* rather
  // than "> 0": zero means nothing drew, and ~100% means the camera is inside a wall or the clear colour
  // changed — both of which a naive "something is non-background" check would pass.
  const h = await readHandle(page);
  expect(h.sample.sampled).toBeGreaterThan(100);
  expect(h.sample.coverage).toBeGreaterThan(0.05);
  expect(h.sample.coverage).toBeLessThan(0.95);
});

test("clicking an element selects it and shows both ids", async ({ page }) => {
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;

  // Sweep for a hit rather than assuming a fixed point: the exact pixel a wall occupies depends on the fit
  // camera, which depends on the viewport aspect, which differs per project in the matrix.
  let hit = false;
  for (const [fx, fy] of [[0.5, 0.55], [0.4, 0.5], [0.6, 0.6], [0.35, 0.62], [0.65, 0.45]]) {
    await canvas.click({ position: { x: box.width * fx!, y: box.height * fy! } });
    if (await page.locator("#sel").getByText("expressID").isVisible().catch(() => false)) {
      hit = true;
      break;
    }
  }
  expect(hit, "no element was hit anywhere in the viewport").toBe(true);

  const sel = page.locator("#sel");
  await expect(sel).toContainText("expressID");
  // Both ids are shown deliberately: expressID is what the parse layer and drawing generator speak, GlobalId
  // is the only one safe to persist. Showing both keeps the distinction visible.
  await expect(sel).toContainText("GlobalId");
  await expect(sel.locator(".mono")).toHaveText(/^[0-9A-Za-z_$]{22}$/);
});

test("Escape clears the selection", async ({ page }) => {
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.55 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("#sel")).toContainText("Click an element");
});

test("orbiting changes what is drawn", async ({ page }) => {
  // Asserts the camera actually moved by comparing the framebuffer, not by reading a camera property — a
  // controller that updates state without re-rendering would pass the latter.
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;

  const before = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).nonBackground);

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.35, { steps: 12 });
  await page.mouse.up();

  const after = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).nonBackground);
  expect(after).not.toBe(before);
});

test("pinch zooms — the only way to zoom on a tablet", async ({ page }) => {
  // Runs on every project, not just the iPad one. There is no wheel on a touch screen, so before this existed
  // an iPad user could not change the zoom level at all — and single-finger orbit worked, which is exactly why
  // nobody noticed. Safari and iPad support is a stated differentiator, so this is a required behaviour.
  const before = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).coverage);

  await pinch(page, 0.3); // fingers together → zoom out
  const out = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).coverage);
  expect(out, "pinching together should show less of the frame").toBeLessThan(before);

  await pinch(page, 3); // fingers apart → zoom back in
  const back = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).coverage);
  expect(back, "pinching apart should show more of the frame").toBeGreaterThan(out);
});

test("units toggle reformats the model panel", async ({ page }) => {
  const model = page.locator("#model");
  await expect(model).toContainText("8.400 m");

  await page.getByRole("button", { name: "m" }).click();
  // Architectural notation with the hyphen — the convention on US construction drawings, and its absence is
  // the first thing a reviewer notices.
  await expect(model).toContainText(/\d+'-\d+/);
  await expect(model).not.toContainText("8.400 m");
});

test("Fit reframes the model", async ({ page, isMobile }) => {
  // Zoom far out so Fit has something to correct — by wheel on desktop, by pinch on a touch screen. There is
  // no wheel on a tablet, and asserting through the gesture the platform actually has is the only way this
  // test says anything about that platform.
  await zoomOut(page, isMobile);
  const zoomedOut = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).coverage);

  await page.getByRole("button", { name: "Fit" }).click();
  const fitted = await page.evaluate(() => window.__massingviewer!.sampleFramebuffer(16).coverage);

  // The model should occupy more of the frame after fitting than when zoomed out.
  expect(fitted).toBeGreaterThan(zoomedOut);
});

test("makes ZERO network requests after first paint", async ({ page, isMobile }) => {
  // The headline claim of the walking skeleton, and the thing massing's own Pages demo cannot say — it fetches
  // a model that does not exist and therefore shows no geometry at all. The fixture is inlined at build time.
  await page.waitForFunction(() => window.__massingviewer !== undefined);

  const requests: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    // Ignore devtools/websocket noise; assert on content the app would fetch.
    if (url.startsWith("ws:") || url.startsWith("wss:") || url.includes("__vite")) return;
    requests.push(url);
  });

  // Exercise the app thoroughly — if anything lazy-loads a model or phones home, this is where it shows.
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.55 } });
  await page.getByRole("button", { name: "Fit" }).click();
  await page.keyboard.press("f");
  await zoomOut(page, isMobile);
  await page.waitForTimeout(500);

  expect(requests, "the app must work with no network").toEqual([]);
});

test("nothing is silently skipped by the tessellator", async ({ page }) => {
  // The tessellator ignores openings by design (no booleans) and REPORTS what it skipped. For this fixture the
  // openings are voids rather than drawn products, so the list must be empty — and if a future change starts
  // dropping elements, this fails rather than the viewer quietly showing half a building.
  const heading = page.locator("#skipped-h");
  await expect(heading).toBeHidden();
  await expect(page.locator("#skipped li")).toHaveCount(0);
});
