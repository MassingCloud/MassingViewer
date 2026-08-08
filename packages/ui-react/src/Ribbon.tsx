import { useEffect, useRef, useState } from "react";
import { createRibbon, type Ribbon as RibbonHandle, type RibbonOptions } from "@massing/ribbon";
import type { RibbonGroup, RibbonItem, ToolContext } from "@massing/ui-model";

/**
 * React hosting the vanilla ribbon.
 *
 * ## Why this file is thin, and must stay thin
 *
 * `docs/adr/0009-ribbon-renders-in-vanilla-dom.md` moved the rendering boundary down a level: the ribbon renders
 * in plain DOM in `packages/ribbon`, and React *wraps* it. The direction of the dependency is the whole argument —
 * a vanilla renderer works in massing's shell and in a React host; a React renderer works in one of them.
 *
 * So this is a mount, an update, and a teardown. Every line of ribbon *behaviour* — collapse, roving tabindex,
 * dim-not-hide, the live region — lives in the package below, once. If this file starts to grow, the ribbon is
 * being reimplemented in React, which is the thing ADR-0009 exists to prevent.
 *
 * ## The three ways React breaks imperative UI
 *
 * **StrictMode mounts, unmounts and mounts again.** Not a hypothetical: it is the default in development, and it
 * exists precisely to catch effects that are not idempotent. An imperative widget created in an effect and not
 * disposed on cleanup ends up rendered twice, and the second copy is the one holding the event listeners.
 *
 * **A new options object every render is a new dependency every render.** If the effect that creates the ribbon
 * depends on `options`, and `options` is an object literal in the caller's JSX, the ribbon is destroyed and
 * rebuilt on every render — losing focus, losing the open dropdown, and costing thirty DOM builds a keystroke.
 * The handlers therefore live in a ref that the effect reads, and the effect depends on nothing that changes.
 *
 * **An effect cannot see the current props.** A handler captured at mount closes over the props from that render
 * forever. That is the stale-closure bug, and it is why `handlersRef` is written on every render rather than
 * passed in once.
 */

export interface RibbonProps {
  readonly context?: ToolContext;
  /** Pre-built groups — from `plugin-host`'s `ribbonFrom(contributions)`, or omitted for the built-in table. */
  readonly groups?: readonly RibbonGroup[];
  readonly availability?: RibbonOptions["availability"];
  readonly onTool: (id: string, item: RibbonItem) => void;
  readonly onTab?: (tab: string) => void;
  className?: string;
  /** Escape hatch for a host that needs the imperative handle — `announce`, `setTab`. */
  readonly onReady?: (ribbon: RibbonHandle) => void;
}

/**
 * Mount the ribbon into a `<div>` React owns but does not render into.
 *
 * The container is React's; everything inside it belongs to `createRibbon`. React must never render children
 * here — two owners of one subtree is how you get "NotFoundError: The node to be removed is not a child of this
 * node" during an unrelated reconciliation.
 */
export function Ribbon(props: RibbonProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const ribbon = useRef<RibbonHandle | null>(null);

  /**
   * Live props, read by the imperative handlers.
   *
   * Written on every render, deliberately — during render rather than in an effect, because the ribbon's own
   * event handlers can fire before an effect has run (a click on the same tick as a re-render), and a handler
   * reading a ref that is one render stale calls the previous `onTool`.
   */
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const node = container.current;
    if (node === null) return;

    const handle = createRibbon(node, {
      context: live.current.context,
      groups: live.current.groups,
      availability: live.current.availability,
      handlers: {
        // Indirected through the ref so the effect has no prop dependencies and never re-creates the ribbon.
        onTool: (id, item) => live.current.onTool(id, item),
        onTab: (tab) => live.current.onTab?.(tab),
      },
    });
    ribbon.current = handle;
    live.current.onReady?.(handle);

    /**
     * Resize handling belongs here, not in the package.
     *
     * `createRibbon` deliberately does not observe its own container: a package that installs a
     * `ResizeObserver` decides for every host when layout happens, and a host with its own layout pass (React,
     * a docking manager, massing's splitter) then gets two. Owning it here means one.
     */
    const observer = new ResizeObserver(() => handle.update());
    observer.observe(node);

    return () => {
      observer.disconnect();
      // Both required, and in this order. StrictMode runs this cleanup immediately after the first mount, so
      // without it the second mount finds a container already full of a ribbon — two tab strips, two live
      // regions, and the listeners on the first one still installed.
      handle.dispose();
      ribbon.current = null;
    };
    // Empty deps, and **not** a suppression: `react-hooks/exhaustive-deps` agrees, because every variable this
    // effect reads is a ref (`container`, `live`, `ribbon`) and refs are stable by definition. That is the point
    // of routing the props through `live` rather than closing over them — it makes "create once" something the
    // linter can verify instead of something a comment asserts. Adding props here would rebuild the ribbon on
    // every render, destroying focus and any open dropdown.
  }, []);

  // Availability and layout are re-evaluated when the context changes, which is a cheap attribute pass rather
  // than a rebuild. That distinction is why `createRibbon` separates `update()` from construction at all.
  useEffect(() => {
    ribbon.current?.update(props.context);
  }, [props.context]);

  return <div ref={container} className={props.className} />;
}

/**
 * The imperative handle, for a host that wants `announce` or `setTab` without prop-drilling.
 *
 * Returns `null` until the ribbon has mounted, and `null` is a real state rather than an oversight: on the first
 * render there is no DOM node yet, so there is nothing to hold a handle to. A hook that lied about this — by
 * throwing, or by returning a stub that silently no-ops — would move the problem to whoever calls `setTab` in a
 * render body.
 */
export function useRibbonHandle(): [RibbonHandle | null, (ribbon: RibbonHandle) => void] {
  const [handle, setHandle] = useState<RibbonHandle | null>(null);
  return [handle, setHandle];
}
