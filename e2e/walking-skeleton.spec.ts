import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * ## A note on locators
 *
 * Every header control is addressed by **id**, never by `getByRole("button", { name })`.
 *
 * That matcher is a case-insensitive *substring* match on the accessible name, so it gets steadily more ambiguous
 * as the app grows: `name: "m"` broke the moment the ribbon added thirty buttons, and `name: "Plan"` now also
 * matches the ribbon's "Section plane". The symptom is not a clear failure — it is a click that lands somewhere
 * else, so a later assertion times out waiting for something that was never going to happen, in a *different*
 * test than the one with the bad locator.
 *
 * An id cannot drift with a label, and it cannot become ambiguous.
 */

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
  authored: number;
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
      authored: mv.authored,
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

/**
 * Console messages that are the browser talking about itself, not the app failing.
 *
 * Exactly one entry, and it is deliberately a precise string rather than a pattern that could swallow real
 * errors. `ResizeObserver loop completed with undelivered notifications` means a resize callback changed layout,
 * so the browser deferred the remaining notifications to the next frame. It is logged at error level, it is not
 * an application fault, and it appears on the narrow iPad viewport where the panel and viewport settle over two
 * frames instead of one.
 *
 * That the resize genuinely *settles* is not assumed — it is what "the canvas tracks its container" asserts, and
 * that test passes on iPad. If the loop did not settle, `decideResize` would keep reporting a change and that
 * test would fail. The canvas is also `width:100%;height:100%` inside a `position:relative` container with
 * `min-height:0`, so resizing it cannot feed back into the grid at all.
 *
 * Filtered on **both** channels, because browsers deliver it as an uncaught error event rather than as a console
 * message — filtering only `console` left it arriving through `pageerror` and the test still failing.
 */
const BENIGN = ["ResizeObserver loop completed with undelivered notifications."];

const isBenign = (text: string): boolean => BENIGN.some((benign) => text.includes(benign));

/**
 * Extract a ZIP with an implementation that is not ours.
 *
 * The BCF writer is hand-rolled (no compression dependency for a 20 KB XML archive), so verifying it with our own
 * reader would only prove self-consistency — the exact failure mode. This throws rather than skipping if no
 * extractor is found: a silently skipped independent check still reports green, which is worse than no check.
 */
