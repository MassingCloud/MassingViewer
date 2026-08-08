# @massing/viewport

## 0.1.1

### Patch Changes

- [`1bcb053`](https://github.com/MassingCloud/MassingViewer/commit/1bcb05348f27a6a25ddb78b6259f1958c7c9d692) Thanks [@ibuilder](https://github.com/ibuilder)! - Seven fixes from a code review of the authoring session, two of which let invalid geometry reach the kernel.

  The worst: after a placement refusal, clicking again bypassed validation entirely and committed the geometry that
  had just been refused. `points` is now derived from the prompt reducer rather than mirrored beside it, which makes
  the drift that caused it unrepresentable.

  Also: a typed distance now follows the cursor's bearing instead of always going due east; the facade resolves a
  clicked element by raycast rather than reading the selection; `CommandContext.dispatch` really dispatches instead
  of returning a fake success; snap candidates come from a grid built per model load rather than a full vertex scan
  per frame; `section.dispose()` reference-counts the renderer's clipping flag; and a snap override no longer arms
  while nothing is armed. `embed` now exposes `commands`, since a host has to register its own verbs.

## 0.1.0

### Minor Changes

- [`5deaaf9`](https://github.com/MassingCloud/MassingViewer/commit/5deaaf991076414152e6d2e2c012ce5c78629892) Thanks [@ibuilder](https://github.com/ibuilder)! - The authoring session, section clipping, and walk mode — closing all five M9 seam gaps.

  `seamCoverage()` now reports **20/20 movable capabilities (100%), 4 staying in massing**, so
  `apps/web/src/viewer` can be deleted.

  New `@massing/authoring`: the object four of those gaps were waiting on. Snapping runs before the prompt
  reducer, so it stays frame-immediate and the reducer stays deterministic; `hover` and `pick` resolve through one
  function, so the crosshair cannot show one point and the click commit another.

  `viewport` gains `section` (a plane or a six-plane box) and `walk` (one first-person implementation, so massing
  can delete both of its two). `embed` exposes the session, markup with orphan detection, and BCF export.

- [`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda) Thanks [@ibuilder](https://github.com/ibuilder)! - First published release.

  Fourteen packages, all `0.x` — where **minor bumps may break**, per the versioning note in CONTRIBUTING.md.
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
  - `kernel-local` — offline IFC authoring: fifteen operations, GlobalIds minted as real compressed UUIDs,
    snapshot undo, and `unsupported` with a usable hint for the other eighty-one.
  - `drawings2d` — the Semantic Drawing Model. Entity geometry is in model space and paper is a render-time
    transform, so restyling a plan is a repaint rather than a regeneration, every line carries the GlobalId of its
    element, and SVG/DXF/PDF are pure functions of (Drawing, Theme, Paper). Includes a plan/section cutter that
    reports what it could not section instead of quietly omitting it.
  - `markup` — BCF 3.0-native topics anchored to IFC GlobalIds rather than to page coordinates, so a markup
    survives a model change and _visibly orphans_ when its element is deleted. Includes Bluebeam-style Tool Sets,
    where the tool carries the issue metadata, and a dependency-free `.bcfzip` writer verified by extracting with
    an independent unzip.
  - `ribbon` — an Office-style ribbon in **vanilla DOM**, so massing and a React shell can both render it. Nine
    tabs, responsive group collapse that never drops a tool, roving-tabindex keyboard navigation, and controls that
    dim with a stated reason rather than disappearing. Layout decisions live in `ui-model`, so two hosts cannot
    disagree about where a tool is. See `docs/adr/0009-ribbon-renders-in-vanilla-dom.md`.
  - `viewport` — imperative three.js rendering with per-element identity, picking, adaptive pixel ratio, and
    mouse _and_ touch navigation including pinch-to-zoom.

### Patch Changes

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - Fix: the published ESM now resolves in Node.

  Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
  `import("@massing/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
  because it resolves workspace packages to source by design. The packaging gate now loads each built entry.

- Updated dependencies [[`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee)]:
  - @massing/core@0.1.0
