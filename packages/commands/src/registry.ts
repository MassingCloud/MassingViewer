import { err, ok, type Result } from "@massing/core";
import {
  assertSerializable,
  availability,
  type Availability,
  type CommandContext,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandOrigin,
} from "./descriptor.js";

/**
 * The command registry and the dispatch bus.
 *
 * Everything downstream reads from here rather than keeping its own list: the ribbon, the palette, the command
 * line's verb index, the keybinding table, and the plugin host. One registry means a command added anywhere
 * appears everywhere, and — the part that actually matters — a command *removed* disappears everywhere,
 * including from the history, so undo cannot replay something that no longer exists.
 */

/**
 * A descriptor with its generics erased, for storage in a heterogeneous registry.
 *
 * `CommandDescriptor<A>` has `run` as a *property* holding `(args: A) => ...`, which under
 * `strictFunctionTypes` is strictly contravariant in `A`. So no single concrete type is a supertype of every
 * descriptor — not `never` (which fails contravariantly) and not `unknown`. TypeScript genuinely cannot
 * express "a collection of differently-parameterised descriptors" soundly.
 *
 * The honest response is one documented cast at `register()`, where the concrete type is still known, rather
 * than casts scattered through every consumer. Everything downstream reads this erased type, and the only
 * place args are narrowed back is inside the command's own `run`.
 */
export type AnyCommandDescriptor = CommandDescriptor<object, unknown>;

export interface HistoryEntry {
  readonly invocation: CommandInvocation;
  readonly inverse: CommandInvocation | undefined;
  readonly label: string;
}

export type UndoOutcome =
  | { readonly kind: "reverted"; readonly label: string }
  /** The honest case: this cannot be reversed. Reported, never silently skipped. */
  | { readonly kind: "unavailable"; readonly label: string; readonly reason: string }
  | { readonly kind: "empty" };

export interface DispatchOptions {
  /** Do not record in history. Used by undo/redo replay, so undoing does not become undoable. */
  readonly transient?: boolean;
}

export interface Middleware {
  (invocation: CommandInvocation, next: () => Promise<Result<unknown>>): Promise<Result<unknown>>;
}

export interface Registry {
  register<A extends object, R>(descriptor: CommandDescriptor<A, R>): () => void;
  get(id: string): AnyCommandDescriptor | undefined;
  list(): readonly AnyCommandDescriptor[];

  /** Resolve a command-line verb or alias, case-insensitively. */
  byVerb(verb: string): AnyCommandDescriptor | undefined;
  /** Commands matching a keybinding, honouring user overrides. */
  byKey(combo: string): readonly AnyCommandDescriptor[];
  /** Remap a key. Overrides are data, so nothing is hardcoded. */
  bind(combo: string, commandId: string | null): void;

  availabilityOf(id: string, ctx: CommandContext): Availability;

  dispatch(invocation: CommandInvocation, ctx: CommandContext, options?: DispatchOptions): Promise<Result<unknown>>;
  use(middleware: Middleware): () => void;

  undo(ctx: CommandContext): Promise<UndoOutcome>;
  redo(ctx: CommandContext): Promise<UndoOutcome>;
  readonly depth: { readonly undo: number; readonly redo: number };

  /** Next sequence number. Exposed so a caller can build an invocation before dispatching it. */
  nextSeq(): number;
  /** The injected clock. Callers building an invocation use this so history is reproducible in tests. */
  now(): string;

  /** Start recording. The returned list *is* a macro, and also a regression test. */
  record(): { stop(): readonly CommandInvocation[] };
}

export interface RegistryOptions {
  /** Injected so history and the audit log are reproducible in tests. */
  readonly now?: () => string;
  readonly maxHistory?: number;
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  const now = options.now ?? (() => new Date().toISOString());
  const maxHistory = options.maxHistory ?? 200;

  const commands = new Map<string, AnyCommandDescriptor>();
  const verbs = new Map<string, string>();
  const bindings = new Map<string, string>();
  const overrides = new Map<string, string | null>();
  const middlewares: Middleware[] = [];

  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let seq = 0;
  let recording: CommandInvocation[] | null = null;

  function indexVerbs(d: AnyCommandDescriptor) {
    if (d.verb) verbs.set(d.verb.toUpperCase(), d.id);
    for (const a of d.aliases ?? []) verbs.set(a.toUpperCase(), d.id);
    for (const k of d.defaultKeys ?? []) bindings.set(k, d.id);
  }

