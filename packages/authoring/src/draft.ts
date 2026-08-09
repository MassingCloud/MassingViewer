import { err, ok, type Result } from "@massing/core";
import type { AnyCommandDescriptor, CommandInvocation } from "@massing/commands";

/**
 * The draft commands — wall, slab, column — as `CommandDescriptor`s.
 *
 * ## Why these did not exist, and why that was the whole M6 gap
 *
 * Everything underneath was already built and tested. The snap engine resolves candidates, `dynInput` parses
 * `12'6`, the prompt reducer accumulates arguments, `LocalKernel` implements `add_wall`, and the ribbon renders a
 * button for it. `createRegistry()` in `packages/embed` was called with **nothing registered**, so
 * `session.arm("…")` had no command to arm and the ribbon's buttons pointed at nothing. The missing piece was
 * never logic; it was the declaration that joins a prompt sequence to a kernel operation.
 *
 * ## Why a factory rather than exported constants
 *
 * `CommandContext` deliberately carries `supportsOp` and `dispatch` but **not** the kernel, so a descriptor's
 * `run` cannot reach one. Closing over an injected `apply` is what keeps this module free of a kernel dependency
 * — the same reason `SessionDeps.candidates` is a callback rather than a list. `@massing/authoring` depends on
 * `commands`, `core` and `geometry-math`, and nothing here changes that.
 *
 * ## Undo is an inverse invocation, not a closure
 *
 * `invert` returns another `CommandInvocation`. That is what makes history persistable, replayable and able to
 * cross a worker boundary — a closure can do none of those. It also means undo of a draft is a real
 * `delete_element`, which `LocalKernel` supports, rather than a snapshot restore.
 */

/** What a draft command needs from its host in order to reach a kernel. */
export interface DraftDeps {
  /**
   * Apply a kernel operation.
   *
   * Returns the GlobalIds created, because `invert` needs them to build the `delete_element` that undoes this.
   * A command that created something and cannot say what is a command that cannot be undone.
   */
  apply(
    op: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Result<{ readonly created: readonly string[] }>>;
  /**
   * Stamp for an inverse invocation: the sequence number and timestamp the registry would assign.
   *
   * `invert(args, result)` does not receive the registry, and `CommandInvocation` requires both fields — so
   * without this an inverse would carry `seq: 0`, and `seq` is what orders the audit journal. Wire it to
   * `registry.nextSeq()` / `registry.now()`. Defaulted so a caller that has no journal is not forced to care.
   */
  readonly stamp?: () => { readonly seq: number; readonly at: string };
  /** Defaults a settings panel would own. Overridable so a host is not stuck with ours. */
  readonly defaults?: {
    readonly wallHeight?: number;
    readonly wallThickness?: number;
    readonly slabThickness?: number;
    readonly columnSize?: number;
  };
}

/** A point argument arrives from the reducer as `[x, z]`. */
type Point = readonly [number, number];

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);

/**
 * Build the `delete_element` invocation that undoes a create.
 *
 * Shared because getting it wrong in one of three places is the likely failure, and the symptom — undo appears to
 * work and silently leaves one element behind — is not something a user reports precisely.
 */
function deletion(
  created: readonly string[],
  stamp: () => { readonly seq: number; readonly at: string },
): CommandInvocation | undefined {
  // Nothing created means nothing to undo. Returning an invocation with an empty list would ask the kernel to
  // delete nothing and surface a refusal at undo time, long after the user could connect it to anything —
  // whereas `undefined` makes the registry dim Undo with a stated reason, which is the designed behaviour.
  if (created.length === 0) return undefined;
  const { seq, at } = stamp();
  return {
    commandId: "mv.edit.delete",
    args: { guids: [...created] },
    /**
     * `replay`, and not because it is a replay.
     *
     * `CommandOrigin` has no "undo" variant, and of the ones it has this is the only one that is both honest —
     * a derived invocation rather than a user action — and *useful*: `Registry.dispatch` excludes `macro` and
     * `replay` origins from an in-progress macro recording. Tagging an inverse `ui` would record the undo into
     * the macro, so replaying it would draw a wall and then delete it.
     */
    origin: { via: "replay", sourceSeq: seq },
    seq,
    at,
  };
}

