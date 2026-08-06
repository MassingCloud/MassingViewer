/**
 * Upstream divergence report.
 *
 * This is the single most important piece of process automation in the repo, and the reason
 * `docs/PROVENANCE.tsv` exists at all.
 *
 * ## The problem it solves
 *
 * About 14,000 lines here were extracted from `ibuilder/massing`. Both repos keep evolving. Nothing in git
 * connects them, so a bug fixed upstream in a file we copied will never arrive — and the first symptom is
 * someone re-reporting a bug that was fixed months ago in the other repo. That is how an extraction quietly
 * becomes a fork.
 *
 * The rate is not theoretical. During the initial extraction session, massing advanced **15 commits in
 * about 90 minutes**. None touched the extracted paths — verified, not assumed — but at that rate,
 * "remembering to check" is not a plan.
 *
 * ## What it does
 *
 * For each row in the ledger, ask GitHub whether that upstream path has changed since the recorded SHA. If
 * anything has, maintain **one** tracking issue listing every drifted file with links. One issue, updated —
 * not a new issue per run, which is how a bot gets muted.
 *
 * Silence is meaningful here: an empty report means every extracted file is still current, which is a claim
 * worth being able to make.
 *
 * Usage:
 *   node scripts/divergence-report.mjs            # print a report
 *   node scripts/divergence-report.mjs --issue    # also create/update the tracking issue (needs gh)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPSTREAM = "ibuilder/massing";
const ISSUE_TITLE = "Upstream divergence: extracted files changed in ibuilder/massing";
const WRITE_ISSUE = process.argv.includes("--issue");

/**
 * Run `gh`, and distinguish "the query worked and found nothing" from "the query failed".
 *
 * This distinction is the whole correctness of this script and it was got wrong first time: a malformed jq
 * expression made every lookup fail, the failures were swallowed as empty output, and the script cheerfully
 * reported **"No divergence: every extracted file is current."** A divergence bot that says all-clear when it
 * is actually broken is strictly worse than no bot, because it manufactures confidence.
 *
 * So failures throw, and the caller decides. Nothing here returns `""` to mean "fine".
 */