function extractWithSomethingElse(archive: string, out: string): void {
  const candidates: { cmd: string; args: string[] }[] = [
    { cmd: "python", args: ["-m", "zipfile", "-e", archive, out] },
    { cmd: "python3", args: ["-m", "zipfile", "-e", archive, out] },
    { cmd: "unzip", args: ["-q", archive, "-d", out] },
  ];
  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, candidate.args, { stdio: "pipe" });
      return;
    } catch (cause) {
      tried.push(`${candidate.cmd}: ${(cause as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`no independent ZIP extractor available. Tried:\n  ${tried.join("\n  ")}`);
}

/**
 * Cut a plan, and fail with a *reason* if one does not appear.
 *
 * `page.locator("#plan-svg svg")` timing out after 60 s says only "timeout exceeded", and there are at least three
 * different causes: the click missed, `generatePlan` threw, or `fitToPaper` returned null and `paintPlan` rendered
 * a "does not fit on A3" warning instead of an SVG. That last one is a real branch in the demo, and it produces
 * exactly the same symptom as the other two.
 *
 * This is the same discipline the `beforeEach` already applies to the missing test hook: a bare wait reports one
 * message for every possible cause, which is the ambiguity this whole suite exists to remove. An intermittent
 * failure that names itself once is worth more than ten runs of guessing.
 */
async function cutPlan(page: Page): Promise<void> {
  /**
   * Wait for startup to settle before clicking.
   *
   * This is the fix for the flake `cutPlan` was written to diagnose. The named failure was "the Plan click did not
   * open the pane", and the cause is a race rather than a missing element: the ribbon observes its container with a
   * `ResizeObserver` and relayouts as the page settles, so a click issued during startup can be dispatched at
   * coordinates that were correct when Playwright measured them and are not by the time the event lands.
   *
   * The kernel-ready signal is the existing marker for "startup has finished", and most tests already wait for it.
   * The export tests did not, which is why they were the ones that failed — and why the failing test appeared to
   * move around, since which of them lost the race depended on timing.
   */
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });

  /**
   * `dispatchEvent`, not `.click()`, and this is a considered choice rather than a workaround.
   *
   * The diagnostic below found the cause of a flake that survived three other fixes. On WebKit, roughly one
   * all-projects run in three, a `.click()` on `#plan` did not reach the handler — and the probe proved the app was
   * innocent every time:
   *
   *   atCentre: "button#plan"          the button is at the click point, nothing covering it
   *   headerOverflows: false           it is not scrolled out of view
   *   page errors: (none)              the handler did not throw
   *   programmaticClickWorks: true     the listener is attached and works
   *
   * So the listener is fine and the *synthetic event delivery* is what intermittently fails. `dispatchEvent`
   * delivers a real DOM event straight to the element, bypassing the actionability and input-routing layer that is
   * the actual flake.
   *
   * This is legitimate here because the subject of these tests is the **plan pipeline** — cut, repaint, export.
   * Where the subject *is* real mouse input, the tests still use real mouse input: "clicking an element selects it
   * and shows both ids" drives `page.mouse`, and "pinch zooms" synthesises pointer events against the canvas. Using
   * `dispatchEvent` for those would be testing a mock of the interaction.
   */
  await page.locator("#plan").dispatchEvent("click");

  /**
   * If the pane did not open, say *why* rather than timing out.
   *
   * The wait above removed most occurrences of this and not all of them — about one all-projects run in three still
   * loses it on webkit. Rather than keep guessing, this collects the facts that distinguish the remaining
   * candidates: is the button off-screen (the header holds nine controls and scrolls horizontally at 834 px), is
   * something on top of it, or did the handler run and `generate()` throw?
   *
   * `elementFromPoint` at the button's own centre is the decisive one. A retry here would make the suite green and
   * destroy the only evidence.
   */
  try {
    await expect(page.locator("#plan-pane")).toBeVisible({ timeout: 15_000 });
  } catch {
    const probe = await page.evaluate(() => {
      const button = document.querySelector("#plan");
      if (button === null) return { found: false } as Record<string, unknown>;
      const box = button.getBoundingClientRect();
      const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const header = button.closest("header");
      return {
        found: true,
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        inViewport: box.top >= 0 && box.left >= 0 && box.right <= window.innerWidth,
        // What is actually at the click point. If this is not the button, something is covering it.
        atCentre: centre === null ? "nothing" : `${centre.tagName.toLowerCase()}#${centre.id || "(no id)"}`,
        headerScrollLeft: header?.scrollLeft ?? null,
        headerOverflows: header === null ? null : header.scrollWidth > header.clientWidth,
        window: { w: window.innerWidth, h: window.innerHeight },
        planPaneHidden: document.querySelector("#plan-pane")?.hasAttribute("hidden") ?? null,
        planInfo: (document.querySelector("#plan-info")?.textContent ?? "").slice(0, 80),
        /**
         * Does a programmatic click work?
         *
         * The decisive question, and the last one left. The probe above proves a real click landed on this exact
         * button with nothing covering it, and the page threw nothing — so either the listener is not attached, or
         * it is attached and the synthetic event is not reaching it. `.click()` dispatches straight at the element,
         * so `true` here means the handler is fine and the *event delivery* is the problem.
         */
        programmaticClickWorks: (() => {
          (button as HTMLElement).click();
          return document.querySelector("#plan-pane")?.hasAttribute("hidden") === false;
        })(),
      };
    });
    // What the page threw, which is the one thing the probe above cannot see. `beforeEach` asserts its own error
    // list *during load* and then that list goes out of scope, so an exception inside a click handler is invisible
    // — and that is precisely the remaining candidate: the click lands, the handler runs, something throws.
    const thrown = pageErrors.get(page) ?? [];
    throw new Error(
      `the Plan click did not open the pane.\n  ${JSON.stringify(probe, null, 2).replace(/\n/g, "\n  ")}\n` +
        `  page errors since load: ${thrown.length > 0 ? thrown.join("\n    ") : "(none)"}`,
    );
  }
  // Rendered by `generate()` after `paintPlan()`, so its presence means generation completed.
  await expect(page.locator("#plan-info"), "generate() did not finish").toContainText("Entities", { timeout: 15_000 });
  // And the branch that renders a warning instead of a drawing, named rather than left as a timeout.
  const warning = await page.locator("#plan-svg .warn").count();
  expect(warning, "the plan did not fit on A3, so paintPlan rendered a warning instead of an SVG").toBe(0);
  await expect(page.locator("#plan-svg svg")).toBeVisible({ timeout: 15_000 });
}

/**
 * Page errors, per page, kept for the whole test.
 *
 * `beforeEach` collects errors and asserts them *during load*, then its local array goes out of scope — so an
 * exception thrown later, inside a click handler, is invisible. That is exactly the shape of the remaining flake:
 * the click lands on the button, the handler runs, something throws, and the assertion that follows times out
 * describing a symptom three steps downstream.
 */
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (e) => {
    if (!isBenign(e.message)) errors.push(e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !isBenign(m.text())) errors.push(m.text());
  });
  await page.goto("/");

  // A bare `waitForFunction` reports "timeout exceeded" for every possible cause, which is the same ambiguity
  // this whole suite exists to remove — a Firefox CI run failed all thirteen tests this way, and the log said
  // nothing about why. So a missing hook is turned into a diagnosis: what the page logged, and whether the
  // browser could give us WebGL at all, which is the difference between "the app is broken" and "this browser
  // has no renderer".
  try {
    await page.waitForFunction(() => window.__massingviewer !== undefined, undefined, { timeout: 20_000 });
  } catch (cause) {
    const probe = await page
      .evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        return {
          webgl: gl === null ? "UNAVAILABLE" : gl.getParameter(gl.VERSION),
          hasCanvas: document.querySelector("#viewport canvas") !== null,
          body: (document.body.textContent ?? "").trim().slice(0, 160),
        };
      })
      .catch((e: Error) => ({ webgl: `probe failed: ${e.message}`, hasCanvas: false, body: "" }));

    throw new Error(
      `the app never set window.__massingviewer.\n` +
        `  WebGL:       ${String(probe.webgl)}\n` +
        `  canvas in DOM: ${probe.hasCanvas}\n` +
        `  page errors: ${errors.length > 0 ? errors.join("\n               ") : "(none reported)"}\n` +
        `  visible text: ${probe.body || "(empty)"}`,
      { cause },
    );
  }

  // Asserted per-test rather than at the end: an exception during init leaves the app in a state where every
  // later assertion fails confusingly, and the console error is the real finding.
  expect(errors, "console errors during load").toEqual([]);

  /**
   * Every test starts from a **settled** page.
   *
   * This closes a whole class of flake rather than one instance of it. Roughly one test per five all-projects runs
   * was failing on `webkit` or `ipad`, and the failing test moved — the plan click, the units toggle, the discipline
   * switch. The common factor is a click issued while startup was still in flight: the ribbon observes its
   * container with a `ResizeObserver` and relayouts as the page settles, so Playwright can measure a button's box,
   * the layout can shift, and the event lands somewhere else. No error, no exception — just a click that did
   * nothing, and a later assertion timing out for a reason that looks unrelated.
   *
   * Fixing it per test was whack-a-mole: adding the wait to `cutPlan` moved the failure to the units toggle. One
   * wait here covers everything, and it is also the more honest fixture — a user does not click during startup
   * either, because the panel says "starting worker…" until this text appears.
   */
  await expect(page.locator("#kernel"), "the kernel never became ready").toContainText("ready — no network", {
    timeout: 25_000,
  });
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

  // The container first, and with the numbers in the message. A bare "canvas.h was 164" cannot distinguish a
  // renderer that sized itself wrongly from a *layout* that squashed the viewport — and those have completely
  // different fixes. Reporting container, canvas and ratio together makes the next failure self-diagnosing.
  const where = `container ${h.container.w}x${h.container.h}, canvas ${h.canvas.w}x${h.canvas.h}, ratio ${h.pixelRatio}`;
  expect(h.container.h, `the viewport element is too short — ${where}`).toBeGreaterThan(300);
  expect(h.container.w, `the viewport element is too narrow — ${where}`).toBeGreaterThan(300);

  // Comfortably above the 64px implausibility floor in `decideResize`.
  expect(h.canvas.w, where).toBeGreaterThan(150);
  expect(h.canvas.h, where).toBeGreaterThan(150);

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
  // Runs on every project, not just the iPad one. There is no wheel on a touch screen, so before this existed an
  // iPad user could not change the zoom level at all — and single-finger orbit worked, which is exactly why
  // nobody noticed. Safari and iPad support is a stated differentiator, so this is required behaviour.
  //
  // Asserted on camera distance, not on framebuffer coverage. A first version used coverage and failed at
  // 0.17 → 0.21: pinching out moves the camera away *and* reveals more of the ground grid, which counts as
  // non-background. Coverage answers "did anything draw"; it does not answer "which way did the zoom go".
  const distance = () => page.evaluate(() => window.__massingviewer!.cameraDistance);
  const before = await distance();

  await pinch(page, 0.3); // fingers together → zoom out
  const out = await distance();
  expect(out, "pinching together should move the camera away").toBeGreaterThan(before);

  await pinch(page, 3); // fingers apart → zoom back in
  expect(await distance(), "pinching apart should bring the camera closer").toBeLessThan(out);
});

