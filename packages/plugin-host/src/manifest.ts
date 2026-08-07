import type { ItemSize, TabId } from "@massingviewer/ui-model";

/**
 * The declarative contribution manifest — what a plugin *says* it adds, before any of its code runs.
 *
 * ## Why declarative, and why that is the whole design
 *
 * VS Code's model, and the reason it works: the manifest is **data**, so the host can build its entire UI —
 * ribbon, palette, keybindings, menus — without executing a single line of plugin code. That is what makes lazy
 * activation possible, and lazy activation is what keeps a hundred installed plugins from costing a hundred
 * module evaluations at startup.
 *
 * The imperative alternative (`api.addRibbonButton(...)` in an `activate()`) inverts it: the host cannot know
 * what exists until it has run everything, so nothing can be lazy, and a plugin that throws halfway leaves the
 * UI in a state nobody designed.
 *
 * ## The test this design has to pass
 *
 * **The first-party ribbon is assembled from manifests.** Not "could be" — is, in `builtin.ts`, asserted against
 * `buildRibbon()` from `ui-model`. The plan put it plainly: if the first-party UI cannot be expressed as
 * contributions, the contribution model is wrong, and it is better to find that out now than after third parties
 * have written against it.
 *
 * ## Validation is not optional
 *
 * A manifest is the one part of a plugin that arrives as data, which means it arrives malformed. Every field is
 * checked, **all** errors are collected rather than the first, and a manifest that fails is refused with reasons.
 * Refusing on the first error makes fixing a manifest an N-round-trip process; reporting all of them makes it one.
 */

export interface CommandContribution {
  /** Namespaced, e.g. `mv.wall.add`. The namespace is asserted to match the plugin's id. */
  readonly id: string;
  readonly title: string;
  /** Category prefix in the palette: "Draw", "View", "Markup". */
  readonly category?: string;
  /** Capability this command needs. Gated by `availabilityOf`, dimmed with a reason when unmet. */
  readonly capability?: "view" | "edit" | "admin";
  /** Short glyph. Text, not an icon font — no extra request, and it survives a CSP with no `font-src`. */
  readonly glyph?: string;
}

export interface RibbonGroupContribution {
  readonly id: string;
  readonly label: string;
  readonly tab: TabId;
  /** Lower collapses first. Explicit, because the group that should survive longest is not the leftmost. */
  readonly priority: number;
  readonly items: readonly {
    /** A command id contributed by this plugin or an earlier one. Asserted to resolve. */
    readonly command: string;
    readonly size: ItemSize;
  }[];
}

export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  readonly location: "left" | "right" | "bottom";
  readonly order?: number;
}

export interface KeybindingContribution {
  readonly command: string;
  /** Chord notation: `Ctrl+K`, `Shift+F`, `Delete`. Normalised and checked for conflicts across plugins. */
  readonly key: string;
  /** Only active when this is true — `selection`, `plan`, `editable`. */
  readonly when?: string;
}

export interface IoContribution {
  readonly id: string;
  /** File kinds this handles, matching `@massingviewer/fileio`'s `FileKind` values. */
  readonly kinds: readonly string[];
  readonly label: string;
}

export interface SettingContribution {
  readonly id: string;
  readonly label: string;
  readonly type: "boolean" | "number" | "string" | "enum";
  readonly default: boolean | number | string;
  readonly options?: readonly string[];
}

export interface Contributions {
  readonly commands?: readonly CommandContribution[];
  readonly ribbon?: readonly RibbonGroupContribution[];
  readonly panels?: readonly PanelContribution[];
  readonly keybindings?: readonly KeybindingContribution[];
  readonly importers?: readonly IoContribution[];
  readonly exporters?: readonly IoContribution[];
  readonly settings?: readonly SettingContribution[];
}

/**
 * When a plugin's code should be loaded.
 *
 * The point of the whole design. A plugin contributing a ribbon button under `onCommand:` costs nothing until
 * that button is pressed — the *button* comes from the manifest, the *code* comes later.
 *
 * `"*"` is legal and discouraged, and {@link validateManifest} warns about it rather than refusing: eager
 * activation is occasionally genuinely necessary (a telemetry sink, a crash reporter) and a rule with no escape
 * hatch gets worked around in a way nobody can audit.
 */
