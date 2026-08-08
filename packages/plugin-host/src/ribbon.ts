import { type RibbonGroup, type TabId, toolId } from "@massing/ui-model";
import type { CommandContribution, Contributions, RibbonGroupContribution } from "./manifest.js";

/**
 * Contributions → the ribbon layout model.
 *
 * This function is the seam that decides whether the whole plugin design is real. `ui-model` owns what a ribbon
 * *is* — groups, items, priorities, and the collapse algorithm that keeps every tool reachable at every width.
 * This converts declarations into that shape and adds nothing, so a plugin's group collapses by exactly the same
 * rules as a built-in one.
 *
 * That symmetry is the point. A host with a privileged path for its own UI and a lesser one for plugins ends up
 * with plugin buttons that behave differently under a narrow window — and nobody notices until a plugin author
 * reports it, by which time the two paths have diverged in five other ways.
 */

/**
 * Merge contributed groups into `RibbonGroup`s.
 *
 * Groups with the same `id` from different plugins are **merged**, not duplicated, and that is a deliberate
 * choice with a specific consequence: a plugin can add a button to the existing *Draw* group instead of creating
 * a second group also called Draw. Two groups with the same label side by side is the shape of a broken extension
 * model, and this is the mechanism that avoids it.
 *
 * Order within a merged group follows load order, which is dependency order — so a plugin's items land after the
 * items of everything it depends on, deterministically.
 */
export function ribbonFrom(contributions: Contributions): readonly RibbonGroup[] {
  const commands = new Map<string, CommandContribution>();
  for (const command of contributions.commands ?? []) commands.set(command.id, command);

  const merged = new Map<string, { group: RibbonGroupContribution; items: RibbonGroup["items"] }>();

  for (const contributed of contributions.ribbon ?? []) {
    const items: RibbonGroup["items"] = contributed.items.flatMap((item) => {
      const command = commands.get(item.command);
      // Dropped rather than rendered as a placeholder. `validateManifest` refuses a dangling command id at load,
      // so reaching here means the owning plugin was quarantined *after* load — and a button whose implementation
      // has been rolled back must not be on screen. Silently dropping it is right; a dead button is not.
      if (command === undefined) return [];
      return [
        {
          // The same derivation built-in tools use, so a plugin command and a built-in tool have ids of one
          // shape. Anything keyed on item id — a saved layout, a keybinding — then treats them alike.
          id: toolId(command.title),
          label: command.title,
          title: command.title,
          preferred: item.size,
        },
      ];
    });

    if (items.length === 0) continue;

    const existing = merged.get(contributed.id);
    if (existing === undefined) merged.set(contributed.id, { group: contributed, items });
    else existing.items = [...existing.items, ...items];
  }

  return [...merged.values()].map(({ group, items }) => ({
    id: group.id,
    label: group.label,
    tab: group.tab as TabId,
    priority: group.priority,
    items,
  }));
}

/**
 * Which contributed commands never reach the ribbon.
 *
 * Not an error — a command reachable only from the palette or a keybinding is a legitimate and common thing. But
 * it is worth being able to *ask*, because the failure it detects is the one massing already shipped: an icon map
 * that was complete and fully tested while the renderer never called it, so "all 27 verbs are mapped" was true
 * and nothing on screen had changed.
 *
 * The general shape: coverage of a table is not coverage of a rendering, and the only way to know is to compare
 * the two directly.
 */
export function commandsNotOnRibbon(contributions: Contributions): readonly string[] {
  const onRibbon = new Set((contributions.ribbon ?? []).flatMap((g) => g.items.map((i) => i.command)));
  return (contributions.commands ?? []).map((c) => c.id).filter((id) => !onRibbon.has(id));
}

/** Groups that declare a tab no built-in tab id matches. Belt and braces over `validateManifest`. */
export function unknownTabs(contributions: Contributions, known: ReadonlySet<string>): readonly string[] {
  return [...new Set((contributions.ribbon ?? []).map((g) => g.tab).filter((tab) => !known.has(tab)))];
}
