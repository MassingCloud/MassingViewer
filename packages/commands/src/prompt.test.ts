import { describe, expect, it, vi } from "vitest";
import { ok } from "@massingviewer/core";
import type { CommandContext, CommandDescriptor } from "./descriptor";
import { begin, step, toInvocation, type PromptEvent, type PromptState } from "./prompt";

/**
 * The prompt loop.
 *
 * These tests exist with **nothing mocked** — no DOM, no viewport, no kernel, no clock — which is the entire
 * reason the reducer is pure. The equivalent logic in a conventional CAD viewer lives inside event handlers
 * holding mutable state, and is therefore untested in practice.
 */

const ctx: CommandContext = {
  capabilities: new Set(["edit"]),
  selection: [],
  supportsOp: () => true,
  opHint: () => "unavailable",
  online: true,
  dispatch: async () => ok(undefined),
};

interface WallArgs {
  start: readonly [number, number];
  end: readonly [number, number];
  height: number;
}

const wall: CommandDescriptor<WallArgs> = {
  id: "mv.draft.wall",
  title: "Wall",
  verb: "WALL",
  aliases: ["W"],
  group: "author",
  args: [
    { name: "start", kind: "point", prompt: "Specify start point" },
    { name: "end", kind: "point", prompt: "Specify end point" },
    { name: "height", kind: "length", prompt: "Height", unit: "m", default: 3 },
  ],
  run: async () => ok({ created: ["guid"] }),
};

interface PolyArgs {
  outline: readonly (readonly [number, number])[];
}

const polyline: CommandDescriptor<PolyArgs> = {
  id: "mv.draft.slab",
  title: "Slab",
  verb: "SLAB",
  group: "author",
  args: [
    {
      name: "outline",
      kind: "point-list",
      prompt: "Specify next point",
      keywords: [
        { key: "C", label: "Close" },
        { key: "U", label: "Undo" },
      ],
    },
  ],
  run: async () => ok({ created: ["guid"] }),
};

/** Drive a sequence of events, so a test reads like the interaction it describes. */
function drive<A extends object>(
  d: CommandDescriptor<A>,
  events: readonly PromptEvent[],
): PromptState<A> {
  let s = begin(d, ctx);
  for (const e of events) s = step(d, s, e, ctx);
  return s;
}

describe("begin", () => {
  it("prompts for the first argument", () => {
    const s = begin(wall, ctx);
    expect(s.status).toBe("collecting");
    expect(s.prompt).toBe("Specify start point");
    expect(s.awaiting?.name).toBe("start");
  });

  it("applies defaults up front", () => {
    // So a command whose arguments all have defaults is immediately `ready`. A zero-argument command must not
    // require an Enter it never prompted for.
    const s = begin(wall, ctx);
    expect((s.collected as Partial<WallArgs>).height).toBe(3);
  });

  it("is immediately ready for a command with no arguments", () => {
    const noArgs: CommandDescriptor = {
      id: "mv.view.fit", title: "Fit", group: "look", args: [], run: async () => ok(undefined),
    };
    expect(begin(noArgs, ctx).status).toBe("ready");
  });

  it("renders bracketed keywords into the prompt", () => {
    expect(begin(polyline, ctx).prompt).toBe("Specify next point or [Close/Undo]");
  });
});

