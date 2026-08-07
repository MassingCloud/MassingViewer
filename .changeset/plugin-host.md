---
"@massingviewer/plugin-host": minor
"@massingviewer/ribbon": minor
---

New package: Tier-0 declarative contributions with lazy activation, and a host no plugin can break.

The manifest is data, so the ribbon and palette are complete at startup without running a line of plugin code.
Quarantine, all-or-nothing activation and cycles-reported-as-cycles make "no plugin can break the host"
structural. And the model is proved on the real UI: `builtinManifests()` derives the first-party ribbon from
`ui-model`'s tables and round-trips through `ribbonFrom` to exactly `buildRibbon()`.

`createRibbon` gains `groups` and `availability`, so a host can render contributed groups through the same
collapse algorithm as built-in ones. `onTool` now hands back the layout `RibbonItem` rather than a `ToolSpec`,
because a contributed group has no `ToolSpec` behind it.
