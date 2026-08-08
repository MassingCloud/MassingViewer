# @massing/embed

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

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: `createMassingViewer()` — the one function a host imports — plus the M9 seam ledger.

  `kernel` is required rather than defaulted, because `ViewerCtx.api: ApiClient` becoming
  `ViewerCtx.kernel: KernelProvider` is the whole extraction in miniature, and a facade that quietly built a
  LocalKernel would let that coupling survive the migration invisibly. `seamCoverage()` answers "can massing delete
  its viewer yet" as a fraction with named gaps, so it is not an opinion.

### Patch Changes

- Updated dependencies [[`5deaaf9`](https://github.com/MassingCloud/MassingViewer/commit/5deaaf991076414152e6d2e2c012ce5c78629892), [`7f9a88a`](https://github.com/MassingCloud/MassingViewer/commit/7f9a88a748a1778f08b75cfde4f07b1f5aa706ec), [`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee), [`0378309`](https://github.com/MassingCloud/MassingViewer/commit/037830952e5a68a164a4b670f7ec26cfbda3144f), [`b861dc0`](https://github.com/MassingCloud/MassingViewer/commit/b861dc074ed3374be1d5387e3a222b01acbd0b26), [`8f3434d`](https://github.com/MassingCloud/MassingViewer/commit/8f3434dd1528dc2fa80470d3a819c4dd66929ec0)]:
  - @massing/authoring@0.1.0
  - @massing/viewport@0.1.0
  - @massing/fileio@0.1.0
  - @massing/core@0.1.0
  - @massing/kernel-api@0.1.0
  - @massing/commands@0.1.0
  - @massing/drawings2d@0.1.0
  - @massing/markup@0.1.0
  - @massing/ribbon@0.1.0
  - @massing/plugin-host@0.1.0
  - @massing/observability@0.1.0