describe("collecting points", () => {
  it("advances through the arguments and becomes ready", () => {
    const s = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    // `height` had a default, so the loop skips it and completes on the second point.
    expect(s.status).toBe("ready");
    expect(s.collected).toEqual({ start: [0, 0], end: [5, 0], height: 3 });
  });

  it("accumulates a variadic point list without advancing", () => {
    const s = drive(polyline, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [4, 0] },
      { t: "pick-point", at: [4, 3] },
    ]);
    expect(s.status).toBe("collecting");
    expect(s.points).toHaveLength(3);
  });

  it("changes the prompt once a variadic argument is completable", () => {
    // Otherwise there is no cue that Enter is now meaningful.
    const one = drive(polyline, [{ t: "pick-point", at: [0, 0] }]);
    expect(one.prompt).not.toContain("Enter to finish");
    const two = step(polyline, one, { t: "pick-point", at: [4, 0] }, ctx);
    expect(two.prompt).toContain("Enter to finish");
  });

  it("Enter finishes a variadic argument", () => {
    const s = drive(polyline, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [4, 0] },
      { t: "pick-point", at: [4, 3] },
      { t: "accept" },
    ]);
    expect(s.status).toBe("ready");
    expect((s.collected as Partial<PolyArgs>).outline).toHaveLength(3);
  });

  it("refuses to finish a polyline with fewer than 2 points", () => {
    // Accepting one point would author a degenerate element the kernel then has to refuse — a round-trip to
    // learn something knowable locally.
    const s = drive(polyline, [{ t: "pick-point", at: [0, 0] }, { t: "accept" }]);
    expect(s.status).toBe("collecting");
    expect(s.error).toMatch(/at least 2 points/);
  });

  it("rejects a point where one is not expected", () => {
    const s = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
      { t: "pick-point", at: [9, 9] }, // already ready
    ]);
    expect(s.status).toBe("ready");
    expect(s.collected).toEqual({ start: [0, 0], end: [5, 0], height: 3 });
  });
});

describe("typed input", () => {
  it("parses a typed coordinate", () => {
    const s = drive(wall, [{ t: "token", text: "2,3" }]);
    expect((s.collected as Partial<WallArgs>).start).toEqual([2, 3]);
  });

  it("parses a typed length", () => {
    const s = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    expect(s.status).toBe("ready");
    // Height was defaulted; override it by going back and typing.
    const back = step(wall, s, { t: "back" }, ctx);
    const typed = step(wall, back, { t: "token", text: "2.7" }, ctx);
    expect((typed.collected as Partial<WallArgs>).height).toBe(2.7);
  });

  it("a bad token is NON-FATAL and keeps everything collected", () => {
    // The behaviour this branch exists for: losing three placed points to one typo is the single most
    // annoying thing a CAD tool can do, and a tool that disarms on bad input trains users to type nothing.
    const s = drive(polyline, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [4, 0] },
      { t: "token", text: "not a point" },
    ]);
    expect(s.status).toBe("collecting");
    expect(s.error).toBeTruthy();
    expect(s.points).toHaveLength(2); // nothing lost
  });

  it("clears the error once valid input arrives", () => {
    const bad = drive(wall, [{ t: "token", text: "nope" }]);
    expect(bad.error).toBeTruthy();
    const good = step(wall, bad, { t: "token", text: "1,1" }, ctx);
    expect(good.error).toBeUndefined();
  });

  it("uses a custom parser when the argument supplies one", () => {
    // How the AutoCAD grammar (`@dx,dy`, `d<a`) and imperial lengths get in without a second parser existing
    // here to drift from the first.
    const parse = vi.fn(() => ok([99, 99] as const));
    const custom: CommandDescriptor<{ p: readonly [number, number] }> = {
      id: "x", title: "X", group: "g",
      args: [{ name: "p", kind: "point", prompt: "Point", parse }],
      run: async () => ok(undefined),
    };
    const s = drive(custom, [{ t: "token", text: "@5<30" }]);
    expect(parse).toHaveBeenCalledWith("@5<30", ctx);
    expect(s.collected).toEqual({ p: [99, 99] });
  });

  it("runs validate after parse and reports its failure", () => {
    const custom: CommandDescriptor<{ n: number }> = {
      id: "x2", title: "X", group: "g",
      args: [{
        name: "n", kind: "number", prompt: "N",
        validate: (v) => (v > 10 ? ok(v) : { ok: false, error: { code: "invalid_param", message: "must exceed 10" } }),
      }],
      run: async () => ok(undefined),
    };
    expect(drive(custom, [{ t: "token", text: "5" }]).error).toBe("must exceed 10");
    expect(drive(custom, [{ t: "token", text: "50" }]).status).toBe("ready");
  });

  it.each([
    ["a length of zero", "length", "0", true],
    ["a negative length", "length", "-3", true],
    ["a non-integer integer", "integer", "1.5", true],
    ["a valid integer", "integer", "4", false],
    ["yes as a boolean", "boolean", "yes", false],
    ["nonsense as a boolean", "boolean", "maybe", true],
  ] as const)("%s", (_label, kind, text, shouldFail) => {
    const d: CommandDescriptor<{ v: unknown }> = {
      id: `t.${kind}.${text}`, title: "T", group: "g",
      args: [{ name: "v", kind, prompt: "V" }],
      run: async () => ok(undefined),
    };
    const s = drive(d, [{ t: "token", text }]);
    expect(Boolean(s.error), `${kind} '${text}'`).toBe(shouldFail);
  });

  it("matches an enum case-insensitively and returns the canonical casing", () => {
    const d: CommandDescriptor<{ side: string }> = {
      id: "t.enum", title: "T", group: "g",
      args: [{ name: "side", kind: "enum", prompt: "Side", options: ["Left", "Right"] }],
      run: async () => ok(undefined),
    };
    expect((drive(d, [{ t: "token", text: "left" }]).collected as { side?: string }).side).toBe("Left");
  });
});

