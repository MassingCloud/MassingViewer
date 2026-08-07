import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The dockable panel layout.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is resizable, collapsible regions around a centre that keeps its own DOM node. It is **not** a tab-dragging,
 * float-anything, arbitrary-split docking manager. That distinction is a decision, not a shortcut:
 *
 * - The centre holds a WebGL canvas. Every arbitrary-docking library reparents nodes as layouts change, and
 *   moving a `<canvas>` in the DOM **loses its WebGL context** in some browsers and always costs a full
 *   re-upload. A layout engine that is free to reparent anything is a layout engine that will eventually reparent
 *   the viewport.
 * - Arbitrary docking produces layouts users cannot get back out of. The feature request is "I want the
 *   properties panel wider"; the implementation people reach for is a tab-dragging engine, and then the support
 *   burden is "my panel has vanished".
 *
 * So: fixed regions, resizable and collapsible, with the layout persisted. That covers the actual request. If
 * float-and-tab is genuinely needed later it is a replaceable component rather than a rewrite, because the panels
 * do not know they are docked.
 *
 * ## Resizing without dropping frames or losing the pointer
 *
 * Two things make a drag handle work properly, and both are easy to leave out:
 *
 * **Pointer capture.** Without `setPointerCapture`, moving the pointer faster than React re-renders sends the
 * events to whatever is under the cursor — the canvas — and the drag silently stops. With it, every move goes to
 * the handle until release, whatever it passes over.
 *
 * **Width applied as a CSS variable, not as state.** Writing a `useState` per pointermove is a React render per
 * mouse move, at 120 Hz, with a WebGL canvas in the tree. The variable is written directly to the DOM during the
 * drag and committed to state once on release.
 */

export type DockSide = "left" | "right" | "bottom";

export interface DockPanel {
  readonly id: string;
  readonly title: string;
  readonly side: DockSide;
  readonly content: React.ReactNode;
  /** Starting size in pixels — width for left/right, height for bottom. */
  readonly size?: number;
  readonly minSize?: number;
  readonly collapsed?: boolean;
}

export interface DockLayout {
  /** Panel id → size in pixels. */
  readonly sizes: Readonly<Record<string, number>>;
  readonly collapsed: readonly string[];
}

export interface DockProps {
  readonly panels: readonly DockPanel[];
  /** The centre. Rendered exactly once, in one node, and never reparented. */
  readonly children: React.ReactNode;
  readonly layout?: DockLayout;
  /** Called on release, not during the drag — one callback per gesture, so persistence is not per frame. */
  readonly onLayoutChange?: (layout: DockLayout) => void;
}

const DEFAULT_SIZE = 280;
const DEFAULT_MIN = 140;

/** Which way a side's size grows relative to pointer movement. */
function delta(side: DockSide, dx: number, dy: number): number {
  if (side === "left") return dx;
  // Right and bottom grow as the pointer moves *towards* the origin, so the sign inverts. Getting this wrong
  // produces a handle that runs away from the cursor, which feels broken rather than backwards.
  if (side === "right") return -dx;
  return -dy;
}

