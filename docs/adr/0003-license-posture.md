# ADR-0003 — Permissive licenses only, enforced by CI

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

Surveying the browser CAD/BIM ecosystem turned up an uncomfortable and non-obvious pattern: **in four
separate categories, the best-in-class option is copyleft or not open source at all.**

| Category | The best option | License |
|---|---|---|
| Browser DWG reading | LibreDWG (`@mlightcad/libredwg-web`) | **GPL-3.0** — and it is the *only* good one |
| BIM viewers | `xeokit-sdk` | **AGPL-3.0** or paid commercial |
| PDF engines | MuPDF | **AGPL** or paid commercial |
| Reference CAD apps | Chili3D, IFC5CAD, Open CAD Studio | **AGPL-3.0 / GPL-3.0** |
| Canvas SDKs | `tldraw` | **Not open source at all**, despite appearing to be |

The `tldraw` case is worth calling out because it is the easiest to get wrong. It looks like an
open-source library, has an npm package and public docs, and is genuinely excellent. Its actual license is
development-only by default; production requires a paid key, the hobby tier keeps a "made with tldraw"
watermark, and the startup license is roughly $6,000. Adopting it as a foundational canvas dependency and
discovering the terms later would be a strategic problem, not a licensing detail.

MassingViewer publishes `@massingviewer/*` packages to npm. That makes the exposure worse than for an
application: a copyleft dependency does not merely constrain us, it constrains everyone who installs us.

There is also an **in-organisation** hazard, which is the one that actually happens. Two sibling repos in
`MassingCloud` are not permissively licensed:

- `MassingCloud/massing-cloud` — **GPL-2.0**
- `MassingCloud/massing-families` — license **"Other"** (unresolved)

Contamination from those arrives by copy-paste between sibling checkouts, not via `npm install`, so a
dependency scanner alone would not see it.

## Decision

**Permissive licenses only**, enforced by `scripts/check-licenses.mjs` as a required CI check on every PR,
walking the full transitive tree.

**Allowed:** MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BSL-1.0 (Boost), MPL-2.0, 0BSD,
Unlicense, CC0-1.0, Zlib, Python-2.0, BlueOak-1.0.0, CC-BY-4.0.

**Refused:** GPL-\*, AGPL-\*, LGPL-\*, SSPL, BUSL, CC-BY-NC-\*, Elastic, Commons-Clause — and, equally,
`"UNKNOWN"`, `"Other"`, `"SEE LICENSE IN …"` and `"UNLICENSED"`. An unresolvable license is not a neutral
state; it is an *unreviewed* one, and treating it as acceptable is exactly how the entries above get in.

MPL-2.0 is allowed deliberately. It is file-level weak copyleft, compatible with a permissively-licensed
project, and it is what `web-ifc` and `@ifc-lite/*` use — the latter being a serious candidate for the 2D
drawing pipeline (see `docs/adr/0004-2d-drawing-engine.md`). The obligation it creates is that
modifications to *MPL-licensed files* stay MPL and are published. The practical rule that follows: consume
MPL dependencies as dependencies and adapt at the boundary; never patch them in-tree.

### Banned by name, with the reason attached

Some packages pass a license check on their manifest but should still be refused, and some are simply the
attractive choice in a category where the trap is invisible from `npm install`. `scripts/check-licenses.mjs`
bans these by name and carries the reason inline, so nobody has to re-derive it:

`tldraw`, `@tldraw/tldraw`, `xeokit-sdk`, `mupdf`, `mupdf-js`, `libredwg`,
`@mlightcad/libredwg-web`, `@mlightcad/libredwg-converter`, `ifcopenshell`, `web-ifc-three`.

`ifcopenshell` deserves a note: it is LGPL-3.0, it is excellent, and it is the reference implementation for
authoring IFC correctly. It stays **server-side, behind `RemoteKernel`, and never crosses into a bundle.**
`LocalKernel` uses `web-ifc` (MPL-2.0) + `manifold-3d` (Apache-2.0) + `clipper2-wasm` (BSL-1.0) instead.

### Three enforcement layers

1. `scripts/check-licenses.mjs` — the transitive tree, plus the name bans, plus a source-header scan for
   the two in-org copyleft repos.
2. GitHub's `dependency-review-action` on PRs, configured with the same deny list — a second, independent
   line of defence that catches what a manifest-based scan misses.
3. `THIRD-PARTY-NOTICES.md` is generated and **staleness-gated**. An attribution file that has drifted
   from the dependency tree satisfies nobody's legal review.

Exceptions live in `ALLOWED_EXCEPTIONS` in `scripts/check-licenses.mjs` and require **both** a written
reason and an issue link — the same discipline massing applies to its `.gitleaksignore` entries. An
exception without both is itself a failure.

## Consequences

- **No DWG.** DXF only, via MIT libraries. DXF covers most real-world 2D exchange; DWG is available later
  either through an arms-length GPL converter running as a separate process, or by licensing the Open
  Design Alliance SDK. Neither is a `0.x` problem.
- **No exact BREP hidden-line removal in v1.** OpenCascade is LGPL-2.1 and a very large WASM payload. v1
  ships z-sort HLR, declared honestly in `DrawingProvenance.approximations` so a drawing says what it
  approximated rather than implying precision it does not have.
- **No parametric constraint solver in v1.** `planegcs` is LGPL-2.1. Grid, snap and alignment inference
  cover architectural massing intent; revisit when a true sketcher ships.
- Reading GPL/AGPL source **for patterns** is fine and encouraged — Chili3D's builder chain and Open CAD
  Studio's ribbon are the best available references. Copying code from them is not. The distinction is
  real and the rule is: read, then write your own.
- The gate must be able to *fail*, not merely pass. Its refusal paths are verified against synthetic
  GPL-3.0, `(MIT AND GPL-3.0)`, and `(MIT OR Apache-2.0)` manifests — the OR case must be accepted and
  the AND case refused, and getting either backwards would be silently wrong in opposite directions.
