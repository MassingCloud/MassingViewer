# ADR-0002 — Depend on upstream packages; do not re-vendor by copy

- **Status:** Accepted
- **Date:** 2026-08-06
- **See also:** `docs/adr/0007-massingifc-boundary.md`, which decides what the upstream boundary *is*

## Context

massing vendors four packages into `apps/web/src/vendor/` — `@massingifc/core-kernel`,
`@massingifc/plugin-sdk`, `@massingifc/project-schema`, and `@massingcloud/pdf-viewer` — 18,192 lines
total. It does this for exactly one reason: every package in `MassingCloud/massingifc` and
`MassingCloud/massing-pdf` is `"private": true` and unpublished. Not for licensing (both are MIT), and not
by preference. The vendoring is a workaround.

MassingViewer could do the same thing, and it is the path of least resistance.

## Decision

**Publish upstream, then depend.** Do not copy.

Four reasons:

1. **A published library cannot ship a copy of another repo's source.** These packages go to npm. Either
   the `files` field balloons with vendored source, or the path aliases break for consumers — and path
   aliases do not survive publication at all.
2. **The alias trick only works inside one repo.** massing's `apps/web/vendorAlias.ts` works because Vite,
   Vitest *and* `tsconfig` paths are all under one roof, held in agreement by a dedicated test. A consumer
   of `@massingviewer/core` inherits none of that.
3. **The vendored copies are already a known liability.** `apps/web/vendorAlias.ts` says so in its own doc
   comment: three copies of one fact is the drift shape that codebase keeps paying for. Adding a fourth
   copy in a new repo repeats a mistake whose cost is already documented.
4. **There is no licensing reason.** Both upstreams are MIT and public. The only obstacle is a `private`
   flag.

## Consequences

- **Blocking prerequisite:** flip `private: false` on `packages/{core-kernel,plugin-sdk,project-schema}` in
  `MassingCloud/massingifc`, add `publishConfig` with public access and npm provenance, add a changesets
  release workflow, tag `1.0.0`. Same for `@massingcloud/pdf-viewer`. Publish **only** the three packages
  massing actually consumes — the other twenty stay private until someone needs them.
- **Fallback, time-boxed:** if publishing slips, carry the vendored trees confined to a single
  a single vendor-bridge workspace workspace with one source-of-truth alias map and the assertion that keeps
  `tsconfig` paths honest. Swapping to real dependencies is then a one-file change. A CI check fails if
  that directory still exists after the expiry date recorded in this ADR. Two weeks, not a plan.
- Publishing to npm is a public, hard-to-reverse action affecting a scope shared with other work. It
  requires explicit sign-off before it happens, not merely a green ADR.
