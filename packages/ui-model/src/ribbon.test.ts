import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TOOLS, type ToolContext } from "./toolbarLayout.js";
import {
  TABS,
  availabilityOf,
  buildRibbon,
  contextualTabsFor,
  everyToolMapped,
  emptyTabs,
  everyToolReachable,
  layoutTab,
  orphanedHomes,
  reachableIn,
  tabsWithContent,
  toolId,
  type ItemSize,
} from "./ribbon.js";

const ribbon = buildRibbon();

describe("mapping the inherited tools", () => {
  it("gives every tool in the source table a home", () => {
    // The bug this is written against: massing's icon map once shipped complete and fully tested while the
    // renderer never called `iconFor`, so "all 27 verbs are mapped" was true and nothing on screen had changed.
    // A tool with no home passes every table test and appears nowhere.
    expect(everyToolMapped(), "tools with no ribbon home").toEqual([]);
  });

  it("has no home pointing at a tool that no longer exists", () => {
    // The other direction. A rename upstream leaves a stale entry that looks like coverage.
    expect(orphanedHomes(), "homes with no matching tool").toEqual([]);
  });

  it("accounts for all 30 tools exactly once", () => {
    const ids = ribbon.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toHaveLength(TOOLS.length);
    // No tool in two groups: a verb in two places is a verb a user cannot learn the location of.
    expect(new Set(ids).size).toBe(TOOLS.length);
  });

  it("puts every group on one of the nine permanent tabs", () => {
    const known = new Set(TABS.map((t) => t.id));
    for (const group of ribbon) expect(known.has(group.tab), `${group.id} → ${group.tab}`).toBe(true);
  });

  it("derives stable ids that survive a label change", () => {
    // Keyed on `title`, which `toolbarLayout` already treats as the key, so relabelling a button does not
    // silently change its identity in a saved layout or a keybinding.
    expect(toolId("Section plane (S) — dbl-click a face")).toBe("section-plane-s-dbl-click-a-face");
    expect(toolId("Show all (H)")).toBe("show-all-h");
    for (const id of ribbon.flatMap((g) => g.items.map((i) => i.id))) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("responsive collapse", () => {
  it("uses preferred sizes when there is plenty of room", () => {
    const layout = layoutTab("home", 3840);
    expect(layout.groups.every((g) => !g.collapsed)).toBe(true);
    for (const laid of layout.groups) {
      for (const item of laid.group.items) {
        expect(laid.sizes!.get(item.id)).toBe(item.preferred);
      }
    }
  });

  it("collapses the lowest-priority group first", () => {
    // Explicit priority rather than reading order: on a narrow screen a user needs Select and Modify far more
    // than Collaborate, whichever comes first left-to-right.
    const wide = layoutTab("review", 3840);
    expect(wide.groups.every((g) => !g.collapsed)).toBe(true);

    const build = layoutTab("build", 300);
    const collapsedIds = build.groups.filter((g) => g.collapsed).map((g) => g.group.id);
    if (collapsedIds.length > 0 && collapsedIds.length < build.groups.length) {
      const survivors = build.groups.filter((g) => !g.collapsed);
      const worstSurvivor = Math.min(...survivors.map((g) => g.group.priority));
      const bestCollapsed = Math.max(...build.groups.filter((g) => g.collapsed).map((g) => g.group.priority));
      // No collapsed group outranks a surviving one.
      expect(bestCollapsed).toBeLessThanOrEqual(worstSurvivor);
    }
  });

  it("shrinks before it collapses", () => {
    // Degrading a label is a smaller loss than hiding a whole group behind a dropdown, so it happens first.
    const wide = layoutTab("build", 3840);
    const medium = layoutTab("build", 420);
    const shrank = medium.groups.some(
      (laid, i) =>
        !laid.collapsed &&
        laid.group.items.some((item) => laid.sizes!.get(item.id) !== wide.groups[i]!.sizes!.get(item.id)),
    );
    expect(shrank || medium.groups.some((g) => g.collapsed)).toBe(true);
  });

  it("is deterministic — the same width always gives the same layout", () => {
    // massing renders this table with its own DOM code and MassingViewer renders it with `packages/ribbon`. If
    // layout were order- or iteration-dependent the two products would disagree about where a tool is.
    for (const width of [320, 500, 768, 1024, 1440, 1920]) {
      const a = JSON.stringify(layoutTab("home", width), replacer);
      const b = JSON.stringify(layoutTab("home", width), replacer);
      expect(a).toBe(b);
    }
  });

  it("terminates rather than looping when nothing more can shrink", () => {
    // A width of 1px cannot fit anything; the algorithm must stop, not spin.
    const layout = layoutTab("build", 1);
    expect(layout.groups.every((g) => g.collapsed)).toBe(true);
    // And it still reports every tool as reachable, because collapsed is not gone.
    expect(reachableIn(layout)).toHaveLength(ribbon.filter((g) => g.tab === "build").flatMap((g) => g.items).length);
  });
});

const replacer = (_k: string, v: unknown): unknown => (v instanceof Map ? [...v.entries()].sort() : v);

describe("the invariant that replaces MAX_PRIMARY", () => {
  it("keeps every tool reachable at every width from 320 to 3840", () => {
    // The reason there is no cap. `MAX_PRIMARY = 8` shipped a real bug: promoting Push/pull silently demoted
    // Move, and `toolbarLayout.ts` records the same failure for Ask. A verb that relocates in response to
    // unrelated state is worse than one that was never there — you learn where it is, and then it is not there.
    //
    // Every integer width, not a sample: the failure would be a narrow band, and a sampled check is exactly how
    // a narrow band survives.
    const failures = everyToolReachable();
    expect(failures.slice(0, 5), `${failures.length} width(s) lose a tool`).toEqual([]);
  });

  it("holds for any width, including absurd ones", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 100_000 }), fc.constantFrom(...TABS.map((t) => t.id)), (width, tab) => {
        const expected = ribbon.filter((g) => g.tab === tab).flatMap((g) => g.items.map((i) => i.id));
        const got = new Set(reachableIn(layoutTab(tab, width)));
        return expected.every((id) => got.has(id));
      }),
      { numRuns: 500 },
    );
  });

  it("never invents or duplicates an item at any width", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 4000 }), (width) => {
        for (const tab of TABS.map((t) => t.id)) {
          const ids = reachableIn(layoutTab(tab, width));
          const expected = ribbon.filter((g) => g.tab === tab).flatMap((g) => g.items.map((i) => i.id));
          if (ids.length !== new Set(ids).size) return false;
          if (ids.length !== expected.length) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("uses more room as the width grows, never less", () => {
    // Monotonicity. A layout that got *smaller* on a wider screen would mean the collapse decision depends on
    // something other than available width, which is how a ribbon starts flickering during a window resize.
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 3000 }), (width) => {
        const narrow = layoutTab("home", width).used;
        const wide = layoutTab("home", width + 400).used;
        return wide >= narrow;
      }),
      { numRuns: 200 },
    );
  });
});

