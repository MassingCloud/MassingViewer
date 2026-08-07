import type { Result } from "@massingviewer/core";
import type { OpId } from "@massingviewer/kernel-api";

/**
 * The command bus's vocabulary.
 *
 * ## The claim, stated precisely
 *
 * Every user action produces exactly **one serializable `CommandInvocation`**. Clicking a ribbon button,
 * typing `WALL 0,0 @5<0`, replaying a macro, and a plugin calling the API all produce the same thing.
 *
 * Interactive multi-step commands — AutoCAD's *"specify next point"* loop — are **not an exception**. A prompt
 * loop is a pure reducer that accumulates arguments and, on completion, emits one invocation. That single
 * property is what makes seven features one mechanism:
 *
 * | Feature | How it falls out |
 * |---|---|
 * | Undo / redo | A serializable inverse invocation, or a kernel transaction rollback |
 * | Command palette | Filter the registry by `availability()` |
 * | AutoCAD command line | The verb index feeds the same prompt loop |
 * | Keybinding remap | `defaultKeys` are defaults; overrides are data, so nothing is hardcoded |
 * | Macro record / replay | Tee the dispatch stream. The recording is also a regression test |
 * | Plugin API | A plugin contributes descriptors and dispatches invocations |
 * | Audit log | The bus is the single choke point, so the log is complete *by construction* |
 *
 * Multi-user sync is the eighth, later: the invocation stream already *is* an operation log, which is why
 * `origin` and `seq` are on the type from the start rather than retrofitted.
 */

// ---------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------

export type ArgKind =
  /** Pickable in the viewport, a plan, or a sheet. */
  | "point"
  | "point-list"
  | "length"
  | "angle"
  | "number"
  | "integer"
  | "text"
  | "boolean"
  | "enum"
  /** An element, by GlobalId. Pickable. */
  | "element"
  | "element-list"
  | "file"
  | "asset";

export interface ArgSpec<T = unknown> {
  readonly name: string;
  readonly kind: ArgKind;
  /**
   * What the command line asks. "Specify start point" — no trailing colon; the renderer adds it.
   *
   * Required, because a prompt loop with an unlabelled step leaves the user staring at a cursor with no
   * idea what the tool wants. There is no sensible default here.
   */
  readonly prompt: string;
  readonly optional?: boolean;
  readonly default?: T | ((ctx: CommandContext) => T);
  /** For `kind: "enum"`. */
  readonly options?: readonly string[];
  readonly unit?: "m" | "deg";
  /**
   * Parse a typed token.
   *
   * Reuses the existing pure parsers rather than inventing a second grammar: `parseCadCommand`'s point
   * syntax (`x,y`, `@dx,dy`, `d<a`) and `parseLength` for imperial (`12'6`). One parser means a coordinate
   * typed at a prompt and one typed on a full command line cannot diverge.
   */
  readonly parse?: (token: string, ctx: CommandContext) => Result<T>;
  readonly validate?: (value: T, ctx: CommandContext) => Result<T>;
  /** Bracketed keywords offered alongside the prompt: "or [Close/Undo]". */
  readonly keywords?: readonly { readonly key: string; readonly label: string }[];
}

// ---------------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------------

export type CapabilityGate = "view" | "review" | "edit" | "admin";

/**
 * Whether a command can run, and if not, **why**.
 *
 * `reason` is required on `dimmed`. That is the type system enforcing this project's house rule:
 *
 * > A dimmed button that says "needs Editor" is onboarding. A missing one is a support ticket.
 *
 * Inherited from massing, where hiding contextual tools under a hard cap *shipped a real bug* — promoting one
 * tool silently demoted another, and the person who noticed was a user who needed the demoted one. Making
 * "dimmed with no stated reason" unrepresentable is the cheapest possible fix.
 */
export type Availability =
  | { readonly state: "enabled" }
  | {
      readonly state: "dimmed";
      readonly reason: string;
      readonly kind: "capability" | "kernel" | "context" | "offline" | "license";
    };

// ---------------------------------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------------------------------

export interface CommandDescriptor<A extends object = object, R = unknown> {
  /** Namespaced: `mv.draft.wall`. A plugin uses its own prefix. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;

  /** AutoCAD command-line verb, upper case. */
  readonly verb?: string;
  /** Single- and double-letter aliases: `["W"]`. Importable from an AutoCAD `.pgp`. */
  readonly aliases?: readonly string[];

  /** Ribbon and palette bucket. */
  readonly group: string;
  readonly icon?: string;

  /** Capability required. Unmet → dimmed **with a reason**, never hidden. */
  readonly cap?: CapabilityGate;
  /** Kernel operation needed. Unavailable → dimmed with the kernel's own hint as the tooltip. */
  readonly requiresOp?: OpId;
  /** Extra context requirement, e.g. "needs a selection". Returning a string dims with it as the reason. */
  readonly requires?: (ctx: CommandContext) => string | null;

  readonly args: readonly ArgSpec[];
  readonly defaultKeys?: readonly string[];
  /** Re-arms on Space/Enter after completing — the drafter's muscle memory. */
  readonly repeatable?: boolean;

  readonly run: (args: A, ctx: CommandContext) => Promise<Result<R>>;

  /**
   * The inverse, expressed as **another invocation** rather than a closure.
   *
   * That is what makes history persistable and replayable: a closure cannot be written to an audit log,
   * survive a reload, or cross a worker boundary. Returning `undefined` means "not invertible", and the Undo
   * control dims with that stated rather than failing after the user commits.
   */
  readonly invert?: (args: A, result: R) => CommandInvocation | undefined;

