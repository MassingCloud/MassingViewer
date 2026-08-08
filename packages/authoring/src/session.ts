import type { PlanBounds, SnapCandidate, SnapKind, SnapResult, Vec2 } from "@massing/geometry-math";
import {
  ALL_OVERRIDE_KINDS,
  KEY_SHORTCUT_MAP,
  OVERRIDE_CODES,
  OVERRIDE_LABEL,
  applyDynamicInput,
  createSnapOverride,
  inferDirection,
  isDynKey,
  parseDynConstraint,
  polarConstrain,
  resolveSnap,
  validatePlacement,
  type DynConstraint,
  type Inference,
  type OverrideKind,
  type SnapOverrideHandle,
} from "@massing/geometry-math";
import {
  begin,
  step,
  toInvocation,
  type AnyCommandDescriptor,
  type CommandContext,
  type CommandInvocation,
  type CommandOrigin,
  type PromptEvent,
  type PromptState,
  type Registry,
} from "@massing/commands";
import type { Result } from "@massing/core";

/**
 * The authoring session — the object four of the five M9 seam gaps were waiting on.
 *
 * ## Why one object closes four gaps
 *
 * `seamCoverage()` listed snapping, the prompt loop, the section box and markup pins as separate gaps, and
 * reading their reasons they share one cause. Every library underneath already exists and is tested:
 * `geometry-math` holds the ported snap engine, `commands` holds the prompt reducer, `markup` is complete.
 * What was missing is the thing that connects them — **a session that knows a tool is armed, holds the
 * half-collected argument bag, and turns a cursor position into a resolved point.**
 *
 * So this is not a fifth feature beside those four. It is the missing middle, and the four become bindings.
 *
 * ## The ordering that the whole design rests on
 *
 * **Snapping happens before the reducer sees anything.** `resolveSnap`, `polarConstrain` and
 * `applyDynamicInput` produce the `at` carried by a `pick-point`; the reducer never computes geometry. Two
 * consequences, both load-bearing:
 *
 * - Snapping stays **frame-immediate**. A reducer round-trip per mouse-move would be visible as lag on the
 *   crosshair, and a crosshair that lags is a crosshair nobody trusts.
 * - The reducer stays **deterministic**. The same event sequence always yields the same state, which is what
 *   makes a recorded macro a reliable regression test rather than a recording of one machine's timing.
 *
 * ## The invariant that matters most
 *
 * **What the crosshair shows is what the click commits.** {@link AuthoringSession.hover} and
 * {@link AuthoringSession.pick} resolve the cursor through *one* function, {@link resolve}, so they cannot
 * disagree. If they resolved separately — even with identical-looking code — any divergence would present as
 * geometry landing a few millimetres from where the user aimed, intermittently, depending on whether a
 * `pointermove` happened to land between the last hover and the click. That is close to undebuggable from a
 * bug report, and it is designed out rather than tested for.
 */

export interface Modifiers {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
}

export interface SnapSettings {
  readonly enabled: boolean;
  /** Pick radius in model units (metres). */
  readonly tolerance: number;
  /** Constrain to 90° from the previous point. Wins over polar, as in every CAD application. */
  readonly ortho: boolean;
  readonly polar: boolean;
  /** Degrees. 45 gives the eight compass directions. */
  readonly polarIncrement: number;
  /** Grid pitch in metres, or null for no grid snap. */
  readonly grid: number | null;
  /** On-axis / parallel / perpendicular inference without holding a modifier. */
  readonly inference: boolean;
}

export const DEFAULT_SNAP: SnapSettings = {
  enabled: true,
  // 0.35 m at 1:100 is about 3.5 mm on screen — close to the 8 px the plan pane's fat-twin trick uses for the
  // same reason. A tolerance in model units rather than pixels is deliberate: it means the same physical
  // tolerance whatever the zoom, so snapping does not get greedier as you zoom out.
  tolerance: 0.35,
  ortho: false,
  polar: true,
  polarIncrement: 45,
  grid: null,
  inference: true,
};

/** What the host should draw this frame. Everything here is presentation, not state. */
export interface HoverFeedback {
  /** Where the point would land if clicked. */
  readonly at: Vec2;
  /** The snap that won, if any — for the glyph beside the crosshair. */
  readonly snap: SnapResult | null;
  /** An inference line to draw, if one is active. */
  readonly inference: Inference | null;
  /** Locked to a polar or ortho angle, in degrees, or null. */
  readonly angle: number | null;
  /** Distance from the previous point, metres — for the dynamic-input readout. */
  readonly distance: number | null;
  /** A one-shot override that is armed and will consume the next pick. */
  readonly override: OverrideKind | null;
}

