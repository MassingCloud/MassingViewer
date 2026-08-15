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

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { devices, chromium, firefox, webkit } from "@playwright/test";

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

/**
 * Preflight: can the browsers this run needs actually start?
 *
 * The same lesson as the port check above, applied one layer out. When a browser binary cannot be spawned,
 * Playwright reports it **once per test** — so a Windows host whose Firefox will not launch produces sixty-two
 * identical `browserType.launch: spawn UNKNOWN` failures and no indication that a single environmental fault
 * caused all of them. That is a suite that reads as broken code, and the reasonable response to it is to stop
 * running the suite.
 *
 * `spawn UNKNOWN` is Node's placeholder for a `CreateProcess` error it has no mapping for, which makes it the
 * least informative string Windows can hand back. The one that occasioned this check was:
 *
 *   > The application has failed to start because its side-by-side configuration is incorrect
 *   > Activation context generation failed … Dependent Assembly mozglue … could not be found
 *
 * — with `mozglue.dll` present and carrying a correct embedded assembly manifest, in two independently
 * downloaded Firefox builds, on a host where Chromium and WebKit both launch. So: a host-level SxS fault, not a
 * bad download and nothing this repository can fix. CI runs Firefox on `ubuntu-latest` under xvfb, where
 * Windows activation contexts do not exist.
 *
 * This does not make the run green. It replaces sixty-two copies of the wrong diagnosis with one right one.
 */
const PW_CLI = "node_modules/@playwright/test/cli.js";

/**
 * Which browser engine each project drives, parsed from the config.
 *
 * The engine itself comes from Playwright's own `devices` table rather than from reading a device name and
 * guessing — `ipad` is WebKit and `shell` is Chromium, so a hand-written copy of that mapping would be wrong
 * within a week. The window is generous because the projects in that file are separated by long comments: at 400
 * characters this silently missed `shell`, whose `name:` and `devices[…]` are 445 apart, and the first version of
 * this preflight then ran five projects while reporting nothing about the sixth. Hence `configuredProjects()`
 * below, which does not trust this function's coverage.
 */
function projectEngines() {
  const map = new Map();
  try {
    const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
    for (const [, project, device] of config.matchAll(/name:\s*"([^"]+)"[\s\S]{0,1500}?devices\[\s*"([^"]+)"\s*\]/g)) {
      const engine = devices[device]?.defaultBrowserType;
      if (engine !== undefined && !map.has(project)) map.set(project, engine);
    }
  } catch {
    /* no preflight, then */
  }
  return map;
}

/**
 * Playwright's own list of configured projects.
 *
 * Authoritative, where a regex over a TypeScript file is not. It costs one extra process and it is the only thing
 * that makes it safe to *reduce* a matrix: without it, a project this script failed to parse would quietly not
 * run, and a smaller green matrix is exactly the shape of result nobody questions.
 */
