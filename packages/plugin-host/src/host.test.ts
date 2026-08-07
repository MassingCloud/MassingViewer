import { describe, expect, it, vi } from "vitest";
import { TABS, buildRibbon, layoutTab } from "@massingviewer/ui-model";
import { isLoadable, normaliseChord, validateManifest, type PluginManifest } from "./manifest.js";
import { createPluginHost, topologicalOrder, type PluginRuntime } from "./host.js";
import { commandsNotOnRibbon, ribbonFrom, unknownTabs } from "./ribbon.js";
import { BUILTIN_ID, builtinManifests, commandIdFor } from "./builtin.js";

const manifest = (over: Partial<PluginManifest> & { id: string }): PluginManifest => ({
  name: over.id,
  version: "1.0.0",
  activation: ["onStartupFinished"],
  contributes: {},
  ...over,
});

/** A plugin with one command, wired to a ribbon item. The smallest thing that is actually a plugin. */
const simple = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest =>
  manifest({
    id,
    activation: [`onCommand:${id}.go`],
    contributes: {
      commands: [{ id: `${id}.go`, title: `Go ${id}` }],
      ribbon: [{ id: `${id}-group`, label: id, tab: "home", priority: 5, items: [{ command: `${id}.go`, size: "medium" }] }],
    },
    ...extra,
  });

// ===================================================================================================
// The test that decides whether the contribution model is real
// ===================================================================================================

describe("the first-party ribbon, assembled from manifests", () => {
  it("round-trips through the contribution model to exactly buildRibbon()", () => {
    // The plan states this as the gate on the whole design: *"the whole first-party ribbon is assembled from
    // these manifests — if it can't be, the contribution model is wrong and we find out in week two."*
    //
    // Deriving `builtinManifests()` from `ui-model`'s tables rather than hand-writing them is what keeps this
    // honest. A hand-written copy would drift, and then this would prove the model can express *last month's*
    // ribbon — which is exactly the class of test massing already has one of: an icon map that was complete and
    // fully tested while the renderer never called it.
    const problems = validateManifest(builtinManifests()[0]!);
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);

    const rebuilt = ribbonFrom(builtinManifests()[0]!.contributes);
    const original = buildRibbon();

    expect(rebuilt).toHaveLength(original.length);
    for (const [i, group] of original.entries()) {
      const mine = rebuilt[i]!;
      expect(mine.id, `group ${i}`).toBe(group.id);
      expect(mine.label).toBe(group.label);
      expect(mine.tab).toBe(group.tab);
      expect(mine.priority).toBe(group.priority);
      expect(mine.items.map((x) => x.id)).toEqual(group.items.map((x) => x.id));
      expect(mine.items.map((x) => x.preferred)).toEqual(group.items.map((x) => x.preferred));
    }
  });

  it("collapses identically, so a plugin group is not a second-class citizen", () => {
    // The symmetry that matters at runtime. A host with a privileged path for its own UI and a lesser one for
    // plugins ends up with plugin buttons that behave differently under a narrow window — and nobody notices
    // until an author reports it, by which time the two paths have diverged in five other ways.
    const rebuilt = ribbonFrom(builtinManifests()[0]!.contributes);
    for (const width of [320, 500, 768, 1024, 1920, 3840]) {
      for (const tab of TABS.map((t) => t.id)) {
        const fromTable = layoutTab(tab, width, buildRibbon());
        const fromManifest = layoutTab(tab, width, rebuilt);
        expect(fromManifest.used, `${tab} at ${width}`).toBe(fromTable.used);
        expect(fromManifest.groups.map((g) => g.collapsed)).toEqual(fromTable.groups.map((g) => g.collapsed));
      }
    }
  });

  it("gives every inherited tool a command, and puts every command on the ribbon", () => {
    const contributions = builtinManifests()[0]!.contributes;
    // Both directions. A command with no ribbon home is legitimate in general — palette-only commands exist —
    // but for the *built-ins* it would mean a tool that used to be reachable no longer is.
    expect(commandsNotOnRibbon(contributions)).toEqual([]);
    expect(unknownTabs(contributions, new Set(TABS.map((t) => t.id)))).toEqual([]);
  });

  it("derives command ids that survive a retitling only by failing loudly", () => {
    expect(commandIdFor("Section plane (S) — dbl-click a face")).toBe(`${BUILTIN_ID}.section-plane-s-dbl-click-a-face`);
    for (const command of builtinManifests()[0]!.contributes.commands ?? []) {
      expect(command.id.startsWith(`${BUILTIN_ID}.`)).toBe(true);
      expect(command.id).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
    }
  });
});

