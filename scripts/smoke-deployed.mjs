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

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/smoke-deployed.mjs <base-url>");
  process.exit(1);
}

/**
 * Two surfaces, because the site is two things.
 *
 * The argument is the *base*: documentation at the root, the demo under `/demo/`. Checking only the demo would have
 * been the easy change when the docs landed on top of it, and it would have left the landing page — the first thing
 * anyone sees — completely unverified. A trailing slash is forced because `new URL("demo/", ".../MassingViewer")`
 * resolves to `.../demo/` **without** the repository segment, which would 404 on Pages and read as a broken deploy.
 */
const docsUrl = base.endsWith("/") ? base : `${base}/`;
const demoUrl = new URL("demo/", docsUrl).href;

const problems = [];
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  // --- the documentation, on its own page so its console errors are not attributed to the demo -----------------
  const docs = await browser.newPage();
  console.log(`fetching ${docsUrl}`);
  const docsResponse = await docs.goto(docsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!docsResponse || !docsResponse.ok()) {
    problems.push(`the documentation returned HTTP ${docsResponse?.status() ?? "no response"}`);
  } else {
    const state = await docs.evaluate(() => ({
      title: document.title,
      navLinks: document.querySelectorAll("nav a").length,
      // The demo link is the one thing on this page that has to work, because it is the only route to the app.
      demoHref: document.querySelector('a[href$="demo/"]')?.getAttribute("href") ?? null,
      headings: document.querySelectorAll("main h1, main h2").length,
      // Zero, by construction: these pages are static HTML with one inline stylesheet. Asserted here as well as
      // in the workflow, because the workflow checks the artifact and this checks what the origin actually serves.
      subresources: document.querySelectorAll("script, link[rel=stylesheet], img[src^='http']").length,
    }));
    console.log(`  nav links  ${state.navLinks}`);
    console.log(`  headings   ${state.headings}`);
    if (state.navLinks < 20) problems.push(`documentation nav has only ${state.navLinks} links — pages are missing`);
    if (state.headings === 0) problems.push("the documentation landing page rendered no headings");
    if (state.demoHref === null) problems.push("the documentation landing page has no link to the demo");
    if (state.subresources > 0) {
      problems.push(`the documentation page loaded ${state.subresources} subresource(s); it must be self-contained`);
    }
  }
  await docs.close();

  // --- the demo ------------------------------------------------------------------------------------------------
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

  console.log(`fetching ${demoUrl}`);
  const response = await page.goto(demoUrl, { waitUntil: "networkidle", timeout: 60_000 });
  if (!response || !response.ok()) {
    problems.push(`the demo returned HTTP ${response?.status() ?? "no response"}`);
  }

  await page.waitForFunction(() => window.__massingviewer !== undefined, undefined, { timeout: 30_000 })
    .catch(() => problems.push("the app never finished initialising (no __massingviewer hook)"));

  if (problems.length === 0) {
    const state = await page.evaluate(() => {
      const mv = window.__massingviewer;
      const canvas = mv.viewport.renderer.domElement;
      return {
        meshes: mv.elements.length,
        triangles: mv.triangles,
        withGuid: mv.elements.filter((e) => e.guid !== null).length,
        // Distinct IFC products, not meshes — see the assertion below for why that distinction is the whole point.
        distinct: new Set(mv.elements.map((e) => e.guid).filter((g) => g !== null)).size,
        canvas: { w: canvas.width, h: canvas.height },
        sample: mv.sampleFramebuffer(24),
      };
    });

    console.log(`  meshes     ${state.meshes}`);
    console.log(`  elements   ${state.distinct} distinct GlobalId(s)`);
    console.log(`  triangles  ${state.triangles}`);
    console.log(`  GlobalIds  ${state.withGuid}/${state.meshes} meshes carry one`);
    console.log(`  canvas     ${state.canvas.w}x${state.canvas.h}`);
    console.log(`  coverage   ${Math.round(state.sample.coverage * 100)}%`);

    /**
     * The fixture's product count, which is what makes this "the right building" rather than "a building".
     *
     * **Six distinct GlobalIds, not six meshes**, and the difference is a bug this file already shipped. It used to
     * assert `elements === 6` and `triangles === 72` against `mv.elements`, which is the *mesh* list. When door and
     * window openings landed, each pierced wall started tessellating as several bands — 6 meshes became 11 and 72
     * triangles became 132 — so both assertions failed, on a deploy-only job, describing a regression that had not
     * happened. The same hardcoded-total mistake this repository has now made four times, and always with the same
     * signature: the failure message asserts the opposite of what changed.
     *
     * Distinct GlobalIds is the number that survives a tessellation change, because it counts what is in the model
     * rather than how it was drawn. It moves only when the fixture gains or loses a product, which is a deliberate
     * act — and `fixtures/sample.test.ts` and the golden suite own the exact geometry, per PR, where a break is
     * cheap. This job's unique claim is narrower: *the deployed origin serves the same model the local build does.*
     */
    if (state.distinct !== 6) problems.push(`expected 6 distinct GlobalIds, got ${state.distinct}`);
    // Not an exact figure: triangle count is a tessellation detail and the golden suite is where it is pinned.
    if (state.triangles < 1) problems.push("no triangles were built");
    if (state.meshes < state.distinct) {
      problems.push(`${state.meshes} meshes for ${state.distinct} elements — something did not tessellate`);
    }
    if (state.withGuid !== state.meshes) {
      problems.push(`${state.meshes - state.withGuid} mesh(es) have no GlobalId`);
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

console.log(
  `\nDeployed smoke test passed: ${docsUrl} serves the documentation, and ${demoUrl} renders the sample building.`,
);
