#!/usr/bin/env node
/**
 * `changeset version`, with the GitHub token found rather than demanded.
 *
 * ## Why this wrapper exists
 *
 * `@changesets/changelog-github` calls the GitHub API to turn each changeset into a changelog line with the
 * commit, the PR and the author — which is most of what makes a generated changelog worth reading. It therefore
 * needs a token, and without one it fails with a 200-character message telling you to go and create a personal
 * access token.
 *
 * That was survivable when versioning happened inside CI, where `GITHUB_TOKEN` is always present. It stopped
 * being survivable when the release moved onto a laptop (see docs/releasing.md): the very first step of the very
 * first release would have failed, on a machine where a perfectly good token was already sitting in `gh`.
 *
 * So this looks for a token in the two places one actually lives, and only then asks. The ordering matters:
 * an explicit `GITHUB_TOKEN` in the environment beats `gh`, because someone who set it meant it.
 *
 * It is read-only usage — `read:user` and `repo:status` — so there is nothing here that can write to the repo.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Resolve a dependency's real path.
 *
 * `createRequire(import.meta.url).resolve` rather than a hand-built `node_modules/...` path: npm is free to hoist,
 * and a literal path is a guess that works until someone installs with a different layout.
 */
const require_ = createRequire(import.meta.url).resolve;

/** A token from `gh`, or null. Never throws: `gh` being absent or logged out is a normal state, not an error. */
function ghToken() {
  // No shell here either. `gh` is a real executable on every platform, so CreateProcess finds `gh.exe` on
  // Windows without one — and a shell would bring DEP0190 back for a lookup that cannot fail usefully anyway.
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const token = (result.stdout ?? "").trim();
  return token === "" ? null : token;
}

const explicit = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const token = explicit ?? ghToken();

if (token === null || token === undefined) {
  console.error(
    "changeset:version needs a GitHub token, because the changelog generator looks up each change's commit,\n" +
      "PR and author through the GitHub API.\n\n" +
      "Easiest, if you have the GitHub CLI:\n\n" +
      "    gh auth login\n\n" +
      "…and this script will find the token itself. Otherwise create one with `read:user` and `repo:status` at\n" +
      "https://github.com/settings/tokens/new and export it as GITHUB_TOKEN.\n\n" +
      "It is read-only usage: nothing here can write to the repository.",
  );
  process.exit(1);
}

if (explicit === undefined) console.log("changeset:version: using the token from `gh auth token`.");

/**
 * Run a child with the token in its environment.
 *
 * `stdio: "inherit"` so changesets' own output reaches the terminal — capturing it would hide the interactive
 * parts and turn a working command into one that appears to hang.
 *
 * No `shell: true`. Node 24 deprecates passing args alongside a shell (DEP0190) because the args are concatenated
 * rather than escaped, so a shell metacharacter in any of them would be interpreted. Nothing here is
 * user-supplied, so it is not a live vulnerability — but the fix is to not need a shell, and a warning left in
 * place is a warning everyone learns to scroll past.
 */
const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // The token reaches the child's environment only. Never written to a file, never echoed — a token in a log is
    // a token that has to be revoked.
    env: { ...process.env, GITHUB_TOKEN: token },
  });
  if (result.error !== undefined) {
    console.error(`could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// The changesets CLI as a JS entry point through this Node, rather than the `changeset` shim. The shim is a
// `.cmd` on Windows, which is what forced `shell: true` in the first place.
run(process.execPath, [require_("@changesets/cli/bin.js"), "version"]);

/**
 * npm's own entry point.
 *
 * `npm_execpath` is set by npm for every script it runs and points at `npm-cli.js`, which is the documented way
 * to re-enter *the same npm* that invoked you. Resolving `"npm/bin/npm-cli.js"` from `node_modules` does not work
 * and looked like it would: npm is the tool running this, not a dependency of it, so it is not installed locally.
 */
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  console.error("run this through npm — `npm run changeset:version` — so it can find npm to refresh the lockfile.");
  process.exit(1);
}

// The lockfile carries every workspace version, so it goes stale the moment versions bump — and a stale lockfile
// makes `npm ci` in CI install the *old* versions: a release that tests one tree and ships another.
run(process.execPath, [npmCli, "install", "--package-lock-only"]);

console.log(
  "\nVersions bumped and changelogs written. Now:\n" +
    "  1. read the diff — this is the review step, and it is the whole reason the version bump is local\n" +
    "  2. npm run gate:release\n" +
    "  3. commit, then push a release-* tag\n" +
    "See docs/releasing.md.",
);
