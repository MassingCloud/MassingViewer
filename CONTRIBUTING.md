# Contributing to MassingViewer

## Setup

**Node 24 is required.** Vite 8 and `@thatopen/fragments` both fail on older Node, usually with an
error that mentions neither. `npm install` checks this and prints the fix, but pre-emptively:

```bash
export PATH="/c/Program Files/nodejs:$PATH"   # Windows / Git Bash — the common trap
nvm use                                        # macOS / Linux, reads .nvmrc
```

```bash
npm install
npm run dev       # studio with a sample model, no backend needed
```

## The four commands

```bash
npm run lint        # eslint 10 + oxlint
npm run typecheck   # tsc --build across project references
npm run test        # vitest
npm run verify      # all of the above, plus the repo gates
```

`npm run verify` is what CI runs. If it passes locally it passes in CI, with the exception of the
browser matrix (`npm run e2e`).

## Repo gates

These are not style preferences. Each exists because the failure it prevents already happened
somewhere, and each fails the build rather than filing a warning nobody reads.

| Gate | What it asserts | Why |
|---|---|---|
| `gate:arch` | Package imports respect the layer DAG | `geometry-math` must never import `viewport`; `kernel-api` must never import `ui-react`. Without this, the framework-agnostic core stops being framework-agnostic one convenient import at a time. |
| `gate:license` | Every transitive dependency is permissively licensed | The best-in-class option is GPL/AGPL in four separate categories (DWG reading, viewers, PDF engines, reference CAD apps). Discovering that after adoption costs a rewrite. |
| `gate:provenance` | Every extracted file has a ledger row, and vice versa | This is how an enterprise legal reviewer audits where the code came from, and how the divergence bot finds upstream changes. |
| `gate:docs` | Every backticked filename in the docs resolves to a tracked path | A doc that cites a gate as evidence, where the gate doesn't exist, is worse than no doc. **Backticks are reserved for files that exist** — use plain quotes for anything aspirational. |
| `gate:versions` | The `three` / `@thatopen/*` / `web-ifc` tuple is identical across every package | These are version-coupled. Bumping one without re-verifying the set is a landmine, and in a monorepo it can differ *between packages* while each looks fine alone. |

## House rules

### Reference elements by GlobalId, never by viewer ID

Viewer IDs are assigned at load and change between loads. A pin, markup, selection set or drawing
entity anchored to one will silently detach. `@massingviewer/core`'s `elementRef` is the identity
boundary; use it.

### Dim controls with a reason — never hide them

Every command that can be unavailable declares a capability or a required kernel operation, and the
UI renders unavailability as *dimmed + `aria-disabled` + a tooltip saying why*. `availability()`
requires the `reason` string; there is no way to return "dimmed" without one.

> A dimmed button that says "needs Editor" is onboarding. A missing one is a support ticket.

This is inherited verbatim from massing, where hiding contextual tools under a hard cap
**shipped a real bug** — promoting one tool silently demoted another, and the person who noticed was a
user who needed the demoted one.

### Nothing blocks the main thread

Every kernel operation is async. There is deliberately no synchronous path, so "just call it inline
for now" is not available. CSG (`manifold-3d`) in particular will halt the event loop on a large mesh
— it must be in a Worker behind the job queue, with cancellation.

### Ratchets, not allowlists

When you need to bound something (unsupported operations, TODO counts, bundle size), write a test that
records the current number and fails when it grows. An allowlist gets appended to forever; a ratchet
only moves one way. Several existing gates work this way — copy the pattern.

### Every drawing must be able to say what it's missing

If you touch drawing generation: populate `DrawingProvenance.incomplete[]` and `guidCoverage`. A plan
missing a wall renders perfectly and reports nothing, which is the worst failure mode in the product.

## Tests

Layers, roughly in order of how often they run:

1. **Unit / pure math** — no DOM, no network. Fast enough to run on save. Most of `geometry-math`.
   Add **property-based** tests (`fast-check`) for invariants, not just examples: `resolveSnap`
   returns the nearest candidate within tolerance *or null*, `parse(format(x)) === x` across metric
   and imperial, `polarConstrain` output is always a multiple of the increment.
2. **Kernel conformance** — `@massingviewer/kernel-conformance`. Both kernels run it. If you add an
   operation, add its conformance assertions in the same PR, including its refusal case.
3. **Golden drawings** — semantic digests, never raw SVG snapshots. See [docs/testing.md](docs/testing.md)
   for how to update one safely.
4. **E2E** — Playwright, `chromium` + `webkit` + `firefox` + iPad. **`webkit` is required**: Safari and
   iPad support is a deliberate differentiator, so it cannot be a nightly-only afterthought.
5. **Visual / perf / memory** — nightly, not per-PR. Deliberately: a flaky per-PR gate gets
   `--update-snapshots`'d reflexively and stops meaning anything.

## Commits and PRs

- Branch from `main`. Squash-merge; `main` keeps a linear history.
- **Sign off your commits** (`git commit -s`) — DCO, not a CLA.
- Conventional-ish subjects are welcome but not enforced. A subject that says what changed and why
  beats a prefix.
- If a PR changes `packages/kernel-api` or `packages/plugin-host`, it needs an ADR. Those are public
  contracts and the deprecation policy binds us to them.
- Add a changeset (`npx changeset`) for anything user-visible in a published package.

## Versioning

All packages are `0.x` until the studio reaches `1.0.0`. **In `0.x`, minor bumps may break** — this is
stated here because SemVer technically permits it and people reasonably expect otherwise.

After `1.0.0`, `@massingviewer/kernel-api` and `@massingviewer/plugin-host` follow the deprecation
policy in "docs/plugin-deprecation-policy.md" (M8): deprecations are marked, warned once per session, and
supported for at least two minors and six months before removal in a major.

## Extracting more code from massing

Much of this repo comes from [ibuilder/massing](https://github.com/ibuilder/massing). If you are
porting more:

1. **Extract from `origin/main`, never from a local clone.** massing moves fast. A stale clone
   silently drops whole features — the initial extraction nearly lost the snap-override work this way.
2. Add the header to every file:
   `// Extracted from ibuilder/massing @ <sha> (apps/web/src/viewer/foo.ts), MIT.`
3. Add the matching row to `docs/PROVENANCE.tsv`. `gate:provenance` checks both directions.
4. **Bring the tests with the code, in the same PR.** The tests are the safety net for the port; a
   port that arrives without them has no way to show it didn't lose anything.
5. Check for in-flight upstream work on the files you're moving before you start. `scripts/` has the
   pre-flight check; it also runs as a required check on extraction PRs.

## Code of conduct

[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Report concerns to the maintainers.
