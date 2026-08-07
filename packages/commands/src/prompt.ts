import { err, ok, type Result } from "@massingviewer/core";
import {
  assertSerializable,
  type ArgSpec,
  type CommandContext,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandOrigin,
} from "./descriptor";

/**
 * The prompt loop, as a **pure reducer**.
 *
 * ## Why this shape
 *
 * An interactive CAD command is normally built as a tangle of viewport event handlers holding mutable
 * state — a `pendingPoints` array here, an `armedTool` flag there, a `waitingFor` string somewhere else. It
 * works, and it is untestable without a renderer, so in practice it is never tested and every fix risks a
 * regression nobody can see.
 *
 * Keeping it pure has one consequence that pays for everything else: **the whole interactive CAD flow is
 * unit-testable with nothing mocked.** No DOM, no viewport, no kernel, no clock. `step()` takes a state and
 * an event and returns a state.
 *
 * It is also what makes the claim in `descriptor.ts` true. A prompt loop is not an exception to "every action
 * is one serializable invocation" — it is a reducer that accumulates arguments and, at exactly one point
 * (`toInvocation`), crosses from interactivity into serializability.
 *
 * ## Where snapping happens
 *
 * **Before** the event reaches the reducer. `resolveSnap` / `polarConstrain` / `applyDynamicInput` produce the
 * `at` carried by a `pick-point`. Two reasons: snapping must be frame-immediate (a reducer round-trip per
 * mouse-move would be visible), and the reducer stays deterministic — the same event sequence always yields
 * the same state, which is what makes a recorded macro a reliable regression test.
 */

export type PromptEvent =
  /** Typed on the command line. */
  | { readonly t: "token"; readonly text: string }
  /** A bracketed keyword, clicked or typed. */
  | { readonly t: "keyword"; readonly key: string }
  /** A point picked in the viewport — already snapped and constrained. */
  | { readonly t: "pick-point"; readonly at: readonly [number, number]; readonly snap?: string }
  | { readonly t: "pick-element"; readonly guid: string }
  /** Committed from the dynamic-input HUD. */
  | { readonly t: "dyn"; readonly distance?: number; readonly angle?: number }
  /** Enter / double-click. Completes a variadic argument, or the command. */
  | { readonly t: "accept" }
  /** Backspace — undo one collected argument. */
  | { readonly t: "back" }
  | { readonly t: "cancel" };

export type PromptStatus = "collecting" | "ready" | "cancelled";

export interface PromptState<A extends object = object> {
  readonly commandId: string;
  readonly collected: Partial<A>;
  /** Index into `descriptor.args`. */
  readonly cursor: number;
  readonly awaiting: ArgSpec | null;
  /** Rendered prompt: "Specify next point or [Close/Undo]". */
  readonly prompt: string;
  readonly keywords: readonly string[];
  readonly status: PromptStatus;
  /**
   * Last parse failure — shown inline, and **non-fatal**.
   *
   * A mistyped coordinate must not cancel the command. Nothing is more annoying than losing three placed
   * points to one typo, and a tool that disarms on bad input trains users to type nothing.
   */
  readonly error?: string;
  /** Points accumulated for a `point-list` argument. */
  readonly points: readonly (readonly [number, number])[];
}

const KINDS_WANTING_POINTS = new Set(["point", "point-list"]);

function renderPrompt(spec: ArgSpec | null, points: readonly unknown[]): string {
  if (!spec) return "";
  const keywords = spec.keywords?.length
    ? ` or [${spec.keywords.map((k) => k.label).join("/")}]`
    : "";
  // A variadic argument's prompt changes once enough points exist to finish, so the user knows Enter is now
  // meaningful. Without it there is no cue that the command is completable.
  const suffix = spec.kind === "point-list" && points.length >= 2 ? " (Enter to finish)" : "";
  return `${spec.prompt}${keywords}${suffix}`;
}

