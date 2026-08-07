import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@massingviewer/core";
import type { CommandContext, CommandDescriptor, CommandInvocation } from "./descriptor.js";
import { createRegistry, rankForPalette, replay, type Registry } from "./registry.js";

/**
 * The registry, which is where "one abstraction, seven features" stops being a claim.
 *
 * Each describe block below is one of the seven, and none of them needed machinery of its own.
 */

function makeCtx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    capabilities: new Set(["edit"]),
    selection: [],
    supportsOp: () => true,
    opHint: (op) => `"${op}" runs on the Massing authoring service. Connect a project to use it.`,
    online: true,
    dispatch: async () => ok(undefined),
    ...over,
  };
}

/** A command that records what it did, so history behaviour is observable. */
function counter(id: string, opts: Partial<CommandDescriptor<{ by: number }>> = {}) {
  const applied: number[] = [];
  const d: CommandDescriptor<{ by: number }> = {
    id,
    title: id,
    group: "test",
    args: [{ name: "by", kind: "number", prompt: "By" }],
    run: async (args) => {
      applied.push(args.by);
      return ok({ total: applied.reduce((a, b) => a + b, 0) });
    },
    invert: (args) => ({
      commandId: id,
      args: { by: -args.by },
      origin: { via: "replay", sourceSeq: 0 },
      seq: 0,
      at: "",
    }),
    ...opts,
  };
  return { d, applied };
}

let registry: Registry;
let seq = 0;

beforeEach(() => {
  registry = createRegistry({ now: () => "2026-08-06T00:00:00.000Z" });
  seq = 0;
});

const inv = (commandId: string, args: object): CommandInvocation => ({
  commandId,
  args,
  origin: { via: "ui", surface: "ribbon" },
  seq: ++seq,
  at: "2026-08-06T00:00:00.000Z",
});

describe("registration", () => {
  it("refuses a duplicate id", () => {
    const { d } = counter("a");
    registry.register(d);
    expect(() => registry.register(d)).toThrow(/already registered/);
  });

  it("refuses a colliding verb", () => {
    // Two commands answering `W` means one is unreachable from the command line, and the user's report would
    // be "the wall shortcut stopped working" with nothing to point at. Better to fail at registration.
    registry.register({ ...counter("a").d, verb: "W" });
    expect(() => registry.register({ ...counter("b").d, verb: "W" })).toThrow(/already bound/);
  });

  it("refuses a colliding alias", () => {
    registry.register({ ...counter("a").d, verb: "WALL", aliases: ["W"] });
    expect(() => registry.register({ ...counter("b").d, verb: "WINDOW", aliases: ["W"] })).toThrow(
      /already bound/,
    );
  });

  it("refuses an argument with no prompt", () => {
    // The command line literally cannot ask for it, so the command would be unusable from the keyboard.
    expect(() =>
      registry.register({
        id: "bad", title: "Bad", group: "t",
        args: [{ name: "x", kind: "number", prompt: "  " }],
        run: async () => ok(undefined),
      }),
    ).toThrow(/no prompt/);
  });

  it("unregistering removes the command, its verbs and its keys", () => {
    const dispose = registry.register({ ...counter("a").d, verb: "AAA", defaultKeys: ["mod+a"] });
    expect(registry.byVerb("AAA")).toBeTruthy();
    dispose();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.byVerb("AAA")).toBeUndefined();
    expect(registry.byKey("mod+a")).toEqual([]);
  });

  it("unregistering PURGES its history in both directions", async () => {
    // Otherwise undo would try to replay an invocation whose descriptor is gone — failing at the moment the
    // user presses Ctrl+Z, long after the plugin that owned it was unloaded.
    const { d } = counter("a");
    const dispose = registry.register(d);
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.dispatch(inv("a", { by: 2 }), ctx);
    expect(registry.depth.undo).toBe(2);
    dispose();
    expect(registry.depth.undo).toBe(0);
  });
});

