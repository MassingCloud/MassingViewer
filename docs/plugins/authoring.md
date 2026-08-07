# Writing a MassingViewer plugin

A plugin is a **manifest** plus a **module**. The manifest is data, so the host builds its entire UI — ribbon,
palette, keybindings — without running a line of your code. The module is fetched only when one of your
declared activation events fires.

That split is the whole design, and it is what makes it reasonable to have a hundred plugins installed. The
alternative — `api.addRibbonButton()` inside an `activate()` — means the host cannot know what exists until it
has run everything, so nothing can be lazy.

> **The model is proved against the real UI.** The first-party ribbon is not special-cased: `builtinManifests()`
> in `packages/plugin-host/src/builtin.ts` derives it from `packages/ui-model/src/ribbon.ts`'s own tables, and
> `packages/plugin-host/src/host.test.ts` asserts it round-trips through `ribbonFrom` to *exactly* `buildRibbon()`
> — same groups, same order, same priorities, and identical collapse at every width from 320 to 3840. If the
> contribution model could not express the product's own UI, you would be building against a second-class API.

## A complete plugin

The example in `apps/demo/src/main.ts` is small enough to read and real enough to prove the seam: it is loaded
through the same `load` callback a third-party plugin would be.

```ts
import type { PluginManifest } from "@massingviewer/plugin-host";

export const manifest: PluginManifest = {
  id: "example.metrics",
  name: "Quick metrics",
  version: "1.0.0",
  publisher: "MassingCloud",
  // Fetch my module when this command is invoked, and not before.
  activation: ["onCommand:example.metrics.footprint"],
  contributes: {
    commands: [{ id: "example.metrics.footprint", title: "Footprint", capability: "view" }],
    ribbon: [
      {
        id: "example-metrics",
        label: "Metrics",
        tab: "analyse",
        priority: 4,
        items: [{ command: "example.metrics.footprint", size: "large" }],
      },
    ],
    keybindings: [{ command: "example.metrics.footprint", key: "Shift+M" }],
  },
};
```

```ts
import type { PluginContext, PluginRuntime } from "@massingviewer/plugin-host";

export const runtime: PluginRuntime = {
  activate(context: PluginContext) {
    context.registerCommand("example.metrics.footprint", () => {
      // Do the work. Anything needing cleanup goes on `context.subscriptions`.
    });
  },
};
```

## Rules the host enforces, and why

Each of these is a refusal at load time, with the field path in the message. They are not style preferences;
every one of them prevents a failure that is invisible until a user hits it.

| Rule | Why |
|---|---|
| **Every id is namespaced under your plugin id.** | Two plugins both contributing `wall.add` produce a conflict the user cannot diagnose and neither author can fix without coordinating. |
| **A ribbon item's `command` must resolve** — to one of yours, or to a dependency's. | A button that does nothing when pressed is the worst failure a toolbar can have: it teaches a user to distrust all of them. |
| **`tab` must be one of the nine.** | Plugins join tabs; they do not invent them. A tenth tab nobody planned for changes the shape of the ribbon for everyone. |
| **An enum setting's default must be one of its options.** | Otherwise the control renders with no selected value, which reads as corrupted state rather than as a bad manifest. |
| **At least one activation event.** | A plugin that never activates is dead code that still costs a manifest to validate. |
| **`activation: ["*"]` is a warning, not an error.** | Eager activation is occasionally necessary — a crash reporter, a telemetry sink. A rule with no escape hatch gets worked around somewhere nobody can audit. |

Validation returns **every** problem, never just the first. Fixing a manifest one error per run is how a plugin
author gives up.

## Activation events

| Event | Fires when |
|---|---|
| `onCommand:<id>` | That command is invoked — from the ribbon, the palette, a keybinding, or a macro. The one to reach for. |
| `onSelection:<IfcClass>` | An element of that class is selected. |
| `onFileType:<kind>` | A file of that kind is opened. Kinds come from `packages/fileio/src/sniff.ts` — and note they are decided by *bytes*, so `onFileType:ifc` fires for a valid IFC whose name ends in ".txt". |
| `onKernel:<id>` | That kernel becomes active — `local` or `remote`. |
| `onView:<kind>` | A view of that kind opens: `plan`, `section`, `sheet`. |
| `onStartupFinished` | After first paint. For work that must happen but need not block anything. |
| `*` | Immediately. Warned about. |

## What the host guarantees

**No plugin can break the host, or another plugin.** Three mechanisms, in
`packages/plugin-host/src/host.ts`:

1. **Quarantine.** If your `activate` throws, your plugin is disabled with the error recorded and everything else
   carries on. One bad plugin taking the application down would make installing anything a risk.

2. **All-or-nothing activation.** If you register two commands and then throw, **both are rolled back** and your
   ribbon items disappear. A partially activated plugin is worse than one that failed outright: its button is
   present and does nothing, and nothing distinguishes it from a working one until someone presses it.

3. **Cycles reported as cycles.** A dependency loop is refused with the actual path — `a -> b -> c -> a`. Every
   plugin outside the cycle still loads; one loop among forty plugins must not disable the other thirty-seven.

A throwing `deactivate` is recorded and swallowed, because disposing a set of plugins must not depend on all of
them being well behaved.

## Keybinding conflicts are reported, not resolved

Chords are normalised, so `Ctrl+K`, `ctrl+k` and `Shift+Ctrl+K` versus `Ctrl+Shift+K` collide as they should.
`LoadResult.keybindingConflicts` maps each contested chord to the commands fighting over it, and `keymap()`
resolves first-wins in load order.

The reporting is the point. First-one-wins is a defensible policy and a terrible *silent* one: the user presses
`Ctrl+K`, gets the wrong command, and nothing anywhere says why. A host that knows about the clash can offer to
rebind; a host that quietly picked cannot.

## Merging into an existing group

Two contributions with the same group `id` **merge**, in load order. That is how you add a button to the existing
*Draw* group rather than creating a second group also called Draw — two groups with the same label side by side
is the shape of a broken extension model.

## What is not here yet

- **Tier 1** — trusted plugins in a Web Worker with typed RPC.
- **Tier 2** — untrusted plugins via a two-context model: QuickJS-WASM logic with no DOM or network, sandboxed
  iframe UI, declared permissions surfaced at install. VS Code is the cautionary tale here, not the model:
  1,200+ malicious extensions, 229M installs, no sandbox.
- **Asset packs** (`.mvpack`) — code-free plugins carrying families, blocks, stamps, hatches and sheet
  templates.

Tier 0 is first-party only, and the trust boundary is exactly that: **a Tier-0 plugin runs with the host's
privileges.** Do not load one you did not write.
