// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS, buildRibbon, type ToolContext } from "@massing/ui-model";
import { DE, EN, createTranslator, type Translator } from "@massing/i18n";
import { createRibbon, type Ribbon } from "./ribbon.js";

/**
 * ## Asserting a table is not asserting a render
 *
 * `docs/pending/toolbarView.test.ts.txt` preserves 137 lines of DOM assertions from massing, and ADR-0006 kept
 * them for a specific reason: massing's icon map once shipped complete and fully tested while the renderer never
 * called `iconFor`, so *"all 27 verbs are mapped"* was true and nothing on screen had changed.
 *
 * `ui-model`'s tests assert the table. **These assert the DOM.** Every tool in the table must produce a button a
 * user can reach, and that is a different claim from every tool having a home.
 */

const CONTEXT: ToolContext = { selection: false, canEdit: true };

let container: HTMLElement;
let ribbon: Ribbon;
const onTool = vi.fn();

/** A fixed width, because `clientWidth` is 0 in happy-dom and a zero-width ribbon collapses everything. */
function mount(width = 1600, context: ToolContext = CONTEXT): Ribbon {
  container = document.createElement("div");
  document.body.appendChild(container);
  return createRibbon(container, { handlers: { onTool }, context, measure: () => width });
}

/**
 * Mount with a translator and hand back the container.
 *
 * Separate from `mount` rather than a fourth positional argument: the existing helper returns the `Ribbon` handle
 * and stores the container in a module-level `let`, which is fine for tests that mount once and would silently
 * cross-talk in the comparison test below, where two ribbons are alive at the same time.
 */
function mountWith(translate?: Translator): { host: HTMLElement; ribbon: Ribbon } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRibbon(host, { handlers: { onTool }, context: CONTEXT, measure: () => 1600, translate });
  return { host, ribbon: r };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("data-cap-edit");
  onTool.mockClear();
});

describe("every tool reaches the DOM", () => {
  it("renders a button for all 30 tools across the tabs", () => {
    ribbon = mount();
    // Panels for inactive tabs are `hidden`, not absent — so the buttons exist and are queryable, which is what
    // makes a command palette able to activate a tool on a tab the user is not looking at.
    const buttons = container.querySelectorAll("button[data-tool]");
    expect(buttons).toHaveLength(TOOLS.length);
  });

  it("gives every button the tool's title as the start of its tooltip", () => {
    ribbon = mount();
    const titles = [...container.querySelectorAll<HTMLButtonElement>("button[data-tool]")].map((b) => b.title);
    for (const tool of TOOLS) {
      // `startsWith`, not equality: a dimmed control's tooltip deliberately appends the reason, so hovering says
      // "Move selected element (E,N,Z metres) — Select an element first" rather than leaving the user to guess.
      // `title` is still the key `toolbarLayout` documents, so a retitled button shows up here rather than
      // drifting silently.
      expect(
        titles.some((t) => t === tool.title || t.startsWith(`${tool.title} — `)),
        `${tool.label}: no button whose tooltip starts with its title`,
      ).toBe(true);
    }
  });

  it("gives every button a visible label and a glyph", () => {
    ribbon = mount();
    for (const button of container.querySelectorAll<HTMLButtonElement>("button[data-tool]")) {
      expect(button.querySelector(".mv-ribbon-glyph")?.getAttribute("aria-hidden")).toBe("true");
      // The glyph is decorative and the label is the accessible name. A glyph-only button with no label is
      // unusable with a screen reader, and `small` hides the label visually while keeping it in the tree.
      expect(button.querySelector(".mv-ribbon-label")?.textContent).toBeTruthy();
    }
  });

  it("renders seven tabs, not nine, because two have no tools yet", () => {
    ribbon = mount();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((b) => b.textContent);
    // An empty tab a user clicks into and finds nothing in reads as a broken app rather than an unfinished one.
    expect(tabs).toEqual(["Home", "Build", "Insert", "Sheet", "Analyse", "Review", "View"]);
  });

  it("shows exactly one panel at a time", () => {
    ribbon = mount();
    const visible = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((p) => !p.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe("mv-panel-home");
  });
});

describe("activation", () => {
  it("calls the handler with the stable id and the tool", () => {
    ribbon = mount();
    const measure = container.querySelector<HTMLButtonElement>('[data-tool="measure-distance-m"]')!;
    measure.click();
    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool.mock.calls[0]![0]).toBe("measure-distance-m");
    expect(onTool.mock.calls[0]![1].label).toBe("Measure");
  });

  it("announces the armed tool, because nothing visible says what the next click will do", () => {
    ribbon = mount();
    container.querySelector<HTMLButtonElement>('[data-tool="measure-distance-m"]')!.click();
    const live = container.querySelector('[role="status"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Measure armed");
  });

  it("does nothing when a dimmed control is pressed, and says why instead", () => {
    ribbon = mount(1600, { selection: false, canEdit: true });
    const move = container.querySelector<HTMLButtonElement>('[data-tool="move-selected-element-e-n-z-metres"]')!;
    expect(move.getAttribute("aria-disabled")).toBe("true");
    move.click();
    expect(onTool).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/Select an element first/);
  });
});

