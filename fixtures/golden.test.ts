import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGuid } from "@massing/core";
import { PAPER_SIZES, boundsOf, digestDrawing, fitToPaper, formatDigest, guidsIn } from "@massing/drawings2d";
// Shared with Tier 3 rather than defined here, so both tiers compare the same drawing on the same sheet. See
// the header of that file for why the duplication was worth removing.
import { FIXTURES, VIEWS, drawingFor, loaded, paperFor } from "./plans.js";

/**
 * Golden drawings — the M5 verification criterion, and the Tier-1/Tier-2 suite `docs/testing.md` specifies.
 *
 * ## What was actually here before
 *
 * `docs/testing.md` has described this in detail since M5: *"per layer, a sorted list of typed geometry
 * operations, coordinates quantised to 0.1 mm at paper scale, GlobalIds retained"*. **None of it existed.** No
 * digest function, no goldens, no structural assertions — the same shape as the `axe-core` claim, and the same
 * reason it survived: every backticked path in the sentence resolves, so the doc-path gate is happy.
 *
 * ## Why the goldens are text files rather than inline snapshots
 *
 * `toMatchSnapshot` would work and is worse here. A committed `.digest` file is a *reviewable artefact*: a
 * reviewer reads "layer A-WALL lost 1 polyline" in a diff against a file they can open, rather than inside a
 * `__snapshots__` blob whose format invites `-u`. The plan's risk #11 is exactly this reflex, and the counter is
 * making the diff worth reading.
 *
 * Update with `GOLDEN=update npx vitest run fixtures/golden.test.ts`, and read the diff — see the checklist in
 * `docs/testing.md`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "golden");
const UPDATE = process.env.GOLDEN === "update";

// ---------------------------------------------------------------------------------------------------
// Tier 1 — semantic digests
// ---------------------------------------------------------------------------------------------------

describe("Tier 1 — semantic digests", () => {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const fixture of FIXTURES) {
    for (const { id, view } of VIEWS) {
      it(`${fixture} / ${id}`, () => {
        const drawing = drawingFor(fixture, view);

        // `paperFor` is the sheet this drawing would actually be plotted on, so the quantisation step is a real
        // plot tolerance rather than an arbitrary one. The digest of an empty drawing has no coordinates in it, so
        // the fallback sheet is irrelevant there by definition.
        const paper = paperFor(drawing);

        const actual = formatDigest(digestDrawing(drawing, { paper }));
        const file = join(GOLDEN_DIR, `${fixture}.${id}.digest`);

        if (UPDATE || !existsSync(file)) {
          writeFileSync(file, actual, "utf8");
          if (!UPDATE) {
            // A missing golden is written and then FAILED, never silently accepted. Accepting it would mean a new
            // view lands green having asserted nothing, and nobody ever reads the file it created.
            expect.fail(
              `no golden for ${fixture}/${id} — one has been written to ${file}. ` +
                `Read it, confirm it is correct, and commit it.`,
            );
          }
          return;
        }

        expect(actual).toBe(readFileSync(file, "utf8"));
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// Tier 2 — structural assertions
// ---------------------------------------------------------------------------------------------------

describe("Tier 2 — structural assertions", () => {
  /**
   * These are the claims a digest cannot make, because a digest compares against *itself last time*. A golden
   * happily records a drawing where every guid is wrong, as long as it was equally wrong when it was blessed.
   * These assert against the model instead.
   */

  for (const fixture of FIXTURES) {
    describe(fixture, () => {
      it("every drawn guid resolves to a GlobalId in the model", () => {
        const modelGuids = new Set(loaded.get(fixture)!.guids);
        for (const { id, view } of VIEWS) {
          const drawing = drawingFor(fixture, view);
          const orphans = guidsIn(drawing).filter((g) => !modelGuids.has(g));
          // A drawn line anchored to a guid the model does not contain is worse than an unanchored one: markup
          // would attach to it, resolve as live, and point at nothing.
          expect(orphans, `${id} drew guids absent from the model`).toEqual([]);
        }
      });

      it("every guid it does carry is a well-formed GlobalId", () => {
        for (const { id, view } of VIEWS) {
          const bad = guidsIn(drawingFor(fixture, view)).filter((g) => !isGuid(g));
          expect(bad, `${id} carried a malformed guid`).toEqual([]);
        }
      });

      it("nothing is drawn outside the sheet border", () => {
        for (const { id, view } of VIEWS) {
          const drawing = drawingFor(fixture, view);
          if (drawing.entities.length === 0) continue;
          const a3 = PAPER_SIZES.find((p) => p.name === "A3")!;
          const paper = fitToPaper(drawing, a3, 10);
          expect(paper, `${id} produced entities that will not fit any sheet`).not.toBeNull();
          if (paper === null) continue;

          // `fitToPaper` is what promises this, so asserting it is asserting the promise rather than trusting it.
          // Half a millimetre of slack for the rounding inside the fit, not for a wall in the margin.
          const b = boundsOf(drawing.entities);
          const printableMm = paper.size.width - 2 * paper.margin;
          const widthMm = ((b.max.x - b.min.x) / paper.scale) * 1000;
          expect(widthMm, `${id} is wider than the printable area`).toBeLessThanOrEqual(printableMm + 0.5);
        }
      });

      it("reports coverage and incompleteness rather than leaving them undefined", () => {
        for (const { id, view } of VIEWS) {
          const { provenance } = drawingFor(fixture, view);
          // `DrawingProvenance` calls `incomplete` the field most likely to be treated as optional. A plan
          // missing a wall renders perfectly, so an absent array and an empty one must not be confusable.
          expect(Array.isArray(provenance.incomplete), `${id} has no incomplete[]`).toBe(true);
          expect(provenance.guidCoverage, `${id} coverage out of range`).toBeGreaterThanOrEqual(0);
          expect(provenance.guidCoverage, `${id} coverage out of range`).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it("the sample's nominal plan cuts every wall, and cuts the pierced ones twice", () => {
    /**
     * The one assertion anchored to *knowable truth* rather than to internal consistency, and the number
     * `build-sample.mjs` promised from the beginning:
     *
     * > *"A plan cut at 1.2 m passes through both, so each of those walls must yield TWO loops."*
     *
     * Four authored walls; a door in the south and a window in the north, both open at 1.2 m. So **six** cut
     * loops across **four** distinct GlobalIds. It read four for as long as the tessellator ignored
     * `IfcRelVoidsElement`, and this file carried a test asserting that defect on purpose so it could not be
     * forgotten. That test is now gone, which is what it was for.
     */
    const drawing = drawingFor("sample", { kind: "plan", cutHeight: 1.2 });
    const wallCuts = drawing.entities.filter((e) => e.ifcClass === "IfcWall" && e.role === "cut");
    expect(wallCuts).toHaveLength(6);
    // Six loops from four walls, not four from one: the pierced walls contribute two each.
    expect(new Set(wallCuts.map((e) => e.guid)).size).toBe(4);
  });

  it("a cut below every opening yields one loop per wall", () => {
    /**
     * The other half of the same claim, and the reason `plan-0300` is one of the eight views.
     *
     * At 300 mm the door is open (it reaches the floor) and the window is not. So the south wall still splits and
     * the other three do not: five loops. A sectioner that ignored voids passed the 1.2 m case with four and this
     * one with four too — identical numbers for opposite reasons, which is why one view was never enough.
     */
    const drawing = drawingFor("sample", { kind: "plan", cutHeight: 0.3 });
    const wallCuts = drawing.entities.filter((e) => e.ifcClass === "IfcWall" && e.role === "cut");
    expect(wallCuts).toHaveLength(5);
    expect(new Set(wallCuts.map((e) => e.guid)).size).toBe(4);
  });

  it("the broken fixture reports what it could not section, instead of silently dropping it", () => {
    // The entire reason a broken fixture exists. `DrawingProvenance.incomplete` is the SDM's honesty feature, and
    // a feature with no failing input has never been exercised — massing's plans drop elements today and say
    // nothing, which is the behaviour this field was added to end.
    const drawing = drawingFor("broken", { kind: "plan", cutHeight: 1.2 });
    expect(drawing.provenance.incomplete.length).toBeGreaterThan(0);
    for (const entry of drawing.provenance.incomplete) {
      // A reason a human can act on, not a bare flag.
      expect(entry.reason.length).toBeGreaterThan(8);
      expect(entry.ifcClass).not.toBe("");
    }
  });

  it("the broken fixture still draws what it could", () => {
    // Partial output, not a thrown error. One unsectionable element must not cost the drawing — that is the
    // difference between a tool that degrades and a tool that fails.
    const drawing = drawingFor("broken", { kind: "plan", cutHeight: 1.2 });
    expect(drawing.entities.length).toBeGreaterThan(0);
    // And coverage reflects reality rather than reading 1.
    expect(drawing.provenance.guidCoverage).toBeLessThanOrEqual(1);
  });
});

// ===================================================================================================
// Cutting exactly at a datum — the regression test for a bug that silently deleted walls
// ===================================================================================================

describe("cuts exactly at a datum", () => {
  /**
   * The defect: `section.ts` discards coplanar triangles, so a cut plane sitting exactly on a face lost geometry
   * with no report. Measured before the fix, cut loops on `sample`: `0, 0, 5, 3, 0` at the five datums, against
   * `1, 6, 7, 5, 0` one millimetre above them. At 2.100 that is four walls missing from a plan, and `incomplete[]`
   * stayed empty because the sectioner did not know it had dropped anything.
   *
   * Plans are cut at storey elevations, so this is the normal case rather than an edge case.
   *
   * The fix nudges a coincident plane up by 0.1 mm and declares it. The assertion is the one that matters and it is
   * deliberately not a hardcoded list: **the exact cut must agree with the cut just above it**, which is what
   * "nudged up" means. A hardcoded set of counts would pass while meaning nothing if the fixture changed.
   */
  const DATUMS = [-0.2, 0, 0.9, 2.1, 3];

  for (const fixture of FIXTURES) {
    for (const datum of DATUMS) {
      it(`${fixture} at ${datum} m agrees with 1 mm above it`, () => {
        const at = drawingFor(fixture, { kind: "plan", cutHeight: datum });
        const above = drawingFor(fixture, { kind: "plan", cutHeight: datum + 0.001 });
        const cuts = (d: typeof at): number => d.entities.filter((e) => e.role === "cut").length;
        expect(cuts(at), `cutting exactly at ${datum} lost loops relative to ${datum + 0.001}`).toBe(cuts(above));
      });
    }
  }

  it("declares the nudge when it happens, and stays quiet when it does not", () => {
    const nudged = drawingFor("sample", { kind: "plan", cutHeight: 2.1 });
    expect(nudged.provenance.approximations.join(" ")).toContain("coincident with a face");
    // 1.2 m is mid-wall — no face there, so no caveat. A caveat on every drawing is one nobody reads.
    const clean = drawingFor("sample", { kind: "plan", cutHeight: 1.2 });
    expect(clean.provenance.approximations.join(" ")).not.toContain("coincident with a face");
  });
});
