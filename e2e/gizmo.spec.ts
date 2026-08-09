import { expect, test, type Page } from "@playwright/test";

/**
 * The transform gizmo, driven the way a pointer drives it.
 *
 * Every assertion here was verified by hand in a browser first, and doing so found **two bugs no unit test could
 * have**, both of which reported success while nothing moved:
 *
 *   1. **The handles did not follow the element after an edit.** Every commit re-exports the IFC and rebuilds every
 *      mesh, so the `SceneElement` the gizmo measured stops existing. The handles stayed where the element used to
 *      be, a second drag pressed on empty space, and the status line still showed the *previous* commit — which
 *      made it look like the drag had worked.
 *   2. **The tessellator discarded rotations.** `rotate_element` wrote them into the file correctly and the
 *      renderer read only the placement's origin point, ignoring `refDirection`. "rotate committed" was true of the
 *      file and false of the picture, which is the worst kind of wrong: the viewport disagreeing with what it
 *      claims to show.
 *
 * So the measurements below come from the **element's own geometry**, never from the gizmo's state. The gizmo could
 * report anything.
 */

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  // The gizmo is created with the draft controller, once the kernel has answered with its op list.
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
}

/** Select the first element of a class by clicking its projected centre, through the real picker. */
async function selectFirst(page: Page, ifcType: string): Promise<string> {
  const target = await page.evaluate((wanted) => {
    const mv = window.__massingviewer!;
    const element = mv.elements.find((e) => e.ifcType === wanted);
    if (element === undefined) return null;
    const camera = mv.viewport.camera;
    const rect = mv.viewport.renderer.domElement.getBoundingClientRect();
    const geometry = element.object.geometry;
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox!.getCenter(camera.position.clone());
    centre.applyMatrix4(element.object.matrixWorld);
    const projected = centre.clone().project(camera);
    return {
      guid: element.guid,
      at: [
        rect.left + (projected.x * 0.5 + 0.5) * rect.width,
        rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      ] as [number, number],
    };
  }, ifcType);

  expect(target, `no ${ifcType} in the model`).not.toBeNull();
  expect(target!.guid, `the ${ifcType} has no GlobalId, so it can carry no handles`).not.toBeNull();

  await page.mouse.click(target!.at[0], target!.at[1]);
  await expect(page.locator("#sel .mono")).toHaveText(target!.guid!);
  return target!.guid!;
}

interface Measured {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly minX: number;
  readonly minZ: number;
}

/** The element's world-space footprint and height, in metres, read off its own geometry. */
async function measure(page: Page, guid: string): Promise<Measured> {
  const out = await page.evaluate((id) => {
    const mv = window.__massingviewer!;
    let found: { dx: number; dy: number; dz: number; minX: number; minZ: number } | null = null;
    mv.viewport.scene.traverse((object) => {
      const mesh = object as unknown as {
        isMesh?: boolean;
        userData?: { guid?: string };
        geometry?: { computeBoundingBox(): void; boundingBox: { clone(): { applyMatrix4(m: unknown): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } } } | null };
        matrixWorld?: unknown;
      };
      if (mesh.isMesh !== true || mesh.userData?.guid !== id || mesh.geometry == null) return;
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox === null) return;
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      found = {
        dx: +(box.max.x - box.min.x).toFixed(3),
        dy: +(box.max.y - box.min.y).toFixed(3),
        dz: +(box.max.z - box.min.z).toFixed(3),
        minX: +box.min.x.toFixed(3),
        minZ: +box.min.z.toFixed(3),
      };
    });
    return found;
  }, guid);
  expect(out, `no mesh for ${guid}`).not.toBeNull();
  return out!;
}

/**
 * Drag a handle by a world-space delta.
 *
 * Both endpoints are projected through the **live camera**, so the drag lands on the handle whatever the current
 * orbit is. A fixed pixel offset would work at one camera position and silently miss at another.
 */
