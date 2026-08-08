# Releasing

Four steps, and the first one is on your machine.

```bash
npm run changeset:version
```

That needs a GitHub token, because `@changesets/changelog-github` looks up each change's commit, PR and author
through the API — which is most of what makes a generated changelog worth reading. **You do not need to do
anything about it:** `scripts/changeset-version.mjs` takes `GITHUB_TOKEN` if you have set one, and otherwise
finds the token `gh` already holds.

This was found by running the steps rather than writing them down. Versioning used to happen inside CI, where
`GITHUB_TOKEN` is always present; moving it to a laptop made the first step of the first release fail, on a
machine where a perfectly good token was already sitting in `gh`. Read-only usage — `read:user` and
`repo:status` — so nothing in that step can write to the repository.

```bash
npm run gate:release
```

```bash
git add -A && git commit -m "release: version packages"
```

```bash
git tag release-$(date +%Y-%m-%d) && git push origin main --follow-tags
```

The tag is what publishes. Everything before it is reviewable and reversible.

## Why the version bump is not in CI

The obvious design — and the one this repo started with — has `changesets/action` open a version PR, and merging
it publishes. It never worked here, and the reason is worth recording because it will come up again:

**The `MassingCloud` organisation has "Allow GitHub Actions to create and approve pull requests" turned off.** That
setting is hierarchical — enterprise, then organisation, then repository — and a lower level can never grant what a
higher level withholds. So the repository checkbox is greyed out, the job's `pull-requests: write` grant is
honoured, and the API call is refused anyway.

That policy is off by default for a good reason: a workflow that can open a PR is a privilege-escalation path,
because a second workflow can approve it. Loosening an **org-wide** policy affecting every current and future
repository, to gain a convenience PR in **one**, is the wrong trade for a repository that SHA-pins every action,
runs gitleaks with an empty ignore file, and publishes with provenance.

So the release stopped needing the permission rather than asking for it. `.github/workflows/release.yml` now has
**strictly less** authority than the version it replaces:

| | Before | Now |
|---|---|---|
| `pull-requests` | `write` | **none** |
| `contents` | `write` — version commit, tags, PR branch | `write` — per-package tags only |
| `id-token` | `write` | `write` |
| Writes a version | yes, in CI | no |

The review step the version PR provided is not lost — it moved. `npm run changeset:version` produces a diff you
read before committing, which is more review than approving a bot's PR.

## The gate this design needs

Moving `changeset version` onto a laptop introduces exactly one new failure mode: **tagging without having run
it.** That fails silently, which is the worst way to fail — `changeset publish` would find every local version
already on npm, publish nothing, exit 0, and the release would report success while shipping nothing. A *partial*
version run is worse still: it ships a set of versions that were never tested together.

So `scripts/check-release-ready.mjs` runs before the publish, locally and in CI:

1. **No pending changesets.** A leftover changeset file in `.changeset` means the versions in this tree do not include it.
2. **Something is actually being published.** A release tag that publishes nothing is a mistake — forgotten
   versioning, or a duplicate tag — and must fail loudly rather than succeed emptily.
3. **Every version being published has a `## <version>` changelog heading.** npm versions are immutable, so an
   unexplained `0.3.1` is unexplained for ever. Matched at a heading, not anywhere in the file, because the
   version string also appears in dependency-bump bullets.
4. **No package is still at `0.0.0`.** The placeholder means it was never versioned.

Run `npm run gate:release` before tagging. Locally is where it is useful; in CI it is binding.

## Nothing publishes without a token

`NPM_TOKEN` absent is a **notice, not a failure**. Publishing to a shared npm scope is irreversible — a version
number can never be reused, even after `npm unpublish` — so it takes a deliberate act by someone with credentials,
not a side effect of a merge.

`workflow_dispatch` is a dry run for the same reason: it runs every gate and skips the publish, so the checks can
be exercised without burning a version. Publishing on a button press would make pushing a tag bypassable, and the
tag is the deliberate act.

## Re-running a failed release

Safe. `changeset publish` is a no-op for any version already on npm, so a partially-failed release can be re-run
and it will publish only what did not make it. Delete and re-push the tag, or use `workflow_dispatch` to check the
gates first.

## If you would rather have the version PR back

Two routes, both real:

- **A fine-grained PAT.** The org restriction only binds `GITHUB_TOKEN`. A PAT scoped to this one repository with
  `contents: write` and `pull requests: write`, passed to `changesets/action` as `GITHUB_TOKEN`, bypasses it —
  this is changesets' own documented workaround. Narrower than the org toggle, at the cost of a credential to
  rotate.
- **Enable it at the organisation level**, at `https://github.com/organizations/MassingCloud/settings/actions`.
  Simplest, and the broadest: it applies to every repository in the org, for ever.
