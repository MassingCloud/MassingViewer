import { expect, test, type Page } from "@playwright/test";

/**
 * M6's acceptance criterion, as the plan states it:
 *
 * > *"snap to a grid intersection, type `12'6`, commit, and confirm the wall appears in 3D **and** in the plan
 * > pane with a matching `data-guid`."*
 *
 * Before the draft wiring landed this could not be performed at all: `@massing/authoring` was consumed only by
 * `packages/embed`, the command registry was created with nothing registered, and `parseDynConstraint` was wired
 * to no UI. Every piece existed and nothing joined them.
 *
 * ## Driven through the real UI
 *
 * Clicks on the ribbon button and pointer events on the canvas, not calls into the session. That is the point: the
 * bug this suite existed to catch was in the *wiring*, and a test that called `session.pick()` directly would have
 * passed against the broken version — the 6 m wall came from the host feeding single characters to a whole-token
 * parser, which no test of the session itself could see.
 */

/** The canvas is what pointer events are dispatched against, and its rect is the projection basis. */
async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator("#viewport canvas").boundingBox();
  expect(box, "no canvas — the viewport never laid out").not.toBeNull();
  return box!;
}

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  // The draft tools are created only once the kernel has answered with its op list, because `availability()` reads
  // it — a tool armed before that would show enabled and refuse on click.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
}

/**
 * Arm a draw verb from the ribbon, the way a user does.
 *
 * The wait is the interesting part. `ready()` above waits for the kernel panel's text, which is a *proxy* for
 * "the draft controller is wired" — and the two were published in the wrong order in `apps/demo/src/main.ts`
 * until 2026-08-15: the panel announced readiness, then `wireDraft` ran. A tool armed in that window has no
 * controller and silently does not arm, which presents exactly as `#dyn-hud` never becoming visible.
 *
 * Both halves are fixed: the app publishes the signal after the wiring, and this asserts the real precondition
 * rather than trusting the order. Two proxies for one fact is how the offline test cost three diagnoses.
 *
 * **Not claimed as the fix for the iPad flake.** It is unexplained, this was found looking for it, and the
 * failure message below is what will identify it if it recurs.
 */
async function arm(page: Page, tool: string): Promise<void> {
  await page.waitForFunction(() => window.__massingviewer?.draft != null, undefined, { timeout: 20_000 });
  const button = page.locator(`#ribbon button[data-tool="${tool}"]`);
  await expect(button, `the ribbon has no button for "${tool}"`).toHaveCount(1);
  await button.dispatchEvent("click");
  await expect(
    page.locator("#dyn-hud"),
    `arming "${tool}" did not show the prompt HUD, with the draft controller present and the button in the ribbon`,
  ).toBeVisible();
}

/** The element count from the test hook, which reads through a getter and so cannot go stale. */
const elementCount = (page: Page) => page.evaluate(() => window.__massingviewer!.elements.length);

test("arming a draw tool shows its prompt, the grid, and a crosshair", async ({ page }) => {
  await ready(page);
  await arm(page, "draw-a-wall-between-two-points-w");

  // The prompt is the descriptor's own first argument prompt, so a tool cannot be armed without saying what it
  // wants. `ArgSpec.prompt` is required for exactly this reason.
  await expect(page.locator("#dyn-hud")).toContainText("Specify start point");

  const scene = await page.evaluate(() => {
    const children = window.__massingviewer!.viewport.scene.children;
    const grid = children.find((o) => o.name === "mv-grid");
    return { grid: grid !== undefined, gridVisible: grid?.visible, preview: children.some((o) => o.name === "mv-draft-preview") };
  });
  // The grid comes on with the tool: M6's criterion is "snap to a grid intersection", and an invisible
  // intersection is one nobody aims at.
  expect(scene).toEqual({ grid: true, gridVisible: true, preview: true });
});