async function dragHandle(
  page: Page,
  role: "move" | "rotate" | "height",
  delta: readonly [number, number, number],
  /**
   * Where the press starts, relative to the handle's own position.
   *
   * Needed for the ring: a torus's `position` is the element **centre**, not a point on the ring — so pressing at
   * the handle position lands on the move plate instead, and the first version of the rotate test dutifully
   * reported "move committed". The offset puts the press on the ring itself.
   */
  fromOffset: readonly [number, number, number] = [0, 0, 0],
): Promise<void> {
  const points = await page.evaluate(
    ({ wanted, by, grab }) => {
      const mv = window.__massingviewer!;
      const camera = mv.viewport.camera;
      const rect = mv.viewport.renderer.domElement.getBoundingClientRect();
      const gizmo = mv.viewport.scene.children.find((o) => o.name === "mv-gizmo");
      const handle = gizmo?.children.find((c) => c.userData.role === wanted);
      if (handle === undefined) return null;
      const screen = (x: number, y: number, z: number): [number, number] => {
        const v = camera.position.clone().set(x, y, z).project(camera);
        return [rect.left + (v.x * 0.5 + 0.5) * rect.width, rect.top + (-v.y * 0.5 + 0.5) * rect.height];
      };
      const h = handle.position;
      const gx = h.x + grab[0];
      const gy = h.y + grab[1];
      const gz = h.z + grab[2];
      return { from: screen(gx, gy, gz), to: screen(gx + by[0], gy + by[1], gz + by[2]) };
    },
    { wanted: role, by: [...delta] as [number, number, number], grab: [...fromOffset] as [number, number, number] },
  );
  expect(points, `no ${role} handle on screen`).not.toBeNull();

  await page.mouse.move(points!.from[0], points!.from[1]);
  await page.mouse.down();
  await page.mouse.move(points!.to[0], points!.to[1]);
  await page.mouse.up();
}

/**
 * Wait until the element's own geometry reaches an expected value.
 *
 * Polling the **geometry** rather than the status line, and that is a correctness fix rather than a style choice.
 * `#status` keeps the *previous* message until the next one replaces it, so
 * `expect(status).toContainText("move committed")` passes instantly on the second drag of a test — before the
 * second commit has happened. `measure()` then read the model mid-flight and the test failed reporting the wrong
 * thing entirely. A stale message is exactly how the handles-not-following bug hid in the first place.
 */
async function waitFor(
  page: Page,
  guid: string,
  read: (m: Measured) => number,
  expected: number,
  what: string,
): Promise<void> {
  await expect
    .poll(async () => read(await measure(page, guid)), { timeout: 20_000, message: what })
    .toBeCloseTo(expected, 2);
}

test("selecting an element attaches all three handles", async ({ page }) => {
  await ready(page);
  await selectFirst(page, "IFCCOLUMN");
  const handles = await page.evaluate(() => {
    const gizmo = window.__massingviewer!.viewport.scene.children.find((o) => o.name === "mv-gizmo");
    return { visible: gizmo?.visible ?? false, roles: (gizmo?.children ?? []).map((c) => c.userData.role as string).sort() };
  });
  // All three at once, because they are not modes: a direct-manipulation gizmo puts every affordance on screen
  // and lets the user choose by grabbing.
  expect(handles).toEqual({ visible: true, roles: ["height", "move", "rotate"] });
});

test("clearing the selection takes the handles away", async ({ page }) => {
  await ready(page);
  await selectFirst(page, "IFCCOLUMN");
  await page.keyboard.press("Escape");
  const visible = await page.evaluate(
    () => window.__massingviewer!.viewport.scene.children.find((o) => o.name === "mv-gizmo")?.visible ?? null,
  );
  // Handles left behind would offer a transform of whatever was selected last.
  expect(visible).toBe(false);
});

test("the move plate translates on both plan axes, in IFC terms", async ({ page }) => {
  await ready(page);
  const guid = await selectFirst(page, "IFCCOLUMN");
  const before = await measure(page, guid);

  await dragHandle(page, "move", [2, 0, 0]);
  await waitFor(page, guid, (m) => m.minX, before.minX + 2, "the element did not move +2 m on x");
  expect((await measure(page, guid)).minZ).toBeCloseTo(before.minZ, 2);

  /**
   * And along the viewport's **z**, which is the assertion that matters most.
   *
   * `move_element` takes IFC axes, where IFC y is the plan y — the viewport's z. A gizmo emitting world axes would
   * send `dz: 3` instead of `dy: 3` and lift the column three metres into the air: the footprint would not move,
   * and nothing would error. Only measuring both axes separately catches it.
   */
  await dragHandle(page, "move", [0, 0, 3]);
  await waitFor(page, guid, (m) => m.minZ, before.minZ + 3, "the element did not move +3 m on the viewport's z");
  expect((await measure(page, guid)).dy, "a plan move changed the element's height").toBeCloseTo(before.dy, 2);
});

