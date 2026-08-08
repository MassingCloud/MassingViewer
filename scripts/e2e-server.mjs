/**
 * Build the demo and serve it, in **one** process, for Playwright's `webServer`.
 *
 * ## Why this file exists rather than an npm script
 *
 * The obvious `webServer.command` is
 * `npm run build --workspace @massing/demo && npm run preview --workspace @massing/demo`. It works,
 * the tests pass — and then Playwright **never exits**. Measured on Windows: the twelve tests finished in ten
 * seconds and the run sat for twenty-seven minutes before being killed manually.
 *
 * The cause is the process tree. `npm run` spawns a shell, which spawns npm again, which spawns vite. Playwright
 * terminates the child it started; the vite grandchild survives, keeps the port bound, and Playwright waits for
 * the port to be released before it will exit. Locally that is an annoyance. In CI it is a job that hangs until
 * the six-hour ceiling and reports nothing, which is strictly worse than a failure — a failure tells you
 * something.
 *
 * So: no shell, no npm, no grandchildren. This is a single Node process that calls vite's JS API, meaning the
 * preview server lives *inside* the process Playwright owns. Killing it releases the port, always.
 *
 * The build runs here rather than in a separate CI step for the same reason the config uses `preview` over
 * `dev`: E2E must exercise the artifact that ships, and a build that a human might forget to run before the
 * tests is a build the tests will eventually run without.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build, preview } from "vite";

const PORT = Number(process.env.E2E_PORT ?? 4173);

/**
 * Bind IPv4 loopback explicitly, and never `localhost`.
 *
 * Left to itself, vite bound only `::1` on this machine — `http://[::1]:4173/` answered and
 * `http://127.0.0.1:4173/` was refused outright. Browsers hide that (Chrome tries both), but Playwright's
 * readiness probe does not, so a run that should take sixteen seconds took six and a half minutes and then hung
 * on teardown. The name `localhost` is the whole problem: it means two different addresses depending on who
 * resolves it, and half the stack picked one while the other half picked the other.
 *
 * So the address is a literal on both sides — here, and in `webServer.url` and `baseURL` in
 * `playwright.config.ts`. They must stay in agreement.
 */
const HOST = "127.0.0.1";

/**
 * Both apps, in one process.
 *
 * `apps/demo` is the vanilla host and `apps/shell` is the React one, and they exist as a pair to test the claim
 * ADR-0009 rests on: the same ribbon package renders in both. Testing that needs both served.
 *
 * Two servers in *one* process rather than two processes, deliberately. This whole file exists because
 * Playwright's own `webServer` teardown hung for 27 minutes and the fix was owning a single lifecycle — adding a
 * second process to supervise would re-introduce the shape of that bug.
 */
const APPS = [
  { name: "demo", port: PORT },
  { name: "shell", port: PORT + 1 },
];

/**
 * Build **everything first**, then start the servers.
 *
 * The first version interleaved them — build demo, serve demo, build shell, serve shell — and the suite went
 * flaky: two webkit tests failed with different assertions on consecutive runs, and one run failed with
 * `ERR_CONNECTION_REFUSED` on the demo's port. The cause is that a vite build is heavy, largely synchronous work
 * in *this* process, so while the shell was building the demo's server was listening and unable to answer.
 *
 * Separating the phases removes the window entirely. It also means the readiness probe means what it says: when
 * both ports answer, nothing else is competing for the event loop.
 */
const built = [];
for (const app of APPS) {
  const root = fileURLToPath(new URL(`../apps/${app.name}/`, import.meta.url));
  const configFile = join(root, "vite.config.ts");
  console.log(`e2e-server: building ${root}`);
  await build({ root, configFile, logLevel: "warn" });
  built.push({ ...app, root, configFile });
}

const servers = [];
for (const app of built) {
  servers.push(
    await preview({
      root: app.root,
      configFile: app.configFile,
      logLevel: "warn",
      // strictPort so a stale server is a loud failure rather than a silent test run against the wrong build —
      // the exact mistake that once produced twelve unrelated failures here.
      preview: { host: HOST, port: app.port, strictPort: true },
    }),
  );
  // Printed only after it is actually listening: the readiness probe waits for these lines.
  console.log(`e2e-server: serving the built ${app.name} on http://${HOST}:${app.port}/`);
}

const shutdown = () => {
  for (const server of servers) server.httpServer.close();
  // If a keep-alive connection refuses to drain, do not become the hang this file exists to prevent.
  setTimeout(() => process.exit(0), 2000).unref();
  setTimeout(() => process.exit(0), 100);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