  function deindexVerbs(d: AnyCommandDescriptor) {
    for (const [k, v] of [...verbs]) if (v === d.id) verbs.delete(k);
    for (const [k, v] of [...bindings]) if (v === d.id) bindings.delete(k);
  }

  return {
    register(descriptor) {
      // The one cast. See AnyCommandDescriptor for why TypeScript cannot do this soundly.
      const d = descriptor as unknown as AnyCommandDescriptor;
      if (commands.has(d.id)) {
        throw new Error(`command '${d.id}' is already registered`);
      }
      // Reject a colliding verb at registration rather than resolving it silently at type-time. Two commands
      // answering `W` means one of them is unreachable from the command line, and the user's report would be
      // "the wall shortcut stopped working" — with nothing to point at.
      for (const key of [d.verb, ...(d.aliases ?? [])].filter(Boolean) as string[]) {
        const existing = verbs.get(key.toUpperCase());
        if (existing && existing !== d.id) {
          throw new Error(
            `verb '${key}' is already bound to '${existing}'; a duplicate makes one of them unreachable`,
          );
        }
      }
      for (const spec of d.args) {
        if (!spec.prompt || spec.prompt.trim() === "") {
          throw new Error(`${d.id}: argument '${spec.name}' has no prompt — the command line cannot ask for it`);
        }
      }

      commands.set(d.id, d);
      indexVerbs(d);

      return () => {
        commands.delete(d.id);
        deindexVerbs(d);
        // Purge history entries for a command that no longer exists, in both directions. Otherwise undo would
        // try to replay an invocation whose descriptor is gone — which fails at the moment the user presses
        // Ctrl+Z, long after the plugin that owned it was unloaded.
        for (const stack of [undoStack, redoStack]) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]!.invocation.commandId === d.id) stack.splice(i, 1);
          }
        }
      };
    },

    get: (id) => commands.get(id),
    list: () => [...commands.values()],
    byVerb(verb) {
      const id = verbs.get(verb.toUpperCase());
      return id ? commands.get(id) : undefined;
    },

    byKey(combo) {
      // An explicit override wins, including an override to `null`, which is how a user *unbinds* a key. A
      // falsy check here would make unbinding impossible.
      if (overrides.has(combo)) {
        const id = overrides.get(combo);
        const d = id ? commands.get(id) : undefined;
        return d ? [d] : [];
      }
      const id = bindings.get(combo);
      const d = id ? commands.get(id) : undefined;
      return d ? [d] : [];
    },

    bind(combo, commandId) {
      overrides.set(combo, commandId);
    },

    availabilityOf(id, ctx) {
      const d = commands.get(id);
      if (!d) {
        return { state: "dimmed", kind: "context", reason: `Unknown command '${id}'` };
      }
      return availability(d, ctx);
    },

    use(mw) {
      middlewares.push(mw);
      return () => {
        const i = middlewares.indexOf(mw);
        if (i >= 0) middlewares.splice(i, 1);
      };
    },

    nextSeq: () => ++seq,
    now,

    async dispatch(invocation, ctx, dispatchOptions) {
      const d = commands.get(invocation.commandId);
      if (!d) {
        return err({ code: "no_such_command", message: `Unknown command '${invocation.commandId}'` });
      }

      // Availability is re-checked at dispatch, not only at render. The gap between a control being drawn and
      // being clicked is where a role change, a kernel swap or a cleared selection lands — and a command
      // invoked from the command line or a macro never passed through the UI check at all.
      const avail = availability(d, ctx);
      if (avail.state === "dimmed") {
        return err({ code: "forbidden", message: avail.reason, detail: { kind: avail.kind } });
      }

      assertSerializable(invocation.args);

      const core = async (): Promise<Result<unknown>> => {
        const result = await d.run(invocation.args, ctx);
        if (!result.ok) return result;

        if (recording && invocation.origin.via !== "macro" && invocation.origin.via !== "replay") {
          recording.push(invocation);
        }

        if (!dispatchOptions?.transient) {
          const inverse = d.invert?.(invocation.args, result.value);
          undoStack.push({ invocation, inverse, label: d.title });
          if (undoStack.length > maxHistory) undoStack.shift();
          // A fresh action invalidates the redo branch. Keeping it would let redo replay a future that no
          // longer follows from the present state.
          redoStack.length = 0;
        }
        return result;
      };

      // Middleware runs outermost-first, so a progress or audit wrapper sees the whole operation including
      // everything inner middleware does.
      let chain = core;
      for (const mw of [...middlewares].reverse()) {
        const next = chain;
        chain = () => mw(invocation, next);
      }
      return chain();
    },

    async undo(ctx) {
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return { kind: "empty" };

      if (!entry.inverse) {
        // Reported, not silently skipped, and the entry stays put. Popping it would mean a second Ctrl+Z
        // skips past an action the user believes is still undoable.
        const d = commands.get(entry.invocation.commandId);
        return {
          kind: "unavailable",
          label: entry.label,
          reason: d?.transactional
            ? `'${entry.label}' needs a kernel transaction to undo, and this kernel has none`
            : `'${entry.label}' cannot be reversed`,
        };
      }

      undoStack.pop();
      // `transient` so undoing does not itself become undoable — otherwise Ctrl+Z alternates between two
      // states for ever instead of walking back through history.
      const r = await this.dispatch(entry.inverse, ctx, { transient: true });
      if (!r.ok) {
        undoStack.push(entry); // restore, so the user can retry rather than losing the entry
        return { kind: "unavailable", label: entry.label, reason: r.error.message };
      }
      redoStack.push(entry);
      return { kind: "reverted", label: entry.label };
    },

    async redo(ctx) {
      const entry = redoStack.pop();
      if (!entry) return { kind: "empty" };
      const r = await this.dispatch(entry.invocation, ctx, { transient: true });
      if (!r.ok) {
        redoStack.push(entry);
        return { kind: "unavailable", label: entry.label, reason: r.error.message };
      }
      undoStack.push(entry);
      return { kind: "reverted", label: entry.label };
    },

    get depth() {
      return { undo: undoStack.length, redo: redoStack.length };
    },

    record() {
      recording = [];
      return {
        stop() {
          const out = recording ?? [];
          recording = null;
          return out;
        },
      };
    },
  };
}