test("units toggle reformats the model panel", async ({ page }) => {
  const model = page.locator("#model");
  await expect(model).toContainText("8.400 m");

  // `#units`, not `locator("#units")`. That matched by substring, so adding the ribbon made it
  // resolve to two elements and the test failed on strict mode rather than on anything real. A locator loose
  // enough to be ambiguous is a locator that will become ambiguous.
  await page.locator("#units").dispatchEvent("click");
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

  await page.locator("#fit").dispatchEvent("click");
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
  await page.locator("#fit").dispatchEvent("click");
  await page.keyboard.press("f");
  await zoomOut(page, isMobile);
  await page.waitForTimeout(500);

  expect(requests, "the app must work with no network").toEqual([]);
});

test("authors a wall offline, in a Worker, and the model actually changes", async ({ page }) => {
  // The headline claim, made checkable rather than stated: the model is edited in the browser, by a kernel in a
  // real Worker, with no network. It is also the **only** place thread isolation is verified — the unit suite
  // drives LocalKernel over a MessageChannel (same thread), because a node:worker_threads variant could not load
  // its own TypeScript module graph. See packages/kernel-local/src/transport.ts.
  const kernel = page.locator("#kernel");
  await expect(kernel).toContainText("ready — no network", { timeout: 20_000 });
  // Fifteen ops, discovered from the worker rather than hardcoded in the page.
  await expect(kernel).toContainText("15");

  const before = await readHandle(page);
  expect(before.elements).toHaveLength(6);

  await page.locator("#author").dispatchEvent("click");
  await expect(kernel).toContainText("authored 1 element", { timeout: 20_000 });

  const after = await readHandle(page);
  // Seven elements, and more triangles: the round trip really went apply → export IFC → re-tessellate, so this
  // asserts the *file* changed rather than that a mesh was appended locally.
  expect(after.elements).toHaveLength(7);
  expect(after.triangles).toBeGreaterThan(before.triangles);
  expect(after.authored).toBe(1);

  // Every element still resolves to a GlobalId, including the one the kernel just minted. This is the invariant
  // the whole product rests on, checked at the moment it is most likely to break.
  const unresolved = after.elements.filter((e) => e.guid === null);
  expect(unresolved, "elements with no GlobalId after authoring").toEqual([]);
  expect(new Set(after.elements.map((e) => e.guid)).size).toBe(7);
  await expect(page.locator("#model")).toContainText("7/7 (100%)");
});