test("draws a wall at a typed imperial distance — the M6 criterion", async ({ page }) => {
  await ready(page);
  const before = await elementCount(page);
  await arm(page, "draw-a-wall-between-two-points-w");

  const box = await canvasBox(page);
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.6;

  // First point. `pointermove` before `pointerdown` because `hover` is what resolves the snap, and a click with no
  // preceding move would commit a point the crosshair never showed.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator("#dyn-hud")).toContainText("Specify end point");

  // Move away, so the typed distance has a bearing to follow. The session refuses a distance with no direction
  // rather than inventing one.
  await page.mouse.move(x + 160, y);
  await expect(page.locator("#dyn-hud")).toContainText("m");

  /**
   * `12'6<0` — twelve feet six inches due east.
   *
   * The bearing is pinned deliberately, and the first version of this test omitted it. Without one the wall
   * follows the cursor's direction, which landed at 45° — and the assertion below measured
   * `max(width, depth)` of the bounding box, which for a diagonal wall is **not its length**. It read 2.826 and
   * the test failed while the geometry was perfectly correct: for a 45° wall of length L and thickness t, the
   * bounding box is 0.7071·(L + t) across, so 2.826 *is* 3.81 m long.
   *
   * Pinning the bearing makes the wall axis-aligned, so the bounding box and the length are the same number — and
   * it exercises the angle half of the dynamic-input grammar rather than only the distance.
   */
  await page.keyboard.type("12'6<0");
  // Echoed as typed, not converted, so the user sees what they entered.
  await expect(page.locator("#dyn-hud")).toContainText("12'6<0");

  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toContainText("committed", { timeout: 20_000 });
  expect(await elementCount(page)).toBe(before + 1);

  /**
   * The measurement, and the assertion that actually caught the bug.
   *
   * The first working version showed `12'6` in the HUD and built a **6 m** wall, because the host fed single
   * characters into a whole-token parser and each character replaced the last constraint — leaving `distance: 6`.
   * Nothing errored and the readout looked correct. Only measuring the geometry catches that.
   */
  const measured = await page.evaluate(() => {
    const elements = window.__massingviewer!.elements;
    const last = elements[elements.length - 1]!;
    let length = 0;
    window.__massingviewer!.viewport.scene.traverse((object) => {
      const o = object as unknown as {
        isMesh?: boolean;
        userData?: { expressId?: number };
        geometry?: { attributes: { position: { array: ArrayLike<number> } } };
      };
      if (o.isMesh !== true || o.userData?.expressId !== last.expressId || o.geometry === undefined) return;
      const p = o.geometry.attributes.position.array;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        minX = Math.min(minX, p[i]!);
        maxX = Math.max(maxX, p[i]!);
        minZ = Math.min(minZ, p[i + 2]!);
        maxZ = Math.max(maxZ, p[i + 2]!);
      }
      // Axis-aligned because the bearing was pinned to 0°, so the long side of the bounding box *is* the length.
      // This equality is exactly what a diagonal wall breaks — see the note on the typed bearing above.
      length = Math.max(maxX - minX, maxZ - minZ);
    });
    return { length, guid: last.guid };
  });

  // 12 ft 6 in = 3.810 m. Within a tenth of a millimetre.
  expect(measured.length).toBeCloseTo(3.81, 4);

  // And the plan half of the criterion: the wall the drafter just drew carries its GlobalId into the drawing, so
  // a markup on that line resolves to that element.
  await page.locator("#plan").dispatchEvent("click");
  await expect(page.locator("#plan-info")).toContainText("Entities", { timeout: 20_000 });
  const inPlan = await page
    .locator(`#plan-svg svg [data-guid="${measured.guid}"]`)
    .count();
  expect(inPlan, "the wall is in the model but not in the plan").toBeGreaterThan(0);
});

