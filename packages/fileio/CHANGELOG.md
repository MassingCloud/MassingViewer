# @massingviewer/fileio

## 0.1.0

### Minor Changes

- [`7f9a88a`](https://github.com/MassingCloud/MassingViewer/commit/7f9a88a748a1778f08b75cfde4f07b1f5aa706ec) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: opening files by reading them, not by trusting their names.

  Byte sniffing that answers what-is-it, how-sure, and does-that-agree-with-the-name as three separate questions.
  A support matrix that declines a format _with that format's own reason_, so "point clouds are M10" replaces
  "unsupported file type". A drop target that cannot navigate your session away, and a picker that works in Safari.

### Patch Changes

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - Fix: the published ESM now resolves in Node.

  Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
  `import("@massingviewer/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
  because it resolves workspace packages to source by design. The packaging gate now loads each built entry.
