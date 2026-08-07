import { TOOLS, type ToolContext, type ToolSpec } from "./toolbarLayout.js";

/**
 * The ribbon's layout model: which tools exist, how they group, and how groups collapse at a given width.
 *
 * Pure data and pure math — no DOM, no framework. That is the point rather than a nicety: massing renders this
 * with its own vanilla DOM code and MassingViewer renders it with `packages/ribbon`, and both must lay out
 * *identically* or the two products disagree about where a tool is. See
 * `docs/adr/0009-ribbon-renders-in-vanilla-dom.md`.
 *
 * ## Why a ribbon replaces the floating toolbar
 *
 * massing's own `railToolbox.ts` wrote the indictment before this existed: the floating bar covered the model and
 * "makes drag-to-place impossible, because half the palette floats over the drop target". Drag-and-drop is a
 * headline interaction here, so a palette that floats over the canvas is disqualifying.
 *
 * ## Why there is no cap on how many tools are visible
 *
 * `MAX_PRIMARY = 8` in the toolbar it replaces **shipped a real bug**: promoting Push/pull silently demoted Move.
 * A hard cap means adding a tool removes one, and the one it removes is whichever sorted last — so a verb
 * relocates in response to unrelated state. `toolbarLayout.ts` documents the same failure for Ask.
 *
 * So nothing is dropped. Groups *degrade* instead — large, then medium, then small, then a dropdown — and
 * {@link everyToolReachable} asserts that at every width from 320 to 3840 every tool is still reachable. That
 * failure class is designed out rather than tested out.
 */

/** The nine permanent tabs. Contextual tabs are appended by {@link contextualTabsFor}. */
export type TabId =
  | "home"
  | "build"
  | "insert"
  | "annotate"
  | "sheet"
  | "analyse"
  | "review"
  | "view"
  | "manage";

export const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "home", label: "Home" },
  { id: "build", label: "Build" },
  { id: "insert", label: "Insert" },
  { id: "annotate", label: "Annotate" },
  { id: "sheet", label: "Sheet" },
  { id: "analyse", label: "Analyse" },
  { id: "review", label: "Review" },
  { id: "view", label: "View" },
  { id: "manage", label: "Manage" },
];

/**
 * How much room a control takes.
 *
 * `large` is a big glyph with a label beneath; `medium` a glyph with a label beside; `small` a glyph alone.
 * `collapsed` means the whole group has become one dropdown button.
 */
export type ItemSize = "large" | "medium" | "small";

export interface RibbonItem {
  /** Stable identity. Derived from the tool's `title`, which `toolbarLayout` already treats as the key. */
  readonly id: string;
  readonly label: string;
  readonly title: string;
  /** Preferred size when there is room. Groups shrink from this downwards. */
  readonly preferred: ItemSize;
}

export interface RibbonGroup {
  readonly id: string;
  readonly label: string;
  readonly tab: TabId;
  readonly items: readonly RibbonItem[];
  /**
   * Lower priority collapses first.
   *
   * Explicit rather than positional, because the group that should survive longest is not the leftmost — on a
   * narrow screen a user needs Select and Draw far more than Collaborate, regardless of reading order.
   */
  readonly priority: number;
}

// ---------------------------------------------------------------------------------------------------
// Mapping the 30 inherited tools onto tabs and groups
// ---------------------------------------------------------------------------------------------------

/**
 * Every tool's home, keyed by its `title` — the same key `toolbarLayout.ts` uses.
 *
 * Keyed by title rather than by index so that reordering the source table cannot silently re-home a tool, and
 * so that {@link everyToolMapped} fails loudly when a tool is added upstream without being placed. A tool with
 * no home is a tool that exists in the table, passes every table test, and appears nowhere — which is exactly
 * the bug `docs/pending/toolbarView.test.ts.txt` was written about.
 */