/** Begin collecting arguments for a command. */
export function begin<A extends object>(d: CommandDescriptor<A>, ctx: CommandContext): PromptState<A> {
  const first = d.args[0] ?? null;
  const collected: Partial<A> = {};

  // Defaults are applied up front so a command with all-optional arguments is immediately `ready` — a
  // zero-argument command must not require an Enter it never prompted for.
  for (const spec of d.args) {
    if (spec.default !== undefined) {
      const value = typeof spec.default === "function"
        ? (spec.default as (c: CommandContext) => unknown)(ctx)
        : spec.default;
      (collected as Record<string, unknown>)[spec.name] = value;
    }
  }

  const state: PromptState<A> = {
    commandId: d.id,
    collected,
    cursor: 0,
    awaiting: first,
    prompt: renderPrompt(first, []),
    keywords: first?.keywords?.map((k) => k.key) ?? [],
    status: first ? "collecting" : "ready",
    points: [],
  };
  return maybeAdvance(d, state, ctx);
}

/** Move past any argument already satisfied (by a default, or by context). */
function maybeAdvance<A extends object>(
  d: CommandDescriptor<A>,
  s: PromptState<A>,
  ctx: CommandContext,
): PromptState<A> {
  let cursor = s.cursor;
  const collected = s.collected as Record<string, unknown>;
  while (cursor < d.args.length) {
    const spec = d.args[cursor]!;
    const satisfied = collected[spec.name] !== undefined;
    // An optional argument is only skipped when it has a value; otherwise the user still gets asked, and can
    // press Enter to accept the default.
    if (!satisfied) break;
    if (spec.kind === "point-list") break; // variadic — always collected explicitly
    cursor++;
  }
  if (cursor >= d.args.length) {
    return { ...s, cursor, awaiting: null, prompt: "", keywords: [], status: "ready" };
  }
  const spec = d.args[cursor]!;
  void ctx;
  return {
    ...s,
    cursor,
    awaiting: spec,
    prompt: renderPrompt(spec, s.points),
    keywords: spec.keywords?.map((k) => k.key) ?? [],
    status: "collecting",
  };
}

function withValue<A extends object>(
  d: CommandDescriptor<A>,
  s: PromptState<A>,
  ctx: CommandContext,
  name: string,
  value: unknown,
): PromptState<A> {
  const collected = { ...(s.collected as Record<string, unknown>), [name]: value };
  const next: PromptState<A> = {
    ...s,
    collected: collected as Partial<A>,
    cursor: s.cursor + 1,
    error: undefined,
  };
  return maybeAdvance(d, next, ctx);
}

/**
 * Advance the loop by one event. Pure.
 *
 * `cancelled` and `ready` are terminal — further events are ignored rather than throwing, because a stray
 * event after completion is normal (a pointer-up arriving after the click that finished the command) and
 * should not be an error.
 */
