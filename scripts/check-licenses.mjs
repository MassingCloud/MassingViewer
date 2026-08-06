/**
 * License gate.
 *
 * The research behind this project turned up an uncomfortable pattern: in **four separate categories**,
 * the best-in-class option is copyleft or not open source at all.
 *
 *   · browser DWG reading  → LibreDWG (GPL-3.0), and it is the only good one
 *   · BIM viewers          → xeokit-sdk (AGPL-3.0 or paid)
 *   · PDF engines          → MuPDF (AGPL or paid)
 *   · reference CAD apps    → Chili3D, Open CAD Studio (AGPL-3.0 / GPL-3.0)
 *   · canvas SDKs           → tldraw, which is **not open source despite appearing to be**
 *
 * Any one of those, adopted as a dependency and discovered later, costs a rewrite of whatever sits on
 * top of it. The cost of preventing it is this file. So the check runs on every PR, over the whole
 * transitive tree, and fails the build rather than filing a warning.
 *
 * It also regenerates THIRD-PARTY-NOTICES.md and fails if the committed copy is stale, because an
 * attribution file that has drifted from the dependency tree satisfies nobody's legal review.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WRITE = process.argv.includes("--write");

/** Permissive licenses. Anything not on this list is refused until someone reviews it. */
const ALLOW = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BSL-1.0",
  "MPL-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
  "Python-2.0",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
]);

/**
 * Patterns that are refused outright.
 *
 * `"UNKNOWN"` and `"SEE LICENSE IN"` are on this list deliberately. An unresolvable license is not a
 * neutral state — it is an unreviewed one, and treating it as acceptable is how the other entries get in.
 */
const DENY_PATTERNS = [
  /^GPL-/i,
  /^AGPL-/i,
  /^LGPL-/i,
  /GPL-\d/i,
  /^SSPL/i,
  /^BUSL/i,
  /^CC-BY-NC/i,
  /^Elastic/i,
  /^Commons-Clause/i,
  /^UNKNOWN$/i,
  /^Other$/i,
  /^SEE LICENSE IN/i,
  /^UNLICENSED$/i,
];

/**
 * Packages banned by name regardless of what their manifest claims.
 *
 * Each is here because it is the *attractive* choice in its category and the reason to refuse it is not
 * visible from `npm install`. The reason travels with the ban so nobody has to re-derive it.
 */
const BANNED = {
  tldraw: "Not open source. The tldraw SDK license is development-only by default; production needs a paid key, the hobby tier keeps a watermark, and the startup license is ~$6k. A foundational canvas dependency behind a commercial gate is a strategic risk, not a licensing detail.",
  "@tldraw/tldraw": "See `tldraw`.",
  "xeokit-sdk": "AGPL-3.0 or a paid commercial license. AGPL is viral over network use, which is fatal for a hosted deployment. Also: the successor SDK is alpha.",
  "mupdf": "AGPL or paid. Explicitly requires source release for network services.",
  "mupdf-js": "See `mupdf`.",
  "libredwg": "GPL-3.0, and it propagates. This is the only good browser DWG reader — that is precisely the trap. Ship DXF (which covers most real exchange with MIT libraries) or run a GPL converter as a separate arms-length process.",
  "@mlightcad/libredwg-web": "See `libredwg`.",
  "@mlightcad/libredwg-converter": "See `libredwg`.",
  "ifcopenshell": "LGPL-3.0. Excellent, and the reference implementation for correct IFC authoring — but this project ships as an npm library, so nothing LGPL is bundled. The offline kernel uses web-ifc (MIT) + manifold-3d (Apache-2.0) + clipper2 (Boost) instead. ifcopenshell stays server-side, behind kernel-remote, and never crosses the boundary.",
  "web-ifc-three": "Deprecated upstream, superseded by @thatopen/fragments.",
};

/**
 * In-org sources that must never be copied from. Both live in the same GitHub organisation as this
 * repo, which is exactly why the risk is real — copy-paste between sibling repos is how contamination
 * actually happens, not via `npm install`.
 */
const FORBIDDEN_COPYRIGHT_SOURCES = [
  { name: "MassingCloud/massing-cloud", license: "GPL-2.0", marker: /massing-cloud/i },
  { name: "MassingCloud/massing-families", license: "Other (unresolved)", marker: /massing-families/i },
];

/** Exceptions require a written reason and a tracking issue — the same discipline as .gitleaksignore. */
const ALLOWED_EXCEPTIONS = {
  // "some-package@1.2.3": { reason: "...", issue: "https://github.com/.../issues/NN" },
};

// ---------------------------------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Walk node_modules, including scoped packages, without shelling out to `npm ls`. */
function collectPackages(dir, found = new Map()) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;

    if (entry.startsWith("@")) {
      for (const sub of readdirSync(full)) {
        const scoped = join(full, sub);
        if (!statSync(scoped).isDirectory()) continue;
        addPackage(scoped, found);
        collectPackages(join(scoped, "node_modules"), found);
      }
      continue;
    }
    addPackage(full, found);
    collectPackages(join(full, "node_modules"), found);
  }
  return found;
}