describe("keywords", () => {
  it("accepts a keyword by key", () => {
    const s = drive(polyline, [{ t: "keyword", key: "C" }]);
    expect((s.collected as Partial<PolyArgs>).outline).toBe("C");
  });

  it("accepts a keyword typed by key or by label", () => {
    // A keyboard-only user reaches keywords by typing them; requiring a click would be an accessibility gap.
    expect(drive(polyline, [{ t: "token", text: "c" }]).status).toBe("ready");
    expect(drive(polyline, [{ t: "token", text: "Close" }]).status).toBe("ready");
  });

  it("reports an unknown keyword without cancelling", () => {
    const s = drive(polyline, [{ t: "pick-point", at: [0, 0] }, { t: "keyword", key: "Z" }]);
    expect(s.error).toMatch(/Unknown option/);
    expect(s.points).toHaveLength(1);
  });
});

describe("back", () => {
  it("removes the last point of a variadic argument", () => {
    const s = drive(polyline, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [4, 0] },
      { t: "back" },
    ]);
    expect(s.points).toEqual([[0, 0]]);
  });

  it("steps back to the previous argument and clears its value", () => {
    const s = drive(wall, [{ t: "pick-point", at: [0, 0] }, { t: "back" }]);
    expect(s.awaiting?.name).toBe("start");
    expect((s.collected as Partial<WallArgs>).start).toBeUndefined();
  });

  it("is a no-op at the first argument rather than cancelling", () => {
    // Backspace on an empty prompt must not disarm the tool.
    const s = drive(wall, [{ t: "back" }]);
    expect(s.status).toBe("collecting");
    expect(s.cursor).toBe(0);
  });
});

describe("cancel", () => {
  it("is terminal and ignores subsequent events", () => {
    const s = drive(wall, [{ t: "cancel" }, { t: "pick-point", at: [1, 1] }]);
    expect(s.status).toBe("cancelled");
    expect(s.collected).toEqual({ height: 3 });
  });
});

describe("dynamic input", () => {
  it("commits a typed distance to a length argument", () => {
    const s = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
      { t: "back" },
      { t: "dyn", distance: 2.4 },
    ]);
    expect((s.collected as Partial<WallArgs>).height).toBe(2.4);
  });

  it("reports when dynamic input does not apply to the current step", () => {
    const s = drive(wall, [{ t: "dyn", distance: 5 }]);
    expect(s.error).toMatch(/does not apply/);
  });
});

