import {
  type ActivationEvent,
  type Contributions,
  type ManifestProblem,
  type PluginManifest,
  isLoadable,
  normaliseChord,
  validateManifest,
} from "./manifest.js";

/**
 * The host: registration, dependency-ordered lazy activation, and the property that matters most —
 * **no plugin can break the host, or any other plugin.**
 *
 * That is a structural claim, not an aspiration, and it needs three separate mechanisms. Each one exists because
 * the failure it prevents is worse than the plugin simply not working:
 *
 * 1. **Quarantine.** A plugin whose `activate` throws is disabled, its error recorded, and everything else
 *    carries on. The alternative — one bad plugin taking the application down — makes installing anything a risk.
 *
 * 2. **All-or-nothing activation.** If a plugin registers two of its three things and then throws, all three are
 *    rolled back. **A partially activated plugin is worse than one that failed**: its ribbon button is present
 *    and does nothing, and a control that does nothing when pressed teaches a user to distrust the whole toolbar.
 *
 * 3. **Cycles reported as cycles.** `a -> b -> c -> a`, the actual path. "A dependency cycle exists" in a graph of
 *    forty plugins is a message that costs an afternoon.
 *
 * ## Contributions are registered at *load*, activation code runs at *activate*
 *
 * The split is the whole point of a declarative manifest. Loading is cheap and eager: every installed plugin's
 * ribbon, palette entries and keybindings exist from startup, so the UI is complete and searchable. Activation is
 * expensive and lazy: the module is not even fetched until an activation event fires.
 *
 * So a user sees the button before any of its code has run — which is the only way a hundred plugins can be
 * installed without a hundred module evaluations at startup.
 */

export type PluginState =
  /** Manifest accepted, contributions registered, code not yet loaded. The normal resting state. */
  | "loaded"
  /** `activate` ran and returned. */
  | "active"
  /** Refused at load: the manifest had errors, or a dependency is missing or cyclic. */
  | "rejected"
  /** Loaded fine, then failed to activate. Its contributions have been rolled back. */
  | "quarantined";

export interface PluginRuntime {
  /** Called once, on the first matching activation event. May be async; may throw. */
  activate?: (context: PluginContext) => void | Promise<void>;
  /** Called on teardown. A throw here is caught and recorded, never propagated. */
  deactivate?: () => void | Promise<void>;
}

export interface PluginContext {
  readonly id: string;
  /** Register the implementation of a declared command. Registering an undeclared id is refused. */
  registerCommand(id: string, run: (...args: unknown[]) => unknown): void;
  /** Anything the plugin needs disposed on deactivation. Disposed in reverse order. */
  readonly subscriptions: { dispose(): void }[];
  /** Read a declared setting's current value. */
  setting(id: string): boolean | number | string | undefined;
}

export interface RegisteredPlugin {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly problems: readonly ManifestProblem[];
  /** Why it was rejected or quarantined. Always present when the state is one of those. */
  readonly failure?: string;
}

export interface LoadResult {
  readonly accepted: readonly string[];
  readonly rejected: readonly { readonly id: string; readonly why: string }[];
  /** Chord → the command ids fighting over it. Reported, never silently resolved. */
  readonly keybindingConflicts: ReadonlyMap<string, readonly string[]>;
}

/** A module loader, injected. The host never imports anything itself, so it works in a test and in a browser. */
export type PluginLoader = (id: string) => Promise<PluginRuntime>;

