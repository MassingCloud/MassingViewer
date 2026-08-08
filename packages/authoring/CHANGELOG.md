# @massingviewer/authoring

## 0.1.0

### Minor Changes

- [`5deaaf9`](https://github.com/MassingCloud/MassingViewer/commit/5deaaf991076414152e6d2e2c012ce5c78629892) Thanks [@ibuilder](https://github.com/ibuilder)! - The authoring session, section clipping, and walk mode — closing all five M9 seam gaps.

  `seamCoverage()` now reports **20/20 movable capabilities (100%), 4 staying in massing**, so
  `apps/web/src/viewer` can be deleted.

  New `@massingviewer/authoring`: the object four of those gaps were waiting on. Snapping runs before the prompt
  reducer, so it stays frame-immediate and the reducer stays deterministic; `hover` and `pick` resolve through one
  function, so the crosshair cannot show one point and the click commit another.

  `viewport` gains `section` (a plane or a six-plane box) and `walk` (one first-person implementation, so massing
  can delete both of its two). `embed` exposes the session, markup with orphan detection, and BCF export.

### Patch Changes

- Updated dependencies [[`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee)]:
  - @massingviewer/core@0.1.0
  - @massingviewer/geometry-math@0.1.0
  - @massingviewer/commands@0.1.0
