// Extracted from ibuilder/massing @ 57ca47a0aad2cd33f340507cc90860231aec2f38 (apps/web/src/viewer/canvasMode.ts), MIT.
// See NOTICE and docs/PROVENANCE.tsv. Upstream changes to that path are reported weekly.

/**
 * The canvas becomes one thing at a time, instead of 3D with a 2D pane stuck to it.
 *
 * ## The complaint this answers
 *
 * A generated plan shown as a side pane is not a peer of the model — it is a strip of it. Upstream's own header
 * puts it plainly: the plan was `position:absolute; right:0; width:38%`, so *"the model was always the thing the
 * canvas was"*. Anything that wants the whole page — a sheet with a title block, a markup session, a drawing at a
 * scale you can measure off — cannot live in a strip.
 *
 * So the mode **is** the state and visibility is derived from it. Two surfaces with independent `hidden` flags have
 * four states and two of them are wrong (both visible, neither visible); nothing prevents them except everyone
 * remembering. Here "exactly one surface is visible" is not a rule anyone has to follow.
 *
 * ## A mode cannot be registered without a surface to enter
 *
 * `specs` has a seat in the type and is not registered by this repository, for the same reason it is not registered
 * upstream: there is no canvas for it. A tab that highlights and shows nothing is the failure this codebase files
 * under *existence is not arrival*.
 *
 * ## Why this is in `ui-model` and not in the app
 *
 * No DOM, so the invariant is testable without a browser and massing's vanilla shell and this repository's React
 * shell read the same reducer rather than each writing their own. That is the same reason `toolbarLayout.ts` lives
 * here — and this file is the reason the plan pane can become a full surface without either host inventing state.
 */

export type CanvasMode = "model" | "sheets" | "specs";

/** Declaration order is tab order. */
export const MODE_ORDER: readonly CanvasMode[] = ["model", "sheets", "specs"] as const;

export interface ModeDef {
  readonly key: CanvasMode;
  /** Tab label. */
  readonly label: string;
  /** Tooltip and accessible description. */
  readonly title?: string;
  /**
   * Why this mode cannot be entered right now, or null when it can. Re-evaluated on every switch.
   *
   * Re-evaluated rather than captured, because the answer changes: `sheets` is blocked until something has been cut,
   * and that becomes true while the tab is already on screen.
   */
  readonly blocked?: () => string | null;
  /** Make this surface the canvas. Called only on an actual change. */
  readonly enter: () => void;
  /** Yield the canvas. Called before the next mode's `enter`. */
  readonly leave: () => void;
}

export interface SwitchResult {
  readonly ok: boolean;
  /** Present only when `ok` is false — always a sentence a user can act on. */
  readonly reason?: string;
}

export interface CanvasModeSwitch {
  /** Registered modes, in {@link MODE_ORDER}. */
  readonly modes: readonly CanvasMode[];
  readonly active: CanvasMode;
  def(mode: CanvasMode): ModeDef | undefined;
  /** Enter `mode`, or refuse with a reason. */
  switchTo(mode: CanvasMode): SwitchResult;
}

/**
 * Build the switch.
 *
 * A factory returning an interface rather than upstream's `class`, matching how everything else in this package is
 * shaped — there is no inheritance here and nothing constructs it with `new` across a package boundary.
 */
export function createCanvasModeSwitch(
  defs: readonly ModeDef[],
  onChange?: (mode: CanvasMode) => void,
): CanvasModeSwitch {
  if (defs.length === 0) throw new Error("a canvas mode switch needs at least one mode");

  const registry = new Map<CanvasMode, ModeDef>();
  for (const def of defs) {
    if (registry.has(def.key)) throw new Error(`duplicate canvas mode: ${def.key}`);
    registry.set(def.key, def);
  }

  const modes = MODE_ORDER.filter((m) => registry.has(m));
  let current = modes[0]!;

  // The opening mode is entered, so the canvas and the state agree from the first frame. Without it the switch
  // believes it is in `model` while whatever the DOM happens to show is showing.
  registry.get(current)!.enter();

  return {
    get modes() {
      return modes;
    },
    get active() {
      return current;
    },
    def(mode) {
      return registry.get(mode);
    },
    switchTo(mode) {
      const def = registry.get(mode);
      if (def === undefined) return { ok: false, reason: `${mode} is not available in this viewer yet` };

      // Switching to the mode already active is a successful no-op, and must NOT re-enter: every click on the
      // current tab would otherwise reset that surface's camera, scroll position and zoom.
      if (mode === current) return { ok: true };

      const why = def.blocked?.() ?? null;
      if (why !== null && why !== "") return { ok: false, reason: why };

      registry.get(current)!.leave();
      current = mode;
      def.enter();
      onChange?.(mode);
      return { ok: true };
    },
  };
}

/**
 * Which surface is visible, derived from the mode.
 *
 * Exported separately so the invariant — for any mode, exactly one registered surface is visible — is testable
 * without constructing a DOM.
 */
export function visibility(mode: CanvasMode, registered: readonly CanvasMode[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of registered) out[m] = m === mode;
  return out;
}