/** Replay a recorded macro. Also how a recording becomes a regression test. */
export async function replay(
  registry: Registry,
  invocations: readonly CommandInvocation[],
  ctx: CommandContext,
  macroId = "macro",
): Promise<Result<number>> {
  for (let i = 0; i < invocations.length; i++) {
    const original = invocations[i]!;
    const origin: CommandOrigin = { via: "macro", macroId, index: i };
    const r = await registry.dispatch(
      { ...original, origin, seq: registry.nextSeq() },
      ctx,
    );
    if (!r.ok) {
      // Stop at the first failure and say where. Continuing would apply the rest of the macro to a state its
      // later steps were never recorded against, which produces plausible-looking wrong geometry.
      return err({
        code: "macro_failed",
        message: `macro '${macroId}' stopped at step ${i + 1} (${original.commandId}): ${r.error.message}`,
        detail: { index: i, commandId: original.commandId },
      });
    }
  }
  return ok(invocations.length);
}

/**
 * Rank commands for the palette.
 *
 * Recency before alphabetical, because the thing you just used is overwhelmingly the thing you want next.
 * Dimmed commands are ranked **last but still listed** — the same dim-don't-hide rule as the ribbon, since a
 * palette that hides unavailable commands cannot teach anyone what exists.
 */
export function rankForPalette(
  registry: Registry,
  ctx: CommandContext,
  query: string,
  recent: readonly string[] = [],
): readonly { readonly descriptor: AnyCommandDescriptor; readonly availability: Availability }[] {
  const q = query.trim().toLowerCase();
  const scored = registry.list().map((d) => {
    const avail = availability(d, ctx);
    const haystack = `${d.title} ${d.verb ?? ""} ${(d.aliases ?? []).join(" ")} ${d.group}`.toLowerCase();
    let score = 0;
    if (q === "") score = 1;
    else if (d.verb?.toLowerCase() === q || d.aliases?.some((a) => a.toLowerCase() === q)) score = 100;
    else if (d.title.toLowerCase().startsWith(q)) score = 50;
    else if (haystack.includes(q)) score = 10;
    const recentIndex = recent.indexOf(d.id);
    if (recentIndex >= 0) score += 20 - recentIndex;
    if (avail.state === "dimmed") score -= 1000;
    return { descriptor: d, availability: avail, score };
  });
  return scored
    .filter((s) => s.score > -1000 || q === "" || s.score > -990)
    .sort((a, b) => b.score - a.score || a.descriptor.title.localeCompare(b.descriptor.title))
    .map(({ descriptor, availability: av }) => ({ descriptor, availability: av }));
}
