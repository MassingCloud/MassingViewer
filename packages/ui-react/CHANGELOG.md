# @massing/ui-react

## 0.1.0

### Minor Changes

- [`f5c3d37`](https://github.com/MassingCloud/MassingViewer/commit/f5c3d3748daf5ff65a2f0a3202b03c7484180fd6) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: React for the parts React is good at.

  `Ribbon` is a thin wrapper around the vanilla renderer — mount, update, dispose — because ADR-0009 says the
  ribbon must work in massing's plain-TypeScript shell too. `PropertyGrid` shows declared against measured values
  and calls out disagreements. `Dock` is fixed resizable regions, deliberately not arbitrary docking, because
  reparenting a `<canvas>` loses its WebGL context. `CommandPalette` is a combobox with the ARIA that makes it
  usable rather than merely present.

### Patch Changes

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - Fix: the published ESM now resolves in Node.

  Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
  `import("@massing/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
  because it resolves workspace packages to source by design. The packaging gate now loads each built entry.

- [`0378309`](https://github.com/MassingCloud/MassingViewer/commit/037830952e5a68a164a4b670f7ec26cfbda3144f) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: crash reporting, telemetry, audit and feature flags with the sinks inverted.

  The default sends nothing — that is the actual privacy control, not the redaction. Telemetry enforces its schema
  at emit, in data, because types cannot stop `track("x", {...provenance})` from shipping GlobalIds. Audit is a
  separate module precisely because it has the opposite requirement: it must carry identifiers. Migrations use a
  `{schemaVersion, data}` envelope and refuse a future version rather than partially reading it; `ui-react`'s dock
  layout now goes through it.

- Updated dependencies [[`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee), [`0378309`](https://github.com/MassingCloud/MassingViewer/commit/037830952e5a68a164a4b670f7ec26cfbda3144f), [`8f3434d`](https://github.com/MassingCloud/MassingViewer/commit/8f3434dd1528dc2fa80470d3a819c4dd66929ec0)]:
  - @massing/ui-model@0.1.0
  - @massing/ribbon@0.1.0
  - @massing/observability@0.1.0