export type ArmOutcome =
  | { readonly ok: true; readonly prompt: string; readonly keywords: readonly string[] }
  /** Refused, with the reason `availability()` gave — dimmed-with-a-reason, at the session level. */
  | { readonly ok: false; readonly reason: string };

export type StepOutcome =
  /** Still collecting. `prompt` is what the command line should show. */
  | { readonly kind: "collecting"; readonly prompt: string; readonly keywords: readonly string[] }
  /** Committed. The invocation went to the registry; `result` is what it returned. */
  | { readonly kind: "committed"; readonly invocation: CommandInvocation; readonly result: Result<unknown> }
  /** Refused before dispatch — a placement that cannot be valid. Never reaches the kernel. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "cancelled" }
  /** Nothing was armed, so the input was not ours. The host may do something else with it. */
  | { readonly kind: "idle" };

export interface SessionDeps {
  readonly registry: Registry;
  /** The command context, read fresh per call — capabilities and selection change under us. */
  context(): CommandContext;
  /**
   * Snap candidates near the cursor.
   *
   * A callback rather than a list, because the host owns the model and the set is view-dependent. It is also
   * the reason this package has no dependency on `viewport` or on any mesh format.
   */
  candidates(cursor: Vec2): readonly SnapCandidate[];
  /** The element under the cursor, for `pick-element` arguments. */
  elementAt?(cursor: Vec2): string | null;
  /** Model bounds, for placement validation before the kernel round-trip. */
  bounds?(): PlanBounds | null;
  readonly snap?: SnapSettings;
}

export interface SessionState {
  readonly armed: string | null;
  readonly prompt: string;
  readonly keywords: readonly string[];
  /** Points collected so far, for the rubber-band preview. */
  readonly points: readonly Vec2[];
  readonly status: "idle" | "collecting" | "ready";
  readonly override: OverrideKind | null;
  readonly snap: SnapSettings;
}

export interface AuthoringSession {
  arm(commandId: string): ArmOutcome;
  disarm(): void;
  /** Cursor moved. Pure — no state is mutated, so calling it per frame is safe. */
  hover(cursor: Vec2, modifiers?: Modifiers): HoverFeedback;
  /** Click. Resolves through the same path as {@link hover}. */
  pick(cursor: Vec2, modifiers?: Modifiers): Promise<StepOutcome>;
  /** A keystroke. Routes override codes, dynamic input, keywords and control keys. */
  key(key: string, modifiers?: Modifiers): Promise<StepOutcome>;
  /** A whole token typed at the command line, or a full `WALL 0,0 @5<0` line. */
  type(text: string): Promise<StepOutcome>;
  setSnap(patch: Partial<SnapSettings>): void;
  readonly state: SessionState;
}

/** The reference point a constraint is measured from: the last collected point. */
function lastPoint(points: readonly Vec2[]): Vec2 | null {
  return points.length === 0 ? null : points[points.length - 1]!;
}

