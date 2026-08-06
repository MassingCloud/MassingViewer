/**
 * Pre-flight check before extracting more code from `ibuilder/massing`.
 *
 * Two failure modes this catches, both of which have nearly happened:
 *
 * **1. Extracting from a stale clone.** The initial extraction was nearly done from a local `HEAD` that was
 * 23 commits behind `origin/main`, which would have silently dropped an entire feature — the snap-override
 * work (`snapOverride.ts`, 142 lines, plus a 192-line test) had landed upstream and was simply absent from
 * the local tree. Nothing about that failure is visible: the files you copy exist, compile, and pass their
 * tests. You just get an older product.
 *
 * **2. Extracting a file someone is mid-way through changing.** An open upstream PR touching a file being
 * moved means the port lands, the PR merges, and the two diverge on day one.
 *
 * Both are "remember to check" problems, so this is a script and a required check on extraction PRs rather
 * than a line in a document.
 *
 * Usage:
 *   node scripts/preflight-extraction.mjs                       # report
 *   node scripts/preflight-extraction.mjs viewer/snapEngine.ts  # focus on specific upstream paths
 */

import { execFileSync } from "node:child_process";

const UPSTREAM = "ibuilder/massing";

/** Directories in massing that make up the design room — the extraction surface. */
const WATCHED = [
  "apps/web/src/viewer",
  "apps/web/src/drawings",
  "apps/web/src/tools",
  "apps/web/src/kernel",
  "apps/web/src/studio",
];

const focus = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const problems = [];
const notes = [];

// --- 1. what is the current upstream tip? ------------------------------------------------------------

const tip = gh(["api", `repos/${UPSTREAM}/commits/main`, "--jq", ".sha"]).trim();
const tipDate = gh(["api", `repos/${UPSTREAM}/commits/${tip}`, "--jq", ".commit.committer.date"]).trim();
notes.push(`Upstream tip: ${tip.slice(0, 8)} (${tipDate})`);

// --- 2. open PRs touching the extraction surface -----------------------------------------------------

const openPrs = JSON.parse(
  gh([
    "api",
    `repos/${UPSTREAM}/pulls?state=open&per_page=100`,
    "--jq",
    "[.[] | {number, title, head: .head.ref}]",
  ]).trim() || "[]",
);

for (const pr of openPrs) {
  const files = gh([
    "api", `repos/${UPSTREAM}/pulls/${pr.number}/files?per_page=100`, "--jq", ".[].filename",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);

  const hits = files.filter(
    (f) =>
      WATCHED.some((w) => f.startsWith(`${w}/`)) &&
      (focus.length === 0 || focus.some((p) => f.endsWith(p))),
  );

  if (hits.length > 0) {
    problems.push(
      `Open PR #${pr.number} (${pr.head}) touches the extraction surface:\n` +
        hits.map((f) => `              ${f}`).join("\n") +
        `\n            https://github.com/${UPSTREAM}/pull/${pr.number}\n` +
        `            Land or close it upstream first, or extract different files.`,
    );
  }
}

// --- 3. is the local clone (if present) current? -----------------------------------------------------

const LOCAL = process.env.MASSING_CLONE ?? "C:/Server/modelmaker";
try {
  const localGit = (...args) =>
    execFileSync("git", args, { cwd: LOCAL, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

  localGit("fetch", "origin", "--quiet");
  const behind = Number(localGit("rev-list", "--count", "HEAD..origin/main"));
  const head = localGit("rev-parse", "HEAD");

  if (behind > 0) {
    const touched = localGit(
      "diff", "--name-only", `HEAD..origin/main`, "--", ...WATCHED,
    )
      .split("\n")
      .filter(Boolean);

    const detail =
      touched.length > 0
        ? `\n            ${touched.length} of them are in the extraction surface:\n` +
          touched.map((f) => `              ${f}`).join("\n")
        : `\n            None are in the extraction surface — but extract from origin/main anyway.`;

    problems.push(
      `Local clone at ${LOCAL} is ${behind} commit(s) behind origin/main ` +
        `(HEAD ${head.slice(0, 8)}).${detail}\n` +
        `            Extract with \`git show origin/main:<path>\`, never from the working tree. A stale ` +
        `clone drops features silently — the copied files exist, compile, and pass.`,
    );
  } else {
    notes.push(`Local clone at ${LOCAL} is current.`);
  }
} catch {
  notes.push(`No local massing clone found (set MASSING_CLONE to check one). Extract via \`gh api\`.`);
}

// ---------------------------------------------------------------------------------------------------

for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.error(`\nPre-flight found ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log(
  `\nPre-flight clear: no open upstream PR touches the extraction surface` +
    `${focus.length > 0 ? ` (filtered to ${focus.join(", ")})` : ""}. ` +
    `Extract from ${tip.slice(0, 8)}.`,
);