describe("dimmed, never hidden", () => {
  it("keeps an unavailable control focusable and announced", () => {
    ribbon = mount(1600, { selection: false, canEdit: true });
    const move = container.querySelector<HTMLButtonElement>('[data-tool="move-selected-element-e-n-z-metres"]')!;
    // `aria-disabled`, not `disabled`: a `disabled` button is unfocusable and unannounced, so a screen-reader
    // user cannot discover it exists — which defeats the entire point of dimming rather than hiding.
    expect(move.hasAttribute("disabled")).toBe(false);
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(move.classList.contains("mv-dimmed")).toBe(true);
  });

  it("puts the reason in the tooltip, so it is readable without a screen reader", () => {
    ribbon = mount(1600, { selection: true, canEdit: false });
    const move = container.querySelector<HTMLButtonElement>('[data-tool="move-selected-element-e-n-z-metres"]')!;
    expect(move.dataset.reason).toMatch(/Editor role/);
    expect(move.title).toMatch(/Editor role/);
  });

  it("enables the control once its precondition is met, without relayout", () => {
    ribbon = mount(1600, { selection: false, canEdit: true });
    const before = container.querySelectorAll("button[data-tool]").length;
    ribbon.update({ selection: true, canEdit: true });
    const move = container.querySelector<HTMLButtonElement>('[data-tool="move-selected-element-e-n-z-metres"]')!;
    expect(move.getAttribute("aria-disabled")).toBe("false");
    // Availability is a render-time state, not a layout decision. If it reflowed, the ribbon would shift under
    // the cursor every time the selection changed.
    expect(container.querySelectorAll("button[data-tool]").length).toBe(before);
  });

  it("carries data-cap so massing's existing capability CSS applies unchanged", () => {
    ribbon = mount();
    const authorButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-cap="edit"]')];
    expect(authorButtons.length).toBeGreaterThan(0);
  });
});