test("authoring makes no network requests", async ({ page }) => {
  // Separate from the test above so a failure says which claim broke: "authoring is broken" and "authoring
  // phones home" are different problems with different owners.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });

  const requests: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith("ws:") || url.startsWith("wss:") || url.includes("__vite")) return;
    requests.push(url);
  });

  await page.locator("#author").dispatchEvent("click");
  await expect(page.locator("#kernel")).toContainText("authored 1 element", { timeout: 20_000 });
  expect(requests, "authoring must not touch the network").toEqual([]);
});

test("the loop: cut a plan, click a line, and the element selects in 3D", async ({ page }) => {
  // The thing no competitor has closed, in one test. A plan is a live view of the model, and a click on its
  // linework resolves to a GlobalId rather than to a page coordinate — which is the difference between this and
  // every PDF-based review tool.
  await cutPlan(page);

  const svg = page.locator("#plan-svg svg");
  await expect(svg).toHaveAttribute("data-kind", "plan");
  // Real AIA layers, not one flat group — DXF export and layer visibility both need them.
  await expect(svg.locator('g[data-layer="A-WALL"]')).toBeVisible();
  // The KPI, displayed rather than logged: below 100% means linework nobody can mark up.
  await expect(page.locator("#plan-info")).toContainText("100%");

  // Click through a fat hit twin, which is the only way a 0.5 mm line is clickable at all.
  const hit = svg.locator("[data-hit][data-guid]").first();
  const guid = await hit.getAttribute("data-guid");
  expect(guid).toMatch(/^[0-9A-Za-z_$]{22}$/);
  await hit.click({ force: true });

  // 3D followed: the properties panel names the same element the plan line came from.
  const sel = page.locator("#sel");
  await expect(sel).toContainText(guid!);
  // And IFC's own class name, not `IfcWALL` — a label that is not a class in any schema reads as bad data.
  await expect(sel).toContainText(/Ifc[A-Z][a-z]/);

  // 3D → plan, the other direction: every entity for that element is lit, not just the first, because one
  // L-shaped wall produces several loops.
  await expect(svg.locator('[data-guid].sel').first()).toBeVisible();
  const lit = await svg.locator(`[data-guid="${guid}"].sel`).count();
  expect(lit).toBeGreaterThan(1);

  await page.keyboard.press("Escape");
  await expect(svg.locator("[data-guid].sel")).toHaveCount(0);
});

test("switching discipline repaints the plan without regenerating it", async ({ page }) => {
  // The claim the Semantic Drawing Model exists to make good on. massing's generator takes discipline as a
  // *generation* flag, so a restyle is a round trip through the geometry kernel.
  await cutPlan(page);
  const svg = page.locator("#plan-svg svg");
  await expect(svg).toHaveAttribute("data-theme", "Architectural");

  const geometry = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll("#plan-svg svg path[id]")].map((p) => [p.id, p.getAttribute("d")]),
      ),
    );
  const before = await geometry();

  await page.locator("#theme").dispatchEvent("click");
  await expect(svg).toHaveAttribute("data-theme", "Fire safety");
  const after = await geometry();

  // Every entity present in both themes has byte-identical geometry — the same drawing, repainted.
  const shared = Object.keys(before).filter((k) => k in after);
  expect(shared.length).toBeGreaterThan(5);
  for (const id of shared) expect(after[id], id).toBe(before[id]);

  // The fire theme hides below-cut linework, and hiding means *absent* rather than invisible-but-clickable.
  expect(Object.keys(after).length).toBeLessThan(Object.keys(before).length);
});

test("an open plan follows an edit instead of going stale", async ({ page }) => {
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  await cutPlan(page);

  const cuts = page.locator('#plan-svg svg path[data-role="cut"]');
  const before = await cuts.count();
  expect(before).toBeGreaterThan(0);

  await page.locator("#author").dispatchEvent("click");
  await expect(page.locator("#kernel")).toContainText("authored 1 element", { timeout: 20_000 });

  // "A plan is a live view of the model" is only true if it tracks the model. A plan that needs a manual refresh
  // is an export with extra steps.
  await expect(cuts).toHaveCount(before + 1);
  await expect(page.locator("#plan-info")).toContainText("100%");
});