export function Dock(props: DockProps): React.ReactElement {
  const { panels, children, onLayoutChange } = props;

  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>(() => {
    const initial: Record<string, number> = {};
    for (const panel of panels) initial[panel.id] = props.layout?.sizes[panel.id] ?? panel.size ?? DEFAULT_SIZE;
    return initial;
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(props.layout?.collapsed ?? panels.filter((p) => p.collapsed === true).map((p) => p.id)),
  );

  const root = useRef<HTMLDivElement>(null);
  /**
   * Panel id → its element.
   *
   * Needed because the drag writes the size straight to the DOM rather than through state, so it has to be able
   * to find the node. A first version wrote `--mv-dock-<id>` on the *root* while the stylesheet read
   * `--mv-dock-width`, and the two names never met: dragging ran, updated a variable nothing consumed, and the
   * panel did not move. One variable name scoped by the element that owns it removes the chance to disagree.
   */
  const nodes = useRef(new Map<string, HTMLDivElement>());

  const commit = useCallback(
    (nextSizes: Readonly<Record<string, number>>, nextCollapsed: ReadonlySet<string>) => {
      onLayoutChange?.({ sizes: nextSizes, collapsed: [...nextCollapsed] });
    },
    [onLayoutChange],
  );

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      commit(sizes, next);
      return next;
    });
  };

  const startDrag = (panel: DockPanel, event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    // Every subsequent move comes here regardless of what the pointer is over. Without this, a fast drag across
    // the canvas silently ends.
    handle.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = sizes[panel.id] ?? DEFAULT_SIZE;
    const min = panel.minSize ?? DEFAULT_MIN;
    let latest = startSize;

    const onMove = (move: PointerEvent): void => {
      const raw = startSize + delta(panel.side, move.clientX - startX, move.clientY - startY);
      // Capped against the container so a panel cannot be dragged wider than the window and hide the viewport
      // entirely — a state a user cannot see their way out of.
      const container = root.current;
      const available = container === null ? Infinity : (panel.side === "bottom" ? container.clientHeight : container.clientWidth) - 200;
      latest = Math.max(min, Math.min(raw, available));
      // Straight to the DOM. A `setState` here is one React render per pointermove, with a WebGL canvas in the
      // tree, at up to 120 Hz.
      nodes.current.get(panel.id)?.style.setProperty("--mv-dock-size", `${latest}px`);
    };

    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // One state update and one persistence callback per gesture.
      setSizes((current) => {
        const next = { ...current, [panel.id]: latest };
        commit(next, collapsed);
        return next;
      });
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    // `pointercancel` matters on touch: a gesture the browser takes over for scrolling never sends `pointerup`,
    // and without this the listeners stay attached for the life of the page.
    handle.addEventListener("pointercancel", onUp);
  };

  // Keyboard resizing, because a drag handle that only responds to a pointer is a control a keyboard user cannot
  // operate at all — and `role="separator"` with `aria-valuenow` is the pattern that makes it discoverable.
  const onHandleKey = (panel: DockPanel, event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? 48 : 12;
    const current = sizes[panel.id] ?? DEFAULT_SIZE;
    const min = panel.minSize ?? DEFAULT_MIN;
    let next: number | null = null;

    if (event.key === (panel.side === "bottom" ? "ArrowUp" : "ArrowLeft")) next = current + (panel.side === "left" ? -step : step);
    if (event.key === (panel.side === "bottom" ? "ArrowDown" : "ArrowRight")) next = current + (panel.side === "left" ? step : -step);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle(panel.id);
      return;
    }
    if (next === null) return;

    event.preventDefault();
    setSizes((currentSizes) => {
      const updated = { ...currentSizes, [panel.id]: Math.max(min, next!) };
      commit(updated, collapsed);
      return updated;
    });
  };

  // Sync the DOM back to state after a commit, a collapse, or a restored layout. Also the point where a drag's
  // direct write is reconciled with the value React now holds — without this the two diverge silently after the
  // first collapse, because collapsing does not go through the drag path.
  useEffect(() => {
    for (const panel of panels) {
      nodes.current.get(panel.id)?.style.setProperty("--mv-dock-size", `${sizes[panel.id] ?? DEFAULT_SIZE}px`);
    }
  }, [panels, sizes, collapsed]);

  const bySide = (side: DockSide): readonly DockPanel[] => panels.filter((p) => p.side === side);

  const renderPanel = (panel: DockPanel): React.ReactElement => {
    const isCollapsed = collapsed.has(panel.id);
    return (
      <div
        key={panel.id}
        ref={(node) => {
          if (node === null) nodes.current.delete(panel.id);
          else nodes.current.set(panel.id, node);
        }}
        className={`mv-dock-panel mv-dock-${panel.side}${isCollapsed ? " mv-collapsed" : ""}`}
      >
        <div className="mv-dock-header">
          <button type="button" aria-expanded={!isCollapsed} onClick={() => toggle(panel.id)}>
            {panel.title}
          </button>
        </div>
        {/*
          Kept mounted when collapsed, and hidden with the `hidden` attribute.
          Unmounting would throw away scroll position, expanded property sets and any in-progress edit — so
          collapsing a panel would silently discard work. And `[hidden]` needs a CSS rule that wins against the
          panel's own `display`, which is the bug that once made all seven ribbon panels render at once.
        */}
        <div className="mv-dock-body" hidden={isCollapsed}>
          {panel.content}
        </div>
        {!isCollapsed && (
          <div
            className="mv-dock-handle"
            role="separator"
            aria-label={`Resize ${panel.title}`}
            aria-orientation={panel.side === "bottom" ? "horizontal" : "vertical"}
            aria-valuenow={Math.round(sizes[panel.id] ?? DEFAULT_SIZE)}
            aria-valuemin={panel.minSize ?? DEFAULT_MIN}
            tabIndex={0}
            onPointerDown={(event) => startDrag(panel, event)}
            onKeyDown={(event) => onHandleKey(panel, event)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="mv-dock" ref={root}>
      <div className="mv-dock-row">
        {bySide("left").map(renderPanel)}
        {/*
          The centre, in one node that is never reparented. This is the reason the layout is regions rather than
          arbitrary docking: moving a `<canvas>` in the DOM loses its WebGL context in some browsers, and always
          costs a full texture re-upload.
        */}
        <div className="mv-dock-centre">{children}</div>
        {bySide("right").map(renderPanel)}
      </div>
      {bySide("bottom").map(renderPanel)}
    </div>
  );
}

/**
 * Persist and restore a layout.
 *
 * Versioned, and an unknown version is **discarded rather than migrated**. A layout is regenerable from defaults
 * in one render, so the cost of throwing it away is nearly zero — and the cost of misreading an old shape is a
 * panel sized `NaN`, which renders as a collapsed sliver the user cannot grab. Cheap to lose, expensive to get
 * wrong: discard.
 */
export function loadLayout(storage: Pick<Storage, "getItem">, key = "mv.dock"): DockLayout | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { version?: number; layout?: DockLayout };
    if (parsed.version !== 1 || parsed.layout === undefined) return undefined;
    // Non-finite sizes are dropped individually: one bad number should not discard a whole layout.
    const sizes: Record<string, number> = {};
    for (const [id, size] of Object.entries(parsed.layout.sizes ?? {})) {
      if (typeof size === "number" && Number.isFinite(size) && size >= 0) sizes[id] = size;
    }
    return { sizes, collapsed: (parsed.layout.collapsed ?? []).filter((id) => typeof id === "string") };
  } catch {
    // Corrupt JSON is the same as no layout. Throwing here would take down the whole shell over a preference.
    return undefined;
  }
}

export function saveLayout(storage: Pick<Storage, "setItem">, layout: DockLayout, key = "mv.dock"): void {
  try {
    storage.setItem(key, JSON.stringify({ version: 1, layout }));
  } catch {
    // Private browsing, a full quota, or storage disabled by policy. A preference that cannot be saved is not a
    // reason to interrupt anyone.
  }
}