function configuredProjects() {
  try {
    const listed = execFileSync(process.execPath, [PW_CLI, "test", "--list", "--reporter=json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(listed).config.projects.map((project) => project.name);
  } catch {
    return null;
  }
}

const LAUNCHERS = { chromium, firefox, webkit };
const args = process.argv.slice(2);
const engines = projectEngines();

/** The projects this invocation will run: whatever `--project` asked for, or all of them. */
const requested = args
  .flatMap((arg, i) => (arg.startsWith("--project=") ? [arg.slice(10)] : arg === "--project" ? [args[i + 1]] : []))
  .filter((name) => name !== undefined);
const projects = requested.length > 0 ? requested : (configuredProjects() ?? []);

// A project whose engine could not be determined disables the preflight rather than being dropped from it. The
// check is cheap insurance against the failure this file already made once: a diagnostic that shrinks the run it
// was meant to explain is worse than no diagnostic at all.
const unmapped = projects.filter((project) => !engines.has(project));
if (unmapped.length > 0) {
  console.error(
    `e2e: skipping the browser-launch preflight — no engine known for ${unmapped.join(", ")}. ` +
      `Every project still runs; only the diagnosis is unavailable.`,
  );
  projects.length = 0;
}

const broken = new Map();
for (const engine of new Set(projects.map((p) => engines.get(p)).filter((e) => e !== undefined))) {
  try {
    const browser = await LAUNCHERS[engine].launch();
    await browser.close();
  } catch (error) {
    // First line only. Playwright appends its launch command and a call log, which is useful in a report and
    // noise in a summary — the rest is in the report if anyone wants it.
    const message = error instanceof Error ? error.message : String(error);
    broken.set(engine, message.split(/\r?\n/)[0]);
  }
}

if (broken.size > 0) {
  const unlaunchable = projects.filter((p) => broken.has(engines.get(p)));
  const skip = process.env.E2E_SKIP_UNLAUNCHABLE === "1";
  const say = (...lines) => console.error(lines.map((line) => (line === "" ? "" : `     ${line}`)).join("\n"));

  console.error(`\ne2e: ${broken.size} browser engine(s) on this host cannot be launched at all.\n`);
  for (const [engine, message] of broken) say(`${engine}: ${message}`);
  say(
    "",
    `Affected projects: ${unlaunchable.join(", ")}`,
    "This is the host, not the test code — every test in those projects would report the same launch error.",
    "Try `npx playwright install --force <engine>` first; if it persists the binary is fine and the operating",
    "system is refusing to start it. On Windows, check the Application event log for SideBySide entries, which",
    "name the assembly that failed to resolve.",
    "",
  );

  if (!skip) {
    say(
      'Exiting 1, because "the browser would not start" and "the tests pass" are different claims and this run',
      "can make neither. To get the other projects' results anyway, set E2E_SKIP_UNLAUNCHABLE=1 — which prints",
      "what it skipped, and is never set in CI, where an unlaunchable browser is a real failure rather than a",
      "local quirk.",
      "",
    );
    process.exit(1);
  }

  const remaining = projects.filter((p) => !broken.has(engines.get(p)));
  if (remaining.length === 0) {
    say("E2E_SKIP_UNLAUNCHABLE=1 leaves nothing to run. Exiting 1.", "");
    process.exit(1);
  }
  say(`E2E_SKIP_UNLAUNCHABLE=1: NOT RUNNING ${unlaunchable.join(", ")}. Running ${remaining.join(", ")} only.`, "");
  // Rewritten rather than appended: the original `--project` flags would otherwise still ask for the broken one.
  args.splice(
    0,
    args.length,
    ...args.filter((arg, i) => !arg.startsWith("--project") && args[i - 1] !== "--project"),
    ...remaining.map((p) => `--project=${p}`),
  );
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
let playwrightRunning = false;
server.on("exit", (code, signal) => {
  serverExit = signal ?? code;
  /**
   * Say so **immediately** when it dies mid-run.
   *
   * The readiness reporting below only covers startup. If the server exits once Playwright is going, nothing
   * mentioned it — every remaining test just failed at `page.goto` with `ERR_CONNECTION_REFUSED`, which reads as
   * "the app is broken" rather than "the thing serving it is gone".
   *
   * That cost a diagnosis on 2026-08-14: the server died twice mid-run and the only evidence was a connection
   * refused on the third test, so the cause had to be guessed at. Two guesses were then eliminated by experiment
   * — aborted in-flight requests (six rounds, survived) and long idles (three 45 s rounds, survived) — and the
   * real cause is still unknown. This line is what makes the *next* occurrence evidence instead of another
   * guessing round: the exit code and the server's own last words, at the moment it happens.
   */
  if (playwrightRunning) {
    console.error(`\ne2e: the server exited mid-run with ${serverExit}. Every test after this point will fail to connect.`);
    const tail = serverOutput.join("").split(/\r?\n/).filter(Boolean).slice(-15);
    if (tail.length > 0) console.error(`e2e: server's last output:\n${tail.map((l) => `  ${l}`).join("\n")}`);
  }
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

playwrightRunning = true;
const playwright = spawn(process.execPath, [PW_CLI, "test", ...args], {
  stdio: "inherit",
});

playwright.on("exit", (code, signal) => {
  stopServer();
  process.exit(signal ? 1 : (code ?? 1));
});
