import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { asModelId, formatLength, METRIC, toGuid, type Guid } from "@massing/core";
import { createViewport, type Viewport } from "@massing/viewport";
import { builtinManifests, createPluginHost, ribbonFrom, type PluginManifest } from "@massing/plugin-host";
import { CommandPalette, Dock, PropertyGrid, Ribbon, loadLayout, saveLayout } from "@massing/ui-react";
import type { PaletteEntry, PropertySet } from "@massing/ui-react";
import type { RibbonItem } from "@massing/ui-model";
import { consoleSink, createCrashHandler, NOOP_CRASH_SINK } from "@massing/observability";
import "@massing/ribbon/ribbon.css";
import "@massing/ui-react/ui-react.css";
import "./shell.css";
import { tessellate } from "./tessellate";
import sampleIfc from "../../../fixtures/sample.ifc?raw";

/**
 * The React shell — the **second host** for the same vanilla ribbon.
 *
 * ## Why this app exists
 *
 * `docs/adr/0009-ribbon-renders-in-vanilla-dom.md` rests on one claim: *a vanilla renderer works in every host, a
 * React renderer works in one.* Until this app existed, that was an argument. Now `apps/demo` mounts
 * `createRibbon` directly from plain TypeScript, this app mounts it through a React component, and both render
 * the same controls from the same package with the same collapse behaviour.
 *
 * That is what makes the massing story credible rather than aspirational: massing's shell is plain TypeScript
 * against the DOM, so massing is `apps/demo`'s kind of host, not this one. If the ribbon only worked here, M9
 * would mean putting React into massing.
 *
 * ## What React is doing that vanilla was not
 *
 * The dock, the property grid and the palette — trees of data replaced wholesale when the selection changes,
 * which is what a component tree is for. The ribbon is the opposite kind of thing, which is exactly why it is
 * not written in React.
 */

// The crash handler, before anything else can throw. A handler attached after initialisation cannot report a
// failure during it, and initialisation is where the interesting failures are.
createCrashHandler({
  where: "shell",
  sink: import.meta.env.DEV ? consoleSink() : NOOP_CRASH_SINK,
}).install(window);

const MODEL = asModelId("sample");

/** The example plugin, identical to the demo's — a contribution is host-agnostic too, which is the other half. */
const EXAMPLE_PLUGIN: PluginManifest = {
  id: "example.metrics",
  name: "Quick metrics",
  version: "1.0.0",
  publisher: "MassingCloud",
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

type Box = { readonly min: [number, number, number]; readonly max: [number, number, number] };

/**
 * Per-element bounds, computed from the tessellated positions in plain arithmetic.
 *
 * Deliberately *not* read off the three.js meshes, even though they are right there. `three` is confined to
 * `packages/viewport` by `scripts/check-architecture.mjs`, and the reason is measured rather than stylistic:
 * massing's vite config carries a comment about `resolve.dedupe: ["three"]` because "Multiple instances of
 * Three.js" was a real failure there — two copies produce objects that fail each other's `instanceof` checks.
 * An app reaching for a `Box3` is the first step towards a second copy.
 */
function boundsByGuid(meshes: readonly { guid: Guid | null; positions: ArrayLike<number> }[]): Map<Guid, Box> {
  const out = new Map<Guid, Box>();
  for (const mesh of meshes) {
    if (mesh.guid === null) continue;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[i + axis]!;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
    if (Number.isFinite(min[0])) out.set(mesh.guid, { min, max });
  }
  return out;
}

/** Parsed once at module scope: it is a constant fixture, and re-parsing it per mount would be pure waste. */
const MODEL_DATA = (() => {
  const { meshes, guids } = tessellate(sampleIfc);
  const byGuid = boundsByGuid(
    meshes.map((m) => ({ guid: toGuid(guids.get(m.expressId)), positions: m.positions })),
  );
  return { meshes, guids, byGuid };
})();

/**
 * The 3D view.
 *
 * A component that owns a `<div>` React renders but never renders *into*, exactly like `Ribbon`. Two owners of
 * one subtree is how you get "the node to be removed is not a child of this node" during an unrelated
 * reconciliation — and the node here holds a WebGL context.
 */
function Viewport3D(props: { readonly onSelect: (guid: Guid | null) => void }): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const node = container.current;
    if (node === null) return;

    /**
     * `createViewport` is async since ADR-0012 — `WebGPURenderer.init()` returns a promise — and an effect must
     * return a *synchronous* cleanup. That combination has one specific hazard, and it is the reason this is not
     * simply `void (async () => …)()`:
     *
     * **StrictMode mounts, unmounts and mounts again.** The unmount can happen while the renderer is still
     * initialising, so cleanup runs before there is anything to clean up — and the viewport then arrives
     * *afterwards*, unreferenced and undisposed. The comment below was already explicit that a leaked WebGL context
     * is not merely wasteful: browsers cap live contexts and silently drop the oldest, so the **first** viewport
     * goes black with nothing in the console to say why. Async construction makes that leak easy to introduce.
     *
     * So `cancelled` is checked after the await, and a viewport that arrives late disposes itself.
     */
    let cancelled = false;
    let viewport: Viewport | null = null;
    let off: (() => void) | null = null;

    // Bound once and registered immediately, so a click during initialisation is a no-op rather than a crash.
    const onClick = (event: MouseEvent): void => {
      if (viewport === null) return;
      const hit = viewport.pick(event);
      // Pass the model back with the id: expressIds are per-file, so without it a federated scene highlights the
      // same number in every loaded discipline.
      viewport.select(hit === null ? [] : [hit.expressId], hit?.modelId ?? undefined);
    };
    node.addEventListener("click", onClick);

    void (async () => {
      const created = await createViewport({ container: node });
      if (cancelled) {
        created.dispose();
        return;
      }
      viewport = created;
      created.showModel(MODEL_DATA.meshes, (expressId) => toGuid(MODEL_DATA.guids.get(expressId)), MODEL);
      created.fit();
      off = created.onSelect((selection) => {
        // The shell holds one model, so the ref's `modelId` is always `MODEL` and the guid map is the right one. The
        // ref is destructured rather than ignored so that adding a second model here is a compile error, not a
        // wrong lookup against the first model's map.
        const first = selection[0];
        live.current.onSelect(first === undefined ? null : toGuid(MODEL_DATA.guids.get(first.expressId)));
      });
    })();

    return () => {
      cancelled = true;
      node.removeEventListener("click", onClick);
      off?.();
      viewport?.dispose();
    };
  }, []);

  return <div className="shell-viewport" id="viewport" ref={container} />;
}