export interface HostOptions {
  readonly load: PluginLoader;
  /** Read a setting. Defaults come from the manifests. */
  readonly settings?: (id: string) => boolean | number | string | undefined;
  /** Called for every failure, so a host can log or report. Never throws back into the host. */
  readonly onFailure?: (id: string, phase: "load" | "activate" | "deactivate", error: unknown) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Order plugins so dependencies come first, or report the cycle.
 *
 * Iterative Kahn's algorithm plus an explicit DFS for the cycle path. The DFS is only run when the sort has
 * already failed, so the common case pays nothing for a diagnostic the failure case cannot do without.
 */
export function topologicalOrder(
  manifests: readonly PluginManifest[],
): { readonly order: readonly string[] } | { readonly cycle: readonly string[] } {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const manifest of manifests) {
    indegree.set(manifest.id, 0);
    dependents.set(manifest.id, []);
  }
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      // A missing dependency is not a cycle; it is handled at load, where the message can name it.
      if (!byId.has(dependency)) continue;
      indegree.set(manifest.id, (indegree.get(manifest.id) ?? 0) + 1);
      dependents.get(dependency)!.push(manifest.id);
    }
  }

  // Sorted, so the order is deterministic for a given input. Two hosts must agree, and Map iteration order
  // depends on insertion order — which depends on directory listing order, which is not a specification.
  const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!.sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
    ready.sort();
  }

  if (order.length === manifests.length) return { order };

  // Something is cyclic. Find the actual path rather than reporting that one exists.
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  let found: string[] | null = null;

  const walk = (id: string): void => {
    if (found !== null || done.has(id)) return;
    if (onStack.has(id)) {
      // Close the loop at the point it re-enters, and repeat the head so the path reads as a cycle.
      found = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    onStack.add(id);
    stack.push(id);
    for (const dependency of (byId.get(id)?.dependencies ?? []).filter((d) => byId.has(d))) walk(dependency);
    stack.pop();
    onStack.delete(id);
    done.add(id);
  };
  for (const manifest of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) walk(manifest.id);

  return { cycle: found ?? manifests.filter((m) => !order.includes(m.id)).map((m) => m.id) };
}

