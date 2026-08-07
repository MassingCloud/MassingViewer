/**
 * Post-deploy smoke test: does the *deployed* page render a building?
 *
 * Separate from the E2E suite on purpose. E2E runs against a local build; this runs against the real URL, over
 * the real network, with the real Content-Security-Policy applied as a meta tag on a host that cannot set
 * headers. Several things can only break here:
 *
 *   - a wrong `base` producing 404s on the hashed asset names
 *   - the CSP blocking WASM or a worker once it is actually enforced
 *   - Pages serving a stale deploy
 *   - anything that works from `localhost` and not from an origin
 *
 * massing's Pages demo has been live and broken for a long time — it fetches a model that does not exist, so it
 * shows no geometry, and nothing noticed because "deployed successfully" and "works" are different claims.
 * This job exists to make the second claim checkable.
 */

import { chromium } from "@playwright/test";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/smoke-deployed.mjs <url>");
  process.exit(1);
}

const problems = [];
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const cspViolations = [];

  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      const text = m.text();
      // A CSP refusal is reported as a console error, and it is the failure most likely to appear only here —
      // the meta-tag policy is enforced by the browser regardless of host, but a `connect-src` or
      // `wasm-unsafe-eval` mistake shows up the moment real code runs.
      if (/Content Security Policy|Refused to/i.test(text)) cspViolations.push(text);
      else consoleErrors.push(text);
    }
  });
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));

  console.log(`fetching ${url}`);
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  if (!response || !response.ok()) {
    problems.push(`page returned HTTP ${response?.status() ?? "no response"}`);
  }

  await page.waitForFunction(() => window.__massingviewer !== undefined, undefined, { timeout: 30_000 })
    .catch(() => problems.push("the app never finished initialising (no __massingviewer hook)"));

  if (problems.length === 0) {
    const state = await page.evaluate(() => {
      const mv = window.__massingviewer;
      const canvas = mv.viewport.renderer.domElement;
      return {
        elements: mv.elements.length,
        triangles: mv.triangles,
        withGuid: mv.elements.filter((e) => e.guid !== null).length,
        canvas: { w: canvas.width, h: canvas.height },
        sample: mv.sampleFramebuffer(24),
      };
    });

    console.log(`  elements   ${state.elements}`);
    console.log(`  triangles  ${state.triangles}`);
    console.log(`  GlobalIds  ${state.withGuid}/${state.elements}`);
    console.log(`  canvas     ${state.canvas.w}x${state.canvas.h}`);
    console.log(`  coverage   ${Math.round(state.sample.coverage * 100)}%`);

    // The fixture's known content, so this asserts the *right* building rendered rather than any building.
    if (state.elements !== 6) problems.push(`expected 6 elements, got ${state.elements}`);
    if (state.triangles !== 72) problems.push(`expected 72 triangles, got ${state.triangles}`);
    if (state.withGuid !== state.elements) {
      problems.push(`${state.elements - state.withGuid} element(s) have no GlobalId`);
    }
    // The zero-width-canvas failure, which is invisible from outside — the model parses perfectly into a
    // canvas nothing can be seen in.
    if (state.canvas.w < 64 || state.canvas.h < 64) {
      problems.push(`canvas is ${state.canvas.w}x${state.canvas.h} — too small to have rendered anything`);
    }
    // A range, not "> 0": zero means nothing drew, ~100% means the camera is inside a wall.
    if (state.sample.coverage < 0.05) problems.push(`only ${Math.round(state.sample.coverage * 100)}% coverage — nothing drew`);
    if (state.sample.coverage > 0.95) problems.push(`${Math.round(state.sample.coverage * 100)}% coverage — the camera is probably inside geometry`);
  }

  if (cspViolations.length > 0) {
    problems.push(`Content-Security-Policy blocked ${cspViolations.length} thing(s):\n    ${cspViolations.slice(0, 5).join("\n    ")}`);
  }
  if (failedRequests.length > 0) {
    problems.push(`${failedRequests.length} request(s) failed:\n    ${failedRequests.slice(0, 5).join("\n    ")}`);
  }
  if (consoleErrors.length > 0) {
    problems.push(`${consoleErrors.length} console error(s):\n    ${consoleErrors.slice(0, 5).join("\n    ")}`);
  }
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\nDeployed smoke test FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\n  The deploy itself may have succeeded. "Deployed" and "works" are different claims, and this job\n` +
      `  checks the second one — see the note at the top of this file.\n`,
  );
  process.exit(1);
}

console.log(`\nDeployed smoke test passed: ${url} renders the sample building.`);
