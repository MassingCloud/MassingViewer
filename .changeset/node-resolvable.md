---
"@massingviewer/core": patch
"@massingviewer/kernel-api": patch
"@massingviewer/kernel-conformance": patch
"@massingviewer/geometry-math": patch
"@massingviewer/ui-model": patch
"@massingviewer/catalog": patch
"@massingviewer/ifc": patch
"@massingviewer/kernel-local": patch
"@massingviewer/kernel-memory": patch
"@massingviewer/commands": patch
"@massingviewer/drawings2d": patch
"@massingviewer/markup": patch
"@massingviewer/plugin-host": patch
"@massingviewer/observability": patch
"@massingviewer/viewport": patch
"@massingviewer/ribbon": patch
"@massingviewer/fileio": patch
"@massingviewer/ui-react": patch
---

Fix: the published ESM now resolves in Node.

Every package emitted extensionless relative imports, which a bundler tolerates and Node does not — so
`import("@massingviewer/core")` failed with ERR_MODULE_NOT_FOUND in every package. Invisible to the test suite,
because it resolves workspace packages to source by design. The packaging gate now loads each built entry.
