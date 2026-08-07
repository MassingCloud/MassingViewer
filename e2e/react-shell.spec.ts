import { expect, test, type Page } from "@playwright/test";

/**
 * The React shell, and the claim ADR-0009 rests on.
 *
 * > *A vanilla renderer works in every host. A React renderer works in one.*
 *
 * `apps/demo` mounts `createRibbon` directly from plain TypeScript — which is the shape massing's shell is. This
 * app mounts the same function through a React component. If the two disagree about what the ribbon contains, the
 * argument for keeping the ribbon out of React collapses, and M9 means putting React into massing.
 *
 * So the interesting assertions here are **comparisons between two hosts**, not facts about one. A test that only
 * looked at this app could pass while the demo rendered something else entirely.
 */

/** Read the ribbon's contents in whichever app the page is currently on. */
async function ribbonShape(page: Page) {
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#ribbon [role="tab"]')].map((t) => t.textContent),
    tools: [...document.querySelectorAll("#ribbon button[data-tool]")].map((b) => b.getAttribute("data-tool")).sort(),
    tabStrips: document.querySelectorAll("#ribbon .mv-ribbon-tabs").length,
    liveRegions: document.querySelectorAll("#ribbon .mv-ribbon-live").length,
    visiblePanels: [...document.querySelectorAll("#ribbon .mv-ribbon-panel")].filter(
      (p) => p.getBoundingClientRect().height > 0,
    ).length,
  }));
}

test("renders the same ribbon as the vanilla demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  const react = await ribbonShape(page);

  // The other host, in the same browser at the same viewport size — so the collapse algorithm sees identical
  // inputs and any difference is the renderer rather than the window.
  await page.goto("http://127.0.0.1:4173/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  const vanilla = await ribbonShape(page);

  expect(react.tabs).toEqual(vanilla.tabs);
  // Sorted ids, so this asserts *which* controls exist rather than what order they came out in.
  expect(react.tools).toEqual(vanilla.tools);
  expect(react.tools.length).toBe(31);
});

test("mounts exactly one ribbon under StrictMode", async ({ page }) => {
  // StrictMode is on in development, and it mounts, unmounts and mounts again. An effect that creates an
  // imperative widget without disposing it on cleanup renders two — and the second holds the listeners while the
  // first sits there catching clicks nobody handles.
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  const shape = await ribbonShape(page);
  expect(shape.tabStrips).toBe(1);
  // Two polite live regions means every announcement is read twice.
  expect(shape.liveRegions).toBe(1);
  // And the `[hidden]`-versus-author-`display` bug, measured rather than asserted on an attribute.
  expect(shape.visiblePanels).toBe(1);
});

test("keeps one WebGL context across StrictMode's double mount", async ({ page }) => {
  // Browsers cap live WebGL contexts and silently drop the oldest, so a viewport that leaks on remount makes the
  // *first* one go black — with nothing in the console to say why.
  await page.goto("/");
  await expect(page.locator("#viewport canvas")).toBeVisible({ timeout: 20_000 });
  expect(await page.locator("canvas").count()).toBe(1);
});

test("opens the palette on Ctrl+K, keeping focus in the input", async ({ page }) => {
  // The assertion that decides whether a screen-reader user can use this at all: the highlight moves via
  // `aria-activedescendant` while focus stays in the combobox. Moving focus to the option is the obvious
  // implementation, and it breaks typing entirely.
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();

  const first = await input.getAttribute("aria-activedescendant");
  expect(first).not.toBeNull();
  // It must point at something that exists — a dangling id is announced as nothing at all, which is
  // indistinguishable from the widget being broken.
  await expect(page.locator(`[id="${first}"]`)).toHaveAttribute("role", "option");

  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);

  await input.press("Escape");
  await expect(page.getByRole("combobox")).toHaveCount(0);
});

test("ranks a fuzzy acronym the way a person means it", async ({ page }) => {
  // `sp` must find "Section plane", not something with a mid-word s-p. Ranking is the whole user experience of a
  // palette: every candidate matching is the same as none matching if the right one is fortieth.
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("sp");
  await expect(page.getByRole("option").first()).toContainText("Section plane");
});

test("runs a plugin command from its manifest-declared chord", async ({ page }) => {
  // Same plugin, same manifest, second host. Keybindings are data here rather than a switch statement — which is
  // what massing's `handleKey` is, and what a plugin cannot extend.
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  await page.locator("#viewport").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Shift+M");
  await expect(page.locator("#status")).toContainText("footprint", { timeout: 10_000 });
});

test("resizes a docked panel from the keyboard", async ({ page }) => {
  // A drag handle that only responds to a pointer is a control a keyboard user cannot operate. `role="separator"`
  // with `aria-valuenow` is what makes it both discoverable and testable.
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });

  const handle = page.getByRole("separator", { name: "Resize Properties" });
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.press("ArrowLeft");
  expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
});

test("keeps a collapsed panel's content mounted", async ({ page }) => {
  // Unmounting would throw away scroll position, expanded property sets and any in-progress edit — so collapsing
  // a panel would silently discard work.
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Project" });
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Present in the DOM and not rendering — the `[hidden]` rule that beats the author `display`.
  const body = page.locator(".mv-dock-body", { hasText: "Tower-A" });
  await expect(body).toHaveCount(1);
  await expect(body).toBeHidden();
});

test("does not scroll horizontally at a phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/");
  await expect(page.locator("#ribbon .mv-ribbon-tabs")).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow, "the page must not scroll sideways").toBe(false);
  // And every tool is still reachable, because groups collapse rather than dropping verbs.
  expect(await page.locator("#ribbon button[data-tool]").count()).toBe(31);
});