export type ActivationEvent =
  | `onCommand:${string}`
  | `onSelection:${string}`
  | `onFileType:${string}`
  | `onKernel:${string}`
  | `onView:${string}`
  | "onStartupFinished"
  | "*";

export interface PluginManifest {
  /** Reverse-DNS-ish, lowercase. Also the namespace every contributed id must sit under. */
  readonly id: string;
  readonly name: string;
  /** SemVer. */
  readonly version: string;
  readonly description?: string;
  readonly publisher?: string;
  /** Other plugin ids that must activate first. Cycles are reported with the actual cycle, not "a cycle exists". */
  readonly dependencies?: readonly string[];
  readonly activation: readonly ActivationEvent[];
  readonly contributes: Contributions;
  /** True for packages that ship with the product. Used to explain, never to skip validation. */
  readonly builtin?: boolean;
}

export interface ManifestProblem {
  /** Dotted path to the offending field, so a fix does not require reading the whole manifest. */
  readonly at: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ACTIVATION = /^(onCommand:|onSelection:|onFileType:|onKernel:|onView:).+$|^onStartupFinished$|^\*$/;
const TABS_ALLOWED = new Set<string>([
  "home", "build", "insert", "annotate", "sheet", "analyse", "review", "view", "manage",
]);

/**
 * Check a manifest, collecting every problem.
 *
 * Returns problems rather than throwing, and never stops at the first. A plugin author fixing a manifest one
 * error per run is a plugin author who gives up — and the host needs the full list anyway, because it decides
 * whether to load at all from the presence of any `error`.
 *
 * `knownCommands` carries ids contributed by manifests already accepted, so a ribbon item may reference a command
 * from a *dependency*. Without it, splitting a plugin into a core and a UI package would be impossible.
 */
export function validateManifest(
  manifest: PluginManifest,
  knownCommands: ReadonlySet<string> = new Set(),
): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  // Braced bodies: `push` returns the new length, and an arrow with a concise body returning it does not satisfy
  // `void` under this config. Worth the two extra characters rather than a cast.
  const error = (at: string, message: string): void => {
    problems.push({ at, message, severity: "error" });
  };
  const warn = (at: string, message: string): void => {
    problems.push({ at, message, severity: "warning" });
  };

  if (typeof manifest.id !== "string" || !ID.test(manifest.id)) {
    error("id", `"${String(manifest.id)}" is not a valid id — lowercase, dots and hyphens only`);
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") error("name", "a display name is required");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    error("version", `"${String(manifest.version)}" is not SemVer`);
  }

  if (!Array.isArray(manifest.activation) || manifest.activation.length === 0) {
    error("activation", "at least one activation event is required — a plugin that never activates is dead code");
  } else {
    manifest.activation.forEach((event, i) => {
      if (typeof event !== "string" || !ACTIVATION.test(event)) {
        error(`activation[${i}]`, `"${String(event)}" is not a recognised activation event`);
      }
      if (event === "*" && manifest.builtin !== true) {
        // A warning, not an error. Eager activation is sometimes genuinely needed, and a rule with no escape
        // hatch gets worked around somewhere nobody can audit.
        warn(`activation[${i}]`, "eager activation costs startup time for every user — prefer a specific event");
      }
    });
  }

  const contributes = manifest.contributes ?? {};
  const ownCommands = new Set<string>();

  (contributes.commands ?? []).forEach((command, i) => {
    const at = `contributes.commands[${i}]`;
    if (typeof command.id !== "string" || !ID.test(command.id)) {
      error(`${at}.id`, `"${String(command.id)}" is not a valid command id`);
      return;
    }
    // Namespacing is enforced rather than encouraged. Two plugins that both contribute `wall.add` produce a
    // conflict the user cannot diagnose and neither author can fix without coordinating.
    if (!command.id.startsWith(`${manifest.id}.`)) {
      error(`${at}.id`, `"${command.id}" must be namespaced under "${manifest.id}."`);
    }
    if (ownCommands.has(command.id)) error(`${at}.id`, `"${command.id}" is contributed twice`);
    ownCommands.add(command.id);
    if (typeof command.title !== "string" || command.title.trim() === "") {
      error(`${at}.title`, "a command with no title cannot appear in the palette");
    }
  });

  const resolvable = new Set([...knownCommands, ...ownCommands]);

