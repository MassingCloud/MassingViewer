# @massing/plugin-host

## 0.1.0

### Minor Changes

- [`8f3434d`](https://github.com/MassingCloud/MassingViewer/commit/8f3434dd1528dc2fa80470d3a819c4dd66929ec0) Thanks [@ibuilder](https://github.com/ibuilder)! - New package: Tier-0 declarative contributions with lazy activation, and a host no plugin can break.

  The manifest is data, so the ribbon and palette are complete at startup without running a line of plugin code.
  Quarantine, all-or-nothing activation and cycles-reported-as-cycles make "no plugin can break the host"
  structural. And the model is proved on the real UI: `builtinManifests()` derives the first-party ribbon from
  `ui-model`'s tables and round-trips through `ribbonFrom` to exactly `buildRibbon()`.

  `createRibbon` gains `groups` and `availability`, so a host can render contributed groups through the same
  collapse algorithm as built-in ones. `onTool` now hands back the layout `RibbonItem` rather than a `ToolSpec`,
  because a contributed group has no `ToolSpec` behind it.

### Patch Changes

- [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee) Thanks [@ibuilder](https://github.com/ibuilder)! - Fix: the published ESM now resolves in Node.

  Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
  `import("@massing/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
  because it resolves workspace packages to source by design. The packaging gate now loads each built entry.

- Updated dependencies [[`bc5d8d4`](https://github.com/MassingCloud/MassingViewer/commit/bc5d8d4d83ba7ac13109f8e83fb6a3c8243d8cda), [`3edb9dd`](https://github.com/MassingCloud/MassingViewer/commit/3edb9dda85b8d9b24e9636cdd9a23ffdd42876ee)]:
  - @massing/ui-model@0.1.0