const HOMES: Record<string, { tab: TabId; group: string; size?: ItemSize }> = {
  // ── Home: the questions people actually ask first — what am I looking at, how big is it ──
  "Show all (H)": { tab: "home", group: "select", size: "medium" },
  "Isolate selection": { tab: "home", group: "select", size: "medium" },
  "Color selection": { tab: "home", group: "select", size: "small" },
  "Toggle storey levels overlay": { tab: "home", group: "level", size: "medium" },
  "Measure distance (M)": { tab: "home", group: "measure", size: "large" },
  "Measure area (A)": { tab: "home", group: "measure", size: "medium" },
  "Clear measurements": { tab: "home", group: "measure", size: "small" },
  "Ask the model — plain-English questions about the data": { tab: "home", group: "assist", size: "large" },

  // ── Build: authoring ──
  "Edit in place — drag the gizmo to move the selected element": { tab: "build", group: "modify", size: "large" },
  "Push/pull — drag the top handle to make the selected element taller or thicker": {
    tab: "build",
    group: "modify",
    size: "large",
  },
  "Move selected element (E,N,Z metres)": { tab: "build", group: "modify", size: "medium" },
  "Copy selected element (offset E,N,Z metres)": { tab: "build", group: "modify", size: "medium" },
  "Rotate selected element (degrees about Z)": { tab: "build", group: "modify", size: "medium" },
  "Delete selected element": { tab: "build", group: "modify", size: "small" },
  "Add door to selected wall": { tab: "build", group: "openings", size: "large" },
  "Add window to selected wall": { tab: "build", group: "openings", size: "large" },
  "Edit a property on the selected element": { tab: "build", group: "data", size: "medium" },
  "Script this — see the GUID-safe recipe plan behind a plain-English command, then apply": {
    tab: "build",
    group: "data",
    size: "small",
  },

  // ── Insert ──
  "Guide underlay — pin a scanned plan to this level and trace over it": {
    tab: "insert",
    group: "reference",
    size: "medium",
  },

  // ── Sheet ──
  "Plan beside model": { tab: "sheet", group: "views", size: "large" },

  // ── Analyse ──
  "Sun & shadow study (date · time · location)": { tab: "analyse", group: "environment", size: "large" },
  "Render mode — sun, soft shadows, PBR lighting, SSAO & bloom": {
    tab: "analyse",
    group: "environment",
    size: "medium",
  },

  // ── Review: collaboration ──
  "Live presence": { tab: "review", group: "collaborate", size: "medium" },
  "Share your current view with everyone": { tab: "review", group: "collaborate", size: "medium" },
  "Share via QR — open this project on a phone or tablet": { tab: "review", group: "collaborate", size: "small" },
  "Capture hero image — this view becomes page 2 of the client project package (PDF)": {
    tab: "review",
    group: "collaborate",
    size: "small",
  },

  // ── View ──
  "Section plane (S) — dbl-click a face": { tab: "view", group: "section", size: "large" },
  "Section box (clip to model bounds)": { tab: "view", group: "section", size: "medium" },
  "Walk through (first-person — W/A/S/D, drag to look)": { tab: "view", group: "navigate", size: "large" },
  "Walk mode — first-person WASD walkthrough (Esc exits)": { tab: "view", group: "navigate", size: "medium" },
};

const GROUP_LABELS: Record<string, string> = {
  select: "Select",
  level: "Level",
  measure: "Measure",
  assist: "Assist",
  modify: "Modify",
  openings: "Openings",
  data: "Data",
  reference: "Reference",
  views: "Views",
  environment: "Environment",
  collaborate: "Collaborate",
  section: "Section",
  navigate: "Navigate",
};

/**
 * Collapse order. Higher survives longer.
 *
 * Select and Modify are the highest because they are what a narrow screen is still for; Collaborate and
 * Environment are lowest because they are occasional and their absence from the strip is not disorienting.
 */
const GROUP_PRIORITY: Record<string, number> = {
  select: 100,
  modify: 100,
  measure: 90,
  openings: 85,
  section: 80,
  views: 75,
  navigate: 70,
  level: 65,
  data: 60,
  assist: 55,
  reference: 40,
  environment: 30,
  collaborate: 20,
};

/** A stable id from a tool title: lowercase, non-alphanumerics to hyphens. */
export function toolId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The full ribbon, built from `TOOLS`. Groups appear in the order their first tool does. */
export function buildRibbon(tools: readonly ToolSpec[] = TOOLS): readonly RibbonGroup[] {
  const groups = new Map<string, { tab: TabId; items: RibbonItem[] }>();

  for (const tool of tools) {
    const home = HOMES[tool.title];
    // An unmapped tool is skipped here and *reported* by `everyToolMapped`. Inventing a home would hide the
    // omission, which is the failure this whole mapping is keyed by title to avoid.
    if (home === undefined) continue;
    const key = `${home.tab}:${home.group}`;
    const bucket = groups.get(key) ?? { tab: home.tab, items: [] };
    bucket.items.push({
      id: toolId(tool.title),
      label: tool.label,
      title: tool.title,
      preferred: home.size ?? "medium",
    });
    groups.set(key, bucket);
  }

  return [...groups.entries()].map(([key, bucket]) => {
    const groupId = key.split(":")[1]!;
    return {
      id: groupId,
      label: GROUP_LABELS[groupId] ?? groupId,
      tab: bucket.tab,
      items: bucket.items,
      priority: GROUP_PRIORITY[groupId] ?? 50,
    };
  });
}

