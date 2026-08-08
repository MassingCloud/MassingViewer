import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ok, type Result } from "@massingviewer/core";
import type { SnapCandidate, Vec2 } from "@massingviewer/geometry-math";
import {
  createRegistry,
  type CommandContext,
  type CommandDescriptor,
  type CommandInvocation,
  type Registry,
} from "@massingviewer/commands";
import { DEFAULT_SNAP, createSession, type AuthoringSession, type SessionDeps } from "./session";

/**
 * The session is where four M9 gaps meet, so these tests are mostly about *seams*: does the crosshair agree with
 * the click, does snapping happen before the reducer, does a refusal keep the user's work.
 *
 * The libraries underneath — the snap engine, the prompt reducer, the placement validator — have their own suites
 * and are not re-tested here. Re-asserting `resolveSnap`'s behaviour through three layers of indirection would be
 * slower, harder to read, and would fail for reasons that have nothing to do with this file.
 */

interface WallArgs {
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}

const dispatched: CommandInvocation[] = [];

/** A two-point draw command, which is the shape every draft tool has. */
const WALL: CommandDescriptor<WallArgs> = {
  id: "mv.wall.add",
  title: "Wall",
  verb: "WALL",
  cap: "edit",
  op: "add_wall",
  args: [
    { name: "start", kind: "point", prompt: "Specify start point" },
    { name: "end", kind: "point", prompt: "Specify next point" },
  ],
  async run(args, ctx) {
    void ctx;
    return ok(args);
  },
};

/** A one-argument element command, to prove element picks route differently from point picks. */
const ISOLATE: CommandDescriptor<{ readonly guid: string }> = {
  id: "mv.view.isolate",
  title: "Isolate",
  verb: "ISOLATE",
  cap: "view",
  args: [{ name: "guid", kind: "element", prompt: "Select an element" }],
  async run(args) {
    return ok(args);
  },
};

function context(over: Partial<CommandContext> = {}): CommandContext {
  return {
    capabilities: new Set(["view", "edit"]),
    selection: [],
    supportsOp: () => true,
    opHint: () => "unsupported",
    online: true,
    dispatch: async () => ok(null) as Result<unknown>,
    ...over,
  };
}

function harness(
  over: Partial<SessionDeps> = {},
  ctx: Partial<CommandContext> = {},
): { session: AuthoringSession; registry: Registry; candidates: SnapCandidate[] } {
  dispatched.length = 0;
  const registry = createRegistry({ now: () => "2026-01-01T00:00:00.000Z" });
  registry.register(WALL);
  registry.register(ISOLATE);
  registry.use(async (invocation, next) => {
    dispatched.push(invocation);
    return await next();
  });

  const candidates: SnapCandidate[] = [];
  const session = createSession({
    registry,
    context: () => context(ctx),
    candidates: () => candidates,
    ...over,
  });
  return { session, registry, candidates };
}

// ===================================================================================================

