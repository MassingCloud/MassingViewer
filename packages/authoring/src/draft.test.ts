import { describe, expect, it, vi } from "vitest";
import { ok, type Result } from "@massing/core";
import { availability, createRegistry, type CommandContext } from "@massing/commands";
import { draftCommands } from "./draft.js";

/**
 * The draft command descriptors.
 *
 * These are the declaration that was missing: `createRegistry()` was being called with nothing registered, so
 * `session.arm("mv.draft.wall")` had no command to arm and every ribbon draw button pointed at nothing.
 *
 * What is worth testing here is not that `apply` gets called — it is the four things a descriptor can get wrong
 * in a way no type checks: the parameters it sends, what it refuses before a round trip, whether its inverse is
 * usable, and whether it dims for the right reason.
 */

/** A recording `apply`, returning fresh GlobalIds so `invert` has something to name. */
function fakeApply() {
  let n = 0;
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const apply = vi.fn(
    async (op: string, params: Readonly<Record<string, unknown>>): Promise<Result<{ created: string[] }>> => {
      calls.push({ op, params: { ...params } });
      n += 1;
      return ok({ created: [`0DraftGuid${String(n).padStart(12, "0")}`] });
    },
  );
  return { apply, calls };
}

function context(over: Partial<CommandContext> = {}): CommandContext {
  return {
    capabilities: new Set(["view", "edit"] as const),
    selection: [],
    supportsOp: () => true,
    opHint: () => "unsupported",
    online: true,
    dispatch: async () => ok(undefined),
    ...over,
  } as CommandContext;
}

const byId = (deps: Parameters<typeof draftCommands>[0], id: string) =>
  draftCommands(deps).find((c) => c.id === id)!;

describe("the set of commands", () => {
  it("registers cleanly, which is the whole point", () => {
    const { apply } = fakeApply();
    const registry = createRegistry();
    for (const command of draftCommands({ apply })) registry.register(command);
    // Every draw verb the ribbon offers now resolves to something armable.
    expect(registry.get("mv.draft.wall")).toBeDefined();
    expect(registry.get("mv.draft.slab")).toBeDefined();
    expect(registry.get("mv.draft.column")).toBeDefined();
  });

  it("includes the delete command its own inverses name", () => {
    // A dangling `commandId` in an inverse fails at *undo* time, long after the action, and reports as "cannot be
    // reversed" rather than as a wiring mistake. Asserting the pair exists together is cheap.
    const ids = draftCommands({ apply: fakeApply().apply }).map((c) => c.id);
    expect(ids).toContain("mv.edit.delete");
  });

  it("declares the kernel operation each one needs", () => {
    // `requiresOp` is what makes the ribbon dim with the kernel's own hint instead of failing on click. A
    // descriptor without it looks enabled against a kernel that cannot run it.
    const commands = draftCommands({ apply: fakeApply().apply });
    for (const command of commands) expect(command.requiresOp, `${command.id} declares no op`).toBeDefined();
  });
});

