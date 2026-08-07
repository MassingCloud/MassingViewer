import { describe, expect, it } from "vitest";
import { decideResize } from "./resize.js";

/**
 * The zero-width-canvas regression.
 *
 * massing carries a version of this test, and it had to duplicate the decision logic as a local function
 * because the real one closed over a renderer world that cannot be built headless. Its own comment says so.
 * That is a real weakness: the copy can pass while the original diverges, which is the failure mode a
 * regression test is supposed to eliminate.
 *
 * Here `decideResize` is exported and pure, so these assertions run against the code that actually ships.
 *
 * The two properties are the ones that genuinely failed upstream:
 *   1. a container that grows from 0 must trigger a resize — the original bug, misdiagnosed for weeks as
 *      "the geometry loader stalls" and cited as an environment limitation in eight changelog entries;
 *   2. a zero size must never be applied — resizing at 0x0 sets a NaN camera aspect, which is a *different*
 *      silent failure, so the fix must not trade one for the other.
 */

const S = (width: number, height: number) => ({ width, height });

describe("decideResize — the bug that was reported as a stalled loader", () => {
  it("resizes when the container gains its width after construction", () => {
    // The exact measured case: container 830x572, canvas 0x493. Four meshes and 230 triangles were built and
    // marked visible, into a canvas of width zero. Nothing renders, and from outside that is
    // indistinguishable from a loader that never finished.
    const d = decideResize(S(0, 493), S(830, 572));
    expect(d.act).toBe("resize");
    if (d.act === "resize") expect(d.to).toEqual(S(830, 572));
  });

  it("resizes when only the height changes", () => {
    expect(decideResize(S(800, 600), S(800, 400)).act).toBe("resize");
  });
});

describe("decideResize — never apply a zero size", () => {
  it.each([
    ["both zero", S(0, 0)],
    ["zero width", S(0, 600)],
    ["zero height", S(800, 0)],
    ["negative width", S(-10, 600)],
  ])("skips %s", (_label, measured) => {
    const d = decideResize(S(800, 600), measured);
    expect(d.act).toBe("skip");
    if (d.act === "skip") expect(d.reason).toBe("zero");
  });

  it("would produce a NaN aspect if it did not skip — which is the point", () => {
    // Stated as an assertion so the reason survives, rather than living only in a comment. 0/0 is NaN, every
    // projected vertex becomes NaN, and the scene vanishes in a way that looks nothing like a sizing bug.
    expect(0 / 0).toBeNaN();
    expect(decideResize(S(800, 600), S(0, 0)).act).toBe("skip");
  });
});

describe("decideResize — do not thrash", () => {
  it("skips an unchanged size", () => {
    const d = decideResize(S(800, 600), S(800, 600));
    expect(d.act).toBe("skip");
    if (d.act === "skip") expect(d.reason).toBe("unchanged");
  });

  it("skips sub-pixel churn that rounds to the same integer", () => {
    // A ResizeObserver on a flex layout fires with widths differing by hundredths of a pixel. Honouring those
    // reallocates the drawing buffer several times a second for no visible change.
    const d = decideResize(S(800, 600), S(800.4, 599.8));
    expect(d.act).toBe("skip");
    if (d.act === "skip") expect(d.reason).toBe("unchanged");
  });

  it("compares AFTER rounding, so it cannot oscillate", () => {
    // The trap in the naive fix: compare raw floats, resize to the rounded value, and the next observation
    // differs from `current` again — forever. Rounding both sides is what stops that.
    let current = S(800, 600);
    for (let i = 0; i < 5; i++) {
      const d = decideResize(current, S(800.4, 600.4));
      if (d.act === "resize") current = d.to;
    }
    expect(decideResize(current, S(800.4, 600.4)).act).toBe("skip");
  });

  it("does resize on a change of one whole pixel", () => {
    expect(decideResize(S(800, 600), S(801, 600)).act).toBe("resize");
  });
});

describe("decideResize — non-finite input", () => {
  it.each([
    ["NaN width", S(Number.NaN, 600)],
    ["Infinite height", S(800, Number.POSITIVE_INFINITY)],
  ])("skips %s with a distinct reason", (_label, measured) => {
    const d = decideResize(S(800, 600), measured);
    expect(d.act).toBe("skip");
    // Distinguished from "zero" deliberately: a NaN measurement means something upstream is broken, whereas a
    // zero measurement is the normal not-yet-laid-out case. Collapsing them hides a real defect.
    if (d.act === "skip") expect(d.reason).toBe("not-finite");
  });
});