describe("availability — dimmed with a reason, never hidden", () => {
  it("dims on an unmet capability and names the role", () => {
    registry.register({ ...counter("a").d, cap: "edit" });
    const a = registry.availabilityOf("a", makeCtx({ capabilities: new Set(["view"]) }));
    expect(a.state).toBe("dimmed");
    if (a.state === "dimmed") {
      expect(a.kind).toBe("capability");
      expect(a.reason).toMatch(/'edit' role/);
    }
  });

  it("dims on an unsupported kernel op, using the KERNEL's own sentence", () => {
    // Only the kernel knows what would unlock the operation, so the reason is not invented here. This is what
    // lets a user see the whole tool surface and learn what connecting a server buys them.
    registry.register({ ...counter("a").d, requiresOp: "add_connection_assembly" });
    const a = registry.availabilityOf("a", makeCtx({ supportsOp: () => false }));
    expect(a.state).toBe("dimmed");
    if (a.state === "dimmed") {
      expect(a.kind).toBe("kernel");
      expect(a.reason).toContain("Massing authoring service");
    }
  });

  it("dims on a contextual requirement", () => {
    registry.register({
      ...counter("a").d,
      requires: (ctx) => (ctx.selection.length > 0 ? null : "Select an element first"),
    });
    expect(registry.availabilityOf("a", makeCtx()).state).toBe("dimmed");
    expect(registry.availabilityOf("a", makeCtx({ selection: ["g"] })).state).toBe("enabled");
  });

  it("reports the MOST FUNDAMENTAL reason first", () => {
    // A command needing both `edit` and a selection should say "requires the Editor role", because fixing the
    // selection would not help. Reporting the wrong one sends the user down a dead end.
    registry.register({
      ...counter("a").d,
      cap: "edit",
      requires: () => "Select an element first",
    });
    const a = registry.availabilityOf("a", makeCtx({ capabilities: new Set(["view"]) }));
    if (a.state === "dimmed") expect(a.kind).toBe("capability");
  });

  it("every dimmed state carries a non-empty reason", () => {
    // The type enforces the field exists; this asserts nobody satisfies it with "".
    registry.register({ ...counter("a").d, cap: "admin" });
    registry.register({ ...counter("b").d, requiresOp: "nope" });
    registry.register({ ...counter("c").d, requires: () => "needs something" });
    const ctx = makeCtx({ capabilities: new Set(["view"]), supportsOp: () => false });
    for (const id of ["a", "b", "c"]) {
      const av = registry.availabilityOf(id, ctx);
      if (av.state === "dimmed") expect(av.reason.trim().length, id).toBeGreaterThan(0);
    }
  });
});

describe("dispatch", () => {
  it("runs the command and records history", async () => {
    const { d, applied } = counter("a");
    registry.register(d);
    const r = await registry.dispatch(inv("a", { by: 5 }), makeCtx());
    expect(r.ok).toBe(true);
    expect(applied).toEqual([5]);
    expect(registry.depth.undo).toBe(1);
  });

  it("re-checks availability AT DISPATCH, not only at render", async () => {
    // The gap between a control being drawn and being clicked is where a role change, a kernel swap or a
    // cleared selection lands — and a command invoked from the command line or a macro never passed through
    // the UI check at all.
    const { d, applied } = counter("a");
    registry.register({ ...d, cap: "edit" });
    const r = await registry.dispatch(inv("a", { by: 1 }), makeCtx({ capabilities: new Set(["view"]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
    expect(applied).toEqual([]); // did not run
    expect(registry.depth.undo).toBe(0); // and did not enter history
  });

  it("refuses an unknown command", async () => {
    const r = await registry.dispatch(inv("nope", {}), makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("no_such_command");
  });

  it("refuses non-serialisable arguments, naming the field", async () => {
    // The property everything downstream rests on. A THREE.Vector3 in an argument bag compiles fine and then
    // silently breaks undo, macros, the audit log and future sync all at once.
    registry.register(counter("a").d);
    class Vec { constructor(public x = 1) {} }
    await expect(
      registry.dispatch(inv("a", { by: 1, v: new Vec() }), makeCtx()),
    ).rejects.toThrow(/args\.v is a Vec/);
  });

  it("does not record history when the command fails", async () => {
    registry.register({
      id: "f", title: "F", group: "t", args: [],
      run: async () => err({ code: "refused", message: "no" }),
    });
    await registry.dispatch(inv("f", {}), makeCtx());
    expect(registry.depth.undo).toBe(0);
  });
});

describe("undo / redo", () => {
  it("reverts via the serializable inverse", async () => {
    const { d, applied } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 7 }), ctx);
    const out = await registry.undo(ctx);
    expect(out.kind).toBe("reverted");
    expect(applied).toEqual([7, -7]);
  });

  it("undoing is not itself undoable", async () => {
    // Otherwise Ctrl+Z alternates between two states for ever instead of walking back through history.
    const { d } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.undo(ctx);
    expect(registry.depth.undo).toBe(0);
    expect(registry.depth.redo).toBe(1);
  });

  it("redo re-applies and returns the entry to the undo stack", async () => {
    const { d, applied } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 3 }), ctx);
    await registry.undo(ctx);
    await registry.redo(ctx);
    expect(applied).toEqual([3, -3, 3]);
    expect(registry.depth).toEqual({ undo: 1, redo: 0 });
  });

  it("a fresh action invalidates the redo branch", async () => {
    // Keeping it would let redo replay a future that no longer follows from the present state.
    const { d } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.undo(ctx);
    expect(registry.depth.redo).toBe(1);
    await registry.dispatch(inv("a", { by: 2 }), ctx);
    expect(registry.depth.redo).toBe(0);
  });

  it("reports a non-invertible command instead of silently skipping it", async () => {
    const { d } = counter("a");
    registry.register({ ...d, invert: undefined });
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    const out = await registry.undo(ctx);
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") expect(out.reason).toMatch(/cannot be reversed/);
  });

  it("LEAVES a non-invertible entry on the stack", async () => {
    // Popping it would mean a second Ctrl+Z skips past an action the user believes is still undoable — so the
    // history silently desynchronises from what they think happened.
    const { d } = counter("a");
    registry.register({ ...d, invert: undefined });
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.undo(ctx);
    expect(registry.depth.undo).toBe(1);
  });

  it("explains a transactional command differently", async () => {
    // "needs a kernel transaction, and this kernel has none" is actionable — connect a different kernel.
    // "cannot be reversed" is not.
    const { d } = counter("a");
    registry.register({ ...d, invert: undefined, transactional: true });
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    const out = await registry.undo(ctx);
    if (out.kind === "unavailable") expect(out.reason).toMatch(/kernel transaction/);
  });

  it("restores the entry when the inverse itself fails", async () => {
    // So the user can retry rather than losing the entry — a failed undo must not consume history.
    let calls = 0;
    registry.register({
      id: "a", title: "A", group: "t",
      args: [{ name: "by", kind: "number", prompt: "By" }],
      run: async () => (++calls === 1 ? ok(1) : err({ code: "refused", message: "inverse failed" })),
      invert: () => inv("a", { by: -1 }),
    });
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    const out = await registry.undo(ctx);
    expect(out.kind).toBe("unavailable");
    expect(registry.depth.undo).toBe(1);
  });

  it("reports an empty history rather than throwing", async () => {
    expect((await registry.undo(makeCtx())).kind).toBe("empty");
    expect((await registry.redo(makeCtx())).kind).toBe("empty");
  });

  it("bounds history at maxHistory", async () => {
    const bounded = createRegistry({ maxHistory: 3 });
    bounded.register(counter("a").d);
    const ctx = makeCtx();
    for (let i = 0; i < 10; i++) await bounded.dispatch(inv("a", { by: i }), ctx);
    expect(bounded.depth.undo).toBe(3);
  });
});

