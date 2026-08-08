#!/usr/bin/env node
/**
 * Tag every published package at its current version, and push.
 *
 * ## Why this exists rather than trusting `changeset publish`
 *
 * `changeset publish` prints `New tag: @massing/core@0.1.0` for each package, and the obvious reading is that it
 * has created a git tag. Twice now the tags have not reached the remote:
 *
 * 1. The first release had no push step at all — the tags were created on the runner and died with it.
 * 2. The second added `git push origin --tags`, which reported **"Everything up-to-date"**. So at the moment the
 *    push ran, the tags changesets had just announced were not in the local repository.
 *
 * I could not explain the second, and a release record that depends on behaviour I cannot explain is not a record.
 * So this does the tagging itself, from the one source of truth that cannot be ambiguous: what each package
 * manifest says its version is, right now, in the tree that was just published.
 *
 * Idempotent by design. An existing tag is skipped rather than failing the run, because a re-run of a partially
 * failed release is a normal thing to do — `changeset publish` is itself a no-op for anything already on npm, and
 * this has to match that.
 */

import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const slashes = (path) => path.split("\\").join("/");
const DRY = process.argv.includes("--dry-run");

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Tags already in this repository, so an existing one can be skipped rather than throwing. */
const existing = new Set(git(["tag", "-l"]).split("\n").filter((line) => line !== ""));

const created = [];
const skipped = [];

for (const rel of globSync("packages/*/package.json", { cwd: ROOT }).map(slashes).sort()) {
  const manifest = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  if (manifest.private === true) continue;
  if (typeof manifest.version !== "string" || manifest.version === "0.0.0") continue;

  const tag = `${manifest.name}@${manifest.version}`;
  if (existing.has(tag)) {
    skipped.push(tag);
    continue;
  }
  if (!DRY) git(["tag", tag]);
  created.push(tag);
}

if (created.length === 0) {
  console.log(`tag-published: nothing to tag (${skipped.length} already tagged).`);
  process.exit(0);
}

console.log(`tag-published: ${created.length} new tag(s):`);
for (const tag of created) console.log(`  ${tag}`);
if (skipped.length > 0) console.log(`  (${skipped.length} already existed)`);

if (DRY) {
  console.log("tag-published: --dry-run, nothing pushed.");
  process.exit(0);
}

// Pushed explicitly by name rather than with `--tags`. `--tags` is what reported "Everything up-to-date" while
// leaving the remote without them, and naming the refs means the push either moves them or fails saying why.
git(["push", "origin", ...created]);
console.log(`tag-published: pushed ${created.length} tag(s).`);