test("the handles follow the element after the model is rebuilt", async ({ page }) => {
  await ready(page);
  const guid = await selectFirst(page, "IFCCOLUMN");
  const before = await measure(page, guid);

  await dragHandle(page, "move", [2, 0, 0]);
  await waitFor(page, guid, (m) => m.minX, before.minX + 2, "the first drag did not land");

  // The second drag can only land if the handles moved with the element — which they did not, before this was
  // fixed. It pressed empty space, no drag started, and the stale status line made it look successful.
  await dragHandle(page, "move", [2, 0, 0]);
  await waitFor(page, guid, (m) => m.minX, before.minX + 4, "the second drag did not land — handles did not follow");
});

test("the top cone changes the height and leaves the footprint alone — push/pull", async ({ page }) => {
  await ready(page);
  const guid = await selectFirst(page, "IFCCOLUMN");
  const before = await measure(page, guid);

  await dragHandle(page, "height", [0, 2, 0]);
  await expect
    .poll(async () => (await measure(page, guid)).dy, { timeout: 20_000, message: "the height never changed" })
    .toBeGreaterThan(before.dy);

  const after = await measure(page, guid);
  // `set_extrusion_depth` changes how far a profile is extruded, not the profile — so the plan is untouched.
  expect(after.dx).toBeCloseTo(before.dx, 2);
  expect(after.dz).toBeCloseTo(before.dz, 2);
});

test("the ring rotates the element, and the viewport actually shows it", async ({ page }) => {
  await ready(page);
  const guid = await selectFirst(page, "IFCWALL");
  const before = await measure(page, guid);
  // A wall, not a column: a square footprint barely changes under rotation and would prove nothing.
  expect(before.dx).toBeGreaterThan(before.dz);

  /**
   * A quarter turn, grabbed at whichever point on the ring is actually on screen.
   *
   * The first version always grabbed at the ring's +x point. That is fine on a 1280-wide desktop canvas and lands
   * **off-screen on iPad**, where the canvas is much narrower and the ring around an 8 m wall is 4.3 m in radius —
   * so the press missed, nothing rotated, and the failure read as "rotation is broken on iPad" rather than "the
   * test aimed outside the viewport". Choosing the grab point by projection tests the feature on every device
   * instead of only where the arithmetic happened to fit.
   */
  const grab = await page.evaluate(() => {
    const mv = window.__massingviewer!;
    const camera = mv.viewport.camera;
    const ring = mv.viewport.scene.children
      .find((o) => o.name === "mv-gizmo")!
      .children.find((c) => c.userData.role === "rotate")!;
    const radius = ring.scale.x;
    const inset = 0.12; // stay clear of the very edge, where a press can miss on a rounded viewport
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180;
      const ox = Math.cos(a) * radius;
      const oz = Math.sin(a) * radius;
      const v = camera.position.clone().set(ring.position.x + ox, ring.position.y, ring.position.z + oz).project(camera);
      const inside = Math.abs(v.x) < 1 - inset && Math.abs(v.y) < 1 - inset;
      if (!inside) continue;
      // The point a quarter turn anticlockwise (seen from above) from this one.
      const b = a - Math.PI / 2;
      return {
        from: [ox, 0, oz] as [number, number, number],
        to: [Math.cos(b) * radius - ox, 0, Math.sin(b) * radius - oz] as [number, number, number],
      };
    }
    return null;
  });
  expect(grab, "no point on the rotate ring is inside the viewport").not.toBeNull();
  await dragHandle(page, "rotate", grab!.to, grab!.from);
  await waitFor(page, guid, (m) => m.dz, before.dx, "the wall's long axis never swapped");

  const after = await measure(page, guid);
  // The long axis swapped: an 8 m × 200 mm wall becomes 200 mm × 8 m. This is the assertion the tessellator's
  // discarded `refDirection` was failing — silently, while the status line said the rotation had committed.
  expect(after.dz).toBeGreaterThan(after.dx);
  expect(after.dz).toBeCloseTo(before.dx, 1);
});

test("a drag that goes nowhere does not write an edit", async ({ page }) => {
  await ready(page);
  const guid = await selectFirst(page, "IFCCOLUMN");
  const before = await measure(page, guid);
  const versionBefore = (await page.locator("#kernel").textContent()) ?? "";

  // Pressed and released inside one snap cell.
  await dragHandle(page, "move", [0.05, 0, 0.05]);
  await page.waitForTimeout(500);

  const after = await measure(page, guid);
  expect(after.minX).toBeCloseTo(before.minX, 3);
  // A zero `move_element` would still bump the model version and write an audit entry for a change nobody made.
  expect((await page.locator("#kernel").textContent()) ?? "").toBe(versionBefore);
});

