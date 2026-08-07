/**
 * Run the E2E suite: start the server, wait for it, run Playwright, stop the server.
 *
 * ## Why this exists instead of Playwright's `webServer`
 *
 * Playwright's built-in `webServer` works and then does not exit. Measured on this Windows host, with
 * `DEBUG=pw:webserver` confirming each phase:
 *
 *   - server ready in 2 s
 *   - one test ran in 3 s
 *   - `Terminating the WebServer` logged — and then nothing, until killed 200 s later
 *
 * The suite reported "12 passed (6.5m)" for ten seconds of actual test time. It was isolated to Playwright's
 * teardown rather than anything in this repo by swapping the command for a **five-line bare `node:http` server**
 * with no vite, no build, and no signal handlers: that hangs identically. So it is not the vite grandchild, not
 * the in-process preview, not the signal handling, and not video recording — all of which were tried first.
 *
 * That leaves two options: hope it behaves differently on the CI runner, or stop depending on it. Hoping is not
 * available here — a hung CI job burns to the six-hour ceiling and reports *nothing*, which is worse than a
 * failure, because a failure tells you something. So this script owns the lifecycle:
 *
 *   1. spawn the server as a direct child (no shell, no npm, so no orphaned grandchild)
 *   2. poll until it answers, or fail loudly with its output
 *   3. run Playwright, which has no `webServer` block and so neither starts nor stops anything
 *   4. kill the server and exit with Playwright's code
 *
 * Same path locally and in CI, and the run went from 4.9 minutes-then-hang to about 16 seconds.
 *
 * Arguments are forwarded, so `npm run e2e -- --project=webkit --grep Escape` works as expected.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.E2E_PORT ?? 4173);
const URL_ = `http://127.0.0.1:${PORT}/`;
const READY_TIMEOUT_MS = 180_000;

/**
 * Preflight: refuse to start if something already holds the port, and say what to do about it.
 *
 * `stopServer` below is supposed to make this impossible, and the comment there says so. It happened anyway —
 * a hard kill of this script (a `timeout` wrapper, a closed terminal, SIGKILL) never runs an `exit` handler, so
 * the child outlives it and holds 4173. What arrived at the next run was vite's `Port 4173 is already in use`,
 * which is true, unhelpful, and points at the wrong run.
 *
 * The lesson generalises past this file: a cleanup handler is a best effort, not a guarantee, so anything that
 * depends on cleanup having happened needs to detect the case where it did not.
 */
async function portIsHeld(port = PORT) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (error) {
    // A refused connection is the expected, healthy answer. A timeout means something is listening but wedged,
    // which still blocks strictPort — so that counts as held too.
    return error instanceof Error && error.name === "TimeoutError";
  }
}

const heldPort = (await portIsHeld(PORT)) ? PORT : (await portIsHeld(PORT + 1)) ? PORT + 1 : null;
if (heldPort !== null) {
  console.error(
    `e2e: something is already serving http://127.0.0.1:${heldPort}/ — almost certainly an orphaned\n` +
      `     e2e-server from a run that was killed rather than stopped. Running against it would test a stale\n` +
      `     build, so this stops instead. To clear it:\n\n` +
      `       PowerShell:  Get-NetTCPConnection -LocalPort ${heldPort} -State Listen | ` +
      `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
      `       POSIX:       kill $(lsof -ti tcp:${heldPort})\n\n` +
      `     Or point this run somewhere else with E2E_PORT.`,
  );
  process.exit(1);
}

const serverOutput = [];
const server = spawn(process.execPath, ["scripts/e2e-server.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, E2E_PORT: String(PORT) },
});
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverOutput.push(chunk);
    process.stderr.write(`[server] ${chunk}`);
  });
}

let serverExit = null;
server.on("exit", (code, signal) => {
  serverExit = signal ?? code;
});

const stopServer = () => {
  if (serverExit === null && server.pid !== undefined) server.kill();
};
// If this script dies for any reason, the server must not outlive it and hold the port — that would make the
// *next* run fail on strictPort, which is a confusing way to be told about a crash that already happened.
process.on("exit", stopServer);
process.on("SIGINT", () => {
  stopServer();
  process.exit(130);
});

/**
 * Both apps have to answer, not just the first.
 *
 * Waiting only for the demo would start Playwright while the shell was still building, and the `shell` project's
 * first navigation would fail with a connection refused — a failure that reads as a broken test rather than as a
 * race in the harness.
 */
const URLS = [URL_, `http://127.0.0.1:${PORT + 1}/`];

async function answers() {
  for (const url of URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const deadline = Date.now() + READY_TIMEOUT_MS;
let ready = false;
while (Date.now() < deadline) {
  if (serverExit !== null) break;
  if (await answers()) {
    ready = true;
    break;
  }
  await sleep(200);
}

if (!ready) {
  const why =
    serverExit !== null
      ? `it exited with ${serverExit}`
      : `it did not answer ${URL_} within ${READY_TIMEOUT_MS / 1000}s`;
  console.error(`\ne2e: the server never became available — ${why}.\n`);
  if (serverOutput.length > 0) console.error(serverOutput.join(""));
  process.exit(1);
}

const playwright = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
});

playwright.on("exit", (code, signal) => {
  stopServer();
  process.exit(signal ? 1 : (code ?? 1));
});
