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

  "spawndamnit@3.0.1": {
    reason:
      'Declares "SEE LICENSE IN LICENSE" in package.json, which this gate refuses on principle because it ' +
      "carries no machine-readable grant. The shipped LICENSE file is, however, the verbatim MIT text " +
      '("Permission is hereby granted, free of charge... without restriction"), Copyright (c) 2017-present ' +
      "James Kyle — so the actual grant is permissive and on the allow-list. Verified by reading " +
      "node_modules/spawndamnit/LICENSE, not by trusting the metadata. It is also a transitive " +
      "devDependency of @changesets/cli, reached via @changesets/git, so it is never part of a published " +
      "package or the shipped bundle. Re-verify if the version changes.",
    verified:
      "Read node_modules/spawndamnit/LICENSE on 2026-08-07: verbatim MIT, Copyright (c) 2017-present " +
      "James Kyle. No issue filed because there is no unresolved risk to track — the declaration is wrong " +
      "and the grant is permissive.",
  },
};

// ---------------------------------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function normaliseLicense(entry) {
  if (typeof entry.license === "string") return entry.license;
  if (entry.license?.type) return entry.license.type;
  if (Array.isArray(entry.licenses)) return entry.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/**
 * Read the dependency tree from `package-lock.json`, not from `node_modules`.
 *
 * The first version of this gate walked `node_modules`, and it could not pass on two platforms at once:
 * `npm ci` installs only the platform-specific optional packages for the current host, so
 * `@oxlint/binding-win32-x64-msvc` exists on Windows and `@oxlint/binding-linux-x64-gnu` in CI. The
 * generated notices therefore differed by host, and the staleness check failed in CI on a file that was
 * correct locally. A gate that cannot pass everywhere gets deleted.
 *
 * The lockfile is strictly better here, for three reasons rather than just being a workaround:
 *
 * 1. **Deterministic.** It is committed, so the notices are a function of the repo rather than of the
 *    machine that generated them.
 * 2. **More complete.** It lists all 45 platform-specific packages, not the ~6 installed on this host —
 *    so the licence review covers what a Linux, macOS or ARM user would actually receive, which is the
 *    population that matters for a published library.
 * 3. **Runs without installing.** The gate works on a fresh clone.
 *
 * npm's lockfile v3 carries `license` on every third-party entry (verified: 213 of 218, and the five
 * without are this repo's own workspace links).
 */
function collectPackages() {
  const lock = readJson(join(ROOT, "package-lock.json"));
  if (!lock?.packages) {
    throw new Error(
      "package-lock.json is missing or has no `packages` map. This gate reads the lockfile so its result " +
        "is platform-independent; run `npm install` to generate one.",
    );
  }

  const found = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue; // the root project
    if (entry.link) continue; // a workspace symlink — our own code, covered by this repo's LICENSE

    // Derive the package name from the lockfile path, since entries do not always carry `name`.
    const name = entry.name ?? path.replace(/^(?:.*\/)?node_modules\//, "");
    if (!name || name.startsWith("@massingviewer/")) continue;

    const key = `${name}@${entry.version ?? "?"}`;
    if (found.has(key)) continue;
    found.set(key, {
      name,
      version: entry.version ?? "?",
      license: normaliseLicense(entry),
      // Recorded so the notices can say which platforms a binary actually reaches.
      platform: entry.os || entry.cpu ? [entry.os ?? [], entry.cpu ?? []].flat().join("/") : null,
      dev: entry.dev === true,
    });
  }
  return found;
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

const packages = [...collectPackages().values()].sort((a, b) => a.name.localeCompare(b.name));

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
      // Every exception needs a written reason, plus **one of two** kinds of evidence — because there are two
      // genuinely different situations here and collapsing them makes the record worse:
      //
      //   `issue`    — we are knowingly carrying a risk that is not resolved. It needs an owner and a ticket,
      //                or it becomes permanent by inattention.
      //   `verified` — the declared metadata is simply wrong, and someone read the actual licence text. There
      //                is nothing to track; the evidence *is* the resolution, and filing a ticket that will
      //                never be actioned trains people to ignore tickets.
      //
      // Requiring `issue` unconditionally pushed toward citing a ticket that did not exist, which would put a
      // dead link in a document whose entire purpose is to be auditable.
      if (!exception.reason) {
        problems.push(`EXCEPTION INCOMPLETE  ${key} — an exception needs a written reason.`);
      } else if (!exception.issue && !exception.verified) {
        problems.push(
          `EXCEPTION INCOMPLETE  ${key} — an exception needs either an "issue" link (a tracked risk) or a\n` +
            `          "verified" note stating which file was read and what licence it actually grants.`,
        );
      }
      continue;
    }
    problems.push(
      `REFUSED ${key} — license "${pkg.license}"\n` +
        `          Permitted: ${[...ALLOW].join(", ")}\n` +
        `          If this is genuinely needed, add it to ALLOWED_EXCEPTIONS with a reason, plus either an\n` +
        `          issue link or a "verified" note recording what the shipped licence file actually says.`,
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

const platformCount = packages.filter((p) => p.platform).length;

const notices =
  `# Third-party notices\n\n` +
  `<!-- GENERATED by scripts/check-licenses.mjs. Do not edit by hand; run \`npm run gate:license -- --write\`. -->\n\n` +
  `MassingViewer depends on the packages below. This project accepts only permissive licenses; the\n` +
  `posture and the reasoning are in \`docs/adr/0003-license-posture.md\`.\n\n` +
  `Generated from \`package-lock.json\` rather than from an installed \`node_modules\`, so this list is the\n` +
  `same on every platform and covers all ${platformCount} platform-specific binaries — not only the handful\n` +
  `installed on whichever host happened to run the generator.\n\n` +
  `${packages.length} package(s) across ${byLicense.size} license(s).\n\n` +
  [...byLicense.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([license, pkgs]) =>
        `## ${license} (${pkgs.length})\n\n` +
        pkgs
          .map((p) => `- \`${p.name}\` ${p.version}${p.platform ? ` _(${p.platform})_` : ""}`)
          .join("\n"),
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