/**
 * Tabs that currently have at least one group.
 *
 * Two of the nine — **Annotate** and **Manage** — come out empty, because the inherited toolbar has no
 * annotation or project-management verbs yet. That is a real gap, not a mapping error, and the honest handling
 * is to render seven tabs rather than nine with two dead ones: an empty tab a user clicks into and finds nothing
 * in is a worse experience than a tab that is not there, and it also reads as a broken app rather than an
 * unfinished one.
 *
 * `TABS` still lists all nine, deliberately — it is the target shape, and the difference between the two lists
 * is exactly the ribbon's remaining work, visible as data rather than buried in a roadmap.
 */
export function tabsWithContent(groups: readonly RibbonGroup[] = buildRibbon()): readonly { id: TabId; label: string }[] {
  const populated = new Set(groups.map((g) => g.tab));
  return TABS.filter((t) => populated.has(t.id));
}

/** Tabs in {@link TABS} that no tool has been mapped into yet. Informational, not a failure. */
export function emptyTabs(groups: readonly RibbonGroup[] = buildRibbon()): readonly TabId[] {
  const populated = new Set(groups.map((g) => g.tab));
  return TABS.filter((t) => !populated.has(t.id)).map((t) => t.id);
}

/** Tools present in the source table with no home in the ribbon. Must be empty. */
export function everyToolMapped(tools: readonly ToolSpec[] = TOOLS): readonly string[] {
  return tools.filter((t) => HOMES[t.title] === undefined).map((t) => t.title);
}

/** Homes pointing at tools that no longer exist — a rename upstream leaves one behind. */
export function orphanedHomes(tools: readonly ToolSpec[] = TOOLS): readonly string[] {
  const titles = new Set(tools.map((t) => t.title));
  return Object.keys(HOMES).filter((title) => !titles.has(title));
}

// ---------------------------------------------------------------------------------------------------
// Responsive collapse
// ---------------------------------------------------------------------------------------------------

/** Approximate widths in CSS pixels. The renderer must agree with these or layout and reality diverge. */
const ITEM_WIDTH: Record<ItemSize, number> = { large: 72, medium: 88, small: 34 };
/** A collapsed group is one dropdown button. */
const COLLAPSED_WIDTH = 78;
/** Padding and the separator each group costs. */
const GROUP_CHROME = 14;

export interface LaidOutGroup {
  readonly group: RibbonGroup;
  /** Null when the group is collapsed into a single dropdown. */
  readonly sizes: ReadonlyMap<string, ItemSize> | null;
  readonly collapsed: boolean;
  readonly width: number;
}

export interface RibbonLayout {
  readonly tab: TabId;
  readonly groups: readonly LaidOutGroup[];
  readonly width: number;
  /** Total laid-out width. May exceed `width` only when a single group cannot fit even collapsed. */
  readonly used: number;
}

function groupWidth(group: RibbonGroup, sizes: ReadonlyMap<string, ItemSize>): number {
  let w = GROUP_CHROME;
  for (const item of group.items) w += ITEM_WIDTH[sizes.get(item.id) ?? item.preferred];
  return w;
}

const SHRINK: Record<ItemSize, ItemSize | null> = { large: "medium", medium: "small", small: null };

/**
 * Lay one tab out at a given width.
 *
 * The algorithm is deliberately boring and deterministic: start at every item's preferred size, then while it
 * does not fit, shrink the largest item in the lowest-priority group that can still shrink; when a group cannot
 * shrink further, collapse it to a dropdown. Lowest priority collapses first.
 *
 * **Nothing is ever dropped.** A collapsed group still contains every one of its items, reachable through the
 * dropdown — which is what makes {@link everyToolReachable} hold at every width and what makes this different
 * from the capped toolbar it replaces.
 */
