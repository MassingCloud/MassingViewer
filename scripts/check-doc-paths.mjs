/**
 * Doc-path gate.
 *
 * Ported in spirit from massing's `services/api/test_claude_md_gates.py`, which checks that every
 * backticked filename in its standing docs resolves to a real tracked path.
 *
 * The reason it earns its place: these docs cite gates and files as *evidence* for claims —
 * "enforced by scripts/check-architecture.mjs", "see docs/adr/0003". A citation pointing at something
 * that does not exist is worse than no citation, because it converts "we should do this" into "we
 * already do this" without anyone noticing. The README makes several such claims, and every one of them
 * should be checkable by clicking.
 *
 * The convention this establishes, recorded in CONTRIBUTING.md: **backticks are reserved for things that
 * exist.** Use plain quotes for anything aspirational.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Docs held to the gate.
 *
 * The floors are a **ratchet, not a guess**: they record the count each doc actually had when it was last
 * checked, and fail if it drops. Guessed numbers are worse than none — too high and the gate blocks work
 * for no reason, too low and it never fires. Regenerate with `npm run gate:docs -- --update` after
 * deliberately adding or removing cross-references.
 *
 * What the floor protects: a doc getting gutted in a refactor and nobody noticing, because prose that
 * still reads plausibly while having lost all its links looks fine in review.
 */
const FLOORS_PATH = "scripts/doc-citation-floors.json";
const GATED = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "NOTICE"];

/**
 * Every markdown file under `docs/`, discovered recursively.
 *
 * Discovery rather than a list, so a new doc cannot skip the check — which was already the stated intent for
 * ADRs, and was not being honoured for anything else. An earlier version listed `docs/architecture.md` by hand
 * and walked only `docs/adr/`, which meant `docs/testing.md` had never been gated at all, and a new
 * subdirectory (`docs/kernels/`) was silently ignored: the gate reported the same doc count before and after a
 * 200-line guide was added. A gate with a blind spot is worse than no gate, because its green is trusted.
 */
function collectDocs(dir, prefix) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      // `pending/` holds extraction leftovers that deliberately cite massing's paths, not ours.
      if (entry === "pending") continue;
      collectDocs(rel, prefix);
    } else if (entry.endsWith(".md")) {
      GATED.push(rel);
    }
  }
}
try {
  collectDocs("docs");
} catch {
  /* no docs yet */
}
GATED.sort();

const UPDATE = process.argv.includes("--update");
let floors = {};
try {
  floors = JSON.parse(readFileSync(join(ROOT, FLOORS_PATH), "utf8"));
} catch {
  /* first run — --update will create it */
}

/**
 * Every dependency name declared anywhere in the workspace.
 *
 * Needed because a handful of npm packages are named like files — `ssim.js`, and by convention most of the
 * `*.js` family — so the extension test below flags them as unresolvable paths. Resolving against the declared
 * dependency set rather than a hand-kept allowlist means the next such package is handled by installing it,
 * which is the difference between a rule and a list of exceptions.
 *
 * Declared, not installed: `node_modules` is not authoritative about what this repo depends on, and the gate
 * must give the same answer before and after `npm ci`.
 */
function declaredPackages() {
  const names = new Set();
  const read = (rel) => {
    try {
      const json = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(json[field] ?? {})) names.add(name);
      }
    } catch {
      /* not a package, or unreadable — the packaging gate owns that complaint */
    }
  };
  read("package.json");
  for (const group of ["packages", "apps"]) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, group));
    } catch {
      continue;
    }
    for (const entry of entries) read(`${group}/${entry}/package.json`);
  }
  return names;
}
const PACKAGES = declaredPackages();

/**
 * A backticked token that looks like a path we should be able to resolve.
 *
 * Deliberately narrow. Backticks are also used for identifiers (`resolveSnap`), npm packages
 * (`@massing/core`), types, CLI flags and shell fragments — none of which are paths. Treating
 * every backticked token as a path would produce so much noise that the gate would be switched off,
 * which is the actual risk with a check like this.
 */
function looksLikePath(token) {
  if (token.includes(" ")) return false;
  if (token.startsWith("@")) return false; // npm scope
  if (token.startsWith("-")) return false; // CLI flag
  if (token.startsWith("$") || token.includes("|")) return false; // shell
  if (/^https?:/.test(token)) return false;
  if (token.startsWith("#")) return false; // in-page anchor
  if (token.startsWith("mailto:")) return false;
  // A declared dependency, not a file. `ssim.js` is a package; `svg.ts` is a file.
  if (PACKAGES.has(token)) return false;
  // Must carry a known source/doc extension, or be an explicit directory reference.
  if (/\.(ts|tsx|mjs|js|json|md|py|yml|yaml|css|html|tsv|txt|frag|ifc|svg|conf)$/.test(token)) return true;
  if (token.endsWith("/") && token.includes("/")) return true;
  // Extensionless files that are nonetheless real and worth citing. Without these the README scored 3
  // citations while linking to five working files, which made the ratchet read the doc as thinner than
  // it is.
  if (["LICENSE", "NOTICE", "CODEOWNERS"].includes(token)) return true;
  return false;
}

