/**
 * Can this host obtain a **software** WebGPU adapter? Report, never assert.
 *
 * ADR-0012 named one blocker for shipping the WebGPU renderer: the visual-regression gate's determinism rests on
 * `--use-angle=swiftshader`, which is an ANGLE/**WebGL** path. WebGPU needs a Dawn/Vulkan adapter, and a CI runner
 * has no GPU. So either a software adapter is obtainable on the runner or the visual gate cannot cover WebGPU at
 * all — and that is a question about the runner, not an opinion.
 *
 * This script exists because the question was **unanswerable on the development host**, and the reason is worth
 * recording rather than rediscovering:
 *
 * - Playwright's default headless browser is `chromium_headless_shell`, which does not expose `navigator.gpu` at
 *   all. Measured: `navigator.gpu` was `undefined` under four different flag combinations, including the visual
 *   gate's own.
 * - `channel: "chromium"` — the full build, which does expose it — fails to launch on that host with
 *   `spawn UNKNOWN`, the same Windows side-by-side fault that stops Firefox there. See `scripts/e2e.mjs`.
 *
 * So it runs in `nightly.yml` on `ubuntu-latest`, where the answer actually matters, and prints what it finds.
 *
 * ## Why it reports instead of failing
 *
 * A probe that fails the build would make "WebGPU is unavailable on a CPU runner" — which is the *expected*
 * starting state — look like a regression. What is wanted is the adapter string, so a decision can be made from
 * it. When a software adapter is confirmed, the visual gate grows a WebGPU project and *that* becomes the gate.
 *
 * ## What it takes, and why the flags are what they are
 *
 * `--use-webgpu-adapter=swiftshader` asks Dawn for the software backend explicitly. `--enable-unsafe-webgpu`
 * disables the adapter blocklist, without which a CPU adapter is refused. `--enable-unsafe-swiftshader` silences
 * the warning banner. And the part that is easy to miss: **SwiftShader's Vulkan path needs the system Vulkan
 * loader and a Mesa ICD present**, or `requestAdapter()` returns null regardless of flags —
 * `npx playwright install --with-deps` does not install those, so the workflow installs them.
 */

import { chromium } from "@playwright/test";

/** Flag sets, cheapest first, so the output shows the *minimum* that works rather than only that something does. */
const ATTEMPTS = [
  { label: "headless shell, no flags", channel: undefined, args: [] },
  { label: "full chromium, no flags", channel: "chromium", args: [] },
  {
    label: "full chromium, swiftshader adapter",
    channel: "chromium",
    args: ["--use-webgpu-adapter=swiftshader", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader"],
  },
  {
    label: "full chromium, swiftshader adapter + Vulkan features",
    channel: "chromium",
    args: [
      "--use-webgpu-adapter=swiftshader",
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--enable-features=Vulkan",
    ],
  },
];

const results = [];

for (const attempt of ATTEMPTS) {
  let browser;
  try {
    browser = await chromium.launch({
      ...(attempt.channel === undefined ? {} : { channel: attempt.channel }),
      args: attempt.args,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    results.push({ ...attempt, outcome: `browser would not launch: ${why}` });
    continue;
  }

  try {
    const page = await browser.newPage();
    const found = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      if (gpu === undefined) return { exposed: false };
      try {
        const adapter = await gpu.requestAdapter();
        if (adapter === null) return { exposed: true, adapter: null };
        return {
          exposed: true,
          vendor: adapter.info?.vendor ?? "(none)",
          architecture: adapter.info?.architecture ?? "(none)",
          description: adapter.info?.description ?? "(none)",
        };
      } catch (error) {
        return { exposed: true, error: String(error).slice(0, 120) };
      }
    });
    results.push({ ...attempt, outcome: JSON.stringify(found) });
  } finally {
    await browser.close();
  }
}

console.log("WebGPU software-adapter probe — see ADR-0012. Reports; never fails the build.\n");
for (const r of results) console.log(`  ${r.label.padEnd(46)} ${r.outcome}`);

const usable = results.find((r) => r.outcome.includes('"vendor"'));
console.log(
  usable === undefined
    ? `\n  No software WebGPU adapter on this runner. The visual gate therefore cannot cover the WebGPU renderer,\n` +
        `  and ADR-0012's blocker stands. Do not add a WebGPU visual project on the strength of hope.`
    : `\n  A software adapter IS available — first working set: "${usable.label}".\n` +
        `  ADR-0012's blocker is resolvable: add a WebGPU visual project using those flags, baseline it, and key\n` +
        `  the baselines by adapter description so a runner-image change fails loudly rather than silently.`,
);