describe("mv.draft.wall", () => {
  it("sends the two points and the height the kernel expects", async () => {
    const { apply, calls } = fakeApply();
    const wall = byId({ apply }, "mv.draft.wall");
    const result = await wall.run({ start: [0, 0], end: [5, 0], height: 2.7 }, context());

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.op).toBe("add_wall");
    expect(calls[0]!.params).toMatchObject({ start: [0, 0], end: [5, 0], height: 2.7 });
  });

  it("falls back to the default height, and takes an override", async () => {
    const { apply, calls } = fakeApply();
    await byId({ apply }, "mv.draft.wall").run({ start: [0, 0], end: [1, 0] }, context());
    expect(calls[0]!.params.height).toBe(3);

    const custom = fakeApply();
    await byId({ apply: custom.apply, defaults: { wallHeight: 4.2 } }, "mv.draft.wall").run(
      { start: [0, 0], end: [1, 0] },
      context(),
    );
    expect(custom.calls[0]!.params.height).toBe(4.2);
  });

  it("refuses a zero-length wall before spending a round trip", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.draft.wall").run({ start: [2, 2], end: [2, 2] }, context());

    expect(result.ok).toBe(false);
    // Not sent. A double-click is the commonest way to produce this, and the honest place to say so is here
    // rather than as "degenerate geometry" from a kernel the user never addressed.
    expect(calls).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe("degenerate_geometry");
      // The message states the measurement, so the user can tell a double-click from a snap that missed.
      expect(result.error.message).toContain("mm apart");
    }
  });

  it("accepts a wall just over the 1 mm threshold", async () => {
    // The boundary in the direction that matters: a refusal that is too eager blocks legitimate detail work.
    const { apply } = fakeApply();
    const result = await byId({ apply }, "mv.draft.wall").run({ start: [0, 0], end: [0.002, 0] }, context());
    expect(result.ok).toBe(true);
  });

  it("refuses when a point is missing rather than sending a partial wall", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.draft.wall").run({ start: [0, 0] }, context());
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("inverts into a delete of exactly what it created", async () => {
    const { apply } = fakeApply();
    const wall = byId({ apply }, "mv.draft.wall");
    const result = await wall.run({ start: [0, 0], end: [5, 0] }, context());
    if (!result.ok) throw new Error("expected the wall to apply");

    const inverse = wall.invert!({ start: [0, 0], end: [5, 0] }, result.value);
    expect(inverse).toBeDefined();
    expect(inverse!.commandId).toBe("mv.edit.delete");
    expect(inverse!.args).toEqual({ guids: [(result.value as { created: string[] }).created[0]] });
  });

  it("tags its inverse `replay`, so undoing does not get recorded into a macro", async () => {
    const { apply } = fakeApply();
    const wall = byId({ apply }, "mv.draft.wall");
    const result = await wall.run({ start: [0, 0], end: [5, 0] }, context());
    if (!result.ok) throw new Error("expected the wall to apply");
    const inverse = wall.invert!({}, result.value)!;
    // `Registry.dispatch` excludes `macro` and `replay` origins from an in-progress recording. Tagged `ui`, a
    // macro would capture the undo and replaying it would draw a wall and then delete it.
    expect(inverse.origin.via).toBe("replay");
  });

  it("stamps its inverse from the registry's own clock when one is wired", async () => {
    const { apply } = fakeApply();
    const registry = createRegistry();
    const wall = byId({ apply, stamp: () => ({ seq: registry.nextSeq(), at: registry.now() }) }, "mv.draft.wall");
    const result = await wall.run({ start: [0, 0], end: [5, 0] }, context());
    if (!result.ok) throw new Error("expected the wall to apply");
    const inverse = wall.invert!({}, result.value)!;
    // `seq` orders the audit journal. Left at 0, every inverse sorts before every action.
    expect(inverse.seq).toBeGreaterThan(0);
    expect(inverse.at).not.toBe("");
  });

  it("does not claim an inverse when nothing was created", () => {
    const { apply } = fakeApply();
    const wall = byId({ apply }, "mv.draft.wall");
    // `undefined` makes the registry dim Undo with a stated reason. An invocation deleting nothing would instead
    // fail at undo time and report as "cannot be reversed", which is a different and misleading claim.
    expect(wall.invert!({}, { created: [] })).toBeUndefined();
  });
});

describe("mv.draft.slab", () => {
  it("sends the outline and thickness", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.draft.slab").run(
      { outline: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.25 },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(calls[0]!.op).toBe("add_slab");
    expect(calls[0]!.params).toMatchObject({ outline: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.25 });
  });

  it("refuses fewer than three points, and says how many it got", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.draft.slab").run({ outline: [[0, 0], [1, 1]] }, context());
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    if (!result.ok) expect(result.error.message).toContain("got 2");
  });

  it("offers Close and Undo keywords, or a polygon tool has no way to finish", () => {
    const outline = byId({ apply: fakeApply().apply }, "mv.draft.slab").args[0]!;
    expect(outline.kind).toBe("point-list");
    const keys = (outline.keywords ?? []).map((k) => k.key);
    expect(keys).toContain("C");
    expect(keys).toContain("U");
  });

  it("drops a malformed point rather than forwarding it as NaN", async () => {
    const { apply, calls } = fakeApply();
    // A NaN coordinate reaching the kernel produces geometry that renders as nothing and reports no error.
    const result = await byId({ apply }, "mv.draft.slab").run(
      { outline: [[0, 0], [4, 0], ["x", 3], [0, 3]] },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(calls[0]!.params.outline).toEqual([[0, 0], [4, 0], [0, 3]]);
  });
});