function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = (e.stderr ?? "").toString().trim();
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr || e.message}`);
  }
}

/** For genuinely optional lookups (an issue that may not exist). Distinguished by name, not a flag. */
function ghOptional(args) {
  try {
    return gh(args);
  } catch {
    return "";
  }
}

// --- read the ledger --------------------------------------------------------------------------------

const rows = readFileSync(join(ROOT, "docs/PROVENANCE.tsv"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#") && !l.startsWith("massing_path\t"))
  .map((l) => l.split("\t"))
  .filter((c) => c.length === 5)
  .map(([massingPath, sha, destPath, action, date]) => ({ massingPath, sha, destPath, action, date }));

if (rows.length === 0) {
  console.log("Ledger is empty — nothing extracted, nothing to watch.");
  process.exit(0);
}

// Group by upstream path: several destinations can share one source (a file that was split).
const byPath = new Map();
for (const row of rows) {
  if (!byPath.has(row.massingPath)) byPath.set(row.massingPath, { sha: row.sha, dests: [] });
  byPath.get(row.massingPath).dests.push({ path: row.destPath, action: row.action });
}

console.log(`Checking ${byPath.size} upstream path(s) against ${UPSTREAM}…\n`);

// --- ask GitHub what has changed --------------------------------------------------------------------

/**
 * Compare a baseline commit against the upstream default branch.
 *
 * ## Why this uses the compare API and NOT `GET /commits?path=…&since=…`
 *
 * The first version of this script did use `?since=`, and it produced a **false negative on a real
 * change**: `apps/web/src/viewer/toolbarLayout.ts` had been modified upstream and the report said
 * "no divergence".
 *
 * The cause is fundamental rather than a typo. `?since=` filters by *committer date*, and a date cannot
 * express "since this commit" in git. In the observed case the baseline was a merge commit dated 07:43,
 * and the commit that changed the file was dated **07:36** — seven minutes *earlier*, because it was
 * authored on a branch and merged afterwards. It is reachable only after the baseline, but its date
 * precedes it, so a date filter drops it. Squash-and-merge and rebase workflows produce this routinely,
 * which means the bug would have hit constantly while looking like good news.
 *
 * `/compare/{base}...{head}` is SHA-based and exact: it answers "what changed between these two commits"
 * without reference to any clock. One call replaces one-per-path, which is also 20x fewer requests.
 */
function compareUpstream(baseline) {
  const files = [];
  const commits = [];
  let page = 1;
  let totalCommits = 0;
  let totalFiles = null;

  // The compare endpoint caps `files` at 300 and `commits` at 250 per response, and paginates both.
  for (;;) {
    const raw = gh([
      "api",
      `repos/${UPSTREAM}/compare/${baseline}...${DEFAULT_BRANCH}?per_page=100&page=${page}`,
    ]);
    const data = JSON.parse(raw);
    totalCommits = data.total_commits ?? 0;
    if (totalFiles === null) totalFiles = data.files?.length ?? 0;

    for (const f of data.files ?? []) files.push({ filename: f.filename, status: f.status });
    for (const c of data.commits ?? []) {
      commits.push({
        sha: c.sha,
        date: c.commit?.committer?.date ?? "",
        message: (c.commit?.message ?? "").split("\n")[0],
      });
    }

    // Stop when a page adds nothing new.
    if ((data.files?.length ?? 0) === 0 && (data.commits?.length ?? 0) === 0) break;
    if (page >= 30) break; // hard stop; 3000 files is far beyond anything meaningful here
    page++;
  }

  return {
    files,
    commits,
    totalCommits,
    // Reported so an under-count is visible rather than silent. GitHub truncates very large comparisons,
    // and a truncated comparison that reads as "nothing changed" is the failure mode this whole function
    // exists to avoid.
    truncated: totalCommits > commits.length,
  };
}

const DEFAULT_BRANCH = gh([
  "api", `repos/${UPSTREAM}`, "--jq", ".default_branch",
]).trim();

const drifted = [];
const failures = [];
const warnings = [];
let checked = 0;

// One compare per distinct baseline. The ledger normally shares a single baseline across every row.
const baselines = [...new Set([...byPath.values()].map((v) => v.sha))];
const comparisons = new Map();

for (const baseline of baselines) {
  try {
    const result = compareUpstream(baseline);
    comparisons.set(baseline, result);
    console.log(
      `  · ${baseline.slice(0, 8)}..${DEFAULT_BRANCH}: ${result.totalCommits} commit(s), ` +
        `${result.files.length} file(s) changed`,
    );
    if (result.truncated) {
      warnings.push(
        `Comparison from ${baseline.slice(0, 8)} is truncated by the API ` +
          `(${result.totalCommits} commits, ${result.commits.length} returned). Per-file drift detection ` +
          `is still exact — it reads the file list — but the commit detail below is incomplete.`,
      );
    }
  } catch (e) {
    failures.push({ path: `baseline ${baseline.slice(0, 8)}`, error: e instanceof Error ? e.message : String(e) });
  }
}

for (const [path, { sha, dests }] of byPath) {
  checked++;
  const cmp = comparisons.get(sha);
  if (!cmp) continue; // its baseline comparison failed; already recorded

  const changed = cmp.files.find((f) => f.filename === path);
  if (!changed) continue;

  // Narrow the commit list to those that actually touched this path. The commit set from `compare` is the
  // exact set between the two SHAs, so intersecting against a per-path listing stays SHA-based throughout —
  // no dates anywhere in this path of the logic.
  let commits = [];
  try {
    const jq = String.raw`.[] | "\(.sha)\t\(.commit.committer.date)\t\(.commit.message | split("\n")[0])"`;
    const inRange = new Set(cmp.commits.map((c) => c.sha));
    commits = gh([
      "api",
      `repos/${UPSTREAM}/commits?path=${encodeURIComponent(path)}&sha=${DEFAULT_BRANCH}&per_page=100`,
      "--jq",
      jq,
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [csha, date, message] = l.split("\t");
        return { sha: csha, date, message };
      })
      .filter((c) => inRange.has(c.sha));
  } catch (e) {
    failures.push({ path, error: e instanceof Error ? e.message : String(e) });
    continue;
  }

  drifted.push({ path, baseline: sha, dests, commits, status: changed.status });
  console.log(`  ! ${path} — ${changed.status}, ${commits.length} commit(s)`);
}

// A path we could not check is NOT a path that is fine. Fail loudly rather than under-reporting, because
// the entire value of this script is that its silence means something.
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n`);
  for (const f of failures) console.error(`  x ${f.path}: ${f.error}`);
  console.error(
    `\nThis is a broken report, not a clean one — do not read the result below as "no divergence".\n`,
  );
  process.exit(2);
}

