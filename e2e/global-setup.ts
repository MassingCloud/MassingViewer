/**
 * Assert a server is listening before any test runs.
 *
 * This config deliberately has **no `webServer` block** — see the long note in `scripts/e2e.mjs` for the
 * measurements behind that. Short version: Playwright's own webServer management does not terminate on this
 * platform, turning a 16-second suite into 5 minutes plus an indefinite hang, and it does so even for a
 * five-line bare `node:http` server. The lifecycle lives in `scripts/e2e.mjs` instead.
 *
 * The cost of that choice is a worse failure mode for anyone who runs `npx playwright test` directly: twelve
 * tests would fail on `net::ERR_CONNECTION_REFUSED`, which says nothing about the actual mistake. This turns
 * that into one message naming the command to use.
 *
 * It lives in global setup rather than at config load so that `playwright show-report` and friends — which
 * load the config but start nothing — are unaffected.
 */

// Same `E2E_PORT` as the server and the config. All three read it, or the escape hatch only half works.
const URL_ = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/`;

export default async function globalSetup(): Promise<void> {
  try {
    const response = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (cause) {
    throw new Error(
      `Nothing is serving ${URL_} (${cause instanceof Error ? cause.message : String(cause)}).\n\n` +
        `This suite does not start its own server. Run it with:\n\n` +
        `    npm run e2e                      # every project\n` +
        `    npm run e2e -- --project=webkit  # one project\n\n` +
        `Those build the demo, serve it, run the tests and stop the server. For repeated runs against one ` +
        `long-lived server, start "node scripts/e2e-server.mjs" yourself and then "npx playwright test" ` +
        `works directly.`,
      { cause },
    );
  }
}
