#!/usr/bin/env node
/**
 * Feature flags must not outlive their expiry date.
 *
 * ## Why this is a gate and not a convention
 *
 * A flag added "for two weeks" is still there two years later. Nobody removes it, because removing it means
 * deciding which branch is the real one — and by then nobody remembers. A codebase with forty permanent flags has
 * 2^40 configurations, of which one is tested.
 *
 * So the declaration carries a required `until`, and this makes passing it a build failure. Same ratchet
 * discipline as the licence exceptions, pointed at the thing that otherwise accumulates silently.
 *
 * ## Why the date comes from git, not from the clock
 *
 * A gate that reads the wall clock fails on a *date* rather than on a *change*: a build that passed yesterday
 * fails today with no commit in between, usually on someone else's unrelated PR. That is the shape of a gate
 * people learn to route around, and a gate that gets routed around is worse than none.
 *
 * Reading the committed HEAD date means the gate fails for the person whose commit crossed the line, in their own
 * build, which is when the decision is cheapest to make. `--today` overrides it for a test.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "packages", "observability", "src", "flags.ts");

const override = process.argv.find((arg) => arg.startsWith("--today="))?.split("=")[1];

function commitDate() {
  try {
    // The committer date of HEAD, as YYYY-MM-DD.
    return execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // A tarball with no git history. Falling back to the clock is the lesser evil — the alternative is a gate
    // that silently passes, which is the failure mode this whole file exists to avoid.
    return new Date().toISOString().slice(0, 10);
  }
}

const today = override ?? commitDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`Flag gate: "${today}" is not a date.`);
  process.exit(1);
}

const source = readFileSync(SOURCE, "utf8");

/**
 * Parse `APP_FLAGS` out of the source.
 *
 * Regex rather than importing the module, because this gate runs on a fresh clone with nothing built — the same
 * constraint the other gates work under. It is brittle by nature, so the brittleness is made *loud*: if the
 * declaration block cannot be found at all, the gate fails rather than reporting zero flags. A gate that
 * silently finds nothing is a gate that passes forever.
 */
const block = /export const APP_FLAGS[^=]*=\s*(\[[\s\S]*?\n\]);/.exec(source);
if (block === null) {
  console.error(
    `Flag gate: could not find \`export const APP_FLAGS = [...]\` in packages/observability/src/flags.ts.\n` +
      `That is a failure, not an absence: this gate is only useful if it can see the declarations, and a parse\n` +
      `miss would otherwise report "0 flags, all fine" forever.`,
  );
  process.exit(1);
}

const flags = [];
for (const entry of block[1].matchAll(/\{[^{}]*\}/g)) {
  const text = entry[0];
  const key = /key:\s*"([^"]+)"/.exec(text)?.[1];
  const until = /until:\s*"([^"]+)"/.exec(text)?.[1];
  const owner = /owner:\s*"([^"]+)"/.exec(text)?.[1];
  flags.push({ key, until, owner, text });
}

const problems = [];
for (const flag of flags) {
  if (flag.key === undefined) problems.push(`a declaration has no \`key\`: ${flag.text.slice(0, 60)}`);
  if (flag.until === undefined) {
    problems.push(`${flag.key ?? "?"} has no \`until\` — an optional expiry is an expiry nobody sets`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flag.until)) {
    problems.push(`${flag.key}'s \`until\` is "${flag.until}", which is not an ISO date`);
    continue;
  }
  if (flag.owner === undefined || flag.owner === "") {
    problems.push(`${flag.key} has no \`owner\` — somebody has to make the removal decision`);
  }
  if (flag.until < today) {
    problems.push(
      `${flag.key} expired on ${flag.until} (HEAD is ${today}), owner ${flag.owner ?? "?"}. ` +
        `Remove the flag and one of its branches, or move the date with a reason in the commit.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Flag gate failed — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(
    `\nA flag with no expiry becomes permanent, and a codebase with forty permanent flags has 2^40\n` +
      `configurations of which one is tested. Deciding which branch is real is cheapest now.`,
  );
  process.exit(1);
}

console.log(
  flags.length === 0
    ? `Flag gate passed: no feature flags declared (HEAD ${today}).`
    : `Flag gate passed: ${flags.length} flag(s), none expired as of HEAD ${today}.`,
);
