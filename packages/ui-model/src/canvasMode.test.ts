import { describe, expect, it, vi } from "vitest";
import { createCanvasModeSwitch, visibility, MODE_ORDER, type ModeDef } from "./canvasMode.js";

/**
 * The canvas mode switch.
 *
 * The whole value of a reducer here is that the invariant — exactly one surface is the canvas — holds by
 * construction rather than by every caller remembering to hide the other one. So these tests are mostly about the
 * states that a pair of `hidden` flags would allow and this cannot reach.
 */

function mode(key: ModeDef["key"], over: Partial<ModeDef> = {}) {
  const events: string[] = [];
  const def: ModeDef = {
    key,
    label: key,
    enter: () => events.push(`enter:${key}`),
    leave: () => events.push(`leave:${key}`),
    ...over,
  };
  return { def, events };
}

describe("opening state", () => {
  it("enters the first registered mode, so the canvas and the state agree from frame one", () => {
    // Without this the switch believes it is in `model` while whatever the DOM happens to show is showing.
    const model = mode("model");
    const s = createCanvasModeSwitch([model.def]);
    expect(s.active).toBe("model");
    expect(model.events).toEqual(["enter:model"]);
  });

  it("normalises registration order to MODE_ORDER, so tabs do not depend on argument order", () => {
    const s = createCanvasModeSwitch([mode("sheets").def, mode("model").def]);
    expect(s.modes).toEqual(["model", "sheets"]);
    // And the *opening* mode is the first in MODE_ORDER, not the first argument.
    expect(s.active).toBe("model");
  });

  it("refuses to be built with no modes, rather than existing with no canvas", () => {
    expect(() => createCanvasModeSwitch([])).toThrow(/at least one/);
  });

  it("refuses a duplicate mode instead of silently keeping one of them", () => {
    expect(() => createCanvasModeSwitch([mode("model").def, mode("model").def])).toThrow(/duplicate/);
  });
});

describe("switching", () => {
  it("leaves the old surface before entering the new one, in that order", () => {
    // Both entered at once is the state a pair of hidden flags allows. The order is the guarantee.
    const order: string[] = [];
    const model: ModeDef = { key: "model", label: "3D", enter: () => order.push("enter:model"), leave: () => order.push("leave:model") };
    const sheets: ModeDef = { key: "sheets", label: "2D", enter: () => order.push("enter:sheets"), leave: () => order.push("leave:sheets") };
    const s = createCanvasModeSwitch([model, sheets]);

    expect(s.switchTo("sheets")).toEqual({ ok: true });
    expect(order).toEqual(["enter:model", "leave:model", "enter:sheets"]);
    expect(s.active).toBe("sheets");
  });

  it("treats a click on the active tab as a successful no-op, and does NOT re-enter", () => {
    /**
     * The subtle one, and the reason this is not `if (mode !== current)` written at each call site: re-entering
     * would reset that surface's camera, scroll position and zoom. Clicking the tab you are already on is the most
     * ordinary thing a user does with a tab strip.
     */
    const model = mode("model");
    const s = createCanvasModeSwitch([model.def, mode("sheets").def]);
    expect(s.switchTo("model")).toEqual({ ok: true });
    expect(model.events, "re-entered the active mode").toEqual(["enter:model"]);
  });

  it("refuses an unregistered mode with a reason rather than doing nothing", () => {
    // `specs` has a seat in the type and no surface here. A tab that swallows a click is indistinguishable from a
    // broken one, so the refusal is a sentence.
    const s = createCanvasModeSwitch([mode("model").def]);
    const result = s.switchTo("specs");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not available/);
  });

  it("refuses a blocked mode, and re-evaluates the block on every attempt", () => {
    // `sheets` is blocked until something has been cut — which becomes true while the tab is already on screen. A
    // block captured once at construction would leave the tab dead for the rest of the session.
    let cut = false;
    const sheets = mode("sheets", { blocked: () => (cut ? null : "Cut a plan first — there is no sheet to show.") });
    const s = createCanvasModeSwitch([mode("model").def, sheets.def]);

    const refused = s.switchTo("sheets");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("Cut a plan first");
    expect(s.active, "a refused switch changed the active mode anyway").toBe("model");
    expect(sheets.events, "a refused switch entered the surface anyway").toEqual([]);

    cut = true;
    expect(s.switchTo("sheets")).toEqual({ ok: true });
    expect(s.active).toBe("sheets");
  });

  it("notifies onChange only for a switch that happened", () => {
    const onChange = vi.fn();
    const s = createCanvasModeSwitch([mode("model").def, mode("sheets", { blocked: () => "nope" }).def], onChange);

    s.switchTo("model"); // no-op
    s.switchTo("sheets"); // refused
    s.switchTo("specs"); // unregistered
    expect(onChange, "notified for a switch that did not happen").not.toHaveBeenCalled();
  });
});

describe("the invariant", () => {
  it("shows exactly one surface for every mode, registered in any combination", () => {
    /**
     * The reason the mode is the state. Independent `hidden` flags have four states for two surfaces and two of
     * them are wrong — both visible, or neither — and nothing prevents them.
     */
    for (const registered of [["model"], ["model", "sheets"], ["model", "sheets", "specs"]] as const) {
      for (const active of registered) {
        const vis = visibility(active, registered);
        const shown = Object.entries(vis).filter(([, v]) => v).map(([k]) => k);
        expect(shown, `mode ${active} of ${registered.join("+")}`).toEqual([active]);
      }
    }
  });

  it("shows nothing for a mode that is not registered, rather than guessing", () => {
    expect(visibility("specs", ["model", "sheets"])).toEqual({ model: false, sheets: false });
  });

  it("keeps MODE_ORDER as the single source of tab order", () => {
    expect(MODE_ORDER).toEqual(["model", "sheets", "specs"]);
  });
});