for (const w of warnings) console.warn(`  ! ${w}`);

// --- report -----------------------------------------------------------------------------------------

if (drifted.length === 0) {
  console.log(
    `\nNo divergence: all ${checked} extracted path(s) are unchanged upstream since their recorded ` +
      `baseline. Every extracted file is current.`,
  );
  if (WRITE_ISSUE) {
    // Close a previously-open issue rather than leaving a stale alarm sitting there.
    const open = ghOptional(["issue", "list", "--search", `"${ISSUE_TITLE}" in:title`, "--state", "open", "--json", "number", "--jq", ".[0].number"]).trim();
    if (open) {
      ghOptional(["issue", "close", open, "--comment", "All extracted paths are current upstream again. Closing; the weekly report will reopen this if that changes."]);
      console.log(`Closed tracking issue #${open}.`);
    }
  }
  process.exit(0);
}

const body = [
  `Extracted files whose **upstream** source has changed since the commit recorded in`,
  `\`docs/PROVENANCE.tsv\`. Each needs a decision, not necessarily a port:`,
  ``,
  `- **Port it** — re-extract, update the header and the ledger row (see CONTRIBUTING.md).`,
  `- **Decline it** — the change does not apply here. Re-baseline the ledger row to the new SHA *after*`,
  `  reading the diff, and say why in the commit message.`,
  ``,
  `Doing neither is the failure mode: the file silently stops being watched from a meaningful baseline.`,
  ``,
  `---`,
  ``,
]
  .concat(
    drifted.flatMap(({ path, baseline, dests, commits }) => [
      `### \`${path}\``,
      ``,
      `Baseline: [\`${baseline.slice(0, 8)}\`](https://github.com/${UPSTREAM}/commit/${baseline})`,
      `Here: ${dests.map((d) => `\`${d.path}\` (${d.action})`).join(", ")}`,
      ``,
      ...commits.map(
        (c) =>
          `- [\`${c.sha.slice(0, 8)}\`](https://github.com/${UPSTREAM}/commit/${c.sha}) ` +
          `${c.date.slice(0, 10)} — ${c.message}`,
      ),
      ``,
      `[Full diff](https://github.com/${UPSTREAM}/compare/${baseline}...main)`,
      ``,
    ]),
  )
  .join("\n");

console.log(`\n${drifted.length} path(s) have diverged.\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Upstream divergence\n\n${body}\n`);
}

if (WRITE_ISSUE) {
  const existing = ghOptional(["issue", "list", "--search", `"${ISSUE_TITLE}" in:title`, "--state", "open", "--json", "number", "--jq", ".[0].number"]).trim();

  if (existing) {
    // Edit the body rather than commenting. A bot that appends a comment every week trains people to mute
    // it; one issue whose body is always the current state stays readable.
    gh(["issue", "edit", existing, "--body", body]);
    console.log(`Updated tracking issue #${existing}.`);
  } else {
    const url = gh([
      "issue", "create",
      "--title", ISSUE_TITLE,
      "--body", body,
      "--label", "upstream-divergence",
    ]).trim();
    console.log(`Opened tracking issue: ${url}`);
  }
} else {
  console.log(body);
}

// Exit non-zero only when asked to gate. The weekly run reports; it does not fail the repo for something
// that happened in a different repo.
process.exit(process.argv.includes("--fail-on-drift") ? 1 : 0);
