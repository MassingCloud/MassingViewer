import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * ## The browser matrix is a product decision, not a default
 *
 * `webkit` is a **required** check, not a nightly afterthought. Safari and iPad support is a stated
 * differentiator — the nearest browser-BIM competitor is Chrome/Edge only, and field teams are on iPads — so a
 * WebKit regression has to fail the PR that caused it, not be discovered a week later by someone else.
 *
 * `iPad Pro 11` runs emulated per-PR for layout and touch. Emulated WebKit does **not** reproduce real iOS
 * memory pressure or WASM limits, which is precisely where an iPad fails on a large model, so this catches
 * layout and interaction regressions only — not the thing that will actually break. A real-device run belongs
 * on a weekly schedule against actual iPadOS.
 */
export default defineConfig({
  testDir: "e2e",
  // Both of these belong to one project each, so every other project is told to skip them.
  //
  // `react-shell` needs a different baseURL — running it against the demo's port would load the wrong app and
  // fail for a reason that has nothing to do with the test.
  //
  // `a11y` is Chromium-only *by choice*, not by omission. axe evaluates the DOM, and the DOM is the same in every
  // browser, so three extra legs would re-assert the same thing at four times the cost. The one class of rule
  // that genuinely differs is contrast, which axe computes from rendered styles — and cross-browser
  // antialiasing differences there produce disagreements about the renderer rather than about the markup. That
  // is the definition of a flaky gate, and `docs/testing.md` is explicit that one gate people trust beats ten
  // they route around. Layout and touch differences across browsers are covered by the other four projects.
  testIgnore: [/react-shell\.spec\.ts/, /a11y\.spec\.ts/],

  // NOT parallel, and this is not a workaround for flakiness — it is recognising what the tests contend for.
  //
  // Every test rasterises WebGL in software (SwiftShader, for determinism — see the launch args below), so they
  // are CPU-bound on the same scarce resource. Running them in parallel makes each one slower *and* trips the
  // adaptive pixel-ratio governor, which legitimately drops resolution when frame times rise. The canvas then
  // changes size mid-test and pick coordinates shift under the assertions.
  //
  // Observed directly: the click test failed in a parallel run and passed in isolation. Parallelism was
  // actively making the suite wrong, not merely slow.
  fullyParallel: false,
  workers: 1,

  /**
   * 60 s per test, up from the 30 s default.
   *
   * Not a cover for slowness — every test finishes in one to three seconds. It is headroom for **contention on one
   * machine**, and the measurement is what makes that the diagnosis rather than a guess: running all four projects
   * locally, one webkit test times out per run and it is a *different* test each time — "authoring makes no network
   * requests" on one run, "exports BCF 3.0" on the next. Each passes three times out of three in isolation, and
   * each project passes 32/32 on its own.
   *
   * The cause is the reason `workers: 1` is already set: every test rasterises WebGL in software, so they compete
   * for one scarce resource, and a fourth project raised the total load. CI does not have this problem at all —
   * `e2e.yml` runs each project as a separate job on its own runner — so the ceiling exists for the local
   * all-projects run, which is the only place four browsers share a CPU.
   */
  timeout: 60_000,
  // No `.only` reaching main. It silently reduces the suite to one test while still reporting green.
  forbidOnly: !!process.env.CI,
  // One retry in CI, none locally. A test that needs two retries is flaky and should be fixed or moved to
  // nightly — retries are for genuine infrastructure noise, not for hiding a race.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"]],

  use: {
    // A literal address, never `localhost` — see the note in scripts/e2e-server.mjs. `localhost` resolved to
    // ::1 for the browser and 127.0.0.1 for the readiness probe, and the run took 6.5 minutes instead of 16
    // seconds because of it.
    baseURL: "http://127.0.0.1:4173",
    // All three are first-retry-only, and video especially.
    //
    // `retain-on-failure` sounds free and is not: Playwright *records* a video for every test and deletes it
    // afterwards if the test passed. Each recording is an ffmpeg child process consuming frames from a browser
    // that is already rasterising WebGL in software, so it competes for the exact resource the whole suite is
    // bottlenecked on. Measured here: the twelve tests take ten seconds of test time and the run took 6.5
    // minutes wall-clock with recording on.
    //
    // CI runs with `retries: 1`, so a real failure still produces a trace, a video and a screenshot on its
    // second attempt. Nothing diagnostic is lost; only the cost of capturing evidence for the 99% of runs that
    // are green.
    trace: "on-first-retry",
    video: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // SwiftShader: a software rasteriser, so WebGL produces identical bytes on any host. Without it
            // the renderer differs between a developer's GPU and a CI runner, and any pixel assertion becomes
            // luck. See docs/testing.md.
            "--use-gl=angle",
            "--use-angle=swiftshader",
            // Required as of recent Chromium: software WebGL is otherwise refused with a deprecation warning
            // and falls back, which defeats the point of pinning the rasteriser for determinism.
            "--enable-unsafe-swiftshader",
            "--force-device-scale-factor=1",
            "--disable-lcd-text",
            "--force-color-profile=srgb",
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Headed under a virtual display when E2E_HEADED is set. Two rounds of `webgl.*` prefs and software
        // WebRender both left the diagnostic reporting "WebGL: UNAVAILABLE", because the missing piece is not
        // permission or a backend — it is a GL *surface*. Headless Firefox on Linux has no drawable, so there is
        // nothing for a context to attach to. Xvfb provides one, and this is the mechanism rather than a third
        // guess at a preference.
        headless: process.env.E2E_HEADED !== "1",
        launchOptions: {
          // Headless Firefox on a GPU-less CI runner refuses WebGL by default, and the symptom is not an error
          // — the renderer simply fails to construct, the app never finishes initialising, and every test times
          // out saying nothing. These three prefs are what make it fall back to software rendering.
          //
          // Unlike the Chromium project this does *not* pin a specific rasteriser, so Firefox is a functional
          // check only. Pixel comparisons across browsers are explicitly not attempted — see docs/testing.md.
          firefoxUserPrefs: {
            "webgl.force-enabled": true,
            "webgl.disabled": false,
            "webgl.disable-fail-if-major-performance-caveat": true,
            // Firefox draws through WebRender, and on a runner with no GPU the hardware path fails and takes
            // WebGL with it. Forcing WebRender's software backend is the other half of the fix; the prefs above
            // alone were not enough, which the diagnostic in e2e/global-setup reported as
            // "WebGL: UNAVAILABLE" rather than as a timeout.
            "gfx.webrender.software": true,
            "gfx.webrender.all": true,
          },
          env: {
            // `launchOptions.env` **replaces** the browser's environment, it does not extend it. Setting only
            // the two variables below launched Firefox with no `DISPLAY`, so running under Xvfb failed with
            // "no DISPLAY environment variable specified" — a bug introduced by the fix for the previous bug.
            // Spreading the parent environment is what makes it additive.
            ...process.env,
            // Mesa must fall back to llvmpipe, or the software WebRender path still asks for a GL context the
            // runner cannot provide.
            LIBGL_ALWAYS_SOFTWARE: "1",
            MOZ_ENABLE_WAYLAND: "0",
          },
        },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      name: "ipad",
      use: { ...devices["iPad Pro 11"] },
    },
    {
      /**
       * WCAG 2.2 AA, gated at `serious` and above. See `e2e/a11y.spec.ts` for what it scans and why the gate
       * sits where it does, and `docs/accessibility.md` for what it honestly cannot cover.
       *
       * A separate project so the leg's name in CI says `a11y` rather than being buried inside `chromium`. When
       * this fails, the failure is about markup, and a reader should not have to guess which of thirty-odd
       * Chromium tests it was.
       */
      name: "a11y",
      testIgnore: [],
      testMatch: /a11y\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            // Pinned so contrast is computed against a known rasterisation rather than the runner's default.
            "--force-device-scale-factor=1",
            "--force-color-profile=srgb",
          ],
        },
      },
    },
    {
      /**
       * The React shell, on its own port.
       *
       * A separate project rather than more tests in the existing ones, because it has a different `baseURL` and
       * `testMatch`. Its whole job is to test the claim ADR-0009 rests on: `apps/demo` mounts `createRibbon` from
       * plain TypeScript, this mounts it through React, and both must produce the same controls from the same
       * package. Asserted across two hosts, because within one host it is not a claim about anything.
       */
      name: "shell",
      // Project options override the top-level ones, so the empty `testIgnore` is what lets this project see the
      // file every other project is told to skip. Without it the top-level ignore would apply here too and the
      // project would silently run zero tests — a green result that proves nothing, which is worse than a failure.
      testIgnore: [],
      testMatch: /react-shell\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4174",
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--force-device-scale-factor=1",
          ],
        },
      },
    },
  ],

  /**
   * No `webServer` block, on purpose — the lifecycle lives in `scripts/e2e.mjs`, so run the suite with
   * `npm run e2e`.
   *
   * Playwright's own webServer management does not terminate on this platform. Measured with
   * `DEBUG=pw:webserver`: server ready in 2 s, one test ran in 3 s, `Terminating the WebServer` logged, then
   * nothing until killed 200 s later. The twelve-test suite reported "12 passed (6.5m)" for ten seconds of
   * real test time. It reproduces with a five-line bare `node:http` server — no vite, no build, no signal
   * handlers — so it is not the grandchild process, the in-process preview, or video recording, all of which
   * were tried first.
   *
   * Hoping CI behaves differently is not an option worth taking: a hung job burns to the six-hour ceiling and
   * reports nothing, which is worse than a failure. `e2e/global-setup.ts` turns "no server" into one clear
   * message instead of twelve connection-refused failures.
   */
  globalSetup: "./e2e/global-setup.ts",
});