  (contributes.ribbon ?? []).forEach((group, i) => {
    const at = `contributes.ribbon[${i}]`;
    if (typeof group.id !== "string" || group.id === "") error(`${at}.id`, "a group needs an id");
    if (typeof group.label !== "string" || group.label === "") error(`${at}.label`, "a group needs a label");
    if (!TABS_ALLOWED.has(group.tab)) {
      error(`${at}.tab`, `"${String(group.tab)}" is not one of the nine tabs — plugins join tabs, they do not invent them`);
    }
    if (typeof group.priority !== "number" || !Number.isFinite(group.priority)) {
      error(`${at}.priority`, "priority must be a finite number: it decides what survives a narrow window");
    }
    if (!Array.isArray(group.items) || group.items.length === 0) {
      error(`${at}.items`, "an empty ribbon group renders as a labelled gap");
      return;
    }
    group.items.forEach((item, j) => {
      // The check that makes the ribbon trustworthy. A dangling command id renders a button that does nothing
      // when pressed, which is the single worst failure a toolbar can have — it teaches a user not to trust it.
      if (!resolvable.has(item.command)) {
        error(`${at}.items[${j}].command`, `"${item.command}" is not contributed by this plugin or its dependencies`);
      }
      if (item.size !== "large" && item.size !== "medium" && item.size !== "small") {
        error(`${at}.items[${j}].size`, `"${String(item.size)}" is not a size`);
      }
    });
  });

  (contributes.keybindings ?? []).forEach((binding, i) => {
    const at = `contributes.keybindings[${i}]`;
    if (!resolvable.has(binding.command)) {
      error(`${at}.command`, `"${binding.command}" is not a known command`);
    }
    if (typeof binding.key !== "string" || normaliseChord(binding.key) === null) {
      error(`${at}.key`, `"${String(binding.key)}" is not a chord this understands`);
    }
  });

  (contributes.settings ?? []).forEach((setting, i) => {
    const at = `contributes.settings[${i}]`;
    if (setting.type === "enum" && (setting.options === undefined || setting.options.length === 0)) {
      error(`${at}.options`, "an enum setting with no options cannot be edited");
    }
    if (setting.type === "enum" && setting.options !== undefined && !setting.options.includes(String(setting.default))) {
      // A default outside the option list produces a control with no selected value, which reads as corruption.
      error(`${at}.default`, `default "${String(setting.default)}" is not one of the options`);
    }
    const actual = typeof setting.default;
    const expected = setting.type === "enum" ? "string" : setting.type;
    if (actual !== expected) error(`${at}.default`, `default is a ${actual}, but the type is ${setting.type}`);
  });

  for (const [i, dependency] of (manifest.dependencies ?? []).entries()) {
    if (!ID.test(dependency)) error(`dependencies[${i}]`, `"${dependency}" is not a valid plugin id`);
    if (dependency === manifest.id) error(`dependencies[${i}]`, "a plugin cannot depend on itself");
  }

  return problems;
}

/**
 * Canonicalise a chord so `ctrl+K`, `Control+k` and `Ctrl+K` are one binding.
 *
 * Returns `null` for anything unrecognised. Conflict detection is only as good as this: two plugins binding
 * `Ctrl+K` and `ctrl+k` must collide, and without normalisation the later one silently wins.
 */
export function normaliseChord(chord: string): string | null {
  const parts = chord.split("+").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return null;

  const key = parts.pop()!;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") modifiers.add("Ctrl");
    else if (lower === "shift") modifiers.add("Shift");
    else if (lower === "alt" || lower === "option") modifiers.add("Alt");
    else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers.add("Meta");
    else return null;
  }

  // Single characters upper-case; named keys title-cased. `Delete` and `delete` are the same key.
  const canonical =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  if (!/^([A-Z0-9]|F\d{1,2}|Delete|Escape|Enter|Tab|Space|Backspace|Home|End|Pageup|Pagedown|Arrowup|Arrowdown|Arrowleft|Arrowright)$/.test(canonical)) {
    return null;
  }

  return [...["Ctrl", "Shift", "Alt", "Meta"].filter((m) => modifiers.has(m)), canonical].join("+");
}

/** Did validation find anything fatal? Warnings do not block a load. */
export function isLoadable(problems: readonly ManifestProblem[]): boolean {
  return !problems.some((p) => p.severity === "error");
}
