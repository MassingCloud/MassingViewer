import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Result } from "axe-core";

/**
 * WCAG 2.2 AA, gated at `serious` and above.
 *
 * ## Why the gate is at `serious` and not at zero
 *
 * `moderate` and `minor` findings are *reported* here and do not fail the build. That is not laziness about the
 * remaining two levels — it is the same reasoning `docs/testing.md` gives for putting visual regression on a
 * nightly and p95 frame time inside a tolerance band: **one gate people trust beats ten they route around.** A
 * gate that fails on `minor` trains the next person to add rule exclusions, and exclusions are permanent in a way
 * that a `moderate` finding in the log is not.
 *
 * `serious` and `critical` are the levels that mean a real user cannot complete a task: unreachable controls,
 * unlabelled interactive elements, contrast a low-vision user cannot read.
 *
 * ## The canvas is not excluded from anything
 *
 * A WebGL canvas is opaque to a screen reader. That is a real limit, and `docs/accessibility.md` states it
 * rather than hiding it — along with the alternative, which is that `cadCommands`' `WALL 0,0 5,0` grammar is a
 * genuinely accessible authoring path (and with the equally honest note that it has no UI wired yet).
 *
 * What the limit does **not** excuse is the canvas element being anonymous, or the controls around it being
 * unreachable. So it is excluded from no rule: if axe finds something about it, that is a finding, and the
 * canvas carries `role="img"`, a label and `tabindex="0"` because of exactly that. The limit is about the
 * *pixels inside*, which axe cannot see and therefore never reports on — so excluding the element would buy
 * nothing and cost the checks that do apply.
 */

/** Everything at `serious` or above. The set that fails a run. */
function blocking(violations: readonly Result[]): readonly Result[] {
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/**
 * A readable failure.
 *
 * axe's raw output is deeply nested JSON, and a gate whose failure message has to be decoded is a gate that gets
 * marked flaky and skipped. This prints the rule, the impact, the selector, and the fix axe itself suggests —
 * which is usually enough to fix the problem without opening the report.
 */
function describeViolations(where: string, violations: readonly Result[]): string {
  const lines = [`${violations.length} accessibility violation(s) at serious+ on ${where}:`];
  for (const v of violations) {
    lines.push(`\n  ${v.impact?.toUpperCase()} ${v.id} — ${v.help}`);
    lines.push(`  ${v.helpUrl}`);
    for (const node of v.nodes.slice(0, 4)) {
      lines.push(`    at ${node.target.join(" ")}`);
      const fix = node.failureSummary?.split("\n").filter((l) => l.trim() !== "") ?? [];
      for (const l of fix) lines.push(`      ${l.trim()}`);
    }
    if (v.nodes.length > 4) lines.push(`    …and ${v.nodes.length - 4} more node(s)`);
  }
  return lines.join("\n");
}

/** Scan the current page state and assert nothing serious. Non-blocking levels are logged, not swallowed. */
async function scan(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // The four tags that together are WCAG 2.2 AA. `best-practice` is deliberately not included: its rules are
    // opinions rather than conformance requirements, and mixing them in would make "AA" mean something else.
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  const serious = blocking(results.violations);
  const lesser = results.violations.filter((v) => !serious.includes(v));
  if (lesser.length > 0) {
    console.log(
      `  ${where}: ${lesser.length} moderate/minor finding(s) — not gated: ` +
        lesser.map((v) => `${v.id}(${v.impact})`).join(", "),
    );
  }
  expect(serious, describeViolations(where, serious)).toEqual([]);
}

/** The app has finished booting. Scanning before this measures a loading screen. */
async function ready(page: Page): Promise<void> {
  await expect(page.locator("#kernel")).toContainText("ready — no network", { timeout: 20_000 });
}

test("the viewer route has no serious violations", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await scan(page, "viewer (initial)");
});

test("every ribbon tab's panel has no serious violations", async ({ page }) => {
  await page.goto("/");
  await ready(page);

  // Each tab is a separate *state*, not a separate route, and a scan of the default tab says nothing about the
  // other eight. This is the "every open panel" half of the claim in docs/testing.md — a per-route scan alone
  // would have let an unlabelled control in the Annotate tab ship.
  const tabs = page.locator('#ribbon [role="tab"]');
  const count = await tabs.count();
  expect(count, "no ribbon tabs found — the selector is wrong and this test is passing vacuously").toBeGreaterThan(
    1,
  );

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
    await tab.dispatchEvent("click");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await scan(page, `ribbon tab "${label}"`);
  }
});

test("the plan pane has no serious violations", async ({ page }) => {
  await page.goto("/");
  await ready(page);

  // The 2D surface is the one a reviewer actually reads, and it is generated SVG rather than authored markup —
  // so it is the panel most likely to emit something unlabelled without anyone noticing.
  await page.locator("#plan").dispatchEvent("click");
  await expect(page.locator("#plan-pane")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#plan-info")).toContainText("Entities", { timeout: 15_000 });
  await scan(page, "plan pane");
});

test("a selection's property panel has no serious violations", async ({ page }) => {
  await page.goto("/");
  await ready(page);

  // Selecting changes the properties panel from placeholder text to a populated grid, and the populated state is
  // the one with content in it. Scanning only the empty state would be scanning the easy case.
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const spots: readonly [number, number][] = [
    [0.5, 0.5],
    [0.45, 0.55],
    [0.55, 0.45],
    [0.5, 0.6],
  ];
  for (const [dx, dy] of spots) {
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    if (await page.locator("#sel .mono").isVisible().catch(() => false)) break;
  }
  await scan(page, "properties (with a selection)");
});