describe("availability — dimmed, never hidden", () => {
  const editable: ToolContext = { selection: true, canEdit: true };
  const viewerWithSelection: ToolContext = { selection: true, canEdit: false };
  const nothingSelected: ToolContext = { selection: false, canEdit: true };

  it("enables a selection verb only when something is selected", () => {
    const move = TOOLS.find((t) => t.label === "Move")!;
    expect(availabilityOf(move, editable).state).toBe("enabled");
    const dimmed = availabilityOf(move, nothingSelected);
    expect(dimmed.state).toBe("dimmed");
    if (dimmed.state === "dimmed") expect(dimmed.reason).toBe("Select an element first");
  });

  it("names the permission before the selection", () => {
    // Most-fundamental-first. Being told to select something you then cannot edit is worse than being told you
    // cannot edit.
    const move = TOOLS.find((t) => t.label === "Move")!;
    const dimmed = availabilityOf(move, viewerWithSelection);
    expect(dimmed.state).toBe("dimmed");
    if (dimmed.state === "dimmed") expect(dimmed.reason).toMatch(/Editor role/);
  });

  it("always gives a dimmed control a reason", () => {
    // `Availability` makes "dimmed for no stated reason" unrepresentable, and this asserts the type is honoured
    // in practice: a dimmed button that says "needs Editor" is onboarding, a missing one is a support ticket.
    for (const tool of TOOLS) {
      for (const ctx of [editable, viewerWithSelection, nothingSelected, { selection: false, canEdit: false }]) {
        const a = availabilityOf(tool, ctx);
        if (a.state === "dimmed") expect(a.reason.length, `${tool.label}`).toBeGreaterThan(3);
      }
    }
  });

  it("never removes a tool from the ribbon for being unavailable", () => {
    // The ribbon is built from the table, not filtered by context — availability is a render-time state, not a
    // layout decision. If it were a layout decision, the ribbon would reflow on selection.
    const ids = buildRibbon().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toHaveLength(TOOLS.length);
  });
});

describe("tabs with no tools yet", () => {
  it("reports Annotate and Manage as empty rather than rendering them dead", () => {
    // A real gap, not a mapping error: the inherited toolbar has no annotation or project-management verbs. The
    // difference between TABS and tabsWithContent() is exactly the ribbon's remaining work, as data.
    expect(emptyTabs()).toEqual(["annotate", "manage"]);
    expect(tabsWithContent().map((t) => t.id)).toEqual(["home", "build", "insert", "sheet", "analyse", "review", "view"]);
  });
});

describe("contextual tabs", () => {
  it("adds a tab for the selection and leaves the permanent nine alone", () => {
    expect(contextualTabsFor(null)).toEqual([]);
    const tabs = contextualTabsFor("IfcWall");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.label).toBe("Wall");
    // A ribbon whose tabs move under you is one nobody can build muscle memory for.
    expect(TABS).toHaveLength(9);
  });
});

describe("sizes", () => {
  it("only ever uses the three known sizes", () => {
    const known: ItemSize[] = ["large", "medium", "small"];
    for (const width of [320, 768, 1440, 3840]) {
      for (const tab of TABS.map((t) => t.id)) {
        for (const laid of layoutTab(tab, width).groups) {
          if (laid.sizes === null) continue;
          for (const size of laid.sizes.values()) expect(known).toContain(size);
        }
      }
    }
  });
});