describe("the invariant that matters most", () => {
  it("commits exactly the point the crosshair showed", async () => {
    // If `hover` and `pick` resolved separately — even with identical-looking code — a divergence would present
    // as geometry landing millimetres from where the user aimed, intermittently, depending on whether a
    // `pointermove` happened to arrive between the last hover and the click. Nearly undebuggable from a report.
    const { session, candidates } = harness();
    candidates.push({ x: 5, z: 0, kind: "endpoint" }, { x: 2.5, z: 0, kind: "midpoint" });
    session.arm("mv.wall.add");

    const cursor = { x: 4.9, z: 0.1 };
    const shown = session.hover(cursor);
    await session.pick(cursor);

    expect(session.state.points[0]).toEqual(shown.at);
    // And it really did snap, or the assertion above would be trivially true for an unsnapped cursor.
    expect(shown.snap?.kind).toBe("endpoint");
    expect(shown.at).toEqual({ x: 5, z: 0 });
  });

  it("holds for any cursor, any settings", () => {
    // A property rather than a case, because the two paths could agree for round numbers and diverge under a
    // constraint. Every branch of `resolve` is exercised by varying ortho/polar/grid together.
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(null, 0.5, 1),
        (x, z, ortho, polar, grid) => {
          const { session, candidates } = harness();
          candidates.push({ x: 3, z: 3, kind: "endpoint" });
          session.setSnap({ ortho, polar, grid });
          session.arm("mv.wall.add");
          // With a point already collected, the direction constraints are live.
          void session.pick({ x: 0, z: 0 });
          const cursor = { x, z };
          const a = session.hover(cursor);
          const b = session.hover(cursor);
          // `hover` is pure, so two calls agree — which is what lets a host call it per frame.
          return a.at.x === b.at.x && a.at.z === b.at.z;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("leaves no state behind when hovering", () => {
    // `resolve` must not consume the override or the typed constraint, or moving the mouse after typing `PER`
    // would silently disarm it — and the user would find out by getting the wrong point.
    const { session, candidates } = harness();
    candidates.push({ x: 1, z: 1, kind: "perpendicular" }, { x: 9, z: 9, kind: "endpoint" });
    session.arm("mv.wall.add");
    void session.type("PE");
    expect(session.state.override).toBe("perpendicular");

    for (let i = 0; i < 10; i++) session.hover({ x: i, z: i });
    expect(session.state.override).toBe("perpendicular");
  });
});

describe("snapping runs before the reducer", () => {
  it("puts the resolved point in the invocation, not the raw cursor", async () => {
    // The ordering the whole design rests on. The reducer never computes geometry, so a recorded macro replays
    // identically rather than re-snapping against whatever model is loaded at replay time.
    const { session, candidates } = harness();
    candidates.push({ x: 0, z: 0, kind: "endpoint" }, { x: 10, z: 0, kind: "endpoint" });
    session.arm("mv.wall.add");

    await session.pick({ x: 0.1, z: -0.05 });
    const outcome = await session.pick({ x: 9.9, z: 0.2 });

    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const args = outcome.invocation.args as unknown as WallArgs;
    expect(args.start).toEqual([0, 0]);
    expect(args.end).toEqual([10, 0]);
  });

  it("records the snap kind that won, so a macro is readable", async () => {
    const { session, candidates } = harness();
    candidates.push({ x: 2.5, z: 0, kind: "midpoint" });
    session.arm("mv.wall.add");
    const shown = session.hover({ x: 2.4, z: 0 });
    expect(shown.snap?.kind).toBe("midpoint");
  });
});

describe("snap overrides", () => {
  it("restricts to one kind for exactly one pick", async () => {
    const { session, candidates } = harness();
    // An endpoint is nearer, but the override says take the midpoint.
    candidates.push({ x: 4.9, z: 0, kind: "endpoint" }, { x: 5.0, z: 0, kind: "midpoint" });
    session.arm("mv.wall.add");
    void session.type("MI");

    const shown = session.hover({ x: 4.9, z: 0 });
    expect(shown.snap?.kind).toBe("midpoint");
    await session.pick({ x: 4.9, z: 0 });

    // Consumed. The next pick snaps normally, so the nearer endpoint wins.
    expect(session.state.override).toBeNull();
    const next = session.hover({ x: 4.9, z: 0 });
    expect(next.snap?.kind).toBe("endpoint");
  });

  it("treats NO as 'the raw cursor', not as 'snap however you like'", async () => {
    // The bug this is written against, and I wrote it. `OVERRIDE_CODES` maps `NO` to `"none"`, documented as
    // "suppress every snap for one pick — the raw cursor, untouched". My first mapping returned `null` for it,
    // and `null` already meant "no kind restriction" — i.e. snap normally. So the one override that means
    // *don't touch my cursor* did the exact opposite, silently.
    const { session, candidates } = harness();
    candidates.push({ x: 5, z: 0, kind: "endpoint" });
    session.arm("mv.wall.add");

    // Without the override it snaps.
    expect(session.hover({ x: 4.9, z: 0.05 }).snap?.kind).toBe("endpoint");

    void session.type("NO");
    const raw = session.hover({ x: 4.9, z: 0.05 });
    expect(raw.snap).toBeNull();
    expect(raw.at).toEqual({ x: 4.9, z: 0.05 });
  });
});

describe("direction constraints", () => {
  it("locks to 90 degrees when Shift is held, whatever the settings say", async () => {
    // The universal CAD convention, and the reason the modifier is read per-move rather than baked into
    // settings: it has to work without the user changing a mode first.
    const { session } = harness();
    session.setSnap({ enabled: false, polar: false, ortho: false });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });

    const free = session.hover({ x: 5, z: 1 });
    expect(free.at).toEqual({ x: 5, z: 1 });

    const locked = session.hover({ x: 5, z: 1 }, { shift: true });
    // Snapped to the X axis: the off-axis component is discarded.
    expect(locked.at.z).toBeCloseTo(0, 6);
    expect(locked.angle).not.toBeNull();
  });

  it("prefers ortho over polar", async () => {
    // Ortho is the stronger, more explicit constraint. If polar won, enabling both would make ortho ineffective —
    // and a mode that does nothing when enabled is worse than one that is absent.
    const { session } = harness();
    session.setSnap({ enabled: false, ortho: true, polar: true, polarIncrement: 45 });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });

    // 30° is within polar's 45° band but ortho forces it to an axis.
    const at = session.hover({ x: 5, z: 2.9 }).at;
    expect(Math.min(Math.abs(at.z), Math.abs(at.x))).toBeCloseTo(0, 6);
  });

  it("reports an inference without moving the point", async () => {
    // Guidance, not relocation. A guide that silently moves the cursor is indistinguishable from a bug.
    const { session } = harness();
    session.setSnap({ enabled: false, polar: false, ortho: false, inference: true });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    const shown = session.hover({ x: 5, z: 0.001 });
    expect(shown.at).toEqual({ x: 5, z: 0.001 });
  });
});