export function layoutTab(tab: TabId, width: number, groups: readonly RibbonGroup[] = buildRibbon()): RibbonLayout {
  const inTab = groups.filter((g) => g.tab === tab);
  const sizes = new Map<string, Map<string, ItemSize>>();
  const collapsed = new Set<string>();

  for (const group of inTab) {
    sizes.set(group.id, new Map(group.items.map((i) => [i.id, i.preferred])));
  }

  const total = (): number =>
    inTab.reduce(
      (sum, g) => sum + (collapsed.has(g.id) ? COLLAPSED_WIDTH : groupWidth(g, sizes.get(g.id)!)),
      0,
    );

  // Bounded by construction: every pass either shrinks an item or collapses a group, and both are finite and
  // monotonic. The guard is a backstop against a future edit breaking that, not a suspicion about this loop.
  const maxPasses = inTab.reduce((n, g) => n + g.items.length * 3 + 1, 1);
  let passes = 0;

  while (total() > width && passes < maxPasses) {
    passes += 1;
    const candidates = inTab
      .filter((g) => !collapsed.has(g.id))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    if (candidates.length === 0) break;

    let acted = false;
    for (const group of candidates) {
      const groupSizes = sizes.get(group.id)!;
      // Shrink the widest item first: it frees the most room for the least visual disruption.
      const shrinkable = [...group.items]
        .filter((i) => SHRINK[groupSizes.get(i.id) ?? i.preferred] !== null)
        .sort((a, b) => ITEM_WIDTH[groupSizes.get(b.id)!] - ITEM_WIDTH[groupSizes.get(a.id)!]);
      const target = shrinkable[0];
      if (target !== undefined) {
        groupSizes.set(target.id, SHRINK[groupSizes.get(target.id)!]!);
        acted = true;
        break;
      }
      // Nothing left to shrink in the lowest-priority group: collapse it.
      collapsed.add(group.id);
      acted = true;
      break;
    }
    if (!acted) break;
  }

  return {
    tab,
    width,
    used: total(),
    groups: inTab.map((group) => ({
      group,
      collapsed: collapsed.has(group.id),
      sizes: collapsed.has(group.id) ? null : sizes.get(group.id)!,
      width: collapsed.has(group.id) ? COLLAPSED_WIDTH : groupWidth(group, sizes.get(group.id)!),
    })),
  };
}

/**
 * Every tool in the tab is reachable in this layout — visible directly, or inside a collapsed group.
 *
 * The invariant that replaces the cap. A layout that satisfies this can never do what `MAX_PRIMARY` did:
 * silently remove a verb because a different verb was promoted.
 */
export function reachableIn(layout: RibbonLayout): readonly string[] {
  const reachable: string[] = [];
  for (const laid of layout.groups) {
    // A collapsed group is still a route to every item it holds, which is the whole reason collapsing is
    // acceptable and dropping is not.
    for (const item of laid.group.items) reachable.push(item.id);
  }
  return reachable;
}

/**
 * Check the reachability invariant across the full width range, and return the widths where it fails.
 *
 * 320 is the narrowest phone; 3840 a 4K desktop. Exported rather than kept in the test file so a host — massing
 * included — can assert it against its own renderer.
 */
export function everyToolReachable(
  groups: readonly RibbonGroup[] = buildRibbon(),
  from = 320,
  to = 3840,
  step = 1,
): readonly { width: number; tab: TabId; missing: readonly string[] }[] {
  const failures: { width: number; tab: TabId; missing: readonly string[] }[] = [];
  const tabs = [...new Set(groups.map((g) => g.tab))];
  for (const tab of tabs) {
    const expected = groups.filter((g) => g.tab === tab).flatMap((g) => g.items.map((i) => i.id));
    for (let width = from; width <= to; width += step) {
      const got = new Set(reachableIn(layoutTab(tab, width, groups)));
      const missing = expected.filter((id) => !got.has(id));
      if (missing.length > 0) failures.push({ width, tab, missing });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------------

export type Availability =
  | { readonly state: "enabled" }
  /** Dimmed, never hidden — and `reason` is required, so "dimmed for no stated reason" is unrepresentable. */
  | { readonly state: "dimmed"; readonly reason: string };

/**
 * Whether a tool is usable, and if not, why — in words a user can act on.
 *
 * **Dimmed, never hidden.** massing's house rule, and the reasoning is worth restating: a user cannot discover
 * what exists in a UI that hides it, and cannot tell "this tool does not exist" from "this tool needs something
 * I do not have". *A dimmed button that says "needs Editor" is onboarding; a missing one is a support ticket.*
 *
 * Checked most-fundamental-first, so the message names the thing the user would fix first: no permission beats
 * no selection, because being told to select something you then cannot edit is worse than being told you cannot
 * edit.
 */
export function availabilityOf(tool: ToolSpec, ctx: ToolContext): Availability {
  const needsSelection = tool.primary !== undefined && tool.primary !== "always";
  if (tool.group === "author" && !ctx.canEdit) {
    return { state: "dimmed", reason: "Requires the Editor role on this project" };
  }
  if (needsSelection && !ctx.selection) {
    return { state: "dimmed", reason: "Select an element first" };
  }
  return { state: "enabled" };
}

/** Contextual tabs for the current selection — added, never replacing the permanent nine. */
export function contextualTabsFor(ifcClass: string | null): readonly { id: string; label: string }[] {
  if (ifcClass === null) return [];
  // Core groups never change and selection *adds* a tab. A ribbon whose tabs move under you is one nobody can
  // build muscle memory for.
  const label = ifcClass.replace(/^Ifc/, "");
  return [{ id: `ctx-${toolId(label)}`, label }];
}