// ===================================================================================================

describe("validation", () => {
  it("collects every problem rather than stopping at the first", () => {
    // A plugin author fixing a manifest one error per run is a plugin author who gives up. The host needs the
    // full list anyway, because "is this loadable" is a question about the presence of *any* error.
    const problems = validateManifest({
      id: "Bad Id",
      name: "",
      version: "one",
      activation: [],
      contributes: {},
    } as unknown as PluginManifest);
    const fields = problems.map((p) => p.at);
    expect(fields).toContain("id");
    expect(fields).toContain("name");
    expect(fields).toContain("version");
    expect(fields).toContain("activation");
    expect(isLoadable(problems)).toBe(false);
  });

  it("refuses an un-namespaced command id", () => {
    // Two plugins that both contribute `wall.add` produce a conflict the user cannot diagnose and neither author
    // can fix without coordinating. Enforcing the namespace makes it impossible rather than unlikely.
    const problems = validateManifest(
      manifest({ id: "acme.tools", contributes: { commands: [{ id: "wall.add", title: "Add wall" }] } }),
    );
    expect(problems.some((p) => p.at.endsWith(".id") && p.message.includes("namespaced"))).toBe(true);
  });

  it("refuses a ribbon item pointing at a command that does not exist", () => {
    // The worst failure a toolbar can have: a button that does nothing when pressed teaches a user not to trust
    // any of them. Caught at load, before it can be rendered.
    const problems = validateManifest(
      manifest({
        id: "acme.tools",
        contributes: {
          commands: [{ id: "acme.tools.a", title: "A" }],
          ribbon: [{ id: "g", label: "G", tab: "home", priority: 1, items: [{ command: "acme.tools.missing", size: "large" }] }],
        },
      }),
    );
    expect(problems.some((p) => p.message.includes("acme.tools.missing"))).toBe(true);
  });

  it("lets a ribbon item reference a dependency's command", () => {
    // Without this, splitting a plugin into a core and a UI package would be impossible — which is the shape
    // every non-trivial extension eventually wants.
    const problems = validateManifest(
      manifest({
        id: "acme.ui",
        dependencies: ["acme.core"],
        contributes: {
          ribbon: [{ id: "g", label: "G", tab: "home", priority: 1, items: [{ command: "acme.core.go", size: "large" }] }],
        },
      }),
      new Set(["acme.core.go"]),
    );
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("refuses a tab plugins are not allowed to invent", () => {
    const problems = validateManifest(
      manifest({
        id: "acme.tools",
        contributes: {
          commands: [{ id: "acme.tools.a", title: "A" }],
          ribbon: [{ id: "g", label: "G", tab: "acme" as never, priority: 1, items: [{ command: "acme.tools.a", size: "large" }] }],
        },
      }),
    );
    expect(problems.some((p) => p.message.includes("nine tabs"))).toBe(true);
  });

  it("warns about eager activation without refusing it", () => {
    // A warning, not an error. Eager activation is sometimes genuinely needed — a crash reporter, a telemetry
    // sink — and a rule with no escape hatch gets worked around somewhere nobody can audit.
    const problems = validateManifest(manifest({ id: "acme.tools", activation: ["*"] }));
    expect(problems.some((p) => p.severity === "warning" && p.message.includes("startup"))).toBe(true);
    expect(isLoadable(problems)).toBe(true);
  });

  it("does not warn about eager activation for a built-in", () => {
    // The built-ins are already in the bundle: there is nothing to defer, so the warning would be noise that
    // trains people to ignore warnings.
    const problems = validateManifest(manifest({ id: "acme.tools", activation: ["*"], builtin: true }));
    expect(problems).toEqual([]);
  });

  it("catches a setting whose default is not one of its options", () => {
    // Produces a control with no selected value, which reads as corrupted state rather than as a bad manifest.
    const problems = validateManifest(
      manifest({
        id: "acme.tools",
        contributes: {
          settings: [{ id: "acme.tools.mode", label: "Mode", type: "enum", default: "fast", options: ["draft", "final"] }],
        },
      }),
    );
    expect(problems.some((p) => p.at.endsWith(".default"))).toBe(true);
  });
});

describe("chord normalisation", () => {
  it("makes ctrl+K and Control+k one binding", () => {
    // Conflict detection is exactly as good as this. Two plugins binding `Ctrl+K` and `ctrl+k` must collide;
    // without normalisation the later one silently wins and nothing anywhere says why.
    expect(normaliseChord("ctrl+K")).toBe("Ctrl+K");
    expect(normaliseChord("Control+k")).toBe("Ctrl+K");
    expect(normaliseChord("CTRL+SHIFT+p")).toBe("Ctrl+Shift+P");
  });

  it("orders modifiers canonically, so Shift+Ctrl+P equals Ctrl+Shift+P", () => {
    expect(normaliseChord("Shift+Ctrl+P")).toBe(normaliseChord("Ctrl+Shift+P"));
  });

  it("accepts named keys and rejects nonsense", () => {
    expect(normaliseChord("Delete")).toBe("Delete");
    expect(normaliseChord("delete")).toBe("Delete");
    expect(normaliseChord("F12")).toBe("F12");
    expect(normaliseChord("Ctrl+ArrowUp")).toBe("Ctrl+Arrowup");
    expect(normaliseChord("Hyper+K")).toBeNull();
    expect(normaliseChord("Ctrl+Banana")).toBeNull();
    expect(normaliseChord("")).toBeNull();
  });
});

describe("dependency order", () => {
  it("puts dependencies first, deterministically", () => {
    // Sorted, because Map iteration order follows insertion order, which follows directory listing order, which
    // is not a specification. Two hosts loading the same plugins must agree.
    const result = topologicalOrder([
      manifest({ id: "c", dependencies: ["b"] }),
      manifest({ id: "a" }),
      manifest({ id: "b", dependencies: ["a"] }),
    ]);
    expect("order" in result && result.order).toEqual(["a", "b", "c"]);
  });

  it("reports the actual cycle, not that one exists", () => {
    // "A dependency cycle exists" in a graph of forty plugins costs an afternoon. The path is the fix.
    const result = topologicalOrder([
      manifest({ id: "a", dependencies: ["c"] }),
      manifest({ id: "b", dependencies: ["a"] }),
      manifest({ id: "c", dependencies: ["b"] }),
    ]);
    expect("cycle" in result).toBe(true);
    if ("cycle" in result) {
      // A closed path: the head repeats at the end so it reads as a cycle rather than a list.
      expect(result.cycle[0]).toBe(result.cycle[result.cycle.length - 1]);
      expect(new Set(result.cycle)).toEqual(new Set(["a", "b", "c"]));
    }
  });

  it("treats a missing dependency as missing, not as a cycle", () => {
    // Different problems with different fixes. Conflating them produces a message that sends the author looking
    // for a loop that is not there.
    const result = topologicalOrder([manifest({ id: "a", dependencies: ["nope"] })]);
    expect("order" in result && result.order).toEqual(["a"]);
  });
});

describe("loading", () => {
  const host = () => createPluginHost({ load: async () => ({}) });

  it("rejects a plugin whose dependency was rejected", () => {
    // Transitive. Loading a plugin whose dependency failed validation would activate code against an API that
    // is not there, and the failure would surface far from its cause.
    const h = host();
    const result = h.load([
      manifest({ id: "broken", version: "nope" }),
      manifest({ id: "dependent", dependencies: ["broken"] }),
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.id).sort()).toEqual(["broken", "dependent"]);
    expect(result.rejected.find((r) => r.id === "dependent")!.why).toContain("broken");
  });

  it("loads the plugins outside a cycle", () => {
    // One cycle among forty plugins must not disable the other thirty-seven.
    const h = host();
    const result = h.load([
      simple("acme.a", { dependencies: ["acme.b"] }),
      simple("acme.b", { dependencies: ["acme.a"] }),
      simple("acme.fine"),
    ]);
    expect(result.accepted).toEqual(["acme.fine"]);
    expect(result.rejected.map((r) => r.id).sort()).toEqual(["acme.a", "acme.b"]);
    expect(result.rejected[0]!.why).toMatch(/dependency cycle: /);
  });

  it("registers contributions at load, before any code runs", () => {
    // The whole point of a declarative manifest. The ribbon and the palette are complete from startup, so a user
    // can find a button before a single line of its plugin has been fetched.
    const load = vi.fn(async (): Promise<PluginRuntime> => ({}));
    const h = createPluginHost({ load });
    h.load([simple("acme.tools")]);

    expect(load).not.toHaveBeenCalled();
    expect(h.contributions().commands).toHaveLength(1);
    expect(ribbonFrom(h.contributions())).toHaveLength(1);
    expect(h.plugins[0]!.state).toBe("loaded");
  });

  it("reports keybinding conflicts instead of silently picking", () => {
    // First-one-wins is a defensible policy and a terrible silent one: the user presses Ctrl+K, gets the wrong
    // command, and nothing says why. A host that knows about the clash can offer to rebind.
    const h = host();
    const result = h.load([
      manifest({
        id: "acme.a",
        contributes: {
          commands: [{ id: "acme.a.go", title: "A" }],
          keybindings: [{ command: "acme.a.go", key: "Ctrl+K" }],
        },
      }),
      manifest({
        id: "acme.b",
        contributes: {
          commands: [{ id: "acme.b.go", title: "B" }],
          // Written differently on purpose: normalisation is what makes this a conflict rather than two bindings.
          keybindings: [{ command: "acme.b.go", key: "ctrl+k" }],
        },
      }),
    ]);
    expect([...result.keybindingConflicts.keys()]).toEqual(["Ctrl+K"]);
    expect(result.keybindingConflicts.get("Ctrl+K")).toEqual(["acme.a.go", "acme.b.go"]);
    // The policy is first-wins, and it is *visible* rather than accidental — the conflict is reported alongside.
    expect(h.keymap().get("Ctrl+K")).toBe("acme.a.go");
  });
});

describe("no plugin can break the host", () => {
  it("quarantines a plugin whose activate throws, and keeps the rest", async () => {
    // One bad plugin taking the application down makes installing anything a risk, which is the end of an
    // ecosystem before it starts.
    const failures: string[] = [];
    const h = createPluginHost({
      load: async (id) => ({
        activate: () => {
          if (id === "acme.bad") throw new Error("kaboom");
        },
      }),
      onFailure: (id, phase) => failures.push(`${id}:${phase}`),
    });

    h.load([simple("acme.one"), simple("acme.bad"), simple("acme.two")]);
    await h.fire("onStartupFinished");
    // These declare `onCommand:` activation, so fire the events they actually want.
    await h.fire("onCommand:acme.one.go");
    await h.fire("onCommand:acme.bad.go");
    await h.fire("onCommand:acme.two.go");

    const state = (id: string) => h.plugins.find((p) => p.manifest.id === id)!.state;
    expect(state("acme.one")).toBe("active");
    expect(state("acme.two")).toBe("active");
    expect(state("acme.bad")).toBe("quarantined");
    expect(h.plugins.find((p) => p.manifest.id === "acme.bad")!.failure).toBe("kaboom");
    expect(failures).toContain("acme.bad:activate");
  });

  it("rolls back everything a failed activation registered", async () => {
    // **A partially activated plugin is worse than one that failed.** Its ribbon button is present and does
    // nothing when pressed, and nothing distinguishes it from a working one until a user tries it.
    const disposed: string[] = [];
    const h = createPluginHost({
      load: async () => ({
        activate: (ctx) => {
          ctx.registerCommand("acme.tools.a", () => "a");
          ctx.subscriptions.push({ dispose: () => disposed.push("sub") });
          ctx.registerCommand("acme.tools.b", () => "b");
          throw new Error("failed after registering two of three");
        },
      }),
    });

    h.load([
      manifest({
        id: "acme.tools",
        activation: ["onStartupFinished"],
        contributes: {
          commands: [
            { id: "acme.tools.a", title: "A" },
            { id: "acme.tools.b", title: "B" },
            { id: "acme.tools.c", title: "C" },
          ],
        },
      }),
    ]);
    await h.fire("onStartupFinished");

    expect(h.plugins[0]!.state).toBe("quarantined");
    // Neither survivor. Not "the one after the throw" — *both*.
    await expect(h.runCommand("acme.tools.a")).rejects.toThrow(/no command/);
    await expect(h.runCommand("acme.tools.b")).rejects.toThrow(/no command/);
    expect(disposed).toEqual(["sub"]);
  });

  it("quarantines a plugin whose module fails to load", async () => {
    // A network failure or a syntax error in a lazily-imported chunk is the same class of event as a throwing
    // `activate`, and must not be a different outcome.
    const h = createPluginHost({
      load: async () => {
        throw new Error("chunk 404");
      },
    });
    h.load([simple("acme.tools")]);
    await h.fire("onCommand:acme.tools.go");
    expect(h.plugins[0]!.state).toBe("quarantined");
    expect(h.plugins[0]!.failure).toContain("chunk 404");
  });

  it("refuses an implementation for a command the manifest does not declare", async () => {
    // Silently accepting it would hide a manifest that is out of date with its code: the command would be
    // unreachable from the palette and the ribbon, and nothing would say so.
    const h = createPluginHost({
      load: async () => ({ activate: (ctx) => ctx.registerCommand("acme.tools.undeclared", () => 1) }),
    });
    h.load([simple("acme.tools")]);
    await h.fire("onCommand:acme.tools.go");
    expect(h.plugins[0]!.state).toBe("quarantined");
    expect(h.plugins[0]!.failure).toContain("does not declare");
  });

  it("drops a quarantined plugin's ribbon items, so no dead button renders", () => {
    // The consequence of rollback, at the layout level. A button whose implementation has been rolled back must
    // not be on screen — a control that does nothing is worse than an absent one.
    const h = createPluginHost({ load: async () => ({ activate: () => { throw new Error("no"); } }) });
    h.load([simple("acme.good"), simple("acme.bad")]);
    expect(ribbonFrom(h.contributions())).toHaveLength(2);
    return h.fire("onCommand:acme.bad.go").then(() => {
      expect(ribbonFrom(h.contributions())).toHaveLength(1);
      expect(ribbonFrom(h.contributions())[0]!.id).toBe("acme.good-group");
    });
  });

  it("swallows a throwing deactivate", async () => {
    // Propagating it would make disposing a set of plugins depend on all of them being well behaved, which is
    // the assumption this whole file exists to avoid.
    const failures: string[] = [];
    const h = createPluginHost({
      load: async () => ({
        activate: () => {},
        deactivate: () => {
          throw new Error("rude");
        },
      }),
      onFailure: (id, phase) => failures.push(`${id}:${phase}`),
    });
    h.load([simple("acme.tools")]);
    await h.fire("onCommand:acme.tools.go");
    await expect(h.dispose()).resolves.toBeUndefined();
    expect(failures).toContain("acme.tools:deactivate");
  });
});

describe("lazy activation", () => {
  it("activates on the command, not before", async () => {
    const load = vi.fn(async (): Promise<PluginRuntime> => ({
      activate: (ctx) => ctx.registerCommand("acme.tools.go", () => "ran"),
    }));
    const h = createPluginHost({ load });
    h.load([simple("acme.tools")]);

    // The button already exists — it came from the manifest.
    expect(ribbonFrom(h.contributions())[0]!.items).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();

    // Running it loads the code on demand. This is what makes `onCommand:` worth having.
    expect(await h.runCommand("acme.tools.go")).toBe("ran");
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.plugins[0]!.state).toBe("active");
  });

  it("activates once when two events fire at the same time", async () => {
    // Sharing the in-flight promise is the whole guard. A boolean flag set *after* the await would let both
    // callers through, so `activate` would run twice and the second `registerCommand` would throw — turning a
    // race into a quarantine.
    let activations = 0;
    const h = createPluginHost({
      load: async () => ({
        activate: async (ctx) => {
          activations++;
          await Promise.resolve();
          ctx.registerCommand("acme.tools.go", () => 1);
        },
      }),
    });
    h.load([simple("acme.tools", { activation: ["onCommand:acme.tools.go", "onStartupFinished"] })]);

    await Promise.all([h.fire("onStartupFinished"), h.fire("onCommand:acme.tools.go")]);
    expect(activations).toBe(1);
    expect(h.plugins[0]!.state).toBe("active");
  });

  it("does not activate a plugin that did not ask for the event", async () => {
    const load = vi.fn(async (): Promise<PluginRuntime> => ({}));
    const h = createPluginHost({ load });
    h.load([simple("acme.tools", { activation: ["onView:plan"] })]);
    await h.fire("onSelection:IfcWall");
    expect(load).not.toHaveBeenCalled();
    await h.fire("onView:plan");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("activates an eager plugin on any event", async () => {
    const load = vi.fn(async (): Promise<PluginRuntime> => ({}));
    const h = createPluginHost({ load });
    h.load([simple("acme.tools", { activation: ["*"] })]);
    await h.fire("onView:plan");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads a setting's declared default without a host store", async () => {
    const h = createPluginHost({ load: async () => ({ activate: () => {} }) });
    h.load([
      manifest({
        id: "acme.tools",
        contributes: { settings: [{ id: "acme.tools.grid", label: "Grid", type: "boolean", default: true }] },
      }),
    ]);
    let seen: unknown;
    const h2 = createPluginHost({
      load: async () => ({ activate: (ctx) => { seen = ctx.setting("acme.tools.grid"); } }),
    });
    h2.load([
      manifest({
        id: "acme.tools",
        contributes: { settings: [{ id: "acme.tools.grid", label: "Grid", type: "boolean", default: true }] },
      }),
    ]);
    await h2.fire("onStartupFinished");
    expect(seen).toBe(true);
  });
});

describe("teardown", () => {
  it("deactivates in reverse dependency order", async () => {
    // A dependent must be torn down before what it depends on, or it disposes against something already gone.
    const order: string[] = [];
    const h = createPluginHost({
      load: async (id) => ({ deactivate: () => order.push(id), activate: () => {} }),
    });
    h.load([simple("acme.core"), simple("acme.ui", { dependencies: ["acme.core"] })]);
    await h.fire("onCommand:acme.core.go");
    await h.fire("onCommand:acme.ui.go");
    await h.dispose();
    expect(order).toEqual(["acme.ui", "acme.core"]);
  });

  it("returns a deactivated plugin to loaded, so it can activate again", async () => {
    const h = createPluginHost({
      load: async () => ({ activate: (ctx) => ctx.registerCommand("acme.tools.go", () => "ran") }),
    });
    h.load([simple("acme.tools")]);
    await h.fire("onCommand:acme.tools.go");
    await h.deactivate("acme.tools");
    expect(h.plugins[0]!.state).toBe("loaded");
    // And its contributions are back on the ribbon, because `loaded` is a UI-complete state.
    expect(ribbonFrom(h.contributions())).toHaveLength(1);
    expect(await h.runCommand("acme.tools.go")).toBe("ran");
  });
});

describe("merging", () => {
  it("merges two plugins' items into one group rather than showing it twice", () => {
    // Two groups with the same label side by side is the shape of a broken extension model. Merging by id is the
    // mechanism that avoids it, and it is what lets a plugin add a button to the existing Draw group.
    const h = createPluginHost({ load: async () => ({}) });
    h.load([
      manifest({
        id: "acme.a",
        contributes: {
          commands: [{ id: "acme.a.go", title: "A" }],
          ribbon: [{ id: "draw", label: "Draw", tab: "build", priority: 9, items: [{ command: "acme.a.go", size: "large" }] }],
        },
      }),
      manifest({
        id: "acme.b",
        contributes: {
          commands: [{ id: "acme.b.go", title: "B" }],
          ribbon: [{ id: "draw", label: "Draw", tab: "build", priority: 9, items: [{ command: "acme.b.go", size: "large" }] }],
        },
      }),
    ]);
    const groups = ribbonFrom(h.contributions());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(["A", "B"]);
  });
});