test("a markup anchors to a GlobalId, and orphans visibly when that element goes", async ({ page }) => {
  // The differentiator, end to end. Every PDF-based review tool stores a shape on a flattened raster that has
  // forgotten what it refers to, so deleting the wall leaves an issue that still *looks* fine. Here it does not.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });

  // Arm the RFI tool — a Tool Set carries the data, so one click produces a correctly typed issue.
  await page.locator('[data-tool="rfi"]').click();
  await cutPlan(page);

  const hit = page.locator("#plan-svg svg [data-hit][data-guid]").first();
  const guid = await hit.getAttribute("data-guid");
  await hit.click({ force: true });
  await page.keyboard.press("m");

  const topic = page.locator("#topics li").first();
  await expect(topic).toHaveAttribute("data-live", "true");
  await expect(topic).toContainText("live");
  const raised = await page.evaluate(() => window.__massingviewer!.topics);
  expect(raised).toHaveLength(1);
  // Typed by the tool, not by the user: the markup and the issue are the same act.
  expect(raised[0]!.type).toBe("Inquiry");
  // Anchored to the element, not to a page coordinate.
  expect(raised[0]!.pin?.guids).toEqual([guid]);

  // Now delete the element the markup points at.
  await hit.click({ force: true });
  await page.locator("#delete").dispatchEvent("click");
  await expect(page.locator("#kernel")).toContainText("deleted 1 element", { timeout: 20_000 });

  // The topic survives — deleting geometry does not delete the conversation about it — but it is now visibly
  // orphaned, struck through, and the reason names the element.
  await expect(topic).toHaveAttribute("data-live", "false");
  await expect(topic).toContainText("orphaned");
  await expect(page.locator("#markup-info")).toContainText("Orphaned");
  await expect(topic.locator("span")).toHaveAttribute("title", new RegExp(`${guid}.*no longer in the model`));

  const after = await readHandle(page);
  expect(after.elements).toHaveLength(5);
  expect(after.elements.some((e) => e.guid === guid)).toBe(false);
});

test("exports BCF 3.0 that a real unzip can read", async ({ page }, testInfo) => {
  // The interop claim, checked rather than stated: a `.bcfzip` written entirely in the page, extracted by an
  // implementation that is not ours. BCF is the reason a topic raised here opens in Solibri and BIMcollab.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  await cutPlan(page);
  // Arm the RFI tool, so this also proves the Tool Set's defaults survive all the way into the exported XML.
  // A first version skipped this and asserted TopicType="Inquiry" against the default Issue tool.
  await page.locator('[data-tool="rfi"]').click();
  await page.locator("#plan-svg svg [data-hit][data-guid]").first().click({ force: true });
  await page.keyboard.press("m");
  await expect(page.locator("#topics li")).toHaveCount(1);

  const download = page.waitForEvent("download");
  await page.locator("#bcf").dispatchEvent("click");
  const file = await download;
  expect(file.suggestedFilename()).toBe("issues.bcfzip");

  const saved = testInfo.outputPath("issues.bcfzip");
  await file.saveAs(saved);
  const bytes = readFileSync(saved);
  // "PK\3\4" — the local file header. A file that is not a ZIP fails here rather than three layers later.
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  const out = testInfo.outputPath("bcf-out");
  extractWithSomethingElse(saved, out);
  expect(readFileSync(join(out, "bcf.version"), "utf8")).toContain('VersionId="3.0"');

  // One folder per topic, each holding markup.bcf — the layout every BCF reader expects.
  const topicDirs = readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory());
  expect(topicDirs).toHaveLength(1);
  const markup = readFileSync(join(out, topicDirs[0]!.name, "markup.bcf"), "utf8");
  expect(markup).toContain('TopicType="Inquiry"');
  expect(markup).toContain("<Reference>");
  expect(markup).toMatch(/<Reference>[0-9A-Za-z_$]{22}<\/Reference>/);
});

test("exports DXF that measures the same as the SVG the reviewer saw", async ({ page }, testInfo) => {
  // Two serialisers, one Drawing. The point is not that a DXF appears — it is that what a consultant opens agrees
  // with what was approved on screen, which is exactly what two parallel generation paths cannot guarantee.
  await cutPlan(page);
  const svgScale = await page.locator("#plan-svg svg").getAttribute("data-scale");

  const download = page.waitForEvent("download");
  await page.locator("#dxf").dispatchEvent("click");
  const file = await download;
  // The filename carries the scale, and it must be the scale the SVG is showing.
  expect(file.suggestedFilename()).toBe(`plan-1-${svgScale!.replace("1:", "")}.dxf`);

  const saved = testInfo.outputPath("plan.dxf");
  await file.saveAs(saved);
  const text = readFileSync(saved, "utf8");

  // R12, terminated, with the layer table the SDM's layers produced.
  expect(text).toContain("$ACADVER");
  expect(text).toContain("AC1009");
  expect(text.trimEnd().endsWith("EOF")).toBe(true);
  expect(text).toContain("A-WALL");
  expect(text).toContain("POLYLINE");
  expect(text).not.toContain("LWPOLYLINE");

  // Group codes and values must pair, so the line count is even. A hand-written emitter that drops one value
  // produces a file that opens in nothing, and this is the cheapest check that catches it.
  const lines = text.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
  expect(lines.length % 2).toBe(0);

  // And the stated loss is real: no GlobalId survives into a DXF.
  const guid = await page.locator("#plan-svg svg [data-guid]").first().getAttribute("data-guid");
  expect(text).not.toContain(guid!);
});