export function draftCommands(deps: DraftDeps): AnyCommandDescriptor[] {
  const d = deps.defaults ?? {};
  const wallHeight = d.wallHeight ?? 3;
  const wallThickness = d.wallThickness ?? 0.2;
  const slabThickness = d.slabThickness ?? 0.2;
  const columnSize = d.columnSize ?? 0.3;
  // Zeroes when no journal is wired. Harmless for undo itself — the registry dispatches the inverse directly —
  // and honest: an unstamped invocation is visibly unstamped rather than carrying a plausible wrong time.
  const stamp = deps.stamp ?? (() => ({ seq: 0, at: "" }));

  /** The delete command undo depends on. Registered here because `invert` names it and a dangling id is a silent failure. */
  const deleteElements: AnyCommandDescriptor = {
    id: "mv.edit.delete",
    title: "Delete",
    description: "Delete the selected elements.",
    verb: "ERASE",
    aliases: ["E"],
    group: "modify",
    cap: "edit",
    requiresOp: "delete_element" as never,
    args: [{ name: "guids", kind: "element-list", prompt: "Select elements to delete" }],
    async run(args) {
      const guids = (args as { guids?: readonly string[] }).guids ?? [];
      if (guids.length === 0) return err({ code: "invalid_param", message: "nothing to delete" }) as never;
      // One operation per element rather than a batch, because `delete_element` takes one guid. Sequential
      // rather than concurrent: the kernel serialises writes anyway, and a failure halfway through is easier to
      // report than a partially-applied set of parallel edits.
      for (const guid of guids) {
        const applied = await deps.apply("delete_element", { guid });
        if (!applied.ok) return applied as never;
      }
      return ok({ deleted: guids }) as never;
    },
    // Deliberately not invertible. massing's service has no inverse for a delete, and `LocalKernel` reports
    // `transactions: "snapshot"` — so undo of a delete is a rollback the registry performs, not something this
    // descriptor can express. Claiming an inverse it does not have is worse than dimming Undo with a reason.
  };

  const wall: AnyCommandDescriptor = {
    id: "mv.draft.wall",
    title: "Wall",
    description: "Draw a wall between two points.",
    verb: "WALL",
    aliases: ["W"],
    group: "draw",
    icon: "▭",
    cap: "edit",
    requiresOp: "add_wall" as never,
    // `repeatable` because a drafter draws walls in runs, and re-arming on Enter is thirty years of muscle
    // memory. The reducer already supports it; this is the declaration that turns it on.
    repeatable: true,
    args: [
      { name: "start", kind: "point", prompt: "Specify start point" },
      { name: "end", kind: "point", prompt: "Specify end point" },
      {
        name: "height",
        kind: "length",
        prompt: "Wall height",
        optional: true,
        unit: "m",
        default: wallHeight,
        validate: (value) =>
          typeof value === "number" && value > 0
            ? ok(value)
            : (err({ code: "invalid_param", message: "height must be greater than zero" }) as never),
      },
    ],
    async run(args) {
      const a = args as { start?: unknown; end?: unknown; height?: number };
      if (!isPoint(a.start) || !isPoint(a.end)) {
        return err({ code: "invalid_param", message: "a wall needs two points" }) as never;
      }
      // Refused here rather than at the kernel. A zero-length wall is the commonest double-click accident, and
      // the honest place to say so is before a round trip that would report it as degenerate geometry.
      const length = Math.hypot(a.end[0] - a.start[0], a.end[1] - a.start[1]);
      if (length < 1e-3) {
        return err({
          code: "degenerate_geometry",
          message: `a wall must be longer than 1 mm — these two points are ${(length * 1000).toFixed(1)} mm apart`,
        }) as never;
      }
      return (await deps.apply("add_wall", {
        start: [a.start[0], a.start[1]],
        end: [a.end[0], a.end[1]],
        height: a.height ?? wallHeight,
        thickness: wallThickness,
      })) as never;
    },
    invert: (_args, result) => deletion((result as { created?: readonly string[] })?.created ?? [], stamp),
  };

  const slab: AnyCommandDescriptor = {
    id: "mv.draft.slab",
    title: "Slab",
    description: "Draw a slab from a closed outline.",
    verb: "SLAB",
    aliases: ["SL"],
    group: "draw",
    icon: "▬",
    cap: "edit",
    requiresOp: "add_slab" as never,
    args: [
      {
        name: "outline",
        kind: "point-list",
        prompt: "Specify outline points",
        // The keywords the reducer offers alongside the prompt. `Close` is how a variadic point list ends, and
        // without it a polygon tool has no way to say "done" other than a mode nobody discovers.
        keywords: [
          { key: "C", label: "Close" },
          { key: "U", label: "Undo last point" },
        ],
      },
      {
        name: "thickness",
        kind: "length",
        prompt: "Slab thickness",
        optional: true,
        unit: "m",
        default: slabThickness,
      },
    ],
    async run(args) {
      const a = args as { outline?: unknown; thickness?: number };
      const outline = Array.isArray(a.outline) ? a.outline.filter(isPoint) : [];
      if (outline.length < 3) {
        return err({
          code: "degenerate_geometry",
          message: `a slab needs at least three points — got ${outline.length}`,
        }) as never;
      }
      return (await deps.apply("add_slab", {
        outline: outline.map((p) => [p[0], p[1]]),
        thickness: a.thickness ?? slabThickness,
      })) as never;
    },
    invert: (_args, result) => deletion((result as { created?: readonly string[] })?.created ?? [], stamp),
  };

  const column: AnyCommandDescriptor = {
    id: "mv.draft.column",
    title: "Column",
    description: "Place a column at a point.",
    verb: "COLUMN",
    aliases: ["C", "COL"],
    group: "draw",
    icon: "▮",
    cap: "edit",
    requiresOp: "add_column" as never,
    repeatable: true,
    args: [
      { name: "at", kind: "point", prompt: "Specify column centre" },
      { name: "height", kind: "length", prompt: "Column height", optional: true, unit: "m", default: wallHeight },
      { name: "size", kind: "length", prompt: "Column size", optional: true, unit: "m", default: columnSize },
    ],
    async run(args) {
      const a = args as { at?: unknown; height?: number; size?: number };
      if (!isPoint(a.at)) return err({ code: "invalid_param", message: "a column needs a point" }) as never;
      return (await deps.apply("add_column", {
        at: [a.at[0], a.at[1]],
        height: a.height ?? wallHeight,
        size: a.size ?? columnSize,
      })) as never;
    },
    invert: (_args, result) => deletion((result as { created?: readonly string[] })?.created ?? [], stamp),
  };

  /**
   * The three transform verbs the gizmo drives.
   *
   * They exist as *commands* rather than as direct kernel calls so a gizmo drag goes through the same bus as a
   * typed one. That is what puts it in the undo stack and the audit log — a gizmo that called the kernel directly
   * would be the one edit `Ctrl+Z` could not reverse, and the one action the audit log had no record of.
   *
   * Each one's `invert` is the opposite transform, which is why they are invertible at all: `move_element` and
   * `rotate_element` both declare `invertible: true` in the kernel, and the opposite of a translation is a
   * translation. `deletion()` is not involved — nothing is created.
   */
  const move: AnyCommandDescriptor = {
    id: "mv.edit.move",
    title: "Move",
    description: "Translate an element.",
    verb: "MOVE",
    aliases: ["M"],
    group: "modify",
    cap: "edit",
    requiresOp: "move_element" as never,
    args: [
      { name: "guid", kind: "element", prompt: "Select an element to move" },
      // IFC axes. `dy` is the plan y, which is the viewport's z — the gizmo converts at its own boundary and
      // this is the other side of that contract.
      { name: "dx", kind: "length", prompt: "Distance along x", optional: true, unit: "m", default: 0 },
      { name: "dy", kind: "length", prompt: "Distance along y", optional: true, unit: "m", default: 0 },
      { name: "dz", kind: "length", prompt: "Distance along z", optional: true, unit: "m", default: 0 },
    ],
    async run(args) {
      const a = args as { guid?: string; dx?: number; dy?: number; dz?: number };
      if (typeof a.guid !== "string" || a.guid === "") {
        return err({ code: "invalid_param", message: "move needs an element" }) as never;
      }
      const dx = a.dx ?? 0;
      const dy = a.dy ?? 0;
      const dz = a.dz ?? 0;
      // A zero move is refused rather than applied. It would still bump the model version and write an audit
      // entry, so "nothing happened" would be recorded as an edit.
      if (dx === 0 && dy === 0 && dz === 0) {
        return err({ code: "invalid_param", message: "a move of zero is not an edit" }) as never;
      }
      return (await deps.apply("move_element", { guid: a.guid, dx, dy, dz })) as never;
    },
    invert: (args) => {
      const a = args as { guid?: string; dx?: number; dy?: number; dz?: number };
      if (typeof a.guid !== "string") return undefined;
      const { seq, at } = stamp();
      return {
        commandId: "mv.edit.move",
        args: { guid: a.guid, dx: -(a.dx ?? 0), dy: -(a.dy ?? 0), dz: -(a.dz ?? 0) },
        origin: { via: "replay", sourceSeq: seq },
        seq,
        at,
      };
    },
  };

  const rotate: AnyCommandDescriptor = {
    id: "mv.edit.rotate",
    title: "Rotate",
    description: "Rotate an element about its own vertical axis.",
    verb: "ROTATE",
    aliases: ["RO"],
    group: "modify",
    cap: "edit",
    requiresOp: "rotate_element" as never,
    args: [
      { name: "guid", kind: "element", prompt: "Select an element to rotate" },
      { name: "degrees", kind: "angle", prompt: "Rotation", unit: "deg" },
    ],
    async run(args) {
      const a = args as { guid?: string; degrees?: number };
      if (typeof a.guid !== "string" || a.guid === "") {
        return err({ code: "invalid_param", message: "rotate needs an element" }) as never;
      }
      if (typeof a.degrees !== "number" || !Number.isFinite(a.degrees) || a.degrees === 0) {
        return err({ code: "invalid_param", message: "rotate needs a non-zero angle" }) as never;
      }
      return (await deps.apply("rotate_element", { guid: a.guid, degrees: a.degrees })) as never;
    },
    invert: (args) => {
      const a = args as { guid?: string; degrees?: number };
      if (typeof a.guid !== "string") return undefined;
      const { seq, at } = stamp();
      return {
        commandId: "mv.edit.rotate",
        args: { guid: a.guid, degrees: -(a.degrees ?? 0) },
        origin: { via: "replay", sourceSeq: seq },
        seq,
        at,
      };
    },
  };

  const height: AnyCommandDescriptor = {
    id: "mv.edit.height",
    title: "Push/pull",
    description: "Change how far an element's profile is extruded.",
    verb: "PUSHPULL",
    aliases: ["PP"],
    group: "modify",
    cap: "edit",
    requiresOp: "set_extrusion_depth" as never,
    args: [
      { name: "guid", kind: "element", prompt: "Select an element" },
      { name: "depth", kind: "length", prompt: "New depth", unit: "m" },
    ],
    async run(args) {
      const a = args as { guid?: string; depth?: number };
      if (typeof a.guid !== "string" || a.guid === "") {
        return err({ code: "invalid_param", message: "push/pull needs an element" }) as never;
      }
      if (typeof a.depth !== "number" || !Number.isFinite(a.depth) || a.depth <= 0) {
        // The kernel declares `min: 0`, which permits zero. A zero-depth solid renders as nothing while the
        // operation succeeds — the element stays in the file and in every schedule, invisibly. Refused here.
        return err({ code: "invalid_param", message: "depth must be greater than zero" }) as never;
      }
      return (await deps.apply("set_extrusion_depth", { guid: a.guid, depth: a.depth })) as never;
    },
    /**
     * Not invertible, deliberately.
     *
     * The inverse of "set the depth to 4" is "set it to whatever it was", and this descriptor is not told the
     * previous value — `run` receives the target depth, not the delta. `LocalKernel` reports
     * `transactions: "snapshot"`, so undo is a rollback the registry performs; claiming an inverse that would
     * need information this function does not have is how undo silently sets a wrong height.
     */
  };

  return [wall, slab, column, deleteElements, move, rotate, height];
}
