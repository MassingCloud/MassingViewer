import { TOOLS, buildRibbon, type ItemSize, type TabId } from "@massing/ui-model";
import type { CommandContribution, PluginManifest, RibbonGroupContribution } from "./manifest.js";

/**
 * The first-party ribbon, expressed as plugin manifests.
 *
 * ## Why this file exists
 *
 * The plan states the test in one sentence: *"The whole first-party ribbon is assembled from these manifests — if
 * it can't be, the contribution model is wrong and we find out in week two."*
 *
 * This is that sentence, executable. `builtinManifests()` derives manifests from `ui-model`'s own tables, and
 * `builtin.test.ts` asserts that feeding them through `ribbonFrom` reproduces `buildRibbon()` **exactly** — same
 * groups, same order, same items, same priorities.
 *
 * A contribution model validated only against toy plugins is a contribution model that discovers its limits when
 * a third party hits them. Deriving rather than hand-writing matters too: a hand-written copy of the built-in
 * ribbon would drift from the real one, and then this test would prove that the model can express *last month's*
 * ribbon.
 *
 * ## What it does not claim
 *
 * The built-in tools are not *loaded* as plugins at runtime, and pretending otherwise would be theatre — they
 * ship in the same bundle, they cannot be uninstalled, and routing them through a loader would add a failure mode
 * for no benefit. What is proved is narrower and is the thing that matters: **the contribution model is
 * expressive enough for the real UI**, so a plugin is not a second-class citizen by construction.
 */

/** Namespace for everything derived from the inherited tool table. */
export const BUILTIN_ID = "massingviewer.core";

/**
 * Command id from a tool title.
 *
 * `title` is what `toolbarLayout` already treats as the key, and it is what `ui-model`'s `HOMES` map is keyed on —
 * a lesson from getting it wrong: keying on the *label* mapped 6 tools of 30, and only an explicit
 * "every tool has a home" assertion caught it.
 *
 * The slug is constrained to what `validateManifest` accepts as an id: lowercase, dots and hyphens.
 */
export function commandIdFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${BUILTIN_ID}.${slug}`;
}

/**
 * Derive manifests for the built-in ribbon from `ui-model`.
 *
 * One manifest, not nine. A tab is not an ownership boundary — `Home` holds groups from Select, Draw and View,
 * and splitting by tab would invent dependencies between things that merely share a tab.
 */
export function builtinManifests(): readonly PluginManifest[] {
  const groups = buildRibbon();

  const commands: CommandContribution[] = TOOLS.map((tool) => ({
    id: commandIdFor(tool.title),
    title: tool.title,
    // Derived from `group`, because that is where `availabilityOf` reads it from. Duplicating the rule as a
    // per-tool `cap` field would be a second source of truth for the same fact, and the two would disagree the
    // first time a tool moved groups.
    capability: tool.group === "author" ? ("edit" as const) : ("view" as const),
  }));

  const ribbon: RibbonGroupContribution[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    tab: group.tab as TabId,
    priority: group.priority,
    items: group.items.map((item) => ({
      command: commandIdFor(item.title),
      size: item.preferred as ItemSize,
    })),
  }));

  return [
    {
      id: BUILTIN_ID,
      name: "MassingViewer core tools",
      version: "0.0.0",
      description: "The inherited tool surface, expressed as contributions so the model is proved against the real UI.",
      publisher: "MassingCloud",
      // Eager, and legitimately so: these are the product's own tools, and there is nothing to defer — the code
      // is already in the bundle. `builtin: true` is what stops `validateManifest` warning about `"*"`.
      activation: ["*"],
      builtin: true,
      contributes: { commands, ribbon },
    },
  ];
}