describe("mv.draft.column", () => {
  it("sends a point, a height and a size", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.draft.column").run({ at: [2, 3] }, context());
    expect(result.ok).toBe(true);
    expect(calls[0]!.op).toBe("add_column");
    expect(calls[0]!.params).toMatchObject({ at: [2, 3], height: 3, size: 0.3 });
  });

  it("re-arms after committing, because columns come in grids", () => {
    expect(byId({ apply: fakeApply().apply }, "mv.draft.column").repeatable).toBe(true);
  });
});

describe("mv.edit.delete", () => {
  it("deletes each element in turn", async () => {
    const { apply, calls } = fakeApply();
    const result = await byId({ apply }, "mv.edit.delete").run({ guids: ["a", "b", "c"] }, context());
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.params.guid)).toEqual(["a", "b", "c"]);
  });

  it("stops at the first failure instead of applying the rest", async () => {
    const calls: string[] = [];
    const apply = async (op: string, params: Readonly<Record<string, unknown>>) => {
      calls.push(String(params.guid));
      return params.guid === "b"
        ? ({ ok: false, error: { code: "no_such_element", message: "gone" } } as never)
        : ok({ created: [] });
    };
    const result = await byId({ apply }, "mv.edit.delete").run({ guids: ["a", "b", "c"] }, context());
    expect(result.ok).toBe(false);
    // "c" is not attempted. Continuing would leave a partially-applied delete that is harder to describe than
    // a clean stop at a named element.
    expect(calls).toEqual(["a", "b"]);
  });

  it("declares itself uninvertible rather than claiming a reverse it lacks", () => {
    // massing's service has no inverse for a delete and `LocalKernel` uses snapshots, so undo of a delete is a
    // rollback the registry performs. A fabricated `invert` here would fail after the user committed.
    expect(byId({ apply: fakeApply().apply }, "mv.edit.delete").invert).toBeUndefined();
  });
});

describe("availability, which is how the ribbon dims", () => {
  it("dims every draft command without the edit capability, with a reason", () => {
    const viewer = context({ capabilities: new Set(["view"] as const) });
    for (const command of draftCommands({ apply: fakeApply().apply })) {
      const state = availability(command, viewer);
      expect(state.state, `${command.id} is enabled for a viewer`).toBe("dimmed");
      // Dimmed-with-a-reason is the house rule: a button that says "needs Editor" is onboarding, a silent one
      // is a support ticket.
      if (state.state === "dimmed") expect(state.reason.length).toBeGreaterThan(0);
    }
  });

  it("dims with the kernel's own hint when the operation is unsupported", () => {
    const limited = context({
      supportsOp: (op) => op !== "add_slab",
      opHint: () => '"add_slab" runs on the Massing authoring service. Connect a project to use it.',
    });
    const state = availability(byId({ apply: fakeApply().apply }, "mv.draft.slab"), limited);
    expect(state.state).toBe("dimmed");
    // Verbatim, so the sentence the kernel wrote is the sentence the user reads.
    if (state.state === "dimmed") expect(state.reason).toContain("Connect a project");
  });

  it("enables a draft command when the capability and the operation are both there", () => {
    for (const command of draftCommands({ apply: fakeApply().apply })) {
      if (command.id === "mv.edit.delete") continue; // needs a selection, checked by its own `requires`
      expect(availability(command, context()).state).toBe("enabled");
    }
  });
});