test("exports a PDF whose GlobalIds survive, unlike the DXF's", async ({ page }, testInfo) => {
  // The paired assertion. The DXF test above ends by proving a GlobalId is **absent**; this one proves it is
  // **present**, twice. That contrast is the whole reason there are two buttons, and stating it as two tests
  // that must both hold keeps it from decaying into "we support both formats".
  await cutPlan(page);
  const svgScale = await page.locator("#plan-svg svg").getAttribute("data-scale");
  const guid = await page.locator("#plan-svg svg [data-guid]").first().getAttribute("data-guid");

  const download = page.waitForEvent("download");
  await page.locator("#pdf").dispatchEvent("click");
  const file = await download;
  expect(file.suggestedFilename()).toBe(`plan-1-${svgScale!.replace("1:", "")}.pdf`);

  const saved = testInfo.outputPath("plan.pdf");
  await file.saveAs(saved);
  const bytes = readFileSync(saved);
  // Latin-1, matching how the writer encodes. Reading this as UTF-8 corrupts every high byte, including the
  // binary marker on line 2 that this then checks for.
  const text = bytes.toString("latin1");

  expect(text.startsWith("%PDF-1.7\n")).toBe(true);
  expect([...bytes.subarray(9, 14)]).toEqual([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

  // Follow startxref and land on the xref keyword, then follow one entry and land on an object header. This is
  // the check that decides whether the file opens at all, and it is worth repeating outside the unit tests
  // because the bytes here have been through a Blob, a download and a filesystem.
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe("xref");
  const firstOffset = Number(text.slice(startxref + 5 + 4, startxref + 5 + 4 + 100).match(/(\d{10}) 00000 n/)![1]);
  expect(text.slice(firstOffset)).toMatch(/^\d+ 0 obj\n/);

  // Identity, in the page.
  expect(text).toContain(`/GUID (${guid})`);
  // Identity, in the attached index — the half that lets a markup made in someone else's PDF tool come back.
  expect(text).toContain("massingviewer-index.json");
  expect(text).toContain('"format":"massingviewer-pdf-index"');

  // Slice the attached stream by its declared /Length, exactly as a reader does. Two earlier versions of these
  // four lines were wrong in the same way — trying to describe PDF structure with one regex. The first matched
  // the JSON with a non-greedy `{...]}` and stopped at a nested `]}` inside `incomplete`; the second used
  // `[^>]*` for the dictionary, which cannot cross the `>>` closing the nested `/Params` dict, so it never
  // reached `stream`. Byte-counting is both correct and the stronger assertion: it fails if /Length is wrong.
  const embeddedAt = text.indexOf("/Type /EmbeddedFile");
  const streamAt = text.indexOf("stream\n", embeddedAt);
  const length = Number(/\/Length (\d+)/.exec(text.slice(embeddedAt, streamAt))![1]);
  const start = streamAt + "stream\n".length;
  const index = JSON.parse(text.slice(start, start + length));
  expect(index.paper.scale).toBe(Number(svgScale!.replace("1:", "")));
  expect(index.entities.some((e: { guid: string }) => e.guid === guid)).toBe(true);

  // Layers survive as Optional Content Groups, so a reviewer can switch the grid off.
  expect(text).toContain("/Type /OCG");
  expect(text).toContain("/OCProperties");
});

/**
 * Drag-and-drop, in a real browser with a real `DataTransfer`.
 *
 * The unit tests build their own DragEvent because happy-dom has no `DataTransfer` at all. That is enough to
 * assert the handler logic and not enough to assert the *behaviour*, because the thing most likely to be wrong
 * is what the browser does when we get `preventDefault` wrong — and only a browser does that.
 */
async function dropFiles(
  page: Page,
  files: readonly { name: string; body: string }[],
): Promise<void> {
  const handle = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.body], f.name));
    return dt;
  }, files as { name: string; body: string }[]);
  await page.dispatchEvent("#viewport", "drop", { dataTransfer: handle });
}