export function step<A extends object>(
  d: CommandDescriptor<A>,
  s: PromptState<A>,
  e: PromptEvent,
  ctx: CommandContext,
): PromptState<A> {
  // `cancelled` is genuinely terminal.
  if (s.status === "cancelled") return s;

  // `ready` is NOT terminal, and getting this wrong is a real usability bug — the first version of this guard
  // allowed only `accept` on a ready state, which meant a command with every argument collected but not yet
  // committed could be neither revised nor abandoned.
  //
  // Three events must still work:
  //   accept — commit, or finish a variadic argument
  //   back   — step back and revise the last argument, which is standard CAD behaviour
  //   cancel — Escape out of a ready-but-uncommitted command
  //
  // Anything else (a stray pointer-up arriving after the click that completed the command) is ignored rather
  // than treated as an error, because it is normal.
  if (s.status === "ready" && e.t !== "accept" && e.t !== "back" && e.t !== "cancel") {
    return s;
  }

  switch (e.t) {
    case "cancel":
      return { ...s, status: "cancelled", awaiting: null, prompt: "", keywords: [] };

    case "back": {
      // Remove the most recent thing collected. For a point list that is the last point; otherwise it is the
      // previous argument. Backspace must undo one *step*, not the whole command.
      if (s.points.length > 0 && s.awaiting?.kind === "point-list") {
        const points = s.points.slice(0, -1);
        return { ...s, points, prompt: renderPrompt(s.awaiting, points), error: undefined };
      }
      if (s.cursor === 0) return { ...s, error: undefined };
      const prevSpec = d.args[s.cursor - 1]!;
      const collected = { ...(s.collected as Record<string, unknown>) };
      delete collected[prevSpec.name];
      return {
        ...s,
        collected: collected as Partial<A>,
        cursor: s.cursor - 1,
        awaiting: prevSpec,
        prompt: renderPrompt(prevSpec, s.points),
        keywords: prevSpec.keywords?.map((k) => k.key) ?? [],
        status: "collecting",
        error: undefined,
      };
    }

    case "keyword": {
      const match = s.awaiting?.keywords?.find(
        (k) => k.key.toUpperCase() === e.key.toUpperCase(),
      );
      if (!match) return { ...s, error: `Unknown option '${e.key}'` };
      // A keyword is recorded under the argument it belongs to. `Close` on a polyline is genuinely the value
      // of that step, not a side channel.
      return withValue(d, s, ctx, s.awaiting!.name, match.key);
    }

    case "pick-point": {
      const spec = s.awaiting;
      if (!spec || !KINDS_WANTING_POINTS.has(spec.kind)) {
        return { ...s, error: "Not expecting a point here" };
      }
      if (spec.kind === "point") return withValue(d, s, ctx, spec.name, e.at);
      const points = [...s.points, e.at];
      return { ...s, points, prompt: renderPrompt(spec, points), error: undefined };
    }

    case "pick-element": {
      const spec = s.awaiting;
      if (!spec) return s;
      if (spec.kind === "element") return withValue(d, s, ctx, spec.name, e.guid);
      if (spec.kind === "element-list") {
        const existing = ((s.collected as Record<string, unknown>)[spec.name] as string[]) ?? [];
        // De-duplicated: clicking the same element twice is a slip, not a request for two of it.
        const list = existing.includes(e.guid) ? existing : [...existing, e.guid];
        return { ...s, collected: { ...s.collected, [spec.name]: list } as Partial<A>, error: undefined };
      }
      return { ...s, error: "Not expecting an element here" };
    }

    case "dyn": {
      const spec = s.awaiting;
      if (!spec) return s;
      if (spec.kind === "length" && e.distance !== undefined) {
        return withValue(d, s, ctx, spec.name, e.distance);
      }
      if (spec.kind === "angle" && e.angle !== undefined) {
        return withValue(d, s, ctx, spec.name, e.angle);
      }
      return { ...s, error: "Dynamic input does not apply to this step" };
    }

    case "token": {
      const spec = s.awaiting;
      if (!spec) return s;
      const text = e.text.trim();
      if (text === "") return s;

      // A keyword may be typed instead of clicked, which is how a keyboard-only user reaches it.
      const kw = spec.keywords?.find(
        (k) => k.key.toUpperCase() === text.toUpperCase() || k.label.toUpperCase() === text.toUpperCase(),
      );
      if (kw) return withValue(d, s, ctx, spec.name, kw.key);

      const parsed = spec.parse
        ? spec.parse(text, ctx)
        : defaultParse(spec, text);
      if (!parsed.ok) {
        // Non-fatal, and it keeps everything already collected. Losing three placed points to one typo is the
        // behaviour this branch exists to avoid.
        return { ...s, error: parsed.error.message };
      }
      const validated = spec.validate ? spec.validate(parsed.value, ctx) : ok(parsed.value);
      if (!validated.ok) return { ...s, error: validated.error.message };

      if (spec.kind === "point-list") {
        const points = [...s.points, validated.value as readonly [number, number]];
        return { ...s, points, prompt: renderPrompt(spec, points), error: undefined };
      }
      return withValue(d, s, ctx, spec.name, validated.value);
    }

    case "accept": {
      const spec = s.awaiting;
      if (!spec) return { ...s, status: "ready" };

      if (spec.kind === "point-list") {
        // Enter finishes a variadic argument — but only when there is enough to be meaningful. Accepting one
        // point as a polyline would author a degenerate element the kernel then has to refuse.
        if (s.points.length < 2) {
          return { ...s, error: `Need at least 2 points (have ${s.points.length})` };
        }
        return withValue(d, s, ctx, spec.name, s.points);
      }

      // Enter on a step with a default accepts it. Enter on a required step with no default is a no-op with
      // the prompt restated, not an error — the user pressed Enter because they were not sure.
      const current = (s.collected as Record<string, unknown>)[spec.name];
      if (current !== undefined) return withValue(d, s, ctx, spec.name, current);
      if (spec.optional) return withValue(d, s, ctx, spec.name, undefined);
      return { ...s, error: `${spec.prompt} is required` };
    }

    default: {
      // Exhaustiveness: adding a PromptEvent variant without handling it is a compile error rather than a
      // silently ignored input.
      const never: never = e;
      void never;
      return s;
    }
  }
}