export interface PluginHost {
  load(manifests: readonly PluginManifest[]): LoadResult;
  /** Fire an activation event. Resolves once every plugin it activates has settled. */
  fire(event: ActivationEvent): Promise<readonly string[]>;
  runCommand(id: string, ...args: unknown[]): Promise<unknown>;
  readonly plugins: readonly RegisteredPlugin[];
  /** Everything registered by *loaded* plugins, merged in dependency order. */
  contributions(): Contributions;
  /** Chord → command id, for the keybinding layer. Conflicts already resolved by load order and reported. */
  keymap(): ReadonlyMap<string, string>;
  deactivate(id: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createPluginHost(options: HostOptions): PluginHost {
  const registry = new Map<string, RegisteredPlugin>();
  /** Load order, which is dependency order. Contribution merging follows it so precedence is predictable. */
  const order: string[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const runtimes = new Map<string, PluginRuntime>();
  const contexts = new Map<string, PluginContext>();
  const activating = new Map<string, Promise<void>>();

  const settingDefaults = new Map<string, boolean | number | string>();
  const onFailure = options.onFailure ?? (() => {});

  const set = (id: string, patch: Partial<RegisteredPlugin>): void => {
    const current = registry.get(id);
    if (current !== undefined) registry.set(id, { ...current, ...patch });
  };

  function load(manifests: readonly PluginManifest[]): LoadResult {
    const accepted: string[] = [];
    const rejected: { id: string; why: string }[] = [];

    const sorted = topologicalOrder(manifests);
    if ("cycle" in sorted) {
      // Every plugin in the cycle is rejected, and the message carries the path so it is fixable in one pass.
      const path = sorted.cycle.join(" -> ");
      for (const id of new Set(sorted.cycle)) {
        registry.set(id, {
          manifest: manifests.find((m) => m.id === id)!,
          state: "rejected",
          problems: [],
          failure: `dependency cycle: ${path}`,
        });
        rejected.push({ id, why: `dependency cycle: ${path}` });
      }
      // The rest still load: one cycle among forty plugins must not disable the other thirty-seven.
      const inCycle = new Set(sorted.cycle);
      return { ...loadInOrder(manifests.filter((m) => !inCycle.has(m.id)).map((m) => m.id), manifests, rejected), keybindingConflicts: conflicts() };
    }

    const result = loadInOrder(sorted.order, manifests, rejected);
    accepted.push(...result.accepted);
    return { accepted, rejected: result.rejected, keybindingConflicts: conflicts() };
  }

  function loadInOrder(
    ids: readonly string[],
    manifests: readonly PluginManifest[],
    rejected: { id: string; why: string }[],
  ): { accepted: string[]; rejected: { id: string; why: string }[] } {
    const accepted: string[] = [];
    const known = new Set<string>(
      [...registry.values()]
        .filter((p) => p.state !== "rejected")
        .flatMap((p) => (p.manifest.contributes.commands ?? []).map((c) => c.id)),
    );

    for (const id of ids) {
      const manifest = manifests.find((m) => m.id === id);
      if (manifest === undefined) continue;

      const missing = (manifest.dependencies ?? []).filter(
        (d) => registry.get(d)?.state === undefined || registry.get(d)!.state === "rejected",
      );
      if (missing.length > 0) {
        const why = `missing or rejected dependencies: ${missing.join(", ")}`;
        registry.set(id, { manifest, state: "rejected", problems: [], failure: why });
        rejected.push({ id, why });
        continue;
      }

      const problems = validateManifest(manifest, known);
      if (!isLoadable(problems)) {
        const why = problems
          .filter((p) => p.severity === "error")
          .map((p) => `${p.at}: ${p.message}`)
          .join("; ");
        registry.set(id, { manifest, state: "rejected", problems, failure: why });
        rejected.push({ id, why });
        continue;
      }

      registry.set(id, { manifest, state: "loaded", problems });
      order.push(id);
      accepted.push(id);
      for (const command of manifest.contributes.commands ?? []) known.add(command.id);
      for (const setting of manifest.contributes.settings ?? []) settingDefaults.set(setting.id, setting.default);
    }

    return { accepted, rejected };
  }

  /**
   * Chords bound by more than one command.
   *
   * Reported rather than resolved. First-one-wins is a defensible policy and a terrible silent one: the user
   * presses Ctrl+K, gets the wrong command, and nothing anywhere says why. A host that knows about the clash can
   * offer to rebind; a host that quietly picked cannot.
   */
  function conflicts(): ReadonlyMap<string, readonly string[]> {
    const byChord = new Map<string, string[]>();
    for (const id of order) {
      const plugin = registry.get(id);
      if (plugin === undefined || plugin.state === "rejected" || plugin.state === "quarantined") continue;
      for (const binding of plugin.manifest.contributes.keybindings ?? []) {
        const chord = normaliseChord(binding.key);
        if (chord === null) continue;
        const bucket = byChord.get(chord);
        if (bucket === undefined) byChord.set(chord, [binding.command]);
        else bucket.push(binding.command);
      }
    }
    return new Map([...byChord].filter(([, commandsFor]) => commandsFor.length > 1));
  }

  function activeManifests(): readonly PluginManifest[] {
    return order
      .map((id) => registry.get(id))
      .filter((p): p is RegisteredPlugin => p !== undefined && p.state !== "rejected" && p.state !== "quarantined")
      .map((p) => p.manifest);
  }

  function contributions(): Contributions {
    const merged: {
      commands: Contributions["commands"];
      ribbon: Contributions["ribbon"];
      panels: Contributions["panels"];
      keybindings: Contributions["keybindings"];
      importers: Contributions["importers"];
      exporters: Contributions["exporters"];
      settings: Contributions["settings"];
    } = { commands: [], ribbon: [], panels: [], keybindings: [], importers: [], exporters: [], settings: [] };

    for (const manifest of activeManifests()) {
      const c = manifest.contributes;
      merged.commands = [...(merged.commands ?? []), ...(c.commands ?? [])];
      merged.ribbon = [...(merged.ribbon ?? []), ...(c.ribbon ?? [])];
      merged.panels = [...(merged.panels ?? []), ...(c.panels ?? [])];
      merged.keybindings = [...(merged.keybindings ?? []), ...(c.keybindings ?? [])];
      merged.importers = [...(merged.importers ?? []), ...(c.importers ?? [])];
      merged.exporters = [...(merged.exporters ?? []), ...(c.exporters ?? [])];
      merged.settings = [...(merged.settings ?? []), ...(c.settings ?? [])];
    }
    return merged;
  }

  function keymap(): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    for (const binding of contributions().keybindings ?? []) {
      const chord = normaliseChord(binding.key);
      // First wins, and `conflicts()` reports the rest — so the policy is visible rather than accidental.
      if (chord !== null && !map.has(chord)) map.set(chord, binding.command);
    }
    return map;
  }

  /** Which loaded plugins want this event? */
  function matching(event: ActivationEvent): readonly string[] {
    return order.filter((id) => {
      const plugin = registry.get(id);
      if (plugin?.state !== "loaded") return false;
      return plugin.manifest.activation.some((declared) => declared === "*" || declared === event);
    });
  }

  async function activate(id: string): Promise<void> {
    const existing = activating.get(id);
    // Two events firing at once must not run `activate` twice. Sharing the promise is the whole guard; a boolean
    // flag set after the await would let both callers through.
    if (existing !== undefined) return existing;

    const plugin = registry.get(id);
    if (plugin === undefined || plugin.state !== "loaded") return;

    const promise = (async () => {
      /**
       * Everything this activation registered, so a failure can undo it.
       *
       * The reason all-or-nothing matters: a plugin that registered two commands and then threw leaves two
       * ribbon buttons that do nothing when pressed. That is worse than a plugin that failed outright, because
       * nothing distinguishes it from a working one until a user presses it.
       */
      const registeredHere: string[] = [];
      const declared = new Set((plugin.manifest.contributes.commands ?? []).map((c) => c.id));

      const context: PluginContext = {
        id,
        subscriptions: [],
        registerCommand(commandId, run) {
          if (!declared.has(commandId)) {
            // Refused, not ignored. An implementation for an undeclared command is unreachable from the palette
            // and the ribbon, so silently accepting it would hide a manifest that is out of date with its code.
            throw new Error(`${id} registered "${commandId}", which its manifest does not declare`);
          }
          if (commands.has(commandId)) throw new Error(`"${commandId}" is already registered`);
          commands.set(commandId, run);
          registeredHere.push(commandId);
        },
        setting: (settingId) => options.settings?.(settingId) ?? settingDefaults.get(settingId),
      };

      let runtime: PluginRuntime;
      try {
        runtime = await options.load(id);
      } catch (error) {
        onFailure(id, "load", error);
        set(id, { state: "quarantined", failure: `could not load: ${messageOf(error)}` });
        return;
      }

      try {
        await runtime.activate?.(context);
      } catch (error) {
        // Roll back, then quarantine. Order matters: leaving the commands registered would make the failure
        // invisible from the UI's point of view.
        for (const commandId of registeredHere) commands.delete(commandId);
        for (const subscription of context.subscriptions.reverse()) {
          try {
            subscription.dispose();
          } catch {
            // A disposer that throws during rollback cannot be allowed to stop the rollback.
          }
        }
        onFailure(id, "activate", error);
        set(id, { state: "quarantined", failure: messageOf(error) });
        return;
      }

      runtimes.set(id, runtime);
      contexts.set(id, context);
      set(id, { state: "active" });
    })();

    activating.set(id, promise);
    await promise;
    // Cleared so a quarantined plugin can be retried after a fix, rather than being dead for the session.
    if (registry.get(id)?.state !== "active") activating.delete(id);
    return promise;
  }

  return {
    load,

    async fire(event) {
      const wanted = matching(event);
      // `allSettled`, not `all`. One plugin failing to activate must not stop the others from being tried, and
      // `activate` already converts every throw into a quarantine — so a rejection here would be a host bug.
      await Promise.allSettled(wanted.map((id) => activate(id)));
      return wanted.filter((id) => registry.get(id)?.state === "active");
    },

    async runCommand(id, ...args) {
      if (!commands.has(id)) {
        // Activate on demand. This is what makes `onCommand:` work, and it is why a ribbon button can exist
        // before a single line of its plugin's code has been fetched.
        const owner = findOwner(id);
        if (owner !== null) await activate(owner);
      }
      const run = commands.get(id);
      if (run === undefined) throw new Error(`no command "${id}" — not declared, or its plugin is quarantined`);
      return run(...args);
    },

    get plugins() {
      return [...registry.values()];
    },

    contributions,
    keymap,

    async deactivate(id) {
      const runtime = runtimes.get(id);
      const context = contexts.get(id);
      for (const commandId of (registry.get(id)?.manifest.contributes.commands ?? []).map((c) => c.id)) {
        commands.delete(commandId);
      }
      for (const subscription of (context?.subscriptions ?? []).reverse()) {
        try {
          subscription.dispose();
        } catch (error) {
          onFailure(id, "deactivate", error);
        }
      }
      try {
        await runtime?.deactivate?.();
      } catch (error) {
        // A throw in `deactivate` is recorded and swallowed. Propagating it would make disposing a set of
        // plugins depend on all of them being well-behaved, which is exactly what cannot be assumed.
        onFailure(id, "deactivate", error);
      }
      runtimes.delete(id);
      contexts.delete(id);
      activating.delete(id);
      set(id, { state: "loaded" });
    },

    async dispose() {
      // Reverse order, so a dependent is torn down before what it depends on.
      for (const id of [...order].reverse()) await this.deactivate(id);
    },
  };

  function findOwner(commandId: string): string | null {
    for (const id of order) {
      const plugin = registry.get(id);
      if (plugin === undefined) continue;
      if ((plugin.manifest.contributes.commands ?? []).some((c) => c.id === commandId)) return id;
    }
    return null;
  }
}
