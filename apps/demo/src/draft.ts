import { toGuid, type Guid, type ModelId } from "@massing/core";
import { createRegistry, type CommandContext, type Registry } from "@massing/commands";
import {
  DEFAULT_SNAP,
  createSession,
  draftCommands,
  type AuthoringSession,
  type HoverFeedback,
} from "@massing/authoring";
import { dynKeystroke, type SnapCandidate } from "@massing/geometry-math";
import { createGrid, createPreview, screenToGround, type GridController } from "@massing/viewport";
import type { KernelProvider } from "@massing/kernel-api";
import type { Viewport } from "@massing/viewport";

/**
 * Draft-tool wiring — the layer that was M6's whole gap.
 *
 * Everything this file uses already existed and was tested: the snap engine, `dynInput`'s `12'6` parser, the
 * prompt reducer, `LocalKernel`'s `add_wall`, the ribbon button. What did not exist was any code that turned a
 * pointer event into `session.hover()`, rendered the result, and sent the click. `@massing/authoring` was
 * consumed only by `packages/embed`, and `parseDynConstraint` was wired to no UI at all.
 *
 * ## Why it is a module and not inlined into main.ts
 *
 * `main.ts` is already the longest file here, and this is a coherent subsystem with one seam: it needs a
 * viewport, a kernel, and a way to say "the model changed, reload". Keeping it separate is also what makes the
 * dependency list above readable as a statement of what drafting actually requires.
 *
 * ## Order of resolution
 *
 * `pointermove` → `screenToGround` → `session.hover()` → preview. `hover` is documented as pure and safe to
 * call per frame, and it resolves the snap through *the same function* `pick` uses — so what the crosshair shows
 * is what the click commits, structurally rather than by remembering to keep two paths in step.
 */

export interface DraftDeps {
  readonly viewport: Viewport;
  readonly kernel: KernelProvider;
  readonly modelId: ModelId;
  /** The canvas, for pointer→ground projection. */
  readonly canvas: HTMLElement;
  /** Where the prompt and the typed buffer are shown. */
  readonly hud: HTMLElement;
  /** The meshes the model is currently made of, for endpoint snaps. Read fresh — authoring replaces them. */
  meshes(): readonly { positions: Float32Array | readonly number[] }[];
  /** Called after a command changed the model, so the host can re-export, re-tessellate and refresh its panels. */
  onModelChanged(): Promise<void>;
  /** Status line, for refusals and commits. */
  status(message: string, kind?: "ok" | "warn"): void;
  /** Whether the user may edit — the ribbon's own capability state. */
  canEdit(): boolean;
}

export interface DraftController {
  /** Arm a command by ribbon tool id. Returns false when the id is not a draft verb. */
  armByToolId(toolId: string): boolean;
  disarm(): void;
  readonly grid: GridController;
  readonly session: AuthoringSession;
  readonly registry: Registry;
  /**
   * Rebuild the endpoint snap index from the host's current meshes.
   *
   * Must be called after the model changes. Left stale, the next point snaps to where the previous wall *used to
   * be* — a wall in the wrong place, with no error anywhere and nothing on screen to suggest why.
   */
  refreshSnaps(): void;
  /** For tests: what the HUD is currently saying. */
  readonly prompt: string;
  dispose(): void;
}

/**
 * Ribbon tool id → command id.
 *
 * Two id spaces meet here and neither should learn about the other: `toolId()` slugs a button *title*, and a
 * command id is a namespaced verb. A map is the honest join. It is also the reason `armByToolId` can return
 * false — a tool that is not a draft verb belongs to whatever else the host does with it.
 */
const TOOL_TO_COMMAND: Record<string, string> = {
  "draw-a-wall-between-two-points-w": "mv.draft.wall",
  "draw-a-slab-from-a-closed-outline": "mv.draft.slab",
  "place-a-column-at-a-point": "mv.draft.column",
};

/** Grid spacing in metres. Matches `createGrid`'s default, or the crosshair snaps where no line is drawn. */
const GRID_SPACING = 1;

