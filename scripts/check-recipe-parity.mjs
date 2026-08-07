/**
 * Recipe parity gate — coverage is a ratcheted number, not a vibe.
 *
 * `fixtures/recipes.tsv` lists all 96 operations massing's authoring service implements, with a per-kernel
 * status column. This gate keeps that file honest in the ways a reviewer cannot check by eye:
 *
 *   1. The vocabulary is closed. A typo'd status ("partial", "wip") would otherwise read as coverage.
 *   2. No duplicates, no blank recipe names, every row has every column.
 *   3. `yes` counts never drop below the committed floor below.
 *
 * What this gate deliberately does **not** check is whether a `yes` is true — a script reading a TSV cannot
 * know that. That check lives where the kernel does: `@massingviewer/kernel-conformance` reads this same file
 * and asserts, against a live kernel, that every `yes` op actually works and every non-`yes` op returns
 * `unsupported`. So the TSV cannot lie in either direction, and the two halves of the check are in the two
 * places that can each see half the truth.
 *
 * The floor is the ratchet. It is a literal here rather than a generated file on purpose: raising it must be a
 * human decision visible in a reviewed diff, and a gate that updates its own baseline is not a gate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "fixtures/recipes.tsv";

/** Total operations the remote service implements. A change here is a re-extraction, and must be reviewed. */
const TOTAL = 96;

/**
 * Minimum `yes` count per kernel. **Only ever increases.**
 *
 * `local` went 0 → 15 when `LocalKernel`'s conformance suite went green, and not one commit sooner. While the
 * fifteen were merely intended they sat in the `planned` column and this floor read 0, because a floor of 0 was
 * the honest statement of "nothing verified yet" — writing 15 to match an intention would have made the gate
 * assert a wish. The suite promoted them by failing until the ledger caught up, which is the ratchet working in
 * the direction it was built for.
 *
 * `remote` stays 0: `RemoteKernel` needs a reachable massing server.
 */
const FLOOR = { memory: 7, local: 15, remote: 0 };

const STATUSES = new Set(["yes", "planned", "no"]);

const problems = [];
const text = readFileSync(join(root, LEDGER), "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));

const header = lines.shift()?.split("\t") ?? [];
if (header[0] !== "recipe" || header[1] !== "category") {
  problems.push(`${LEDGER}: header must start "recipe\\tcategory", got ${JSON.stringify(header.slice(0, 2))}`);
}
const kernels = header.slice(2);
if (kernels.length === 0) problems.push(`${LEDGER}: no kernel columns`);

const seen = new Set();
const counts = Object.fromEntries(kernels.map((k) => [k, { yes: 0, planned: 0, no: 0 }]));
const categories = new Map();

for (const [i, line] of lines.entries()) {
  const row = line.split("\t");
  const where = `${LEDGER}:${i + 2}`;
  if (row.length !== header.length) {
    problems.push(`${where}: ${row.length} column(s), expected ${header.length} — is a tab missing?`);
    continue;
  }
  const [recipe, category] = row;
  if (!recipe) problems.push(`${where}: blank recipe name`);
  if (seen.has(recipe)) problems.push(`${where}: "${recipe}" listed twice`);
  seen.add(recipe);
  if (!category) problems.push(`${where}: "${recipe}" has no category`);
  categories.set(category, (categories.get(category) ?? 0) + 1);

  for (const [j, kernel] of kernels.entries()) {
    const status = row[j + 2];
    if (!STATUSES.has(status)) {
      problems.push(
        `${where}: "${recipe}" has status "${status}" for ${kernel} — must be one of ${[...STATUSES].join(", ")}`,
      );
      continue;
    }
    counts[kernel][status] += 1;
  }
}

if (seen.size !== TOTAL) {
  problems.push(
    `${LEDGER}: ${seen.size} recipes, expected ${TOTAL}. If the service gained or lost a recipe, ` +
      `re-extract from massing's edit.py and update TOTAL in this script in the same commit.`,
  );
}

for (const kernel of kernels) {
  const floor = FLOOR[kernel];
  if (floor === undefined) {
    problems.push(`${LEDGER}: kernel column "${kernel}" has no entry in FLOOR — add one, even if it is 0`);
    continue;
  }
  const actual = counts[kernel].yes;
  if (actual < floor) {
    problems.push(
      `${kernel} coverage regressed: ${actual} verified, floor is ${floor}. ` +
        `A recipe moved out of "yes" — either restore it, or lower the floor with the reason in the commit.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Recipe parity gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

const pct = (n) => `${((n / TOTAL) * 100).toFixed(1)}%`;
console.log(`Recipe parity gate passed: ${TOTAL} recipes across ${categories.size} categories.`);
for (const kernel of kernels) {
  const c = counts[kernel];
  const ahead = c.yes > FLOOR[kernel] ? `  ← floor ${FLOOR[kernel]}, raise it` : "";
  console.log(
    `  ${kernel.padEnd(8)} ${String(c.yes).padStart(3)} verified (${pct(c.yes).padStart(6)})` +
      `  ${String(c.planned).padStart(3)} planned  ${String(c.no).padStart(3)} out of scope${ahead}`,
  );
}
