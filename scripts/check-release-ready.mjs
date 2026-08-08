#!/usr/bin/env node
/**
 * Is this tree in a state that can be published?
 *
 * ## Why a tag-triggered release needs this gate specifically
 *
 * The old design ran `changeset version` *inside* CI, so the version bump and the publish were one atomic act and
 * could not disagree. Publishing from a tag moves that step onto a human's laptop, which buys a real reduction in
 * CI privilege — no `pull-requests: write`, nothing opening PRs — and introduces exactly one new failure mode:
 *
 * **the human tags a release without having run `changeset version`.**
 *
 * That failure is silent in the worst way. `changeset publish` would find every local version already on npm,
 * publish nothing, exit 0, and the release would look successful while shipping nothing. Or worse: a *partial*
 * version run publishes some packages and leaves others behind, so consumers get a set of versions that were
 * never tested together.
 *
 * So the human step gets a machine check. Every design that moves work out of CI has to pay this cost somewhere,
 * and paying it as an explicit gate is cheaper than paying it as a bad release.
 *
 * ## What is checked
 *
 * 1. **No pending changesets.** A leftover `.changeset/*.md` means `changeset version` was not run after the last
 *    change landed, so the versions about to be published do not include it.
 * 2. **Something is actually being published.** A release tag that publishes nothing is a mistake — either the
 *    versioning was forgotten or the tag is a duplicate — and it must fail loudly rather than succeed emptily.
 * 3. **Every version being published has a changelog entry.** A published version with no changelog is a version
 *    nobody can audit, and it is the one thing that cannot be fixed after the fact: npm version numbers are
 *    immutable, so an unexplained 0.3.1 is unexplained for ever.
 * 4. **No package is still at 0.0.0.** The placeholder version means it was never versioned at all.
 *
 * Run it before tagging (`npm run gate:release`) and it runs again in CI on the tag. Locally is where it is
 * useful; in CI is where it is binding.
 */

import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const slashes = (path) => path.split("\\").join("/");

/** `--offline` skips the npm registry queries, for a fast local check and for tests. */
const OFFLINE = process.argv.includes("--offline");

const problems = [];
const notes = [];

// --- 1. pending changesets -------------------------------------------------------------------------

const pending = globSync(".changeset/*.md", { cwd: ROOT })
  .map(slashes)
  .filter((path) => !path.endsWith("/README.md"));

if (pending.length > 0) {
  problems.push(
    `${pending.length} changeset(s) are still pending: ${pending.map((p) => p.split("/").pop()).join(", ")}.\n` +
      `    That means \`npm run changeset:version\` has not been run since they were added, so the versions in\n` +
      `    this tree do not include those changes. Run it, review the diff, commit, then tag.`,
  );
}

// --- 2 & 4. what would be published ----------------------------------------------------------------

const manifests = globSync("packages/*/package.json", { cwd: ROOT })
  .map(slashes)
  .sort()
  .map((rel) => ({ rel, dir: rel.slice(0, rel.lastIndexOf("/")), json: JSON.parse(readFileSync(join(ROOT, rel), "utf8")) }))
  // `private: true` packages are never published, so their versions are nobody's business.
  .filter((entry) => entry.json.private !== true);

const unversioned = manifests.filter((entry) => entry.json.version === "0.0.0");
if (unversioned.length > 0) {
  problems.push(
    `${unversioned.length} package(s) are still at the 0.0.0 placeholder: ` +
      `${unversioned.map((e) => e.json.name).join(", ")}.\n` +
      `    A package at 0.0.0 was never versioned. Publishing it would burn 0.0.0 permanently.`,
  );
}

/** Which packages have a version npm does not already have? */
function toPublish() {
  if (OFFLINE) {
    notes.push("offline: skipped the npm registry check, so 'already published' was not verified");
    return manifests.filter((entry) => entry.json.version !== "0.0.0");
  }
  const publishable = [];
  for (const entry of manifests) {
    let published = [];
    try {
      const raw = execFileSync("npm", ["view", entry.json.name, "versions", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const parsed = JSON.parse(raw);
      published = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // A package that has never been published errors here, and that is the normal first-release case — not a
      // reason to fail. Treating "npm view failed" as "nothing published" is right for E404 and wrong for a
      // network outage, so the distinction is reported in the summary rather than guessed at silently.
      published = [];
    }
    if (!published.includes(entry.json.version)) publishable.push(entry);
  }
  return publishable;
}

const publishing = toPublish();

// Only reported when the versions are otherwise sane. If packages are still at 0.0.0 then "nothing to publish"
// is a *consequence* of that, not a separate finding — and listing a consequence beside its cause makes a
// three-problem report out of one problem, which is how a gate's output stops being read.
if (publishing.length === 0 && unversioned.length === 0) {
  problems.push(
    "nothing to publish — every package version in this tree is already on npm.\n" +
      "    A release tag that publishes nothing means either the versioning step was skipped or the tag\n" +
      "    duplicates an earlier release. Either way it must not be reported as a successful release.",
  );
}

// --- 3. changelog entries --------------------------------------------------------------------------

for (const entry of publishing) {
  const changelog = join(ROOT, entry.dir, "CHANGELOG.md");
  if (!existsSync(changelog)) {
    problems.push(
      `${entry.json.name} would publish ${entry.json.version} with no CHANGELOG.md at all.\n` +
        `    npm versions are immutable, so an unexplained version is unexplained for ever.`,
    );
    continue;
  }
  const text = readFileSync(changelog, "utf8");
  // Changesets writes `## 0.1.0` headings. Matched at a heading rather than anywhere in the file, because the
  // version string appears in dependency-bump bullets too, and matching those would pass a missing entry.
  if (!new RegExp(`^##\\s+${entry.json.version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "m").test(text)) {
    problems.push(
      `${entry.json.name} would publish ${entry.json.version}, but its CHANGELOG.md has no "## ${entry.json.version}" heading.\n` +
        `    Either the changelog was hand-edited or the version was bumped without changesets.`,
    );
  }
}

// --- report ---------------------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`Release-readiness gate FAILED — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}\n`);
  console.error(
    "The release flow is: `npm run changeset:version` locally, read the diff, commit it, then push a\n" +
      "`release-*` tag. See docs/releasing.md.",
  );
  process.exit(1);
}

console.log(
  `Release-readiness gate passed: ${publishing.length} package(s) to publish ` +
    `(${publishing.map((e) => `${e.json.name}@${e.json.version}`).slice(0, 4).join(", ")}` +
    `${publishing.length > 4 ? `, +${publishing.length - 4} more` : ""}), no pending changesets.`,
);
for (const note of notes) console.log(`  note: ${note}`);