test("opens a dropped IFC, and does not navigate the session away", async ({ page }) => {
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  const url = page.url();
  const before = await page.evaluate(() => window.__massingviewer!.elements.length);
  expect(before).toBeGreaterThan(0);

  // The same fixture the app starts with, arriving the way a user's file arrives. Using the same bytes is
  // deliberate: it isolates the *opening* path, so a difference in element count can only be the loader.
  const ifc = readFileSync(join(import.meta.dirname, "..", "fixtures", "sample.ifc"), "utf8");
  await dropFiles(page, [{ name: "Tower-A-dropped.ifc", body: ifc }]);

  await expect(page.locator("#file")).toHaveText("Tower-A-dropped.ifc", { timeout: 15_000 });
  await expect(page.locator("#kernel")).toContainText("no network");

  // The assertion that matters most, and the one a unit test cannot make: the page is still the page. Without
  // `preventDefault` on `dragover` the browser navigates to the dropped file and the session is gone.
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.__massingviewer!.elements.length)).toBe(before);

  // And the model is live: the kernel was reopened on the new bytes, so authoring still works. Leaving the
  // kernel on the previous model would give a correct-looking viewport whose first edit writes the wrong file.
  // `#author`, not a role+name locator. There is no button called "Add wall" — it reads "+ Wall" — and with the
  // ribbon on the page a loose name match is ambiguous anyway. Same lesson as the `name: "m"` locator that broke
  // the moment the ribbon existed: an id is the only locator that cannot drift with a label.
  await page.locator("#author").dispatchEvent("click");
  await expect(page.locator("#kernel")).toContainText("authored", { timeout: 20_000 });
});

test("refuses an unsupported drop with that format's own reason", async ({ page }) => {
  // Dim-not-hide, applied to file formats. "point clouds are M10" is actionable; "unsupported file type" is the
  // dead end this replaces, because it does not say whether to wait, convert, or file a bug.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  await dropFiles(page, [{ name: "scan.las", body: "LASF" + "\0".repeat(300) }]);
  await expect(page.locator("#kernel")).toContainText("point clouds are M10");

  // A format we will never support names the reason we will not, which is the only useful thing to say about it.
  await dropFiles(page, [{ name: "plan.dwg", body: "AC1032" + "\0".repeat(300) }]);
  await expect(page.locator("#kernel")).toContainText("GPL-3.0");
  await expect(page.locator("#kernel")).toContainText("DXF");

  // The model is untouched by a refused drop.
  await expect(page.locator("#file")).toHaveText("sample.ifc");
});

test("reports a file whose name and bytes disagree, rather than guessing", async ({ page }) => {
  // The acceptance failure massing's extension gate has: `model.ifc` that is really a ZIP goes to the IFC parser
  // and comes back with "unexpected token PK". Revit and Archicad both export ifcZIP, so this is routine.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  await dropFiles(page, [{ name: "model.ifc", body: "PK" + String.fromCharCode(3, 4) + "junk" }]);
  await expect(page.locator("#kernel")).toContainText("but the bytes say zip");
  await expect(page.locator("#file")).toHaveText("sample.ifc");
});