describe("middleware", () => {
  it("wraps dispatch outermost-first", async () => {
    const order: string[] = [];
    registry.register(counter("a").d);
    registry.use(async (i, next) => { order.push("outer-in"); const r = await next(); order.push("outer-out"); return r; });
    registry.use(async (i, next) => { order.push("inner-in"); const r = await next(); order.push("inner-out"); return r; });
    await registry.dispatch(inv("a", { by: 1 }), makeCtx());
    expect(order).toEqual(["outer-in", "inner-in", "inner-out", "outer-out"]);
  });

  it("sees every invocation — which is why the audit log is complete by construction", async () => {
    // The point: the log cannot miss an action, because there is no path to the document that bypasses the
    // bus. Completeness by construction rather than by remembering to log.
    const seen: string[] = [];
    registry.register(counter("a").d);
    registry.register(counter("b").d);
    registry.use(async (i, next) => { seen.push(i.commandId); return next(); });
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.dispatch(inv("b", { by: 2 }), ctx);
    await registry.undo(ctx); // undo goes through the bus too
    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("can be removed", async () => {
    const spy = vi.fn(async (_i: CommandInvocation, next: () => Promise<unknown>) => next());
    registry.register(counter("a").d);
    const off = registry.use(spy as never);
    await registry.dispatch(inv("a", { by: 1 }), makeCtx());
    off();
    await registry.dispatch(inv("a", { by: 1 }), makeCtx());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("keybindings — overrides are data", () => {
  it("resolves a default key", () => {
    registry.register({ ...counter("a").d, defaultKeys: ["mod+w"] });
    expect(registry.byKey("mod+w").map((d) => d.id)).toEqual(["a"]);
  });

  it("an override wins over the default", () => {
    registry.register({ ...counter("a").d, defaultKeys: ["mod+w"] });
    registry.register(counter("b").d);
    registry.bind("mod+w", "b");
    expect(registry.byKey("mod+w").map((d) => d.id)).toEqual(["b"]);
  });

  it("binding to null UNBINDS the key", () => {
    // A falsy check instead of `has()` would make unbinding impossible — the override would be ignored and
    // the default would come back, which reads as the setting not saving.
    registry.register({ ...counter("a").d, defaultKeys: ["mod+w"] });
    registry.bind("mod+w", null);
    expect(registry.byKey("mod+w")).toEqual([]);
  });
});

describe("macros — record and replay, with no new machinery", () => {
  it("records dispatched invocations", async () => {
    registry.register(counter("a").d);
    const rec = registry.record();
    const ctx = makeCtx();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    await registry.dispatch(inv("a", { by: 2 }), ctx);
    expect(rec.stop().map((i) => i.args)).toEqual([{ by: 1 }, { by: 2 }]);
  });

  it("replays a recording", async () => {
    const { d, applied } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    const rec = registry.record();
    await registry.dispatch(inv("a", { by: 4 }), ctx);
    await registry.dispatch(inv("a", { by: 6 }), ctx);
    const macro = rec.stop();

    applied.length = 0;
    const r = await replay(registry, macro, ctx, "m1");
    expect(r.ok).toBe(true);
    expect(applied).toEqual([4, 6]);
  });

  it("does not re-record during replay", async () => {
    // Otherwise replaying a macro while recording produces a macro containing itself.
    registry.register(counter("a").d);
    const ctx = makeCtx();
    const first = registry.record();
    await registry.dispatch(inv("a", { by: 1 }), ctx);
    const macro = first.stop();

    const second = registry.record();
    await replay(registry, macro, ctx, "m1");
    expect(second.stop()).toEqual([]);
  });

  it("stops at the first failure and says where", async () => {
    // Continuing would apply the rest of the macro to a state its later steps were never recorded against,
    // which produces plausible-looking wrong geometry rather than an error.
    let n = 0;
    registry.register({
      id: "a", title: "A", group: "t",
      args: [{ name: "by", kind: "number", prompt: "By" }],
      run: async () => (++n === 2 ? err({ code: "refused", message: "boom" }) : ok(1)),
    });
    const ctx = makeCtx();
    const macro = [inv("a", { by: 1 }), inv("a", { by: 2 }), inv("a", { by: 3 })];
    const r = await replay(registry, macro, ctx, "m1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/stopped at step 2/);
      expect(r.error.detail).toMatchObject({ index: 1, commandId: "a" });
    }
    expect(n).toBe(2); // step 3 never ran
  });

  it("a recording is a regression test", async () => {
    // The free consequence worth naming: the same list that replays a macro also asserts the sequence still
    // produces the same result.
    const { d, applied } = counter("a");
    registry.register(d);
    const ctx = makeCtx();
    const rec = registry.record();
    await registry.dispatch(inv("a", { by: 2 }), ctx);
    await registry.dispatch(inv("a", { by: 3 }), ctx);
    const macro = rec.stop();
    const firstRun = [...applied];

    applied.length = 0;
    await replay(registry, macro, ctx);
    expect(applied).toEqual(firstRun);
  });
});

describe("palette ranking", () => {
  beforeEach(() => {
    registry.register({ ...counter("wall").d, title: "Wall", verb: "WALL", aliases: ["W"], group: "author" });
    registry.register({ ...counter("window").d, title: "Add window", verb: "WINDOW", group: "author" });
    registry.register({ ...counter("measure").d, title: "Measure distance", verb: "DIST", group: "measure" });
  });

  it("ranks an exact verb or alias highest", () => {
    expect(rankForPalette(registry, makeCtx(), "w")[0]?.descriptor.id).toBe("wall");
  });

  it("ranks a title prefix above a substring", () => {
    const ranked = rankForPalette(registry, makeCtx(), "measure");
    expect(ranked[0]?.descriptor.id).toBe("measure");
  });

  it("boosts recently used commands", () => {
    // The thing you just used is overwhelmingly the thing you want next.
    const ranked = rankForPalette(registry, makeCtx(), "", ["window"]);
    expect(ranked[0]?.descriptor.id).toBe("window");
  });

  it("still LISTS dimmed commands, ranked last", () => {
    // Same dim-don't-hide rule as the ribbon: a palette that hides unavailable commands cannot teach anyone
    // what exists.
    registry.register({ ...counter("admin").d, title: "Purge model", cap: "admin" });
    const ranked = rankForPalette(registry, makeCtx(), "");
    const ids = ranked.map((r) => r.descriptor.id);
    expect(ids).toContain("admin");
    expect(ids[ids.length - 1]).toBe("admin");
    expect(ranked[ids.length - 1]?.availability.state).toBe("dimmed");
  });

  it("returns everything for an empty query", () => {
    expect(rankForPalette(registry, makeCtx(), "")).toHaveLength(3);
  });
});
