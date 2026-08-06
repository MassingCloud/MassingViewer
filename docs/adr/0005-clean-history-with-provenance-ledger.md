# ADR-0005 — Clean history, with a provenance ledger instead

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

Roughly 14,000 lines of this repo were extracted from [ibuilder/massing](https://github.com/ibuilder/massing).
Both projects are MIT with the same copyright holder, so there is no licensing obstacle — the only
requirement is retaining the notice, which `NOTICE` does.

The question is whether to import filtered git history (`git filter-repo`) so `git blame` reaches back
into massing, or to start clean.

The case for history is real: authorship attribution, blame continuity, and the "why does this code look
like that" archaeology that matters for genuinely hairy code. There is some of that here — a comment
explaining that a WebGL canvas must have a fresh frame rendered synchronously before reading pixels because
`preserveDrawingBuffer` is off, and another explaining that the Fragments worker *hangs rather than rejects*
on malformed input.

## Decision

**Start clean.** Record provenance in a machine-checkable ledger instead.

Four reasons, in order of weight:

1. **The paths do not survive anyway.** About half of what was extracted was *moved and restructured* — a
   5,064-line file becomes six packages; `apps/web/src/viewer/*` splits across `geometry-math`, `viewport`
   and `core`. `filter-repo --path apps/web/src/viewer` gives history for files that no longer exist at
   those paths, so `git blame` breaks at the move commit regardless. Full price, partial benefit.

2. **massing's history is one monorepo history.** Its log is version-bump-style commits spanning backend,
   ops, docs and frontend in the same commit. Filtering to the viewer yields a log dominated by messages
   describing unrelated work. That is noise presented as provenance, which is worse than an honest gap.

3. **Secret-scanning surface.** massing's `.gitleaksignore` documents five historical fingerprints pinned
   to specific commits, each triaged as a false positive. Importing history imports those objects and the
   obligation to re-triage them in a new *public* repo. Starting clean lets MassingViewer's gitleaks gate
   begin genuinely green with an **empty ignore list** — a materially stronger claim than "green with five
   documented exceptions".

4. **Weight with no use.** A 1.1 MB demo-data JSON that churns, a committed `apps/web/dist-demo/`, and build
   artifacts — none of which this repo needs.

### What replaces it

Provenance is recorded where it is actually readable, in two places that CI keeps in agreement:

**A per-file header.**

```
// Extracted from ibuilder/massing @ 813f3628d2498afa0267c745bd1d8783d512e393 (apps/web/src/viewer/snapEngine.ts), MIT.
// See NOTICE and docs/PROVENANCE.tsv. Upstream changes to that path are reported weekly.
```

**A ledger** at `docs/PROVENANCE.tsv`: `massing_path`, `massing_sha`, `massingviewer_path`, `action`,
`date` — where `action` distinguishes a `move` (byte-identical apart from the header) from a `port`
(adapted during the move).

`scripts/check-provenance.mjs` asserts these agree **in both directions**: a file with a header and no row
fails, and a row whose file has lost its header fails. One direction alone would let the ledger rot in the
easy direction.

## Why the ledger is better than filtered history for the two things that matter

**Legal review.** The audience for provenance is an enterprise reviewer asking "where did this come from".
One `grep` over a TSV answers it for every file. Filtered git history cannot be audited that way.

**Divergence detection.** This is the load-bearing reason. The weekly divergence report reads the ledger
and asks GitHub which of those upstream paths have changed since the recorded SHA, opening a single
tracking issue for anything that has. Filtered history cannot do that at all — it records where code came
from, not what happened to it afterwards.

That risk is not hypothetical. The gate proved itself within an hour of being written: massing advanced
**15 commits during the extraction session**, and two files ended up with headers from a later commit than
the ledger recorded. The gate caught the mismatch immediately. A re-baseline script then verified every
extracted path was byte-identical between the two commits *before* moving the recorded SHA forward —
because "these commits didn't touch our files" is exactly the kind of claim that must be checked rather
than assumed.

## Consequences

- Every extraction PR must add the header and the ledger row. This is in `CONTRIBUTING.md`, and the gate
  enforces it, so it cannot be forgotten quietly.
- The recorded SHA must be accurate, because the divergence report's usefulness rests on it entirely. A
  wrong SHA means a file is watched from the wrong baseline, which silently produces either false alarms or
  false silence.
- Re-baselining onto a newer upstream commit is allowed **only** after verifying byte-identity of every
  affected path. Never as a bulk find-and-replace.
- **If archaeology is ever genuinely needed**, the compromise is available: run `git filter-repo` once and
  keep the result on an orphan branch `provenance/massing-history` that is never merged. Available on
  demand, clean `main`.
