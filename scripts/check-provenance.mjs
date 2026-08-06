/**
 * Provenance gate.
 *
 * Most of this repo was extracted from `ibuilder/massing`. Both are MIT with the same copyright holder,
 * so the extraction carries no licensing obligation beyond retaining the notice — but two other things
 * depend on knowing exactly which file came from where, and neither survives on trust:
 *
 *   1. **Legal review.** The audience for provenance is an enterprise reviewer asking "where did this
 *      come from". That answer should be one `grep` away, not reconstructed from commit archaeology.
 *      (We deliberately did not import filtered git history — see ADR-0005 — so the ledger *is* the
 *      record.)
 *
 *   2. **Divergence detection.** Both repos keep evolving. The weekly divergence report reads this
 *      ledger and asks GitHub which of those upstream paths have changed since the recorded SHA. A
 *      missing row means an extracted file is silently unwatched, and the first symptom is a bug fixed
 *      upstream that never arrives here — which is exactly the failure mode that turns an extraction
 *      into a fork.
 *
 * So the check is bidirectional. A file with a header and no row fails, and a row with no file fails.
 * One direction alone would let the ledger rot in the easy direction.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const LEDGER = join(ROOT, "docs", "PROVENANCE.tsv");

const HEADER_RE = /^\/\/ Extracted from ibuilder\/massing @ ([0-9a-f]{40}) \(([^)]+)\), MIT\.$/m;
const VALID_ACTIONS = new Set(["move", "port", "split", "rewrite"]);

if (!existsSync(LEDGER)) {
  console.error(`\nProvenance gate failed: ${relative(ROOT, LEDGER)} does not exist.\n`);
  process.exit(1);
}

// --- parse the ledger ------------------------------------------------------------------------------

const rows = [];
const problems = [];

const lines = readFileSync(LEDGER, "utf8").split("\n");
lines.forEach((line, i) => {
  const lineNo = i + 1;
  if (line.trim() === "" || line.startsWith("#")) return;
  if (line.startsWith("massing_path\t")) return; // column header

  const cols = line.split("\t");
  if (cols.length !== 5) {
    problems.push(`PROVENANCE.tsv:${lineNo}: expected 5 tab-separated columns, got ${cols.length}`);
    return;
  }
  const [massingPath, sha, destPath, action, date] = cols.map((c) => c.trim());

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    problems.push(`PROVENANCE.tsv:${lineNo}: "${sha}" is not a full 40-character commit SHA`);
  }
  if (!VALID_ACTIONS.has(action)) {
    problems.push(
      `PROVENANCE.tsv:${lineNo}: action "${action}" is not one of ${[...VALID_ACTIONS].join(", ")}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push(`PROVENANCE.tsv:${lineNo}: "${date}" is not an ISO date (YYYY-MM-DD)`);
  }
  if (!massingPath.startsWith("apps/web/src/") && !massingPath.startsWith("services/") && !massingPath.startsWith("scripts/")) {
    problems.push(
      `PROVENANCE.tsv:${lineNo}: "${massingPath}" does not look like a path in ibuilder/massing`,
    );
  }
  if (!existsSync(join(ROOT, destPath))) {
    problems.push(
      `PROVENANCE.tsv:${lineNo}: ledger claims "${destPath}" exists, but it does not. ` +
        `Delete the row, or restore the file.`,
    );
  }
  rows.push({ massingPath, sha, destPath, action, date, lineNo });
});

// --- find every file carrying an extraction header --------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|css|txt)$/.test(entry)) out.push(full);
  }
  return out;
}

const ledgerByDest = new Map(rows.map((r) => [r.destPath, r]));
const headered = [];

for (const file of [
  ...walk(join(ROOT, "packages")),
  ...walk(join(ROOT, "apps")),
  ...walk(join(ROOT, "docs", "pending")),
]) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const head = readFileSync(file, "utf8").slice(0, 4000);
  const match = HEADER_RE.exec(head);
  if (!match) continue;

  headered.push(rel);
  const [, sha, massingPath] = match;
  const row = ledgerByDest.get(rel);

  if (!row) {
    problems.push(
      `${rel}: carries an extraction header but has no row in docs/PROVENANCE.tsv. ` +
        `Add:\n            ${massingPath}\\t${sha}\\t${rel}\\t<move|port>\\t<YYYY-MM-DD>`,
    );
    continue;
  }
  if (row.sha !== sha) {
    problems.push(
      `${rel}: header says @${sha.slice(0, 8)} but the ledger says @${row.sha.slice(0, 8)}. ` +
        `The divergence report reads the ledger, so a wrong SHA means this file is watched from the ` +
        `wrong baseline.`,
    );
  }
  if (row.massingPath !== massingPath) {
    problems.push(
      `${rel}: header says it came from "${massingPath}" but the ledger says "${row.massingPath}".`,
    );
  }
}

// --- the other direction: a row whose file has lost its header ---------------------------------------

const headeredSet = new Set(headered);
for (const row of rows) {
  if (!headeredSet.has(row.destPath) && existsSync(join(ROOT, row.destPath))) {
    problems.push(
      `PROVENANCE.tsv:${row.lineNo}: "${row.destPath}" is in the ledger but carries no ` +
        `"// Extracted from ibuilder/massing @ ..." header. Restore the header, or remove the row if ` +
        `the file has been rewritten from scratch.`,
    );
  }
}

// --- ledger hygiene ---------------------------------------------------------------------------------

const seenDest = new Map();
for (const row of rows) {
  if (seenDest.has(row.destPath)) {
    problems.push(
      `PROVENANCE.tsv:${row.lineNo}: "${row.destPath}" already has a row at line ` +
        `${seenDest.get(row.destPath)}. One destination, one row.`,
    );
  }
  seenDest.set(row.destPath, row.lineNo);
}

// ---------------------------------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`\nProvenance gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

const shas = new Set(rows.map((r) => r.sha));
console.log(
  `Provenance gate passed: ${rows.length} extracted file(s) from ${shas.size} upstream commit(s), ` +
    `ledger and headers agree in both directions.`,
);
