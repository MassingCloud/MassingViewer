# @massingviewer/observability

## 0.1.0

### Minor Changes

- [`0378309`](https://github.com/MassingCloud/MassingViewer/commit/037830952e5a68a164a4b670f7ec26cfbda3144f) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: crash reporting, telemetry, audit and feature flags with the sinks inverted.

  The default sends nothing — that is the actual privacy control, not the redaction. Telemetry enforces its schema
  at emit, in data, because types cannot stop `track("x", {...provenance})` from shipping GlobalIds. Audit is a
  separate module precisely because it has the opposite requirement: it must carry identifiers. Migrations use a
  `{schemaVersion, data}` envelope and refuse a future version rather than partially reading it; `ui-react`'s dock
  layout now goes through it.

### Patch Changes

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - Fix: the published ESM now resolves in Node.

  Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
  `import("@massingviewer/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
  because it resolves workspace packages to source by design. The packaging gate now loads each built entry.