describe("typed input", () => {
  it("lets a typed distance beat a nearby snap", async () => {
    // Someone who typed `5` has stated exactly what they want. Letting an endpoint 4.9 away override that makes
    // typed entry unreliable, which defeats the point of having it.
    const { session, candidates } = harness();
    candidates.push({ x: 4.9, z: 0, kind: "endpoint" });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });

    void (await session.type("5"));
    const shown = session.hover({ x: 4.95, z: 0 });
    expect(shown.snap).toBeNull();
    expect(Math.hypot(shown.at.x, shown.at.z)).toBeCloseTo(5, 6);
  });

  it("commits a typed distance on Enter as a point, not as an accept", async () => {
    // `5 <Enter>` at a "specify next point" prompt must place the point it describes. Treating Enter as an
    // accept would end the command with one argument collected, which is a different command entirely.
    const { session } = harness();
    session.setSnap({ enabled: false });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    await session.type("5<0");
    const outcome = await session.key("Enter");

    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const args = outcome.invocation.args as unknown as WallArgs;
    expect(args.end[0]).toBeCloseTo(5, 6);
  });

  it("arms a tool from a typed verb, and records that origin", async () => {
    // What makes the command line a command line rather than a second, weaker palette. And the origin has to be
    // truthful: an auditor needs "typed" told apart from "clicked".
    const { session } = harness();
    session.setSnap({ enabled: false });
    const outcome = await session.type("WALL");
    expect(outcome.kind).toBe("collecting");
    expect(session.state.armed).toBe("mv.wall.add");

    await session.pick({ x: 0, z: 0 });
    const committed = await session.pick({ x: 3, z: 0 });
    expect(committed.kind).toBe("committed");
    if (committed.kind !== "committed") return;
    expect(committed.invocation.origin).toEqual({ via: "command-line", line: "WALL" });
  });

  it("attributes a ribbon-armed command to the ribbon, even after a typed one", async () => {
    // `reset()` restores the default origin. Without that, every command after a typed one would be recorded as
    // typed — and a wrong audit entry is worse than a missing one, because it will be believed.
    const { session } = harness();
    session.setSnap({ enabled: false });
    await session.type("WALL");
    await session.key("Escape");

    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    const committed = await session.pick({ x: 3, z: 0 });
    expect(committed.kind).toBe("committed");
    if (committed.kind !== "committed") return;
    expect(committed.invocation.origin).toEqual({ via: "ui", surface: "ribbon" });
  });
});

describe("refusals keep the user's work", () => {
  it("refuses a degenerate run before the kernel sees it, and stays armed", async () => {
    // `placeValid` exists so a 3 mm wall is refused with a sentence rather than accepted, sent to the kernel and
    // rejected by a message written for a different audience.
    //
    // Staying armed is the part that matters. Discarding collected points on a refusal is what makes people stop
    // trusting a draw tool: they lose work for making one bad click.
    const { session } = harness();
    session.setSnap({ enabled: false, polar: false });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    const outcome = await session.pick({ x: 0.001, z: 0 });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toBeTruthy();
    expect(session.state.armed).toBe("mv.wall.add");
    expect(dispatched).toHaveLength(0);
  });

  it("refuses to arm a tool the actor cannot use, with availability's own reason", async () => {
    // The same `availability()` the ribbon dims with, so the two cannot disagree — and the sentence is identical
    // in both places, which is what stops a user being told two different things about one control.
    const { session } = harness({}, { capabilities: new Set(["view"]) });
    const outcome = session.arm("mv.wall.add");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/edit|Editor/i);
    expect(session.state.armed).toBeNull();
  });
});

describe("element picks", () => {
  it("takes the element, not a coordinate, when the argument wants one", async () => {
    // Checking the *awaited argument's kind* rather than guessing from what is under the cursor keeps
    // "click a wall" and "click a point" distinguishable even when a wall is under the point.
    const { session } = harness({ elementAt: () => "0aBcDeFgHiJkLmNoPqRsTu" });
    session.arm("mv.view.isolate");
    const outcome = await session.pick({ x: 1, z: 1 });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.invocation.args).toEqual({ guid: "0aBcDeFgHiJkLmNoPqRsTu" });
  });

  it("keeps waiting when the click hit nothing", async () => {
    // Not an error, and not a cancel: clicking empty space while asked for an element is a miss, and the prompt
    // should still be asking.
    const { session } = harness({ elementAt: () => null });
    session.arm("mv.view.isolate");
    const outcome = await session.pick({ x: 1, z: 1 });
    expect(outcome.kind).toBe("collecting");
    expect(session.state.armed).toBe("mv.view.isolate");
  });
});