export function createSession(deps: SessionDeps): AuthoringSession {
  let snap: SnapSettings = deps.snap ?? DEFAULT_SNAP;
  let descriptor: AnyCommandDescriptor | null = null;
  let prompt: PromptState<object> | null = null;
  let points: Vec2[] = [];
  /**
   * One-shot snap override.
   *
   * From `geometry-math`, not reimplemented — and it has to be a handle rather than a field because "armed for
   * exactly the next pick, then cleared" is the whole semantic, and that is easy to get wrong by leaving it set.
   */
  const override: SnapOverrideHandle = createSnapOverride();
  /** Typed dynamic-input constraint, pending until the next pick or Enter. */
  let dyn: DynConstraint | null = null;
  /**
   * How the armed tool was armed.
   *
   * Carried so the invocation records where it came from, which is what makes the audit log worth having.
   * There is no `via: "prompt"` in `CommandOrigin` and inventing one would have been wrong: the prompt loop
   * is a *mechanism*, not an origin. The same loop is driven from the ribbon and from the command line, and
   * those are the two things an auditor needs told apart.
   */
  let origin: CommandOrigin = { via: "ui", surface: "ribbon" };

  function stateNow(): SessionState {
    return {
      armed: descriptor?.id ?? null,
      prompt: prompt?.prompt ?? "",
      keywords: prompt?.keywords ?? [],
      points: [...points],
      status: prompt === null ? "idle" : prompt.status === "cancelled" ? "idle" : prompt.status,
      override: override.peek(),
      snap,
    };
  }

  /**
   * Cursor → the point that would be committed.
   *
   * **The single resolution path.** `hover` and `pick` both call this, which is what makes "what you see is
   * what you get" structural rather than a thing to remember. It is also pure: no state is mutated, so a host
   * may call it per animation frame without the override being consumed or the dyn constraint being cleared.
   *
   * Order is not arbitrary. Each step narrows the previous one, and swapping any two changes the result:
   *
   *   1. **A typed constraint wins outright.** Someone who typed `5 <Tab> 90` has stated exactly what they
   *      want, and letting a nearby endpoint override that would make typed entry unreliable — which defeats
   *      the point of having it.
   *   2. **An armed override wins over ordinary snapping**, because it is a one-shot instruction: "this pick,
   *      take a perpendicular."
   *   3. **Ortho beats polar.** Ortho is the stronger, more explicit constraint.
   *   4. **Snapping is applied last** and only within tolerance, so it refines a constrained direction rather
   *      than fighting it.
   */
  function resolve(cursor: Vec2, modifiers: Modifiers = {}): HoverFeedback {
    const from = lastPoint(points);
    const armedOverride = override.peek();

    // 1. A typed constraint is an instruction, not a hint.
    if (dyn !== null && from !== null) {
      const at = applyDynamicInput(from, cursor, dyn);
      return {
        at,
        snap: null,
        inference: null,
        angle: dyn.angle ?? null,
        distance: Math.hypot(at.x - from.x, at.z - from.z),
        override: armedOverride,
      };
    }

    let at: Vec2 = cursor;
    let angle: number | null = null;
    let inference: Inference | null = null;

    // 2. A one-shot override either restricts snapping to one kind, or turns it off for this pick.
    const effect: OverrideEffect | null = armedOverride === null ? null : overrideEffect(armedOverride);
    const onlyKind: SnapKind | null = effect !== null && effect.mode === "only" ? effect.kind : null;

    // 3. Direction constraints, relative to the previous point.
    if (from !== null) {
      // Holding Shift forces ortho for this move, which is the universal CAD convention and the reason it is
      // read here rather than baked into the settings.
      const wantOrtho = snap.ortho || modifiers.shift === true;
      if (wantOrtho) {
        const locked = polarConstrain(from, cursor, 90, 45);
        at = { x: locked.x, z: locked.z };
        angle = locked.angle;
      } else if (snap.polar) {
        const locked = polarConstrain(from, cursor, snap.polarIncrement, 4);
        if (locked.locked) {
          at = { x: locked.x, z: locked.z };
          angle = locked.angle;
        }
      }

      // Inference is reported but does not move the point unless it locked — it is guidance, and a guide that
      // silently relocates the cursor is indistinguishable from a bug.
      if (snap.inference && angle === null) {
        inference = inferDirection(from, at) ?? null;
      }
    }

    // 4. Snapping refines, within tolerance.
    let snapped: SnapResult | null = null;
    // `NO` means the raw cursor, so it beats both the settings and any other consideration.
    const suppressed = effect !== null && effect.mode === "off";
    if (!suppressed && (snap.enabled || armedOverride !== null)) {
      const candidates = [...deps.candidates(at)];
      if (snap.grid !== null) candidates.push(gridCandidate(at, snap.grid));
      snapped = resolveSnap(at, candidates, snap.tolerance, onlyKind);
      if (snapped !== null) at = { x: snapped.x, z: snapped.z };
    }

    return {
      at,
      snap: snapped,
      inference,
      angle,
      distance: from === null ? null : Math.hypot(at.x - from.x, at.z - from.z),
      override: armedOverride,
    };
  }

  /** Feed an event to the reducer, and commit if it turned ready. */
  async function advance(event: PromptEvent): Promise<StepOutcome> {
    if (descriptor === null || prompt === null) return { kind: "idle" };

    const ctx = deps.context();
    prompt = step(descriptor, prompt, event, ctx);

    if (prompt.status === "cancelled") {
      reset();
      return { kind: "cancelled" };
    }
    if (prompt.status !== "ready") {
      return { kind: "collecting", prompt: prompt.prompt, keywords: prompt.keywords };
    }

    // Validate before the round trip. `placeValid` exists so a wall of 3 mm, or one outside the site, is
    // refused with a sentence rather than accepted, sent to the kernel, and rejected by a message written for
    // a different audience.
    const verdict = validate();
    if (verdict !== null) {
      // Deliberately NOT cancelled: the tool stays armed with its points intact, so the user corrects the last
      // click rather than starting over. Discarding collected work on a refusal is the behaviour that makes
      // people stop trusting a draw tool.
      return { kind: "refused", reason: verdict };
    }

    const invocation = toInvocation(prompt, origin, deps.registry.nextSeq(), deps.registry.now());
    const result = await deps.registry.dispatch(invocation, ctx);
    reset();
    return { kind: "committed", invocation, result };
  }

  function validate(): string | null {
    if (points.length === 0) return null;
    const bounds = deps.bounds?.() ?? null;
    const kind = points.length === 1 ? "point" : points.length === 2 ? "run" : "poly";
    const verdict = validatePlacement(
      kind,
      points.map((p) => [p.x, p.z] as [number, number]),
      bounds,
    );
    return verdict.ok ? null : verdict.reason;
  }

  function reset(): void {
    descriptor = null;
    // Restored, not left as-is: a tool armed from the ribbon after one armed from the command line would
    // otherwise be recorded as having come from the command line, and a wrong audit entry is worse than none.
    origin = { via: "ui", surface: "ribbon" };
    prompt = null;
    points = [];
    dyn = null;
    override.clear();
  }

  /**
   * Arm a tool.
   *
   * A named local rather than only a method, because `routeTyped` arms from the command line too — and reaching
   * it through `this` from a hoisted function does not work: `this` is not the session there. A shared local is
   * the fix; the alternative is two arming paths that drift.
   */
  function armTool(commandId: string, from: CommandOrigin = { via: "ui", surface: "ribbon" }): ArmOutcome {
    const found = deps.registry.get(commandId);
    if (found === undefined) return { ok: false, reason: `no command "${commandId}"` };

    // The same `availability()` the ribbon dims with, so the ribbon and the session cannot disagree about
    // whether a tool is usable — and the *reason* is the same sentence in both places.
    const state = deps.registry.availabilityOf(commandId, deps.context());
    if (state.state !== "enabled") return { ok: false, reason: state.reason };

    reset();
    descriptor = found;
    origin = from;
    prompt = begin(found, deps.context());
    return { ok: true, prompt: prompt.prompt, keywords: prompt.keywords };
  }

  return {
    arm: armTool,

    disarm() {
      reset();
    },

    hover(cursor, modifiers) {
      return resolve(cursor, modifiers);
    },

    async pick(cursor, modifiers) {
      if (descriptor === null || prompt === null) return { kind: "idle" };

      // An element argument takes the element, not a coordinate. Checking the awaited argument's kind rather
      // than guessing from what is under the cursor keeps "click a wall" and "click a point" distinguishable
      // even when a wall happens to be under the point.
      if (prompt.awaiting?.kind === "element") {
        const guid = deps.elementAt?.(cursor) ?? null;
        if (guid === null) return { kind: "collecting", prompt: prompt.prompt, keywords: prompt.keywords };
        return await advance({ t: "pick-element", guid });
      }

      const resolved = resolve(cursor, modifiers);
      points.push(resolved.at);
      // `consume()`, not `clear()`. The handle's own contract says why: a one-shot is spent by the pick that
      // reads it *whether or not that pick found anything of the kind*, because otherwise a failed override
      // silently applies to the next click too. `clear()` happens to do the same thing here, but `consume()` is
      // the method that means it — and the package had already worked this out before I hand-rolled it.
      override.consume();
      dyn = null;

      return await advance({
        t: "pick-point",
        at: [resolved.at.x, resolved.at.z],
        snap: resolved.snap?.kind,
      });
    },

    async key(key, modifiers) {
      if (key === "Escape") {
        if (descriptor === null) return { kind: "idle" };
        return await advance({ t: "cancel" });
      }
      if (descriptor === null) return { kind: "idle" };

      if (key === "Enter") {
        // A pending typed constraint commits as a point rather than as an accept — otherwise typing `5 <Enter>`
        // at a "specify next point" prompt would end the command instead of placing the point it describes.
        if (dyn !== null) {
          const from = lastPoint(points);
          if (from !== null) {
            const at = applyDynamicInput(from, from, dyn);
            points.push(at);
            dyn = null;
            return await advance({ t: "pick-point", at: [at.x, at.z] });
          }
        }
        return await advance({ t: "accept" });
      }

      if (key === "Backspace") {
        // Per-stroke undo, distinct from document undo. Backspace revises the point being collected; Ctrl+Z
        // undoes a committed command. Conflating them means Backspace during a draw would undo the *previous
        // wall*, which is a data-loss bug disguised as a keystroke.
        points.pop();
        return await advance({ t: "back" });
      }

      return await routeTyped(key, modifiers);
    },

    async type(text) {
      const trimmed = text.trim();
      if (trimmed === "") return descriptor === null ? { kind: "idle" } : await advance({ t: "accept" });
      return await routeTyped(trimmed);
    },

    setSnap(patch) {
      snap = { ...snap, ...patch };
    },

    get state() {
      return stateNow();
    },
  };

  /**
   * Route a typed string to the one thing it means.
   *
   * The ordering here is a correctness requirement, not a preference. `geometry-math` asserts that the snap
   * override codes and the two-letter draw-tool codes are **disjoint**, precisely because both are typed into
   * the same buffer — and its comment says why: an overlap "silently arms the wrong tool". Since they cannot
   * collide, the order below is safe; the assertion in that package is what keeps it safe.
   */
  async function routeTyped(text: string, _modifiers: Modifiers = {}): Promise<StepOutcome> {
    const upper = text.toUpperCase();

    // A snap override, e.g. `PER` for perpendicular. One shot, consumed by the next pick.
    // `arm` takes the two-letter CODE, not the kind — and passing the kind fails *silently*, because `arm`
    // looks the string up in `OVERRIDE_CODES` and returns null for a miss. Three tests caught it; nothing at
    // the type level could, since both are strings.
    const armedKind = override.arm(upper);
    if (armedKind !== null) {
      const kind = armedKind;
      return descriptor === null
        ? { kind: "idle" }
        : { kind: "collecting", prompt: `${OVERRIDE_LABEL[kind]} — pick a point`, keywords: prompt?.keywords ?? [] };
    }

    // A dynamic-input constraint: `5`, `5<90`, `12'6`.
    if (isDynKey(text) || /^[\d'"@<.\-+ ]+$/.test(text)) {
      const parsed = parseDynConstraint(text);
      if (parsed !== null) {
        dyn = parsed;
        if (descriptor === null) return { kind: "idle" };
        return { kind: "collecting", prompt: prompt?.prompt ?? "", keywords: prompt?.keywords ?? [] };
      }
    }

    if (descriptor === null) {
      // Nothing armed: the text may be a verb. Arming from the command line is what makes the CAD command line
      // a command line rather than a second, weaker palette.
      const byVerb = deps.registry.byVerb(text);
      if (byVerb === undefined) return { kind: "idle" };
      const armed = armTool(byVerb.id, { via: "command-line", line: text });
      return armed.ok
        ? { kind: "collecting", prompt: armed.prompt, keywords: armed.keywords }
        : { kind: "refused", reason: armed.reason };
    }

    // A bracketed keyword offered by the prompt.
    if (prompt !== null && prompt.keywords.some((k) => k.toUpperCase() === upper)) {
      return await advance({ t: "keyword", key: upper });
    }

    return await advance({ t: "token", text });
  }
}

/**
 * What an armed override does to snapping.
 *
 * Three outcomes, not two, and collapsing them is a real bug I wrote first time round. `OVERRIDE_CODES` includes
 * `NO` → `"none"`, whose documented meaning is *"suppress every snap for one pick — the raw cursor, untouched"*.
 * A function returning `SnapKind | null` cannot express that: `null` already means "restrict to nothing in
 * particular", i.e. snap normally. So `none` mapped to `null` would have turned "give me the exact cursor" into
 * "snap however you like" — the precise opposite of what the user asked for, silently.
 *
 * `"intersection"` was also in my first version's switch and is not an `OverrideKind` at all; the compiler caught
 * that one.
 */
type OverrideEffect =
  /** Restrict snapping to this one kind. */
  | { readonly mode: "only"; readonly kind: SnapKind }
  /** Suppress snapping entirely for this pick. */
  | { readonly mode: "off" };

function overrideEffect(kind: OverrideKind): OverrideEffect {
  switch (kind) {
    case "none":
      return { mode: "off" };
    case "endpoint":
      return { mode: "only", kind: "endpoint" };
    case "midpoint":
      return { mode: "only", kind: "midpoint" };
    case "center":
      return { mode: "only", kind: "center" };
    case "perpendicular":
      return { mode: "only", kind: "perpendicular" };
    case "nearest":
      return { mode: "only", kind: "nearest" };
  }
}

/** The nearest grid intersection, as a candidate so it competes with real geometry rather than pre-empting it. */
function gridCandidate(cursor: Vec2, pitch: number): SnapCandidate {
  return {
    x: Math.round(cursor.x / pitch) * pitch,
    z: Math.round(cursor.z / pitch) * pitch,
    kind: "grid",
  };
}

/** Re-exported so a host can offer the override codes without importing `geometry-math` directly. */
export { ALL_OVERRIDE_KINDS, KEY_SHORTCUT_MAP, OVERRIDE_CODES, OVERRIDE_LABEL };
