// @massing/plugin-host — declarative contributions, lazy activation, and a host no plugin can break.
//
// The manifest is DATA, so the host builds its entire UI — ribbon, palette, keybindings — without running a line
// of plugin code. That is what makes lazy activation possible, and lazy activation is what keeps a hundred
// installed plugins from costing a hundred module evaluations at startup. The imperative alternative
// (`api.addRibbonButton()` inside `activate()`) inverts it: nothing can be lazy, because nothing is known until
// everything has run.
//
// Three mechanisms make "no plugin can break the host" structural rather than aspirational:
//
//   - quarantine, so one bad plugin does not take the application down
//   - all-or-nothing activation, because a half-registered plugin shows a button that does nothing — worse than
//     one that failed outright, since nothing distinguishes it from a working one until someone presses it
//   - dependency cycles reported as `a -> b -> c -> a`, not as "a cycle exists"
//
// And the model is proved against the real UI: `builtinManifests()` derives the first-party ribbon from
// `ui-model`'s own tables, and the tests assert it round-trips through `ribbonFrom` to exactly `buildRibbon()`.

export { isLoadable, normaliseChord, validateManifest } from "./manifest.js";
export type {
  ActivationEvent,
  CommandContribution,
  Contributions,
  IoContribution,
  KeybindingContribution,
  ManifestProblem,
  PanelContribution,
  PluginManifest,
  RibbonGroupContribution,
  SettingContribution,
} from "./manifest.js";

export { createPluginHost, topologicalOrder } from "./host.js";
export type {
  HostOptions,
  LoadResult,
  PluginContext,
  PluginHost,
  PluginLoader,
  PluginRuntime,
  PluginState,
  RegisteredPlugin,
} from "./host.js";

export { commandsNotOnRibbon, ribbonFrom, unknownTabs } from "./ribbon.js";

export { BUILTIN_ID, builtinManifests, commandIdFor } from "./builtin.js";