function addPackage(dir, found) {
  const manifest = readJson(join(dir, "package.json"));
  if (!manifest?.name || !manifest.version) return;
  // Our own workspace packages are covered by the repo's LICENSE, not by third-party review.
  if (manifest.name.startsWith("@massingviewer/")) return;
  const key = `${manifest.name}@${manifest.version}`;
  if (found.has(key)) return;
  found.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: normaliseLicense(manifest),
    repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url,
  });
}

function normaliseLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/**
 * Evaluate an SPDX expression.
 *
 * `"(MIT OR Apache-2.0)"` is acceptable if *either* side is; `"(MIT AND GPL-3.0)"` is not acceptable
 * even though one side is. Getting the OR case wrong would refuse a large number of legitimate
 * dual-licensed packages; getting the AND case wrong would admit GPL.
 */
function isAcceptable(expression) {
  const expr = expression.replace(/[()]/g, " ").trim();
  if (/\bAND\b/i.test(expr)) {
    return expr.split(/\bAND\b/i).every((part) => isAcceptable(part.trim()));
  }
  if (/\bOR\b/i.test(expr)) {
    return expr.split(/\bOR\b/i).some((part) => isAcceptable(part.trim()));
  }
  const id = expr.replace(/\+$/, "").trim();
  if (DENY_PATTERNS.some((re) => re.test(id))) return false;
  return ALLOW.has(id);
}

// --- 1. transitive dependency licenses -------------------------------------------------------------

const packages = [...collectPackages(join(ROOT, "node_modules")).values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

const problems = [];

for (const pkg of packages) {
  const key = `${pkg.name}@${pkg.version}`;
  const exception = ALLOWED_EXCEPTIONS[key];

  const bannedReason = BANNED[pkg.name];
  if (bannedReason) {
    problems.push(`BANNED  ${key}\n          ${bannedReason}`);
    continue;
  }

  if (!isAcceptable(pkg.license)) {
    if (exception) {
      if (!exception.reason || !exception.issue) {
        problems.push(
          `EXCEPTION INCOMPLETE  ${key} — an exception needs both a reason and an issue link.`,
        );
      }
      continue;
    }
    problems.push(
      `REFUSED ${key} — license "${pkg.license}"\n` +
        `          Permitted: ${[...ALLOW].join(", ")}\n` +
        `          If this is genuinely needed, add it to ALLOWED_EXCEPTIONS with a reason and an issue.`,
    );
  }
}

// --- 2. no in-org copyleft source headers ----------------------------------------------------------

function walkSource(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full, out);
    else if (/\.(ts|tsx|mjs|js|css)$/.test(entry)) out.push(full);
  }
  return out;
}

for (const file of [...walkSource(join(ROOT, "packages")), ...walkSource(join(ROOT, "apps"))]) {
  const head = readFileSync(file, "utf8").slice(0, 2000);
  for (const source of FORBIDDEN_COPYRIGHT_SOURCES) {
    if (source.marker.test(head) && /copyright|extracted from/i.test(head)) {
      problems.push(
        `CONTAMINATION  ${file}\n` +
          `          References ${source.name} (${source.license}) in its header. Nothing may be copied ` +
          `from that repository — see docs/adr/0003-license-posture.md.`,
      );
    }
  }
}

// --- 3. THIRD-PARTY-NOTICES.md is current ---------------------------------------------------------

const byLicense = new Map();
for (const pkg of packages) {
  if (!byLicense.has(pkg.license)) byLicense.set(pkg.license, []);
  byLicense.get(pkg.license).push(pkg);
}

const notices =
  `# Third-party notices\n\n` +
  `<!-- GENERATED by scripts/check-licenses.mjs. Do not edit by hand; run \`npm run gate:license -- --write\`. -->\n\n` +
  `MassingViewer depends on the packages below. This project accepts only permissive licenses; the\n` +
  `posture and the reasoning are in \`docs/adr/0003-license-posture.md\`.\n\n` +
  `${packages.length} package(s) across ${byLicense.size} license(s).\n\n` +
  [...byLicense.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([license, pkgs]) =>
        `## ${license} (${pkgs.length})\n\n` +
        pkgs.map((p) => `- \`${p.name}\` ${p.version}`).join("\n"),
    )
    .join("\n\n") +
  `\n\n## Deliberately excluded\n\n` +
  `These are the attractive option in their category, and are refused anyway. The gate enforces it by\n` +
  `name, so the decision cannot be quietly reversed by an \`npm install\`.\n\n` +
  Object.entries(BANNED)
    .filter(([, reason]) => !reason.startsWith("See "))
    .map(([name, reason]) => `- **\`${name}\`** — ${reason}`)
    .join("\n") +
  `\n`;

const noticesPath = join(ROOT, "THIRD-PARTY-NOTICES.md");
if (WRITE) {
  writeFileSync(noticesPath, notices, "utf8");
  console.log(`wrote THIRD-PARTY-NOTICES.md (${packages.length} packages)`);
} else {
  const existing = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";
  if (existing.trim() !== notices.trim()) {
    problems.push(
      `STALE   THIRD-PARTY-NOTICES.md does not match the dependency tree.\n` +
        `          Run: npm run gate:license -- --write`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`\nLicense gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `License gate passed: ${packages.length} package(s), all permissive; ` +
    `${Object.keys(BANNED).length} banned by name; notices current.`,
);
