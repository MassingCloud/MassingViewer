---
"@massingviewer/core": minor
"@massingviewer/kernel-api": minor
"@massingviewer/kernel-conformance": minor
"@massingviewer/kernel-memory": minor
"@massingviewer/geometry-math": minor
"@massingviewer/ui-model": minor
"@massingviewer/catalog": minor
"@massingviewer/commands": minor
"@massingviewer/viewport": minor
"@massingviewer/ifc": minor
---

First published release.

Ten packages, all `0.x` — where **minor bumps may break**, per the versioning note in CONTRIBUTING.md.
That is stated explicitly because SemVer permits it and people reasonably expect otherwise.

What is in this release:

- `geometry-math` — object snapping with priority ties, one-shot snap overrides, polar tracking, dynamic
  input including imperial (`12'6`), drawing inference, placement validation, the AutoCAD command grammar.
- `core` — branded GUID/LocalId identity so a persisted reference cannot be anchored to a transient viewer
  id; metres-only units with a fractional-inch formatter; `Result`, so refusals travel as values.
- `kernel-api` + `kernel-conformance` + `kernel-memory` — the authoring contract, the suite every kernel
  must pass, and a reference implementation that passes it.
- `commands` — the command bus: one serializable invocation per action, with the interactive prompt loop as
  a pure reducer.
- `ui-model`, `catalog` — the ribbon layout table and the parametric element palette, as framework-free data.
- `ifc` — the IFC file as something you can edit without breaking. It holds the file's own STEP entity table
  and re-emits untouched entities byte-for-byte, so moving one wall cannot silently delete a consultant's
  analytical model. See `docs/adr/0008-local-kernel-geometry-stack.md`.
- `viewport` — imperative three.js rendering with per-element identity, picking, adaptive pixel ratio, and
  mouse *and* touch navigation including pinch-to-zoom.