function App(): React.ReactElement {
  const [selected, setSelected] = useState<Guid | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [status, setStatus] = useState("ready");

  /**
   * The plugin host, created once.
   *
   * `useMemo` rather than module scope so a second `App` in a test gets its own — and because a host at module
   * scope would load its manifests at import time, which is exactly the eager work the design avoids.
   */
  const host = useMemo(() => {
    const created = createPluginHost({
      load: async (id) => {
        if (id !== EXAMPLE_PLUGIN.id) throw new Error(`no module for ${id}`);
        return {
          activate: (ctx) => {
            ctx.registerCommand("example.metrics.footprint", () => {
              let minX = Infinity;
              let minY = Infinity;
              let maxX = -Infinity;
              let maxY = -Infinity;
              for (const box of MODEL_DATA.byGuid.values()) {
                minX = Math.min(minX, box.min[0]);
                minY = Math.min(minY, box.min[1]);
                maxX = Math.max(maxX, box.max[0]);
                maxY = Math.max(maxY, box.max[1]);
              }
              const x = maxX - minX;
              const y = maxY - minY;
              setStatus(`footprint ${formatLength(x, METRIC)} x ${formatLength(y, METRIC)} = ${(x * y).toFixed(1)} m2`);
            });
          },
        };
      },
      onFailure: (id, phase, error) =>
        setStatus(`plugin ${id} failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`),
    });
    created.load([...builtinManifests(), EXAMPLE_PLUGIN]);
    return created;
  }, []);

  const groups = useMemo(() => ribbonFrom(host.contributions()), [host]);

  /**
   * Palette entries, from the same contributions the ribbon is built from.
   *
   * One source, two renderings. A hand-maintained palette list is how a command ends up in the ribbon and not in
   * the palette — which reads as the search being broken rather than as a list being stale.
   */
  const entries = useMemo<PaletteEntry[]>(() => {
    const keymap = host.keymap();
    const chordFor = (command: string): string | undefined =>
      [...keymap.entries()].find(([, id]) => id === command)?.[0];

    return (host.contributions().commands ?? []).map((command) => ({
      id: command.id,
      label: command.title,
      category: command.capability === "edit" ? "Edit" : "View",
      chord: chordFor(command.id),
      kind: "command" as const,
      // Dimmed with a reason rather than hidden, the same rule the ribbon follows. A user cannot tell "does not
      // exist" from "not right now", and the palette is where they go precisely because they cannot find a thing.
      unavailable: command.capability === "edit" && selected === null ? "Select an element first" : undefined,
    }));
  }, [host, selected]);

  const runCommand = useCallback(
    (id: string) => {
      void host.runCommand(id).catch((error: unknown) => {
        setStatus(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    [host],
  );

  // Ctrl+K, plus every chord the manifests declare. Both go through the host, so remapping is data rather than
  // a switch statement — which is the thing massing's `handleKey` is, and cannot be extended by a plugin.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      const parts: string[] = [];
      if (event.shiftKey) parts.push("Shift");
      if (event.altKey) parts.push("Alt");
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      const command = host.keymap().get(parts.join("+"));
      if (command === undefined) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, runCommand]);

  const onTool = useCallback(
    (_id: string, item: RibbonItem) => {
      const command = (host.contributions().commands ?? []).find((c) => c.title === item.title);
      if (command === undefined) {
        setStatus(`${item.label}: no command behind this control`);
        return;
      }
      runCommand(command.id);
    },
    [host, runCommand],
  );

  /**
   * Properties for the selection, with declared *and* measured values.
   *
   * The measured numbers are real — computed off the tessellated geometry — because the entire point of the two
   * columns is that they can disagree. Filling the measured column from the declared value would make the
   * feature look present and prove nothing, which is worse than leaving it out.
   */
  const sets = useMemo<PropertySet[] | null>(() => {
    if (selected === null) return null;
    const box = MODEL_DATA.byGuid.get(selected);
    if (box === undefined) return [];
    const thickness = Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1]) * 1000;
    const height = (box.max[2] - box.min[2]) * 1000;
    return [
      {
        name: "Pset_WallCommon",
        properties: [
          // 300 mm declared against whatever the geometry actually is. That disagreement is the most common real
          // defect in a federated model, and every other viewer in this market shows you one of the two numbers
          // without telling you which.
          { name: "Thickness", declared: 300, measured: Math.round(thickness), tolerance: 1, unit: "mm" },
          { name: "LoadBearing", declared: true },
        ],
      },
      {
        name: "Pset_QuantityTakeOff",
        collapsed: true,
        properties: [{ name: "Height", declared: Math.round(height), measured: Math.round(height), tolerance: 1, unit: "mm" }],
      },
    ];
  }, [selected]);

  const [layout] = useState(() => loadLayout(window.localStorage));

  return (
    <div className="shell">
      <header>
        <strong>MassingViewer</strong>
        <span className="muted">React shell — the same ribbon as the demo</span>
        <span className="spacer" />
        <button type="button" id="open-palette" onClick={() => setPaletteOpen(true)}>
          Search <kbd>Ctrl+K</kbd>
        </button>
      </header>

      {/*
        The ribbon: a React component wrapping vanilla DOM, rendering groups from the plugin host.
        Wrapped in an id'd element rather than given an `id` prop — `Ribbon` owns its container's contents and
        nothing else, so adding pass-through DOM attributes to it would be the start of it growing into the thing
        ADR-0009 says it must not become.
      */}
      <div id="ribbon">
        <Ribbon groups={groups} onTool={onTool} context={{ selection: selected !== null, canEdit: true }} />
      </div>

      <Dock
        layout={layout}
        onLayoutChange={(next) => saveLayout(window.localStorage, next)}
        panels={[
          {
            id: "project",
            title: "Project",
            side: "left",
            size: 220,
            content: (
              <ul className="shell-tree">
                <li>Tower-A</li>
                <li>Levels</li>
                <li>Views</li>
              </ul>
            ),
          },
          {
            id: "properties",
            title: "Properties",
            side: "right",
            size: 320,
            content: (
              <PropertyGrid
                sets={sets}
                subject={
                  selected === null ? undefined : { label: "Selected element", ifcClass: "IfcWall", guid: selected }
                }
              />
            ),
          },
        ]}
      >
        <Viewport3D onSelect={setSelected} />
      </Dock>

      <footer>
        <span id="status">{status}</span>
        <span className="spacer" />
        <span id="selection">{selected === null ? "nothing selected" : selected}</span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        entries={entries}
        onRun={(entry) => runCommand(entry.id)}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

const root = document.querySelector("#app");
if (root === null) throw new Error("#app missing");
createRoot(root).render(
  // StrictMode on, deliberately. It double-mounts every effect, which is exactly the pressure the imperative
  // wrappers here need to be under — a viewport or a ribbon that leaks on remount then fails loudly in
  // development rather than quietly in production.
  <StrictMode>
    <App />
  </StrictMode>,
);