/** Parsing for argument kinds that do not supply their own. */
function defaultParse(spec: ArgSpec, text: string): Result<unknown> {
  switch (spec.kind) {
    case "number":
    case "length":
    case "angle": {
      const n = Number(text);
      if (!Number.isFinite(n)) return err({ code: "invalid_param", message: `'${text}' is not a number` });
      if (spec.kind === "length" && n <= 0) {
        return err({ code: "invalid_param", message: `a length must be greater than 0 (got ${n})` });
      }
      return ok(n);
    }
    case "integer": {
      const n = Number(text);
      if (!Number.isInteger(n)) return err({ code: "invalid_param", message: `'${text}' is not a whole number` });
      return ok(n);
    }
    case "boolean": {
      const t = text.toLowerCase();
      if (["y", "yes", "true", "on", "1"].includes(t)) return ok(true);
      if (["n", "no", "false", "off", "0"].includes(t)) return ok(false);
      return err({ code: "invalid_param", message: `'${text}' is not yes or no` });
    }
    case "enum": {
      const match = spec.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      if (!match) {
        return err({
          code: "invalid_param",
          message: `'${text}' is not one of ${spec.options?.join(", ") ?? "(no options declared)"}`,
        });
      }
      return ok(match);
    }
    case "point": {
      // `x,y` only. Relative and polar forms come from `parseCadCommand` via `ArgSpec.parse`, so there is one
      // implementation of that grammar rather than a simplified copy here that drifts from it.
      const parts = text.split(",").map((p) => Number(p.trim()));
      if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
        return err({ code: "invalid_param", message: `'${text}' is not an x,y point` });
      }
      return ok([parts[0]!, parts[1]!] as const);
    }
    case "text":
      return ok(text);
    default:
      return err({
        code: "invalid_param",
        message: `'${spec.kind}' arguments cannot be typed; pick one instead`,
      });
  }
}

/**
 * The single exit from interactivity into serializability.
 *
 * Throws if called on a state that is not `ready`, because producing an invocation from a half-collected
 * state would put a partial argument bag into the undo history and the audit log — and the failure would
 * surface later, somewhere else, as a command that cannot be replayed.
 */
export function toInvocation<A extends object>(
  s: PromptState<A>,
  origin: CommandOrigin,
  seq: number,
  now: string,
): CommandInvocation<A> {
  if (s.status !== "ready") {
    throw new Error(
      `toInvocation called on a '${s.status}' prompt for ${s.commandId}; only 'ready' may be committed`,
    );
  }
  const args = s.collected as A;
  assertSerializable(args);
  return { commandId: s.commandId, args, origin, seq, at: now };
}