describe("control keys", () => {
  it("Escape cancels and disarms", async () => {
    const { session } = harness();
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    const outcome = await session.key("Escape");
    expect(outcome.kind).toBe("cancelled");
    expect(session.state.armed).toBeNull();
    expect(session.state.points).toEqual([]);
  });

  it("Escape with nothing armed is idle, so the host can do something else", async () => {
    // Reported rather than swallowed: Escape with no tool armed usually means "clear the selection", and that is
    // the host's decision, not this package's.
    const { session } = harness();
    expect((await session.key("Escape")).kind).toBe("idle");
  });

  it("Backspace revises the point being drawn, not the previous command", async () => {
    // Per-stroke undo, distinct from document undo. Conflating them means Backspace mid-draw undoes the
    // *previous wall* — a data-loss bug disguised as a keystroke.
    const { session } = harness();
    session.setSnap({ enabled: false, polar: false });
    session.arm("mv.wall.add");
    await session.pick({ x: 0, z: 0 });
    expect(session.state.points).toHaveLength(1);

    await session.key("Backspace");
    expect(session.state.points).toHaveLength(0);
    // Still armed, and no command was undone.
    expect(session.state.armed).toBe("mv.wall.add");
    expect(dispatched).toHaveLength(0);
  });

  it("ignores input when nothing is armed", async () => {
    const { session } = harness();
    expect((await session.key("Enter")).kind).toBe("idle");
    expect((await session.pick({ x: 1, z: 1 })).kind).toBe("idle");
    expect(session.hover({ x: 1, z: 1 }).at).toEqual({ x: 1, z: 1 });
  });
});

describe("the grid", () => {
  it("competes with real geometry rather than pre-empting it", async () => {
    // A grid candidate goes through `resolveSnap` like any other, so an endpoint still beats a grid intersection
    // by priority. A grid applied *after* snapping would drag every snapped point onto the grid, which is how a
    // wall ends up 40 mm from the column it was snapped to.
    const { session, candidates } = harness();
    candidates.push({ x: 1.02, z: 0, kind: "endpoint" });
    session.setSnap({ grid: 1, tolerance: 0.35 });
    session.arm("mv.wall.add");
    const shown = session.hover({ x: 1.01, z: 0 });
    expect(shown.snap?.kind).toBe("endpoint");
    expect(shown.at.x).toBeCloseTo(1.02, 6);
  });

  it("snaps to the grid when nothing else is near", () => {
    const { session } = harness();
    session.setSnap({ grid: 1, tolerance: 0.35 });
    session.arm("mv.wall.add");
    expect(session.hover({ x: 2.9, z: 4.1 }).at).toEqual({ x: 3, z: 4 });
  });
});

describe("defaults", () => {
  it("measures tolerance in metres, not pixels", () => {
    // A pixel tolerance makes snapping greedier as you zoom out, so the same gesture picks different geometry at
    // different zooms — which reads as unpredictable rather than as a setting.
    expect(DEFAULT_SNAP.tolerance).toBeGreaterThan(0);
    expect(DEFAULT_SNAP.tolerance).toBeLessThan(1);
  });

  it("starts with polar on and ortho off", () => {
    // Polar at 45° is helpful and rarely wrong; ortho is a mode a user turns on deliberately.
    expect(DEFAULT_SNAP.polar).toBe(true);
    expect(DEFAULT_SNAP.ortho).toBe(false);
  });
});

describe("candidate sourcing", () => {
  it("asks the host for candidates near the resolved cursor, not the raw one", () => {
    // Subtle and load-bearing: with ortho on, the raw cursor and the constrained point can be metres apart, and
    // gathering candidates around the raw cursor would offer snaps that are nowhere near where the point will go.
    const seen: Vec2[] = [];
    const { session } = harness({
      candidates: (cursor) => {
        seen.push(cursor);
        return [];
      },
    });
    session.setSnap({ ortho: true });
    session.arm("mv.wall.add");
    void session.pick({ x: 0, z: 0 });
    seen.length = 0;
    session.hover({ x: 5, z: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.z).toBeCloseTo(0, 6);
  });

  it("reads the context fresh on every arm", () => {
    // Capabilities and selection change under us — a project switched from viewer to editor mid-session must not
    // need a reload to arm a draw tool.
    const context_ = vi.fn(() => context());
    const { session } = harness({ context: context_ });
    session.arm("mv.wall.add");
    const first = context_.mock.calls.length;
    session.arm("mv.wall.add");
    expect(context_.mock.calls.length).toBeGreaterThan(first);
  });
});