test("the ribbon's transform verbs say where the handles are", async ({ page }) => {
  /**
   * The four transform buttons are not modes and must not pretend to be.
   *
   * The handles for move, rotate and push/pull are on screen together the moment something is selected. So the
   * honest thing for these buttons to do is point at the right handle — the button literally reads "drag the
   * gizmo", and announcing beats both silence and a fake mode.
   */
  await ready(page);
  await selectFirst(page, "IFCCOLUMN");
  await page
    .locator('#ribbon button[data-tool="push-pull-drag-the-top-handle-to-make-the-selected-element-taller-or-thicker"]')
    .dispatchEvent("click");
  await expect(page.locator("#status")).toContainText("cone");
});

test("with nothing selected, a transform verb says to select something first", async ({ page }) => {
  await ready(page);
  await page
    .locator('#ribbon button[data-tool="edit-in-place-drag-the-gizmo-to-move-the-selected-element"]')
    .dispatchEvent("click");
  // The ribbon's live region, which is what a screen-reader user hears — a hint only in the footer reaches half
  // the audience.
  await expect(page.locator("#ribbon .mv-ribbon-live")).toContainText("Select an element first");
});

// ---------------------------------------------------------------------------------------------------
// The property inspector
// ---------------------------------------------------------------------------------------------------

/** Read the Selection panel as term → value pairs, which is what a `<dl>` actually means. */
async function selectionRows(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const dl = document.querySelector("#sel")!;
    const out: Record<string, string> = {};
    const children = [...dl.children];
    for (let i = 0; i < children.length; i += 2) {
      const term = children[i]?.textContent ?? "";
      out[term] = children[i + 1]?.textContent ?? "";
    }
    return out;
  });
}

test("the inspector shows an element's property set, read from the kernel", async ({ page }) => {
  /**
   * Wall-South carries `Pset_WallCommon` in the fixture, and it is there *because of this*.
   *
   * The pset-rendering path was code no test exercised: the fixture had no property sets, so the panel showed a
   * name and nothing else — and would have shown nothing else on a real model too, undetectably.
   */
  await ready(page);
  const guid = await selectFirst(page, "IFCWALL");
  expect(guid, "the fixture's first wall should be the one carrying the pset").toBe("OwCSTfxILZZaOeUwK4fcAk");

  // Asynchronous: the kernel is in a Worker, so the panel fills in a moment after the click.
  await expect(page.locator("#sel")).toContainText("Pset_WallCommon", { timeout: 20_000 });
  const rows = await selectionRows(page);

  expect(rows["Name"]).toBe("Wall-South");
  expect(rows["Pset_WallCommon"]).toContain("5 propert");
  expect(rows["· Reference"]).toBe("EW-01");
  expect(rows["· FireRating"]).toBe("EI60");

  /**
   * The two non-string values, which is why the fixture carries them.
   *
   * A boolean rendered as `true` and a wrapped measure rendered as `[object Object]` are both things a formatter
   * gets wrong silently, and a pset of nothing but strings would never reveal either.
   */
  expect(rows["· LoadBearing"]).toBe("yes");
  expect(rows["· ThermalTransmittance"]).toBe("0.28");
});

test("an element with no properties says so, rather than looking unloaded", async ({ page }) => {
  await ready(page);
  /**
   * The column has a name and no property sets, and the panel says so.
   *
   * Two different absences, deliberately worded differently: "no property sets" means the kernel answered and the
   * element has none, while "none recorded" means the element was *absent from the reply* — `properties()` omits
   * an element it could not answer for, precisely so a caller can tell those apart. Both beat silence, which reads
   * as "still loading" because that is the reading that suggests data might yet arrive.
   */
  await selectFirst(page, "IFCCOLUMN");
  await expect(page.locator("#sel")).toContainText("no property sets", { timeout: 20_000 });
});

test("clicking quickly between elements does not leave the wrong properties on screen", async ({ page }) => {
  /**
   * The race the `pending` guard exists for.
   *
   * Each selection starts a Worker round trip. Without the guard, a slow earlier reply overwrites a faster later
   * one and the panel shows the properties of an element the user is no longer looking at — with nothing on screen
   * to suggest it.
   */
  await ready(page);
  await selectFirst(page, "IFCWALL");
  await selectFirst(page, "IFCCOLUMN");
  await expect(page.locator("#sel")).toContainText("no property sets", { timeout: 20_000 });
  // The wall's pset must not have leaked onto the column.
  await expect(page.locator("#sel")).not.toContainText("Pset_WallCommon");
});
