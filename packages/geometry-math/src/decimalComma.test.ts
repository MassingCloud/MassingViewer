import { describe, expect, it } from "vitest";
import { parseLength } from "@massing/core";
import { parseCadCommand } from "./cadCommands.js";
import { parseDynConstraint } from "./dynInput.js";

/**
 * The decimal-comma trap, which the plan names explicitly and asks to be resolved in an ADR and tested.
 *
 * `3,5` is the point (3, 5) to an anglophone drafter and the number 3.5 to most of the rest of the world. Both are
 * valid input to this grammar, so the two cannot be told apart — and the failure is silent: a wall lands in the
 * wrong place with no error and nothing to suspect.
 *
 * The resolution, and what each block below pins down:
 *
 * - Where there is only ONE number, `,` is a decimal separator. No competing reading exists, and refusing it makes
 *   the tool feel broken to most of its potential users.
 * - Where there are TWO, `,` stays the coordinate separator and `;` is the explicit alternative. So `3,5;7,2` is
 *   (3.5, 7.2) and needs no locale setting to be unambiguous.
 * - Locale is never consulted, because a command invocation is serialisable and a locale-dependent parser makes a
 *   saved macro mean different things to different people.
 *
 * See docs/adr/0011-decimal-comma-and-the-coordinate-grammar.md.
 */

/** Pull the resolved points out of a parsed command, so the assertions are about geometry rather than shape. */
function wall(input: string): { start: [number, number]; end: [number, number]; height: number } | null {
  const parsed = parseCadCommand(input);
  if (parsed.kind !== "recipe") return null;
  const [step] = parsed.steps;
  const p = step!.params as { start?: number[]; end?: number[]; height?: number };
  if (p.start === undefined || p.end === undefined) return null;
  return {
    start: [p.start[0]!, p.start[1]!],
    end: [p.end[0]!, p.end[1]!],
    height: p.height ?? 3,
  };
}

describe("a single number: comma is a decimal separator", () => {
  it("parseLength accepts both separators identically", () => {
    expect(parseLength("2,5")).toBeCloseTo(2.5, 9);
    expect(parseLength("2.5")).toBeCloseTo(2.5, 9);
    expect(parseLength("2,5")).toBe(parseLength("2.5"));
    // With a unit suffix too, which is the form a settings field produces.
    expect(parseLength("1200,5mm")).toBeCloseTo(1.2005, 9);
  });

  it("a typed distance accepts a comma", () => {
    expect(parseDynConstraint("2,5")?.distance).toBeCloseTo(2.5, 9);
    // And a bearing, which is also a single number.
    expect(parseDynConstraint("<30,5")?.angle).toBeCloseTo(30.5, 9);
    expect(parseDynConstraint("2,5<30,5")?.distance).toBeCloseTo(2.5, 9);
  });

  it("a standalone command argument accepts a comma", () => {
    // The height. `WALL 0,0 5,0 2,7` is a 2.7 m wall to most of the world, and NaN would refuse valid input.
    expect(wall("WALL 0,0 5,0 2,7")?.height).toBeCloseTo(2.7, 9);
  });
});

describe("a coordinate: comma stays the separator, semicolon is the way out", () => {
  it("keeps the AutoCAD reading, because muscle memory outranks number formatting", () => {
    // The case a regression would break, and the reason locale is not consulted. This must not change.
    const w = wall("WALL 0,0 3,5");
    expect(w?.start).toEqual([0, 0]);
    expect(w?.end).toEqual([3, 5]);
  });

  it("reads `;` as the separator, which makes a comma a decimal point", () => {
    const w = wall("WALL 0;0 3,5;7,2");
    expect(w?.start).toEqual([0, 0]);
    expect(w?.end![0]).toBeCloseTo(3.5, 9);
    expect(w?.end![1]).toBeCloseTo(7.2, 9);
  });

  it("the two forms are genuinely different points, which is the whole problem", () => {
    // Stated as an assertion rather than a comment: if these ever agree, the disambiguation has been lost and one
    // of the two populations is silently getting the other's geometry.
    expect(wall("WALL 0,0 3,5")?.end).not.toEqual(wall("WALL 0;0 3,5;7,2")?.end);
  });

  it("relative and polar forms both take the comma as a decimal", () => {
    // `@d<a` has one number on each side of the `<`, so there is nothing to be ambiguous with.
    const polar = wall("WALL 0,0 @5,5<0");
    expect(polar?.end![0]).toBeCloseTo(5.5, 9);
    // Relative cartesian with the explicit separator.
    const rel = wall("WALL 1;1 @2,5;0");
    expect(rel?.end![0]).toBeCloseTo(3.5, 9);
    expect(rel?.end![1]).toBeCloseTo(1, 9);
  });

  it("still refuses a malformed coordinate rather than guessing", () => {
    // The pre-existing strictness must survive: a dropped component is an error, not a zero.
    expect(parseCadCommand("WALL 0,0 5").kind).toBe("error");
    expect(parseCadCommand("WALL 0,0 5<").kind).toBe("error");
    expect(parseCadCommand("WALL 0;0 5;").kind).toBe("error");
  });
});

describe("an empty coordinate component is an error, never a zero", () => {
  /**
   * A bug this file found, and it was half pre-existing.
   *
   * `Number("")` is 0, so `WALL 0,0 5,` drew a wall to (5, 0) — a point the drafter never typed, with no error.
   * The polar branch has carried a comment about precisely this hazard since extraction; the cartesian branch
   * beside it never got the guard. Adding `;` hit the same hole one character over, which is how it surfaced.
   */
  it("refuses a trailing separator in either form", () => {
    expect(parseCadCommand("WALL 0,0 5,").kind).toBe("error");
    expect(parseCadCommand("WALL 0;0 5;").kind).toBe("error");
    expect(parseCadCommand("WALL 0,0 ,5").kind).toBe("error");
    expect(parseCadCommand("WALL 0,0 5,,2").kind).toBe("error");
  });

  it("still accepts the three-component form, whose z is ignored", () => {
    // The guard must not refuse `x,y,z` — it is documented as valid with z dropped.
    const w = wall("WALL 0,0,0 5,0,3");
    expect(w?.end).toEqual([5, 0]);
  });
});
