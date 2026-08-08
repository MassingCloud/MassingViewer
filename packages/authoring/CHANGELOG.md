# @massing/authoring

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

### Patch Changes

- Updated dependencies [[`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee)]:
  - @massing/core@0.1.0
  - @massing/geometry-math@0.1.0
  - @massing/commands@0.1.0
