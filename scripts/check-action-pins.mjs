/**
 * Every pinned GitHub Action SHA must actually exist.
 *
 * ## Why this exists
 *
 * Pinning to a SHA is a supply-chain measure — it stops a tag being moved under you — but it only works if the
 * SHA is real, and nothing else in the pipeline checks that. `zizmor` checks that actions *are* pinned rather
 * than floating on a tag; it does not resolve them. So a wrong pin passes every local gate and fails at the one
 * moment the workflow runs, which for a release workflow is the worst moment available.
 *
 * ## The mistake that prompted it, told accurately
 *
 * Not a fabricated SHA. `actions/cache` was pinned to `0400d5f6…` commented `# v4`, and both were correct: that
 * commit is exactly the `v4.2.4` tag. What went wrong was the *verification*. Checking a pin by fetching
 * `git/ref/tags/v4` returns whatever the `v4` tag currently points at — the newest v4 release — which differs
 * from any older-but-valid v4 commit. Seeing the two differ, I concluded the pin was invented, "fixed" a
 * non-problem, and reported having fabricated a SHA. Both claims were wrong.
 *
 * The lesson is exactly what this script encodes: **a tag lookup is not an existence check.** Resolving the
 * commit is. `repos/{repo}/commits/{sha}` answers the question actually being asked, and answers it for any
 * commit on any branch or tag.
 *
 * ## Why it validates its own resolver before believing a single answer
 *
 * Because the first version of this could not be trusted and I could not immediately tell. It used `fetch`, and
 * on the fabricated-SHA test it reported "resolves" — which looked like proof of an intercepting proxy, and was
 * really just the commit existing after all. Either way the diagnosis was unavailable from the output.
 *
 * So before any real pin is checked, the resolver is asked for a SHA that *cannot* exist. If it says that one
 * resolves, the environment is answering for the API and this script refuses to report at all rather than
 * declaring every pin fine. "Could not check" and "checked and fine" are different answers, and the whole
 * episode above came from conflating them.
 *
 * ## Why it is not in `npm run gates`
 *
 * It needs the network and the `gh` CLI. `gates` must pass offline — on a plane, in a locked-down container,
 * during a GitHub outage — so a check that cannot is one that makes the whole suite unreliable. This runs in
 * `security.yml`, where network access is a given, `gh` is preinstalled on the runners, and the other
 * supply-chain checks already live.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";

/**
 * A SHA that cannot exist in any repository: forty zeroes is the null object id.
 *
 * Used to prove the resolver actually discriminates before its answers are believed.
 */
const IMPOSSIBLE_SHA = "0".repeat(40);

/**
 * Resolve a commit through `gh api`.
 *
 * Returns `null` when the lookup itself could not be performed — which is deliberately distinct from "the commit
 * does not exist", because treating an unreachable API as a bad pin would fail the build for the wrong reason and
 * a gate that cries wolf gets switched off.
 */
function resolveSha(repo, sha) {
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { exists: out.trim() === sha };
  } catch (cause) {
    const message = String(cause.stderr ?? cause.message ?? "");
    // A genuine 404/422 is the answer we want. Anything else — no auth, no network, rate limit — is not an answer.
    if (/HTTP 404|HTTP 422|Not Found|No commit found/i.test(message)) return { exists: false };
    return null;
  }
}

/** Every `uses: owner/repo[/sub/path]@<ref>` in every workflow, deduplicated by repository and ref. */
function collect() {
  const found = new Map();
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const text = readFileSync(join(DIR, file), "utf8");

    for (const m of text.matchAll(/uses:\s*([\w./-]+)@([^\s#]+)\s*(?:#\s*(\S+))?/g)) {
      const [, path, ref, comment] = m;
      // A local action (`./.github/actions/...`) has no repository to resolve.
      if (path.startsWith(".")) continue;
      // Only the first two segments are the repository — `github/codeql-action/init` is a subdirectory action,
      // not a repo called `init`. An earlier version got that wrong and reported CodeQL as broken, which is a
      // reminder that a gate's false positives cost more than the bugs it catches.
      const repo = path.split("/").slice(0, 2).join("/");
      const key = `${repo}@${ref}`;
      if (!found.has(key)) found.set(key, { repo, ref, comment: comment ?? null, file, path });
    }
  }
  return [...found.values()];
}

const entries = collect();
if (entries.length === 0) {
  console.log("Action-pin check: no external actions are used.");
  process.exit(0);
}

// --- validate the instrument before believing it ---------------------------------------------------

const control = entries[0].repo;
const negative = resolveSha(control, IMPOSSIBLE_SHA);
if (negative === null) {
  console.error(
    "Action-pin check could not run: `gh api` did not answer.\n" +
      "  Needs the GitHub CLI, authenticated, with network access. Failing rather than passing, because " +
      '"could not check" and "checked and fine" are different answers.\n',
  );
  process.exit(2);
}
if (negative.exists) {
  console.error(
    "Action-pin check is not trustworthy in this environment and refuses to report.\n" +
      `  It asked ${control} for commit ${IMPOSSIBLE_SHA} — which cannot exist — and was told it does.\n` +
      "  Something is answering for the API (a proxy, a cache, an interception layer). An earlier version of\n" +
      "  this script used raw HTTP here and passed the exact fabricated SHA it was written to catch.\n",
  );
  process.exit(2);
}

// --- now check the real pins -----------------------------------------------------------------------

const problems = [];
let checked = 0;

for (const entry of entries) {
  // An unpinned action is a different problem and `zizmor` already reports it. Two gates failing for one cause
  // makes the real one harder to find.
  if (!/^[0-9a-f]{40}$/.test(entry.ref)) {
    problems.push(
      `${entry.file}: ${entry.path}@${entry.ref} is not pinned to a full commit SHA — a tag can be moved under you`,
    );
    continue;
  }

  const result = resolveSha(entry.repo, entry.ref);
  if (result === null) {
    problems.push(`${entry.file}: ${entry.path}@${entry.ref} could not be checked — the API did not answer`);
    continue;
  }
  checked += 1;
  if (!result.exists) {
    problems.push(
      `${entry.file}: ${entry.path}@${entry.ref} does not resolve` +
        `${entry.comment === null ? "" : ` — the comment claims ${entry.comment}`}\n` +
        `          A pinned SHA that does not exist fails only when the workflow runs, which for a release ` +
        `workflow is the worst possible moment.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Action-pin check failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `Action-pin check passed: ${checked} pinned action(s) all resolve, and the resolver correctly rejected a ` +
    `control SHA that cannot exist.`,
);
