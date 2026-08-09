import { EN_TRANSLATOR, type MessageKey, type Translator } from "@massing/i18n";
import {
  type Availability,
  type ItemSize,
  type RibbonGroup,
  type RibbonItem,
  type TabId,
  availabilityOf,
  buildRibbon,
  contextualTabsFor,
  layoutTab,
  tabsWithContent,
} from "@massing/ui-model";
import { TOOLS, type ToolContext, type ToolSpec } from "@massing/ui-model";

/**
 * The ribbon, rendered in vanilla DOM.
 *
 * ## Why this is not React
 *
 * `docs/adr/0009-ribbon-renders-in-vanilla-dom.md`. MassingViewer must work standalone *and* development
 * continues in massing, whose shell is plain TypeScript against the DOM. A vanilla renderer works in both hosts
 * — massing mounts it, and React mounts it in a `useEffect` against a `ref`, which is how every framework hosts
 * imperative UI. A React renderer works in one. The direction of that dependency is the whole argument.
 *
 * It follows `createViewport`'s shape for the same reason: `create…(container, options)` returning `update()` and
 * `dispose()`. A host that can call three functions can render a ribbon.
 *
 * ## Why the DOM is built once and then mutated
 *
 * Re-rendering on every resize would be simpler and is wrong: it destroys the focused element, so a keyboard user
 * loses their place every time the window changes width — and the layout *does* change on resize, by design. So
 * the buttons are created once and `update()` only sets classes, attributes and `tabindex`.
 */

export interface RibbonHandlers {
  /**
   * A tool was activated. `id` is the stable `toolId`, which is what a keybinding or macro would carry.
   *
   * The second argument is the layout {@link RibbonItem}, not a `ToolSpec`. That is a deliberate narrowing: a
   * group contributed by a plugin has no `ToolSpec` behind it, and `RibbonItem` already carries the `id`, `label`
   * and `title` the renderer and its callers actually read. Handing back a `ToolSpec` would make the whole
   * renderer unusable for anything but the built-in table — which is the coupling ADR-0009 argues against one
   * layer up.
   */
  readonly onTool: (id: string, item: RibbonItem) => void;
  /** The active tab changed. Hosts may want to persist it. */
  readonly onTab?: (tab: TabId | string) => void;
}

export interface RibbonOptions {
  readonly handlers: RibbonHandlers;
  /**
   * Translator for every string this renders.
   *
   * Optional, defaulting to English — so a host that has not thought about locale gets byte-identical output to
   * before, and the ribbon does not become the reason M9 is blocked on massing adopting i18n first.
   *
   * A tool's label is looked up as `tool.<id>.label`, where `<id>` is the same identity the `data-tool` attribute
   * carries. When the catalogue has no entry the item's own `label` is used, which is what lets a contributed
   * plugin group — whose labels come from a manifest and were never in any catalogue — render its own text rather
   * than a bare key.
   */
  readonly translate?: Translator;
  readonly context?: ToolContext;
  /** Override the tool table — for tests, and for a host that has extra verbs. */
  readonly tools?: readonly ToolSpec[];
  /**
   * Render these groups instead of deriving them from the tool table.
   *
   * How a plugin host renders: `plugin-host`'s `ribbonFrom(contributions)` produces exactly this shape, so a
   * contributed group collapses by the same algorithm as a built-in one rather than through a second path that
   * will diverge.
   */
  readonly groups?: readonly RibbonGroup[];
  /**
   * Decide whether an item is available, and why not.
   *
   * Defaults to looking the item up in the tool table and calling `availabilityOf`. A host supplying its own
   * `groups` supplies this too, because there is no tool table to look anything up in — and an item with no
   * availability rule must default to *enabled* rather than silently dimmed.
   */
  readonly availability?: (item: RibbonItem, context: ToolContext) => Availability;
  /**
   * Measure the available width. Injectable because `clientWidth` is 0 in a detached container and in happy-dom,
   * and a ribbon that silently lays out at zero width collapses everything — which looks like a bug in the
   * collapse algorithm rather than a missing measurement.
   */
  readonly measure?: (container: HTMLElement) => number;
}

