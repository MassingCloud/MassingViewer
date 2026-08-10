/**
 * Consumer licence gate — the stricter list, on the closure a host actually ships.
 *
 * ## Why a second licence gate
 *
 * `check-licenses.mjs` checks *this repository's* whole dependency tree against this repository's allowlist, which
 * permits `MPL-2.0` and `BSL-1.0`. That is the right list here: `@resvg/resvg-js` (MPL-2.0) rasterises the Tier-3
 * drawing baselines, `@ifc-lite/*` (MPL-2.0) is the 2D bake-off's differential oracle, `@axe-core/playwright`
 * (MPL-2.0) is the accessibility gate. None of them run in anyone's browser.
 *
 * massing's list is narrower — **MIT / BSD-2 / BSD-3 / 0BSD / Apache-2.0 / ISC, with GPL, AGPL, CC BY-NC and SSPL
 * as hard exclusions** — and it tolerates weak copyleft only where it is already unavoidable in an
 * `ifcopenshell`/`certifi` core. A new one arriving through a viewer dependency is not that.
 *
 * Today the two lists agree in practice: every MPL-2.0 package here is a devDependency. That is a *fact about
 * today*, and the whole point of a gate is that it stops being one that has to be rechecked by hand. Without this,
 * the day someone adds an MPL-2.0 runtime dependency to `@massing/drawings2d` is the day massing's own licence
 * audit fails, in massing's repository, for a reason that originated here.
 *
 * ## What "the consumed closure" means, precisely
 *
 * The runtime closure of {@link ENTRY} — its `dependencies` and `peerDependencies`, transitively, with workspace
 * packages expanded through their own manifests and external packages expanded through the lockfile. Peers are
 * included because a peer is something the host installs *because we asked it to*; excluding them would let this
 * gate pass while handing massing a licence problem to resolve itself.
 *
 * `devDependencies` are excluded at every level, which is the entire distinction being drawn.
 *
 * Read from the lockfile rather than from `node_modules`, for the reason the sibling gate gives: the answer must
 * not depend on which platform ran `npm install`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The package massing imports. Everything reachable from here at runtime is in scope.
 *
 * One entry point rather than "every published package", deliberately: `@massing/kernel-local` pulls a geometry
 * stack a host using `RemoteKernel` never loads, and failing this gate over a package nobody consumes would train
 * people to widen the list.
 */
const ENTRY = "@massing/embed";

/** massing's list, verbatim. Not a superset, not "roughly" — the point is that it is theirs. */
const CONSUMER_ALLOW = new Set(["MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "ISC"]);

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

const lock = readJson(join(ROOT, "package-lock.json"));
if (lock?.packages === undefined) {
  console.error(
    "check-consumer-licenses: package-lock.json is missing or has no `packages` map. This gate reads the " +
      "lockfile so its result is platform-independent; run `npm install`.",
  );
  process.exit(1);
}

/** Workspace manifests by package name, so `@massing/*` resolves to source rather than to a published tarball. */
const workspace = new Map();
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!entry.link) continue;
  const manifest = readJson(join(ROOT, entry.resolved ?? path, "package.json"));
  if (manifest?.name !== undefined) workspace.set(manifest.name, manifest);
}

/**
 * Resolve a dependency name to its lockfile entry.
 *
 * npm hoists, so a package required by a nested dependency may live at the top level. Checking the nested path
 * first and then the root mirrors Node's own resolution closely enough for a licence question, where what matters
 * is *which version is present*, not which copy a given importer binds to.
 */
function lockEntryFor(name, fromPath) {
  const nested = `${fromPath}/node_modules/${name}`;
  return lock.packages[nested] ?? lock.packages[`node_modules/${name}`] ?? null;
}

/** `license` is usually a string; older manifests use `licenses: [{ type }]`. */
function licenseOf(entry) {
  if (typeof entry.license === "string") return entry.license;
  if (Array.isArray(entry.license)) return entry.license.join(" OR ");
  if (Array.isArray(entry.licenses)) return entry.licenses.map((l) => l.type ?? "?").join(" OR ");
  return "UNKNOWN";
}

const external = new Map();
const seen = new Set();
const missing = [];

function walk(name, fromPath) {
  if (seen.has(name)) return;
  seen.add(name);

  const local = workspace.get(name);
  if (local !== undefined) {
    // Our own code, covered by this repository's LICENSE. Recurse for what it pulls in.
    for (const dep of Object.keys({ ...local.dependencies, ...local.peerDependencies })) walk(dep, "");
    return;
  }

  const entry = lockEntryFor(name, fromPath);
  if (entry === null) {
    // Recorded rather than skipped. A dependency the lockfile cannot account for is exactly the case where
    // silence would be indistinguishable from a clean result.
    missing.push(name);
    return;
  }

  external.set(name, { version: entry.version ?? "?", license: licenseOf(entry) });
  const path = lock.packages[`${fromPath}/node_modules/${name}`] !== undefined
    ? `${fromPath}/node_modules/${name}`
    : `node_modules/${name}`;
  for (const dep of Object.keys({ ...entry.dependencies, ...entry.peerDependencies })) walk(dep, path);
}

if (!workspace.has(ENTRY)) {
  console.error(`check-consumer-licenses: ${ENTRY} is not a workspace package. Has it been renamed or removed?`);
  process.exit(1);
}
walk(ENTRY, "");

const problems = [];
for (const [name, info] of [...external].sort(([a], [b]) => a.localeCompare(b))) {
  if (CONSUMER_ALLOW.has(info.license)) continue;
  problems.push(
    `${name}@${info.version} is ${info.license}, which massing does not permit.\n` +
      `          It is reachable at runtime from ${ENTRY}, so adopting this repository would hand massing a\n` +
      `          licence problem originating here. Permitted: ${[...CONSUMER_ALLOW].join(", ")}.\n` +
      `          Either move it to devDependencies, replace it, or take it up with massing before merging.`,
  );
}
for (const name of missing.sort()) {
  problems.push(`${name} is required at runtime but has no lockfile entry, so its licence cannot be determined.`);
}

if (problems.length > 0) {
  console.error(`Consumer licence gate failed — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log(
  `Consumer licence gate passed: ${external.size} runtime package(s) reachable from ${ENTRY}, ` +
    `all within massing's list (${[...CONSUMER_ALLOW].join(", ")}).`,
);