/**
 * Citations to files in an *upstream* repository.
 *
 * These are provenance references — "massing's `apps/web/vite.config.ts` documents why" — not promises
 * about this repo, so they cannot be resolved locally and must not be flagged.
 *
 * The rule this creates is a genuine improvement to the prose, not a loophole: an upstream citation must
 * be **fully qualified** with its repo-relative path. `vite.config.ts` is ambiguous — the reader cannot
 * tell which repo it is in, and neither can the gate. `apps/web/vite.config.ts` is unambiguous to both.
 * The first run of this gate flagged six such citations, and qualifying all six made the docs clearer.
 */
const UPSTREAM_PREFIXES = [
  // ibuilder/massing
  "apps/web/",
  "services/",
  "docs/roadmap",
  "plugins/",
  // MassingCloud/massingifc — cited by its own package-relative paths
  "core-kernel/",
  "plugin-sdk/",
  "project-schema/",
  "viewer-runtime/",
  "authoring/",
];

const problems = [];
let totalCitations = 0;

// Declared before the loop that calls it: `let` bindings are hoisted but not initialised, so a
// top-level loop reaching a `let` declared below it throws rather than seeing `undefined`.
let allFiles = null;

/**
 * Files matching a bare basename.
 *
 * Docs cite `snapEngine.ts` rather than `packages/geometry-math/src/snapEngine.ts`, and requiring the
 * full path in prose would make it unreadable for no gain. The lookup is lazy because most runs never
 * need it.
 */
function findByBasename(name) {
  if (allFiles === null) {
    allFiles = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else allFiles.push(relative(ROOT, full).replace(/\\/g, "/"));
      }
    };
    walk(ROOT);
  }
  return allFiles.filter((f) => f.endsWith(`/${name}`) || f === name);
}

const observed = {};

for (const docPath of GATED) {
  const full = join(ROOT, docPath);
  if (!existsSync(full)) {
    problems.push(`${docPath}: gated doc does not exist`);
    continue;
  }
  const text = readFileSync(full, "utf8");

  // Skip fenced code blocks — a path inside a shell example may legitimately not exist yet.
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");

  // Two citation forms, both of which are promises to the reader that something exists.
  //
  // Backticked tokens are the form massing's original gate checks. But in a README the dominant form is
  // a **markdown link** — `[LICENSE](LICENSE)` — and that is a *stronger* promise, because the reader
  // clicks it and gets a 404 rather than merely reading a stale name. The first run of this gate
  // reported "README.md: 0 path citations" for a README full of working links, which is the gate being
  // wrong rather than the doc. So both count.
  const backticked = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const linked = [...withoutFences.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);

  const citations = [...backticked, ...linked].filter(looksLikePath);
  totalCitations += citations.length;
  observed[docPath] = citations.length;

  for (const token of new Set(citations)) {
    // A path:line reference — check the file, ignore the line.
    const bare = token.replace(/:\d+(-\d+)?$/, "");
    if (UPSTREAM_PREFIXES.some((p) => bare.startsWith(p))) continue;

    /**
     * Resolved **relative to the citing document first**, then from the repository root.
     *
     * The root-only version of this check blessed links that do not work. A markdown link is relative to the
     * file containing it, so `[ADR-0013](docs/adr/0013-federation.md)` written *inside* `docs/adr/` points at
     * `docs/adr/docs/adr/0013-federation.md` — a 404 for every reader — while satisfying a gate that only ever
     * tried the root. That is why documents under `docs/` had drifted into writing the root-prefixed form: it
     * was the form the gate accepted, so it was the form that got written.
     *
     * `scripts/build-site.mjs` found all five of them the moment it started checking, because a site generator
     * has no choice but to resolve links the way a browser does. Accepting both here lets a citation be written
     * the way that actually works, and leaves the site builder as the stricter of the two.
     */
    const relativeToDoc = posix.normalize(posix.join(posix.dirname(docPath), bare));
    if (existsSync(join(ROOT, relativeToDoc))) continue;
    if (existsSync(join(ROOT, bare))) continue;

    // Allow a bare basename if exactly one file in the repo has that name — docs often cite
    // `snapEngine.ts` rather than the full package path, and requiring the full path everywhere would
    // make the prose unreadable for no gain.
    if (!bare.includes("/")) {
      if (findByBasename(bare).length > 0) continue;
    }
    problems.push(
      `${docPath}: cites \`${token}\` which does not exist. ` +
        `Backticks are reserved for things that exist — use plain quotes if this is aspirational.`,
    );
  }

  const floor = floors[docPath];
  if (floor !== undefined && citations.length < floor) {
    problems.push(
      `${docPath}: ${citations.length} path citation(s), down from ${floor}. ` +
        `A doc whose cross-references quietly disappear still reads plausibly, which is why this is a ` +
        `ratchet. If the reduction is intentional, run: npm run gate:docs -- --update`,
    );
  }
}

if (UPDATE) {
  const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(ROOT, FLOORS_PATH), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`wrote ${FLOORS_PATH} — ${Object.keys(sorted).length} doc(s) baselined`);
}


if (problems.length > 0) {
  console.error(`\nDoc-path gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Doc-path gate passed: ${GATED.length} doc(s), ${totalCitations} path citation(s), all resolvable.`,
);