describe("toInvocation — the single exit into serializability", () => {
  it("produces a serializable invocation", () => {
    const s = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    const inv = toInvocation(s, { via: "ui", surface: "ribbon" }, 1, "2026-08-06T00:00:00.000Z");
    expect(inv.commandId).toBe("mv.draft.wall");
    expect(inv.args).toEqual({ start: [0, 0], end: [5, 0], height: 3 });
    expect(inv.seq).toBe(1);
    // The property everything downstream rests on: it must survive a structured clone to cross a worker
    // boundary, land in the audit log, and be replayable.
    expect(structuredClone(inv)).toEqual(inv);
    expect(JSON.parse(JSON.stringify(inv))).toEqual(inv);
  });

  it("throws on a half-collected prompt", () => {
    // Committing a partial argument bag would put it in the undo history and the audit log, and the failure
    // would surface later, elsewhere, as a command that cannot be replayed.
    const s = begin(wall, ctx);
    expect(() => toInvocation(s, { via: "ui", surface: "ribbon" }, 1, "t")).toThrow(/only 'ready'/);
  });

  it("throws on a cancelled prompt", () => {
    const s = drive(wall, [{ t: "cancel" }]);
    expect(() => toInvocation(s, { via: "ui", surface: "ribbon" }, 1, "t")).toThrow(/cancelled/);
  });

  it("records where the command came from", () => {
    // Load-bearing in four places: macro replay must not re-record, a remote peer's op must not echo, the
    // audit log needs it, and "repeat last command" needs to know the last thing was a real action.
    const s = drive(wall, [{ t: "pick-point", at: [0, 0] }, { t: "pick-point", at: [1, 0] }]);
    const inv = toInvocation(s, { via: "command-line", line: "WALL 0,0 1,0" }, 7, "t");
    expect(inv.origin).toEqual({ via: "command-line", line: "WALL 0,0 1,0" });
  });
});

describe("determinism", () => {
  it("the same event sequence always yields the same state", () => {
    // What makes a recorded macro a reliable regression test, and why snapping happens BEFORE the reducer.
    const events: PromptEvent[] = [
      { t: "pick-point", at: [0, 0] },
      { t: "token", text: "bad" },
      { t: "pick-point", at: [5, 0] },
    ];
    expect(drive(wall, events)).toEqual(drive(wall, events));
  });

  it("step never mutates the state it is given", () => {
    const before = begin(wall, ctx);
    const snapshot = structuredClone({ ...before, awaiting: null });
    step(wall, before, { t: "pick-point", at: [1, 2] }, ctx);
    expect(structuredClone({ ...before, awaiting: null })).toEqual(snapshot);
  });
});

describe("a ready prompt is not terminal", () => {
  // Regression for a real bug in the first version of the guard: it allowed only `accept` on a `ready` state,
  // so a command with every argument collected but not yet committed could be neither revised nor abandoned.
  // Both of those are standard CAD behaviour and their absence is the kind of thing that makes a tool feel
  // broken without anyone being able to name why.

  it("back revises the last argument after the prompt is ready", () => {
    const ready = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    expect(ready.status).toBe("ready");

    const back = step(wall, ready, { t: "back" }, ctx);
    expect(back.status).toBe("collecting");
    expect(back.awaiting?.name).toBe("height");
    expect((back.collected as Partial<WallArgs>).height).toBeUndefined();

    const revised = step(wall, back, { t: "token", text: "2.7" }, ctx);
    expect(revised.status).toBe("ready");
    expect((revised.collected as Partial<WallArgs>).height).toBe(2.7);
  });

  it("cancel abandons a ready-but-uncommitted command", () => {
    const ready = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    expect(step(wall, ready, { t: "cancel" }, ctx).status).toBe("cancelled");
  });

  it("ignores a stray pick after the command is ready", () => {
    // Normal, not an error: a pointer-up can arrive after the click that completed the command.
    const ready = drive(wall, [
      { t: "pick-point", at: [0, 0] },
      { t: "pick-point", at: [5, 0] },
    ]);
    const after = step(wall, ready, { t: "pick-point", at: [9, 9] }, ctx);
    expect(after).toBe(ready);
    expect(after.error).toBeUndefined();
  });
});