test("snaps to a grid intersection, so a typed run starts from a round number", async ({ page }) => {
  await ready(page);
  await arm(page, "draw-a-wall-between-two-points-w");
  const box = await canvasBox(page);

  /**
   * Swept over a grid of positions rather than a handful, and the first version of this test got that wrong.
   *
   * Five samples clustered near the centre of the canvas all failed — not because grid snapping was broken, but
   * because the *building* is in the middle of the view and a model endpoint outranks a grid intersection at the
   * same range. `grid` is deliberately the lowest-priority snap kind, so the sample has to reach past the model
   * to observe one at all. That is the feature, and a narrow sample made it look like a bug.
   */
  // Listed rather than matched with a regex. The previous version ended its pattern with a word-boundary escape,
  // and that escape did not survive the layers of quoting it was written through: it reached the file as a literal
  // backspace byte, so the pattern matched nothing and the test failed as "grid snapping is broken". A plain
  // substring check has nothing to mangle.
  const SNAP_KINDS = ["endpoint", "midpoint", "center", "intersection", "perpendicular", "grid", "nearest"];
  const kinds = new Set<string>();
  for (const fx of [0.15, 0.3, 0.45, 0.6, 0.75, 0.85]) {
    for (const fy of [0.25, 0.45, 0.65, 0.85]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      const hud = (await page.locator("#dyn-hud").textContent()) ?? "";
      const match = SNAP_KINDS.find((kind) => hud.includes(`· ${kind}`)) ?? null;
      if (match !== null) kinds.add(match);
    }
  }
  // A grid intersection must be reachable somewhere on the plane. Zero would mean `SnapSettings.grid` is not
  // wired through to the session at all.
  expect([...kinds], "no sampled position snapped to the grid").toContain("grid");
});

test("refuses a degenerate wall before the kernel, and stays armed", async ({ page }) => {
  await ready(page);
  const before = await elementCount(page);
  await arm(page, "draw-a-wall-between-two-points-w");

  const box = await canvasBox(page);
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;

  // The same point twice — a double-click, which is the commonest way to produce this.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up();

  // Refused with the measurement stated, so the user can tell a double-click from a snap that missed.
  await expect(page.locator("#status")).toContainText("too short", { timeout: 20_000 });
  expect(await elementCount(page), "a degenerate wall reached the kernel").toBe(before);

  /**
   * Still armed, and this is the requirement rather than a detail.
   *
   * `docs/testing.md` lists "Refusal UX (tool stays armed, no lost work)" as a golden-path E2E case. A refusal
   * that disarmed would throw away the point already collected, and losing work to a validation message is what
   * makes people stop trusting a tool.
   */
  await expect(page.locator("#dyn-hud")).toBeVisible();
});

test("Escape cancels the command rather than the selection", async ({ page }) => {
  await ready(page);
  await arm(page, "place-a-column-at-a-point");
  await expect(page.locator("#dyn-hud")).toContainText("Specify column centre");

  await page.keyboard.press("Escape");
  // Hidden, so the tool is disarmed. Before the draft wiring, Escape here would have cleared the *selection* —
  // two unrelated meanings on one key, with the wrong one winning.
  await expect(page.locator("#dyn-hud")).toBeHidden();
});

test("Backspace edits the typed number instead of deleting a placed point", async ({ page }) => {
  await ready(page);
  await arm(page, "draw-a-wall-between-two-points-w");
  const box = await canvasBox(page);
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.6;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator("#dyn-hud")).toContainText("Specify end point");

  await page.mouse.move(x + 160, y);
  await page.keyboard.type("55");
  await expect(page.locator("#dyn-hud")).toContainText("55");
  await page.keyboard.press("Backspace");
  await expect(page.locator("#dyn-hud")).toContainText("5");
  await expect(page.locator("#dyn-hud")).not.toContainText("55");

  // Still collecting the END point, not back to the start — the placed point survived. The session's own comment
  // calls conflating these "a data-loss bug disguised as a keystroke".
  await expect(page.locator("#dyn-hud")).toContainText("Specify end point");
});

test("the Levels tool toggles the construction grid", async ({ page }) => {
  await ready(page);
  const visible = () =>
    page.evaluate(
      () => window.__massingviewer!.viewport.scene.children.find((o) => o.name === "mv-grid")?.visible ?? null,
    );

  // Off until something asks for it: a grid drawn over a model nobody is drafting on is clutter.
  expect(await visible()).toBe(false);
  await page.locator('#ribbon button[data-tool="toggle-storey-levels-overlay"]').dispatchEvent("click");
  expect(await visible()).toBe(true);
  await page.locator('#ribbon button[data-tool="toggle-storey-levels-overlay"]').dispatchEvent("click");
  expect(await visible()).toBe(false);
});