/** Snap tolerance in metres. Generous, because a 1 m grid on a small building is a coarse target. */
const SNAP_TOLERANCE = 0.35;

export function wireDraft(deps: DraftDeps): DraftController {
  const grid = createGrid(deps.viewport.scene, { spacing: GRID_SPACING, extent: 60, major: 10 });
  const preview = createPreview(deps.viewport.scene);

  const registry = createRegistry();
  for (const command of draftCommands({
    /**
     * The kernel round trip, and then a reload.
     *
     * `onModelChanged` is awaited *inside* apply rather than left to the caller, because a command that
     * returned before the viewport caught up would let a second click land against stale geometry — and the
     * snap candidates come from that geometry, so the second wall would snap to where the first one used to be.
     */
    apply: async (op, params) => {
      const applied = await deps.kernel.apply(deps.modelId, op as never, params as never);
      if (!applied.ok) return applied as never;
      await deps.onModelChanged();
      return { ok: true, value: { created: applied.value.created } } as never;
    },
    // Stamped from the registry's own clock, so an inverse orders correctly in the journal.
    stamp: () => ({ seq: registry.nextSeq(), at: registry.now() }),
  })) {
    registry.register(command);
  }

  /**
   * Endpoint snap candidates from the model's own geometry, bucketed on a coarse hash grid.
   *
   * `hover()` asks for candidates on every pointer move, and the fixture alone has thousands of vertices. Copied
   * from the same approach in `packages/embed`, for the same reason: a linear scan per frame is the difference
   * between snapping feeling instant and feeling like a delay nobody can attribute.
   */
  const CELL = 1;
  let buckets = new Map<string, SnapCandidate[]>();

  const cellKey = (x: number, z: number): string => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

  function rebuildSnaps(): void {
    const next = new Map<string, SnapCandidate[]>();
    // Deduplicated on a 1 mm lattice. A triangle soup repeats every shared vertex once per triangle, so without
    // this a box contributes 36 identical candidates and the tie-break compares a point against itself.
    const seen = new Set<string>();
    for (const mesh of deps.meshes()) {
      const p = mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = Number(p[i]);
        const z = Number(p[i + 2]);
        const key = `${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = next.get(cellKey(x, z));
        if (bucket === undefined) next.set(cellKey(x, z), [{ x, z, kind: "endpoint" }]);
        else bucket.push({ x, z, kind: "endpoint" });
      }
    }
    buckets = next;
  }
  rebuildSnaps();

  function candidates(cursor: { x: number; z: number }): SnapCandidate[] {
    const out: SnapCandidate[] = [];
    const cx = Math.floor(cursor.x / CELL);
    const cz = Math.floor(cursor.z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = buckets.get(`${cx + dx}:${cz + dz}`);
        if (bucket !== undefined) out.push(...bucket);
      }
    }
    // No grid candidates here on purpose: `SnapSettings.grid` already makes the session add them, and adding a
    // second set would mean two places deciding where an intersection is. Grid snaps are lowest-priority in
    // `resolveSnap`, so a corner of the building always wins over the paper underneath it.
    return out;
  }

  const context = (): CommandContext => ({
    capabilities: new Set(deps.canEdit() ? (["view", "edit"] as const) : (["view"] as const)),
    selection: [],
    supportsOp: (op) => ops.has(op as string),
    opHint: (op) =>
      `"${String(op)}" is not one of this kernel's operations. It may need the Massing authoring service.`,
    online: true,
    dispatch: async (invocation) => await registry.dispatch(invocation, context()),
  });

  /**
   * The operations the kernel declares, read once.
   *
   * Read rather than assumed, because `availability()` dims a command with the kernel's own hint when its
   * operation is missing — and `LocalKernel` supports 15 of 96. Assuming support would show every draw verb as
   * enabled against a kernel that would refuse it on click.
   */
  const ops = new Set<string>();
  void (async () => {
    const listed = await deps.kernel.ops();
    if (listed.ok) for (const descriptor of listed.value) ops.add(descriptor.id as string);
  })();

  const session = createSession({
    registry,
    context,
    candidates,
    // `grid: GRID_SPACING` is what turns on grid snapping — the session already resolves it, through the same
    // `gridSnaps` this file would otherwise have called itself. Setting it here rather than pushing candidates in
    // `candidates()` keeps one grid-snap path, so the crosshair and the reducer cannot disagree about where an
    // intersection is.
    snap: { ...DEFAULT_SNAP, grid: GRID_SPACING, tolerance: SNAP_TOLERANCE },
  });

  // --- the HUD ------------------------------------------------------------------------------------

  /** The typed buffer, mirrored for display. `session.key` owns the authoritative copy inside the reducer. */
  let typed = "";
  let lastFeedback: HoverFeedback | null = null;

  function renderHud(): void {
    const state = session.state;
    if (state.armed === null) {
      deps.hud.hidden = true;
      deps.hud.textContent = "";
      return;
    }
    deps.hud.hidden = false;
    const bits = [state.prompt];
    if (state.keywords.length > 0) bits.push(`[${state.keywords.join("/")}]`);
    // The dynamic-input readout: the live distance and bearing, or whatever the user is typing over it. This is
    // the surface `parseDynConstraint` existed for and had none.
    if (typed !== "") {
      bits.push(`⟨${typed}⟩`);
    } else if (lastFeedback?.distance != null) {
      const angle = lastFeedback.angle == null ? "" : ` · <${lastFeedback.angle.toFixed(0)}°`;
      bits.push(`⟨${lastFeedback.distance.toFixed(3)} m${angle}⟩`);
    }
    if (lastFeedback?.snap != null) bits.push(`· ${lastFeedback.snap.kind}`);
    if (lastFeedback?.override != null) bits.push(`· ${lastFeedback.override} override`);
    deps.hud.textContent = bits.join(" ");
  }

  function paint(): void {
    const state = session.state;
    preview.update({
      at: lastFeedback === null ? null : { x: lastFeedback.at.x, z: lastFeedback.at.z },
      snapKind: lastFeedback?.snap?.kind ?? null,
      points: state.points.map((p) => ({ x: p.x, z: p.z })),
    });
    renderHud();
  }

  // --- pointer and keyboard ------------------------------------------------------------------------

  function groundOf(event: PointerEvent | MouseEvent): { x: number; z: number } | null {
    return screenToGround(event, deps.viewport.camera, deps.canvas, grid.elevation);
  }

  const onMove = (event: PointerEvent): void => {
    if (session.state.armed === null) return;
    const at = groundOf(event);
    // Off the ground plane — looking at the horizon. The crosshair hides rather than freezing at its last
    // position, which would suggest the tool is still tracking something.
    lastFeedback = at === null ? null : session.hover(at, { shift: event.shiftKey, ctrl: event.ctrlKey });
    paint();
  };

  const onDown = (event: PointerEvent): void => {
    if (session.state.armed === null) return;
    // Left button only, and swallowed so the viewport's own orbit/select does not also act on it. A click that
    // both places a point and re-selects an element is the classic double-handled-event bug.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = groundOf(event);
    if (at === null) return;
    void commit(session.pick(at, { shift: event.shiftKey, ctrl: event.ctrlKey }));
  };

  /**
   * Keystrokes, and the distinction that makes typed distances work at all.
   *
   * **The host owns the character buffer; the session owns whole tokens.** `session.key()` routes its argument
   * straight into the token parser, so feeding it one character at a time parses each character as a *complete*
   * constraint: typing `12'6` sent `1`, then `2`, then `'`, then `6`, and each one replaced the last, leaving a
   * distance of **6**. The wall came out 6 m long while the HUD read `12'6`. Nothing errored, and the readout
   * looked right — which is exactly why this needed driving in a browser rather than reasoning about.
   *
   * `dynKeystroke` is the buffer that was designed for this and that nothing was using: it appends dyn characters,
   * trims on Backspace, and leaves anything else alone. The whole buffer then goes to `session.type()`.
   *
   * Backspace is routed by *context*: while a buffer exists it edits the buffer, and only when the buffer is empty
   * does it mean "undo the last point". Conflating those would make Backspace mid-number delete a committed
   * point — the session's own comment calls that "a data-loss bug disguised as a keystroke".
   */
  const onKey = (event: KeyboardEvent): void => {
    if (session.state.armed === null) return;
    // Never swallow a browser shortcut. Ctrl/Meta combinations belong to the platform, and stealing Ctrl+R from
    // a user mid-command is a memorable way to lose their trust.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === "Escape") {
      event.preventDefault();
      typed = "";
      void commit(session.key("Escape"));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      // The buffer is already in the session as a parsed constraint; Enter is what turns it into a point.
      typed = "";
      void commit(session.key("Enter"));
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      if (typed !== "") {
        typed = dynKeystroke(typed, "Backspace");
        if (typed === "") {
          // `clearTyped`, not `key("Escape")` — Escape cancels the whole command, which would throw away the
          // points already collected because the user deleted a digit.
          session.clearTyped();
          paint();
        } else {
          void commit(session.type(typed));
        }
        return;
      }
      void commit(session.key("Backspace"));
      return;
    }

    const next = dynKeystroke(typed, event.key);
    if (next !== typed) {
      event.preventDefault();
      typed = next;
      // The WHOLE buffer, every time. This is the fix for the 6 m wall.
      void commit(session.type(typed));
      return;
    }

    // Not a dynamic-input character — a keyword letter, or an override code. Straight through.
    if (event.key.length === 1) {
      event.preventDefault();
      void commit(session.key(event.key, { shift: event.shiftKey, ctrl: event.ctrlKey }));
    }
  };

  /** Apply a step outcome: report it, clear the buffer on a boundary, repaint. */
  async function commit(pending: Promise<Awaited<ReturnType<AuthoringSession["pick"]>>>): Promise<void> {
    const outcome = await pending;
    switch (outcome.kind) {
      case "committed": {
        typed = "";
        deps.status(
          outcome.result.ok ? "committed" : `${outcome.result.error.code}: ${outcome.result.error.message}`,
          outcome.result.ok ? "ok" : "warn",
        );
        break;
      }
      case "refused": {
        // Armed and still armed. A refusal must not throw away the points already collected — losing work to a
        // validation message is what makes people stop trusting a tool.
        deps.status(outcome.reason, "warn");
        break;
      }
      case "cancelled": {
        typed = "";
        lastFeedback = null;
        preview.clear();
        deps.status("cancelled");
        break;
      }
      case "collecting":
      case "idle":
        break;
    }
    paint();
  }

  // `capture` on pointerdown, so the draft tool sees the click before the viewport's selection handler and can
  // stop it. Registered on the canvas rather than the window: a click on the ribbon is not a pick.
  deps.canvas.addEventListener("pointermove", onMove);
  deps.canvas.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("keydown", onKey);

  return {
    armByToolId(toolId) {
      const commandId = TOOL_TO_COMMAND[toolId];
      if (commandId === undefined) return false;
      const armed = session.arm(commandId);
      if (!armed.ok) {
        // The reason `availability()` gave, verbatim. Dimmed-with-a-reason, at the session level.
        deps.status(armed.reason, "warn");
        return true;
      }
      // The grid comes on with a draw tool. An invisible grid you can still snap to is a snap nobody aimed at,
      // and M6's criterion is "snap to a grid intersection" — the intersection has to be visible to be aimed at.
      grid.visible(true);
      typed = "";
      lastFeedback = null;
      paint();
      deps.status(armed.prompt);
      return true;
    },

    disarm() {
      session.disarm();
      typed = "";
      lastFeedback = null;
      preview.clear();
      renderHud();
    },

    grid,
    session,
    registry,
    refreshSnaps: rebuildSnaps,
    get prompt() {
      return deps.hud.textContent ?? "";
    },

    dispose() {
      deps.canvas.removeEventListener("pointermove", onMove);
      deps.canvas.removeEventListener("pointerdown", onDown, { capture: true } as never);
      window.removeEventListener("keydown", onKey);
      preview.dispose();
      grid.dispose();
    },
  };
}

/** Rebuildable snap index, exposed so the host can refresh it after the model changes. */
export type { Guid, ModelId };
export { toGuid };