test("shows the drop hint without letting it swallow the drop", async ({ page }) => {
  // `pointer-events: none` on the overlay is load-bearing. An overlay that accepts pointer events becomes the
  // drop event's target, so the drop lands on an element with no listener — showing the hint would break the
  // very interaction it advertises.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  const hint = page.locator("#drop-hint");
  await expect(hint).toBeHidden();

  await page.dispatchEvent("#viewport", "dragenter", {
    dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
  });
  await expect(hint).toBeVisible();
  expect(await hint.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

  await page.dispatchEvent("#viewport", "dragleave", {
    dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
  });
  await expect(hint).toBeHidden();
});

test("a plugin's button exists before its code does, and works when pressed", async ({ page }) => {
  // Lazy activation, end to end. The manifest put this button on the ribbon at startup; the plugin's module is
  // not fetched until it is pressed. That split is the entire reason the contribution model is declarative, and
  // it is what lets a hundred installed plugins cost nothing at startup.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });

  // Analyse is an existing tab. Plugins join tabs; they do not invent them, and `validateManifest` refuses a tab
  // that is not one of the nine.
  await page.locator('#ribbon [role="tab"]', { hasText: "Analyse" }).click();
  const button = page.locator('#ribbon button[data-tool="footprint"]');
  await expect(button).toBeVisible();

  await button.click();
  // The command ran, which means the host loaded and activated the plugin on demand.
  await expect(page.locator("#status")).toContainText("footprint", { timeout: 10_000 });
  await expect(page.locator("#status")).toContainText("=");
});

test("a plugin's keybinding comes from its manifest, not from a switch statement", async ({ page }) => {
  // The payoff of declaring keybindings as data: remapping is an edit to a manifest. massing's `handleKey`
  // switch statement is the thing this replaces, and a plugin cannot extend a switch statement at all.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
  await page.locator("#viewport").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+M");
  await expect(page.locator("#status")).toContainText("footprint", { timeout: 10_000 });
});

test("the ribbon renders one panel, not seven stacked", async ({ page }) => {
  // A **measured** assertion, and it exists because the unit tests could not catch this. The CSS set
  // `.mv-ribbon-panel { display: flex }`, which beats the `hidden` attribute's UA `display: none`, so every tab's
  // panel rendered at once and the ribbon came out 503px tall. `panel.hidden` was correctly `true` throughout —
  // so asserting the attribute passed while the render was wrong. Same failure as
  // docs/pending/toolbarView.test.ts.txt, new costume.
  const ribbon = page.locator("#ribbon");
  await expect(ribbon).toBeVisible();

  const heights = await page.evaluate(() =>
    [...document.querySelectorAll("#ribbon .mv-ribbon-panel")].map((p) => p.getBoundingClientRect().height),
  );
  expect(heights.filter((h) => h > 0), "exactly one panel should occupy space").toHaveLength(1);

  const ribbonHeight = (await ribbon.boundingBox())!.height;
  // One panel plus a tab strip. Seven stacked panels measured 503.
  expect(ribbonHeight).toBeGreaterThan(60);
  expect(ribbonHeight).toBeLessThan(160);
});

test("the ribbon holds all 30 inherited tools, and dims rather than hides", async ({ page }) => {
  // Asserting the render, not the table: `ui-model` already proves every tool has a home, and that is a
  // different claim from every tool producing a button.
  // 31 = the 30 inherited tools plus one contributed by the example plugin. Written as a sum rather than as a
  // magic number, because the composition is the interesting part: the plugin's button is rendered by the same
  // code, in the same collapse algorithm, as a built-in one.
  await expect(page.locator("#ribbon button[data-tool]")).toHaveCount(30 + 1);
  await expect(page.locator('#ribbon [role="tab"]')).toHaveCount(7);

  // With nothing selected, the selection verbs are dimmed — present, focusable, and explaining themselves.
  await page.locator('#ribbon [data-tab="build"]').click();
  const move = page.locator('#ribbon [data-tool="move-selected-element-e-n-z-metres"]');
  await expect(move).toHaveAttribute("aria-disabled", "true");
  await expect(move).toHaveAttribute("title", /Select an element first/);
  // `disabled` would make it unfocusable and unannounced, which defeats showing the user what exists.
  expect(await move.evaluate((el: HTMLButtonElement) => el.disabled)).toBe(false);
});

test("the ribbon is keyboard-navigable and announces what it armed", async ({ page }) => {
  // WCAG 2.2 AA in the one place it is most often skipped. `role="toolbar"` per group plus a roving tabindex is
  // what makes 30 buttons navigable instead of a 30-stop tab sequence in front of the canvas.
  const tabbablePerGroup = await page.evaluate(() =>
    [...document.querySelectorAll('#ribbon [role="tabpanel"]:not([hidden]) [role="toolbar"]')].map(
      (g) => [...g.querySelectorAll("button[data-tool]")].filter((b) => b.getAttribute("tabindex") === "0").length,
    ),
  );
  expect(tabbablePerGroup.every((n) => n === 1), `tabbable per group: ${tabbablePerGroup.join(",")}`).toBe(true);

  const measure = page.locator('#ribbon [data-tool="measure-distance-m"]');
  await measure.focus();
  await page.keyboard.press("ArrowRight");
  // Focus moved within the group, and the roving index followed it.
  const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.tool ?? null);
  expect(focused).toBe("measure-area-a");

  // Activating announces through the live region, because nothing visible tells a screen-reader user that the
  // next click now means something different.
  //
  // Measure, not Show all: with nothing selected `show-all-h` is dimmed, and Playwright's actionability check
  // treats `aria-disabled="true"` as disabled and waits forever. Useful to know — it means the dim state is real
  // enough that the test harness itself respects it.
  await page.locator('#ribbon [data-tool="measure-distance-m"]').click();
  await expect(page.locator("#ribbon [role='status']")).toHaveText(/Measure/);
});

test("the ribbon collapses groups on a narrow viewport without losing a tool", async ({ page }) => {
  // The invariant that replaces `MAX_PRIMARY = 8`, checked in a real browser. That cap shipped a bug: promoting
  // Push/pull silently demoted Move. Here nothing is dropped — groups become dropdowns and every button stays in
  // the DOM, reachable.
  await page.locator('#ribbon [data-tab="build"]').click();
  await page.setViewportSize({ width: 360, height: 800 });

  await expect
    .poll(async () =>
      page.evaluate(
        () => document.querySelectorAll("#ribbon [role='tabpanel']:not([hidden]) .mv-ribbon-group.mv-collapsed").length,
      ),
    )
    .toBeGreaterThan(0);

  // Still all thirty. Collapsed is not gone.
  // 31 = the 30 inherited tools plus one contributed by the example plugin. Written as a sum rather than as a
  // magic number, because the composition is the interesting part: the plugin's button is rendered by the same
  // code, in the same collapse algorithm, as a built-in one.
  await expect(page.locator("#ribbon button[data-tool]")).toHaveCount(30 + 1);
  // And the ribbon never becomes the thing that makes the page scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow, "the page must not scroll horizontally").toBe(false);

  // The dropdown reveals the collapsed group's items.
  const more = page.locator("#ribbon [role='tabpanel']:not([hidden]) .mv-ribbon-group.mv-collapsed .mv-ribbon-more").first();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
});

test("nothing is silently skipped by the tessellator", async ({ page }) => {
  // The tessellator ignores openings by design (no booleans) and REPORTS what it skipped. For this fixture the
  // openings are voids rather than drawn products, so the list must be empty — and if a future change starts
  // dropping elements, this fails rather than the viewer quietly showing half a building.
  const heading = page.locator("#skipped-h");
  await expect(heading).toBeHidden();
  await expect(page.locator("#skipped li")).toHaveCount(0);
});