describe("keyboard navigation", () => {
  it("has exactly one tabbable button per group", () => {
    ribbon = mount();
    for (const group of container.querySelectorAll<HTMLElement>('[role="toolbar"]')) {
      const tabbable = [...group.querySelectorAll<HTMLButtonElement>("button[data-tool]")].filter(
        (b) => b.getAttribute("tabindex") === "0",
      );
      // Roving tabindex. Without it, Tab steps through all thirty buttons before reaching the canvas.
      expect(tabbable, group.getAttribute("aria-label") ?? "").toHaveLength(1);
    }
  });

  it("moves within a group with the arrow keys and wraps", () => {
    ribbon = mount();
    const group = container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Select"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-tool]")];
    buttons[0]!.focus();

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]!.getAttribute("tabindex")).toBe("0");
    expect(buttons[0]!.getAttribute("tabindex")).toBe("-1");

    // Wrapping rather than stopping: a toolbar that stops at the end makes the user reverse direction to reach
    // the item one step the other way.
    buttons[buttons.length - 1]!.focus();
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("supports Home and End", () => {
    ribbon = mount();
    const group = container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Measure"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-tool]")];
    buttons[1]!.focus();
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("moves between tabs with the arrow keys and switches panel", () => {
    ribbon = mount();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]!.focus();
    container.querySelector('[role="tablist"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(ribbon.activeTab).toBe("build");
    expect(container.querySelector<HTMLElement>("#mv-panel-build")!.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#mv-panel-home")!.hidden).toBe(true);
  });

  it("makes only the selected tab tabbable", () => {
    ribbon = mount();
    const tabbable = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
      (b) => b.getAttribute("tabindex") === "0",
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("does not move focus when the window is resized", () => {
    // The reason the DOM is built once and mutated rather than re-rendered: layout genuinely changes on resize,
    // and re-rendering would destroy the focused element every time.
    ribbon = mount(1600);
    const button = container.querySelector<HTMLButtonElement>('[data-tool="measure-distance-m"]')!;
    button.focus();
    ribbon.update();
    expect(document.activeElement).toBe(button);
  });
});

describe("ARIA structure", () => {
  it("uses the tabs pattern correctly", () => {
    ribbon = mount();
    const tablist = container.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute("aria-label")).toBe("Ribbon");
    for (const tab of container.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const panelId = tab.getAttribute("aria-controls")!;
      const panel = container.querySelector(`#${panelId}`)!;
      expect(panel.getAttribute("role")).toBe("tabpanel");
      // Bidirectional: the panel names its tab and the tab controls its panel.
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("labels every group toolbar", () => {
    ribbon = mount();
    const groups = [...container.querySelectorAll<HTMLElement>('[role="toolbar"]')];
    expect(groups.length).toBe(buildRibbon().length);
    for (const group of groups) expect(group.getAttribute("aria-label")).toBeTruthy();
  });

  it("marks the collapsed-group dropdown as expandable", () => {
    ribbon = mount(360);
    const more = container.querySelector<HTMLButtonElement>(".mv-ribbon-group.mv-collapsed .mv-ribbon-more");
    if (more === null) return; // nothing collapsed at this width on this tab
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("responsive collapse in the DOM", () => {
  it("applies the model's sizes as data-size, so CSS and layout agree", () => {
    ribbon = mount(3840);
    const sizes = new Set(
      [...container.querySelectorAll<HTMLButtonElement>("#mv-panel-home button[data-tool]")].map(
        (b) => b.dataset.size,
      ),
    );
    for (const size of sizes) expect(["large", "medium", "small"]).toContain(size);
  });

  it("collapses groups at a narrow width and keeps their buttons in the DOM", () => {
    ribbon = mount(320);
    const collapsed = container.querySelectorAll("#mv-panel-home .mv-ribbon-group.mv-collapsed");
    expect(collapsed.length).toBeGreaterThan(0);
    // The whole justification for collapsing rather than dropping: every button is still there, reachable through
    // the dropdown. This is the DOM-level counterpart of `everyToolReachable`.
    expect(container.querySelectorAll("button[data-tool]")).toHaveLength(TOOLS.length);
  });

  it("uncollapses when the width returns", () => {
    ribbon = mount(320);
    expect(container.querySelectorAll("#mv-panel-home .mv-ribbon-group.mv-collapsed").length).toBeGreaterThan(0);

    // Re-mount wide rather than mutating the measure, which is what a real resize does through ResizeObserver.
    ribbon.dispose();
    ribbon = mount(3840);
    expect(container.querySelectorAll("#mv-panel-home .mv-ribbon-group.mv-collapsed")).toHaveLength(0);
  });

  it("closes an open dropdown when its group stops being collapsed", () => {
    // Otherwise the floating panel is left hanging over a strip that no longer has a button behind it.
    ribbon = mount(320);
    const group = container.querySelector<HTMLElement>("#mv-panel-home .mv-ribbon-group.mv-collapsed")!;
    group.querySelector<HTMLButtonElement>(".mv-ribbon-more")!.click();
    expect(group.classList.contains("mv-open")).toBe(true);
    ribbon.dispose();
    ribbon = mount(3840);
    expect(container.querySelector(".mv-ribbon-group.mv-open")).toBeNull();
  });
});

describe("lifecycle", () => {
  it("disposes cleanly and is idempotent", () => {
    // React strict mode unmounts twice, and an observer that outlives its container keeps the whole subtree alive.
    ribbon = mount();
    ribbon.dispose();
    expect(container.innerHTML).toBe("");
    expect(container.classList.contains("mv-ribbon")).toBe(false);
    expect(() => ribbon.dispose()).not.toThrow();
  });

  it("can be mounted twice into the same container without duplicating", () => {
    ribbon = mount();
    const first = container.querySelectorAll("button[data-tool]").length;
    ribbon = createRibbon(container, { handlers: { onTool }, measure: () => 1600 });
    expect(container.querySelectorAll("button[data-tool]")).toHaveLength(first);
  });

  it("switches tab programmatically, for the command palette", () => {
    ribbon = mount();
    ribbon.setTab("view");
    expect(ribbon.activeTab).toBe("view");
    expect(container.querySelector<HTMLElement>("#mv-panel-view")!.hidden).toBe(false);
  });

  it("ignores a tab that does not exist rather than blanking the ribbon", () => {
    ribbon = mount();
    ribbon.setTab("nonexistent");
    expect(ribbon.activeTab).toBe("home");
    expect(container.querySelector<HTMLElement>("#mv-panel-home")!.hidden).toBe(false);
  });
});

describe("translation", () => {
  /**
   * The ribbon in a second language.
   *
   * The reason this is here rather than in `@massing/i18n`: a translator that returns the right string proves
   * nothing about a renderer that never asks it. Every mistake worth catching is at the boundary — a label read
   * straight off the tool table, a string concatenated in an `aria-label`, a `title` attribute nobody routed.
   */
  const german = () => createTranslator({ locale: "de", catalogue: DE });

  it("renders translated tab labels", () => {
    const { host } = mountWith(german());
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toContain("Start");
    expect(tabs).not.toContain("Home");
  });

  it("translates a tool's label and its title attribute", () => {
    const { host } = mountWith(german());
    const levels = host.querySelector<HTMLElement>('button[data-tool="toggle-storey-levels-overlay"]')!;
    expect(levels.querySelector(".mv-ribbon-label")!.textContent).toBe("Ebenen");
    // The `title` is the tooltip and is a separate lookup, so it is a separate chance to have been missed.
    expect(levels.title).toBe("Geschossebenen ein- oder ausblenden");
  });

  it("translates the tablist's accessible name", () => {
    const { host } = mountWith(german());
    expect(host.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Multifunktionsleiste");
  });

  it("translates the live-region announcement, not just the visible label", () => {
    const { host } = mountWith(german());
    host.querySelector<HTMLElement>('button[data-tool="toggle-storey-levels-overlay"]')!.click();
    // "Ebenen aktiviert" — the sentence is a catalogue string with a slot, not `${label} armed` with the label
    // swapped. A screen-reader user in a German UI otherwise hears half a sentence in each language.
    expect(host.querySelector(".mv-ribbon-live")!.textContent).toBe("Ebenen aktiviert");
  });

  it("falls back to English for a tool the catalogue has not reached", () => {
    /**
     * Against a purpose-built partial catalogue, not against German's gaps.
     *
     * This test used to pick a tool German had not reached, and **completing the German catalogue broke it** — the
     * lucky outcome. A test asserting that a *fallback occurred* would instead have started asserting nothing while
     * still passing, because the fallback simply stops happening. What is under test is the renderer's behaviour
     * when a key is absent, which no amount of translation work should be able to invalidate.
     */
    const { host } = mountWith(createTranslator({ locale: "bg", catalogue: { "tab.home": "Начало" } }));
    const move = host.querySelector<HTMLElement>('button[data-tool="move-selected-element-e-n-z-metres"]')!;
    // Rendering its English label rather than the key. This is what makes shipping a partial catalogue safe rather
    // than reckless.
    expect(move.querySelector(".mv-ribbon-label")!.textContent).toBe("Move");
    // And the tab that *is* translated still is, so the mount is genuinely using the partial catalogue.
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain("Начало");
  });

  it("keeps `data-tool` in English, because it is an identity and not a label", () => {
    const { host } = mountWith(german());
    // The E2E suite and every keybinding select on this. If it localised, a macro recorded in German would not
    // replay for anyone else — the same reasoning that keeps the command grammar locale-independent.
    expect(host.querySelector('button[data-tool="toggle-storey-levels-overlay"]')).not.toBeNull();
  });

  it("renders identically to before when no translator is given", () => {
    const withDefault = mountWith();
    const withEnglish = mountWith(createTranslator({ locale: "en", catalogue: EN }));
    const shape = (host: HTMLElement) =>
      [...host.querySelectorAll("button[data-tool]")].map((b) => b.textContent).join("|");
    expect(shape(withDefault.host)).toBe(shape(withEnglish.host));
  });
});