export interface Ribbon {
  /** Re-evaluate layout and availability. Call after a resize, a selection change, or a permission change. */
  update(context?: ToolContext): void;
  /** Switch tab programmatically — the command palette and a plugin both need this. */
  setTab(tab: TabId | string): void;
  readonly activeTab: TabId | string;
  /** Announce something to screen readers via the live region. */
  announce(message: string): void;
  dispose(): void;
}

const DEFAULT_CONTEXT: ToolContext = { selection: false, canEdit: true };

/** Short glyphs. Deliberately text, not an icon font: no extra request, and it survives a CSP with no font-src. */
const GLYPHS: Record<string, string> = {
  select: "▣",
  level: "≡",
  measure: "📏",
  assist: "?",
  modify: "✥",
  openings: "⌂",
  data: "▤",
  reference: "▦",
  views: "▥",
  environment: "☀",
  collaborate: "◍",
  section: "✂",
  navigate: "🚶",
};

export function createRibbon(container: HTMLElement, options: RibbonOptions): Ribbon {
  const tools = options.tools ?? TOOLS;
  const groups = options.groups ?? buildRibbon(tools);

  const i18n = options.translate ?? EN_TRANSLATOR;

  /**
   * Translate a key, falling back to a literal.
   *
   * The fallback is what makes this safe to apply everywhere at once. Three sources of label reach this ribbon —
   * the inherited tool table, plugin manifests, and contextual tabs derived from an IFC class — and only the first
   * is in the catalogue. Without a literal fallback the other two would render as `tool.some-plugin-verb.label`,
   * which is a worse product than untranslated English and would have shown up as a plugin-author bug report.
   */
  const tr = (key: string, literal: string, params?: Readonly<Record<string, string | number>>): string => {
    const translated = i18n.t(key as MessageKey, params);
    // `t()` returns the key itself when nothing has it, which is precisely the signal that this is not a
    // catalogued string.
    return translated === key ? literal : translated;
  };

  const itemLabel = (item: RibbonItem): string => tr(`tool.${item.id}.label`, item.label);
  const itemTitle = (item: RibbonItem): string => tr(`tool.${item.id}.title`, item.title);
  const groupLabel = (group: RibbonGroup): string => tr(`group.${group.id}`, group.label);
  /**
   * Stable id → tool.
   *
   * Keyed on the id rather than on `button.title`, and that is a bug fix rather than a preference. An earlier
   * version looked the tool up by reading `button.title` back — but `applyAvailability` *writes* that attribute,
   * appending the dim reason to it. So after a control dimmed once, the lookup returned undefined and it could
   * never be re-enabled: dimmed was a one-way door. Reading back an attribute you also write is the shape of the
   * mistake, not the specific string.
   */
  const byId = new Map<string, RibbonItem>();
  for (const group of groups) {
    for (const item of group.items) byId.set(item.id, item);
  }

  /**
   * Availability, from the caller or from the tool table.
   *
   * The fallback is `{ state: "enabled" }` for an item with no matching tool, not "dimmed". An unknown item is a
   * gap in *our* knowledge, and dimming it would tell the user their permissions are wrong when the truth is
   * that a lookup missed — a refusal for a reason nobody can act on, which is the failure `availabilityOf`'s
   * required `reason` field exists to make unrepresentable.
   */
  const availabilityOfItem =
    options.availability ??
    ((item: RibbonItem, ctx: ToolContext): Availability => {
      const tool = tools.find((t) => t.title === item.title);
      return tool === undefined ? { state: "enabled" } : availabilityOf(tool, ctx);
    });
  const tabs = tabsWithContent(groups);
  const measure = options.measure ?? ((el: HTMLElement) => el.clientWidth);

  let context = options.context ?? DEFAULT_CONTEXT;
  let activeTab: TabId | string = tabs[0]?.id ?? "home";
  let contextualClass: string | null = null;

  container.classList.add("mv-ribbon");
  container.innerHTML = "";

  // --- tab strip ---------------------------------------------------------------------------------
  const tablist = document.createElement("div");
  tablist.className = "mv-ribbon-tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", i18n.t("ribbon.label"));
  container.appendChild(tablist);

  const panels = document.createElement("div");
  panels.className = "mv-ribbon-panels";
  container.appendChild(panels);

  /**
   * A polite live region.
   *
   * Arming a tool changes what the next click does and nothing visible says so to a screen-reader user. Without
   * this, the most consequential state in the application is invisible to them.
   */
  const live = document.createElement("div");
  live.className = "mv-ribbon-live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  container.appendChild(live);

  const tabButtons = new Map<string, HTMLButtonElement>();
  const tabPanels = new Map<string, HTMLElement>();
  const itemButtons = new Map<string, HTMLButtonElement>();
  const groupElements = new Map<string, HTMLElement>();

  function makeTab(id: string, label: string, contextual: boolean): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = contextual ? "mv-ribbon-tab mv-ribbon-tab-contextual" : "mv-ribbon-tab";
    button.textContent = label;
    button.id = `mv-tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `mv-panel-${id}`);
    button.dataset.tab = id;
    button.addEventListener("click", () => setTab(id));
    tablist.appendChild(button);
    tabButtons.set(id, button);
    return button;
  }

  function makePanel(id: string, forTab: TabId | string): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "mv-ribbon-panel";
    panel.id = `mv-panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `mv-tab-${id}`);
    panels.appendChild(panel);
    tabPanels.set(id, panel);

    for (const group of groups.filter((g) => g.tab === forTab)) {
      panel.appendChild(makeGroup(group));
    }
    return panel;
  }

  function makeGroup(group: RibbonGroup): HTMLElement {
    const element = document.createElement("div");
    element.className = "mv-ribbon-group";
    element.dataset.group = group.id;
    // One toolbar per group, so arrow keys move within a group and Tab moves between them — which is what the
    // WAI-ARIA toolbar pattern specifies, and what makes 13 groups navigable rather than a 30-stop tab sequence.
    element.setAttribute("role", "toolbar");
    element.setAttribute("aria-label", groupLabel(group));
    element.addEventListener("keydown", (event) => onGroupKey(event, group));

    const items = document.createElement("div");
    items.className = "mv-ribbon-items";
    element.appendChild(items);

    for (const item of group.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mv-ribbon-item";
      button.dataset.tool = item.id;
      button.title = itemTitle(item);
      // `data-cap` is massing's own mechanism, kept verbatim so its CSS and its tests transfer.
      button.dataset.cap = "edit";
      // The first item of every group is the group's tab stop, set at construction rather than only in
      // `applyLayout`. `applyLayout` runs for the active tab only, so groups on tabs the user has not visited
      // had no tabbable button at all — Tab reached the panel and found nothing to focus.
      button.setAttribute("tabindex", group.items[0]!.id === item.id ? "0" : "-1");
      button.innerHTML =
        `<span class="mv-ribbon-glyph" aria-hidden="true">${GLYPHS[group.id] ?? "•"}</span>` +
        `<span class="mv-ribbon-label"></span>`;
      button.querySelector(".mv-ribbon-label")!.textContent = itemLabel(item);
      button.addEventListener("click", () => activate(item.id));
      items.appendChild(button);
      itemButtons.set(item.id, button);
    }

    // The dropdown a collapsed group becomes. Created up front rather than on demand so collapsing never has to
    // build DOM mid-resize.
    const more = document.createElement("button");
    more.type = "button";
    more.className = "mv-ribbon-more";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-label", i18n.t("ribbon.more", { group: groupLabel(group) }));
    more.innerHTML = `<span class="mv-ribbon-glyph" aria-hidden="true">${GLYPHS[group.id] ?? "•"}</span><span>${groupLabel(group)}</span>`;
    more.addEventListener("click", () => {
      const open = element.classList.toggle("mv-open");
      more.setAttribute("aria-expanded", String(open));
    });
    element.appendChild(more);

    const caption = document.createElement("div");
    caption.className = "mv-ribbon-group-label";
    caption.textContent = groupLabel(group);
    element.appendChild(caption);

    groupElements.set(group.id, element);
    return element;
  }

  function activate(id: string): void {
    const button = itemButtons.get(id);
    if (button === undefined) return;
    // A dimmed control is focusable and announced, and does nothing when pressed. Removing it from the tab order
    // would hide the very thing dimming is meant to teach.
    if (button.getAttribute("aria-disabled") === "true") {
      announce(
        `${button.querySelector(".mv-ribbon-label")?.textContent ?? id}: ` +
          `${button.dataset.reason ?? i18n.t("ribbon.unavailable")}`,
      );
      return;
    }
    const item = byId.get(id);
    if (item === undefined) return;
    announce(i18n.t("ribbon.armed", { tool: itemLabel(item) }));
    options.handlers.onTool(id, item);
  }

  /**
   * Roving tabindex within a group.
   *
   * Arrow keys move, Home/End jump, and exactly one button in each group is tabbable — so Tab reaches each group
   * once instead of stepping through thirty buttons.
   */
  function onGroupKey(event: KeyboardEvent, group: RibbonGroup): void {
    const order = group.items.map((i) => itemButtons.get(i.id)!).filter((b) => b.offsetParent !== null || true);
    const current = order.findIndex((b) => b === document.activeElement);
    if (current === -1) return;

    let next = current;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % order.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + order.length) % order.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = order.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    for (const button of order) button.setAttribute("tabindex", "-1");
    order[next]!.setAttribute("tabindex", "0");
    order[next]!.focus();
  }

  // --- tabs -------------------------------------------------------------------------------------

  for (const tab of tabs) {
    makeTab(tab.id, tr(`tab.${tab.id}`, tab.label), false);
    makePanel(tab.id, tab.id);
  }

  tablist.addEventListener("keydown", (event) => {
    const order = [...tabButtons.values()];
    const current = order.findIndex((b) => b === document.activeElement);
    if (current === -1) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else return;
    event.preventDefault();
    order[next]!.focus();
    setTab(order[next]!.dataset.tab!);
  });

  function setTab(tab: TabId | string): void {
    if (!tabButtons.has(tab)) return;
    activeTab = tab;
    for (const [id, button] of tabButtons) {
      const selected = id === tab;
      button.setAttribute("aria-selected", String(selected));
      // Only the selected tab is tabbable, per the ARIA tabs pattern: Tab enters the strip, arrows move within.
      button.setAttribute("tabindex", selected ? "0" : "-1");
      button.classList.toggle("mv-active", selected);
    }
    for (const [id, panel] of tabPanels) {
      panel.hidden = id !== tab;
    }
    options.handlers.onTab?.(tab);
    applyLayout();
  }

  // --- layout and availability -------------------------------------------------------------------

  function applyAvailability(): void {
    for (const [id, button] of itemButtons) {
      const item = byId.get(id);
      if (item === undefined) continue;
      const state: Availability = availabilityOfItem(item, context);
      const dimmed = state.state === "dimmed";
      // `aria-disabled` rather than `disabled`: a `disabled` button is unfocusable and unannounced, so a screen
      // reader user cannot discover it exists — which defeats dim-not-hide entirely.
      button.setAttribute("aria-disabled", String(dimmed));
      button.classList.toggle("mv-dimmed", dimmed);
      if (dimmed) {
        // Translated when this repository produced the text, verbatim when it did not — a plugin's own prose and a
        // remote service's refusal both arrive with no key and must survive untouched. The dimmed control exists
        // to *teach*, so the one string that must not silently stay English is this one.
        const reason = state.reasonKey === undefined ? state.reason : i18n.t(state.reasonKey);
        button.dataset.reason = reason;
        // The reason is on the element, so the CSS `::after` badge and the tooltip say the same thing.
        button.title = `${itemTitle(item)} — ${reason}`;
      } else {
        delete button.dataset.reason;
        button.title = itemTitle(item);
      }
    }
  }

  function applyLayout(): void {
    const width = Math.max(0, measure(container));
    const known = tabs.some((t) => t.id === activeTab) ? (activeTab as TabId) : (tabs[0]?.id ?? "home");
    const layout = layoutTab(known, width, groups);

    for (const laid of layout.groups) {
      const element = groupElements.get(laid.group.id);
      if (element === undefined) continue;
      element.classList.toggle("mv-collapsed", laid.collapsed);
      if (laid.collapsed) {
        element.classList.remove("mv-open");
        element.querySelector(".mv-ribbon-more")?.setAttribute("aria-expanded", "false");
      }
      for (const item of laid.group.items) {
        const button = itemButtons.get(item.id);
        if (button === undefined) continue;
        const size: ItemSize = laid.sizes?.get(item.id) ?? item.preferred;
        button.dataset.size = size;
      }
      // Exactly one tabbable button per group, restored after every layout — and only if focus is not already
      // inside, so a resize cannot move the user's place.
      const first = laid.group.items[0];
      if (first !== undefined && !element.contains(document.activeElement)) {
        for (const item of laid.group.items) itemButtons.get(item.id)?.setAttribute("tabindex", "-1");
        itemButtons.get(first.id)?.setAttribute("tabindex", "0");
      }
    }
  }

  function announce(message: string): void {
    // Cleared first: assigning the same text twice is not a change, and a screen reader stays silent — so
    // arming the same tool twice would be announced once.
    live.textContent = "";
    live.textContent = message;
  }

  // --- contextual tab ---------------------------------------------------------------------------

  function syncContextualTab(ifcClass: string | null): void {
    const wanted = contextualTabsFor(ifcClass);
    if (contextualClass !== null && (wanted.length === 0 || wanted[0]!.id !== contextualClass)) {
      tabButtons.get(contextualClass)?.remove();
      tabPanels.get(contextualClass)?.remove();
      tabButtons.delete(contextualClass);
      tabPanels.delete(contextualClass);
      if (activeTab === contextualClass) setTab(tabs[0]?.id ?? "home");
      contextualClass = null;
    }
    const next = wanted[0];
    if (next !== undefined && contextualClass !== next.id) {
      makeTab(next.id, tr(`tab.${next.id}`, next.label), true);
      makePanel(next.id, next.id);
      contextualClass = next.id;
      // Added, never replacing: the permanent tabs do not move, so muscle memory survives a selection.
      setTab(activeTab);
    }
  }

  // --- resize -----------------------------------------------------------------------------------

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => applyLayout());
    observer.observe(container);
  }

  setTab(activeTab);
  applyAvailability();
  applyLayout();

  return {
    update(next?: ToolContext) {
      if (next !== undefined) context = next;
      syncContextualTab((context as ToolContext & { ifcClass?: string | null }).ifcClass ?? null);
      applyAvailability();
      applyLayout();
    },
    setTab,
    get activeTab() {
      return activeTab;
    },
    announce,
    dispose() {
      // Idempotent, and it disconnects the observer — an observer that outlives its container keeps the whole
      // subtree alive, which is the leak `raf.ts` exists to prevent for animation frames.
      observer?.disconnect();
      observer = null;
      container.innerHTML = "";
      container.classList.remove("mv-ribbon");
      itemButtons.clear();
      groupElements.clear();
      tabButtons.clear();
      tabPanels.clear();
    },
  };
}
