/**
 * Version-parity gate for the coupled 3D stack.
 *
 * Ported from massing's `scripts/check-fragments-version.mjs`, and **retargeted**. massing compares one
 * `package.json` against two Dockerfiles, because its risk is a client and a server producing incompatible
 * `.frag` tiles. MassingViewer has no Dockerfiles and a different, monorepo-specific risk: two packages
 * resolving *different* versions of the same coupled dependency while each looks fine in isolation.
 *
 * ## Why these packages are one decision, not seven
 *
 * `@thatopen/fragments` writes a binary tile format. `@thatopen/components` consumes it. `web-ifc` produces
 * the geometry that becomes it. `three` defines the buffer layouts all of them build. Mixing versions does
 * not produce a clean error — it produces geometry that loads and renders **wrongly**, or a worker that
 * *hangs rather than rejects* on a payload it cannot parse. massing documents that hang in its model-loading
 * code, and it is the reason a version drift here is expensive to diagnose rather than merely broken.
 *
 * `three` carries a second, independent trap. massing's `apps/web/vite.config.ts` documents
 * `resolve.dedupe: ["three"]` because "Multiple instances of Three.js" was a *measured* failure there — two
 * copies in one bundle produce objects that fail each other's `instanceof` checks, and the symptom is
 * geometry that silently refuses to render. Version parity across packages is half of preventing that; the
 * architecture gate confining `three` to one package is the other half.
 *
 * The original's warning is worth carrying verbatim: bumping any one of these without re-verifying the set
 * is the coupling landmine.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The verified-good tuple, carried over from massing at the extraction baseline.
 *
 * These are exact, not ranges, and `.npmrc` sets `save-exact=true` repo-wide so a caret cannot creep in.
 * Changing a value here is a deliberate act that requires re-verifying the whole set — load a model, cut a
 * plan, check the worker does not hang — not a dependency bump.
 *
 * **Only `three` and `@types/three` are actually installed.** The `@thatopen/*` entries and `web-ifc` are
 * *pre-registered*: nothing in this repository depends on them, because `packages/ifc` is a hand-written STEP
 * parser and `packages/viewport` sits on raw three.js. They are kept so that the day one is added it is pinned to
 * a value someone verified rather than to whatever npm resolves that afternoon — and the gate now prints which
 * half is which, because reading this list as a live seven-package pin cost a sibling repository real effort.
 */
const KNOWN_GOOD = {
  three: "0.185.1",
  "@types/three": "0.185.4",
  "@thatopen/components": "3.4.8",
  "@thatopen/components-front": "3.4.4",
  "@thatopen/ui": "3.4.10",
  "@thatopen/fragments": "3.4.7",
  "web-ifc": "0.0.77",
};

const problems = [];

/** Every workspace manifest, plus the root. */
function manifests() {
  const out = [{ label: "package.json", json: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) }];
  for (const group of ["packages", "apps"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name, "package.json");
      if (!existsSync(path)) continue;
      out.push({ label: `${group}/${name}/package.json`, json: JSON.parse(readFileSync(path, "utf8")) });
    }
  }
  return out;
}

const all = manifests();

/** dep name -> [{ label, version }] — every place each coupled dependency is declared. */
const declarations = new Map();

for (const { label, json } of all) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(json[field] ?? {})) {
      if (!(name in KNOWN_GOOD)) continue;
      if (!declarations.has(name)) declarations.set(name, []);
      declarations.get(name).push({ label, version, field });
    }
  }
}

// --- 1. every declaration matches KNOWN_GOOD exactly -----------------------------------------------

for (const [name, sites] of declarations) {
  const expected = KNOWN_GOOD[name];
  for (const site of sites) {
    if (site.version !== expected) {
      problems.push(
        `${site.label} (${site.field}): ${name} is "${site.version}", expected exactly "${expected}". ` +
          `A range here is also a failure — the coupled set moves together.`,
      );
    }
  }
}

// --- 2. cross-package agreement (the monorepo-specific failure massing cannot have) ---------------

for (const [name, sites] of declarations) {
  const distinct = [...new Set(sites.map((s) => s.version))];
  if (distinct.length > 1) {
    problems.push(
      `${name} is declared at ${distinct.length} different versions across the workspace:\n` +
        sites.map((s) => `              ${s.version}  ${s.label}`).join("\n") +
        `\n            Each package looks fine alone; the bundle gets two copies.`,
    );
  }
}

// --- 3. the installed tree agrees with the declarations -------------------------------------------
//
// A declaration can be correct while the lockfile resolved something else — a transitive dependency
// pulling its own `three`, for instance. Checking what is on disk is the only way to see that.

for (const name of Object.keys(KNOWN_GOOD)) {
  const installed = join(ROOT, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(installed)) continue; // not installed yet — nothing to contradict
  const { version } = JSON.parse(readFileSync(installed, "utf8"));
  if (version !== KNOWN_GOOD[name]) {
    problems.push(
      `node_modules/${name} resolved to ${version}, but KNOWN_GOOD says ${KNOWN_GOOD[name]}. ` +
        `Something in the tree is overriding the declaration.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`\nVersion-parity gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\n  The three/@thatopen/web-ifc set is version-coupled. Mixing versions does not error cleanly —\n` +
      `  it renders wrongly, or hangs a worker. Bump the whole set together and re-verify.\n`,
  );
  process.exit(1);
}

const declared = [...declarations.keys()].sort();
const preRegistered = Object.keys(KNOWN_GOOD)
  .filter((name) => !declarations.has(name))
  .sort();

/**
 * Both halves, named.
 *
 * It used to print only the count of declared packages, which was true and read as though the whole tuple were
 * enforced. A sibling repository took it at face value and spent real effort reconciling against five versions
 * that are not installed here — `@thatopen/*` and `web-ifc` are not dependencies at all, because `packages/ifc`
 * is a hand-written STEP parser. The numbers were never wrong; the *scope* was narrower than the appearance, and
 * a gate that looks broader than it is will be trusted for things it does not check.
 *
 * The pre-registered entries stay, because they are worth keeping: the day one of them is added it is pinned to a
 * verified value instead of to whatever npm resolves that afternoon. They are just no longer implied to be live.
 */
console.log(
  declared.length === 0
    ? `Version-parity gate passed: none of the coupled 3D packages are declared yet ` +
        `(${Object.keys(KNOWN_GOOD).length} pre-registered, enforced from the moment one appears).`
    : `Version-parity gate passed: ${declared.length} of ${Object.keys(KNOWN_GOOD).length} coupled package(s) ` +
        `declared across ${all.length} manifest(s), all matching KNOWN_GOOD.`,
);
console.log(`  enforced now:   ${declared.join(", ")}`);
if (preRegistered.length > 0) {
  console.log(`  not installed:  ${preRegistered.join(", ")} — pinned in advance, nothing to check yet`);
}