  /** True → wrap in a kernel transaction; undo becomes rollback rather than an inverse. */
  readonly transactional?: boolean;

  /** Live feedback while the prompt loop is mid-flight. Must never mutate the document. */
  readonly preview?: (partial: Partial<A>, ctx: CommandContext) => Disposable;
}

// ---------------------------------------------------------------------------------------------------
// Invocations
// ---------------------------------------------------------------------------------------------------

/**
 * Where a command came from.
 *
 * Recorded because it is load-bearing in four places, not for telemetry curiosity: macro replay must be
 * distinguishable from a user action (so it does not re-record), a remote peer's operation must be
 * distinguishable from a local one (so it does not echo), the audit log needs it, and "repeat last command"
 * needs to know whether the last thing was a real action.
 */
export type CommandOrigin =
  | { readonly via: "ui"; readonly surface: "ribbon" | "palette" | "context-menu" | "gizmo" | "panel" | "library" }
  | { readonly via: "command-line"; readonly line: string }
  | { readonly via: "keybinding"; readonly combo: string }
  | { readonly via: "macro"; readonly macroId: string; readonly index: number }
  | { readonly via: "plugin"; readonly pluginId: string }
  | { readonly via: "remote"; readonly peerId: string }
  | { readonly via: "replay"; readonly sourceSeq: number };

export interface CommandInvocation<A extends object = object> {
  readonly commandId: string;
  /**
   * ALWAYS JSON-serialisable.
   *
   * Enforced by a runtime assertion in `assertSerializable`, because this is the property everything else
   * depends on and it is easy to break by accident — putting a `THREE.Vector3`, a DOM node, or a closure in
   * an argument bag compiles fine and then silently breaks undo, macros, the audit log and future sync all
   * at once.
   */
  readonly args: A;
  readonly origin: CommandOrigin;
  readonly txId?: string;
  /** Monotonic per-session counter. Orders the journal, and the op log if sync ever lands. */
  readonly seq: number;
  readonly at: string;
}

/**
 * Assert an argument bag is serialisable, and say *which field* is not.
 *
 * `structuredClone` alone would throw with a message naming no path, which on a nested bag is nearly
 * useless. This walks the object so the error points at `args.start.__proto__` rather than "could not be
 * cloned".
 */
export function assertSerializable(args: unknown, path = "args"): void {
  if (args === null) return;
  const t = typeof args;
  if (t === "string" || t === "number" || t === "boolean") {
    if (t === "number" && !Number.isFinite(args as number)) {
      throw new TypeError(`${path} is ${String(args)} — not JSON-serialisable`);
    }
    return;
  }
  if (t === "undefined") return; // dropped by JSON, but harmless in an optional field
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new TypeError(`${path} is a ${t}, which cannot be serialised`);
  }
  if (Array.isArray(args)) {
    args.forEach((v, i) => assertSerializable(v, `${path}[${i}]`));
    return;
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(args);
    if (proto !== Object.prototype && proto !== null) {
      // A class instance. `structuredClone` would strip it to a plain object, silently losing methods and
      // any prototype-based identity — so a Vector3 becomes {x,y,z} and stops behaving like a Vector3 after
      // one undo/redo cycle. Refuse it at the boundary instead.
      throw new TypeError(
        `${path} is a ${proto?.constructor?.name ?? "non-plain object"}; command arguments must be plain ` +
          `JSON. Convert it at the call site (e.g. a Vector3 to [x, y, z]).`,
      );
    }
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      assertSerializable(v, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------

/**
 * What a command can see.
 *
 * Deliberately narrow and injected. A command that could reach the whole application would be untestable and
 * would make the plugin boundary meaningless.
 */
export interface CommandContext {
  /** Capabilities the current actor holds. */
  readonly capabilities: ReadonlySet<CapabilityGate>;
  /** GlobalIds currently selected. */
  readonly selection: readonly string[];
  /** Whether the active kernel supports an operation. */
  supportsOp(op: OpId): boolean;
  /** The kernel's own explanation for an unsupported operation — used verbatim as the dimmed tooltip. */
  opHint(op: OpId): string;
  readonly online: boolean;
  /** Dispatch another command — how a composite command is built. */
  dispatch(invocation: CommandInvocation): Promise<Result<unknown>>;
}

/**
 * Can this command run right now, and if not, why?
 *
 * Checked in a fixed order, most-fundamental first, so the reason the user sees is the most useful one. A
 * command needing both `edit` and a selection should say "requires the Editor role" rather than "select an
 * element first" — fixing the selection would not help.
 */
export function availability(d: CommandDescriptor, ctx: CommandContext): Availability {
  if (d.cap && !ctx.capabilities.has(d.cap)) {
    return {
      state: "dimmed",
      kind: "capability",
      reason: `Requires the '${d.cap}' role on this project`,
    };
  }
  if (d.requiresOp && !ctx.supportsOp(d.requiresOp)) {
    // The kernel's own sentence, not one invented here. Only the kernel knows what would unlock it.
    return { state: "dimmed", kind: "kernel", reason: ctx.opHint(d.requiresOp) };
  }
  const contextual = d.requires?.(ctx);
  if (contextual) return { state: "dimmed", kind: "context", reason: contextual };
  return { state: "enabled" };
}
