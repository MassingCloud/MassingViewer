import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGuid, toGuid, type Guid } from "@massing/core";
import {
  PAPER_SIZES,
  boundsOf,
  digestDrawing,
  fitToPaper,
  formatDigest,
  generatePlan,
  guidsIn,
  type Drawing,
  type ElementMesh,
  type ViewDefinition,
} from "@massing/drawings2d";
// The tessellator lives in `apps/demo`, which is a wart: an IFC→mesh step is not app code, and this suite needs
// the same one the product uses or it is testing a different pipeline. Imported by relative path rather than
// duplicated — a second tessellator is how the digest ends up asserting the wrong geometry confidently. Moving it
// into `@massing/ifc` is recorded in docs/testing.md as outstanding.
import { tessellate } from "../apps/demo/src/tessellate.js";

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

/**
 * The eight views, per fixture.
 *
 * Chosen so each one can fail for a *different* reason, rather than to reach eight:
 *
 * | View | What only it can catch |
 * |---|---|
 * | `plan-1200` | The nominal cut. Doors and windows are both open at 1.2 m, so each pierced wall must yield two loops |
 * | `plan-0300` | Below every opening — the same walls must yield ONE loop each. A sectioner that ignores voids passes 1200 and fails here |
 * | `plan-2400` | Above the door head and above the walls' 2.4 m top: the cut plane leaves the solid entirely |
 * | `plan-0050` | Grazing the slab. The degenerate case: a cut plane almost coincident with a face |
 * | `plan-1200-shallow` | `belowDepth: 0.1`, so almost nothing qualifies as `below`. Isolates role assignment from geometry |
 * | `plan-1200-deep` | `belowDepth: 50`, so everything does. The other end of the same axis |
 * | `plan-storey` | Filtered by storey name rather than by height |
 * | `plan-negative` | A cut below the building. Must produce an empty drawing and say so, not throw |
 */
const VIEWS: readonly { readonly id: string; readonly view: ViewDefinition }[] = [
  { id: "plan-1200", view: { kind: "plan", cutHeight: 1.2 } },
  { id: "plan-0300", view: { kind: "plan", cutHeight: 0.3 } },
  { id: "plan-2400", view: { kind: "plan", cutHeight: 2.4 } },
  { id: "plan-0050", view: { kind: "plan", cutHeight: 0.05 } },
  { id: "plan-1200-shallow", view: { kind: "plan", cutHeight: 1.2, belowDepth: 0.1 } },
  { id: "plan-1200-deep", view: { kind: "plan", cutHeight: 1.2, belowDepth: 50 } },
  { id: "plan-storey", view: { kind: "plan", cutHeight: 1.2, storey: "Level 1" } },
  { id: "plan-negative", view: { kind: "plan", cutHeight: -5 } },
];

/**
 * The fixtures.
 *
 * **Two, not the six the plan names, and the gap is deliberate rather than unfinished.** The plan's six
 * (2 MB house → 240 MB tower, one deliberately broken) are specified for the *bake-off harness* — a
 * performance and fidelity comparison between two candidate 2D engines. A 240 MB IFC is a perf fixture: it
 * cannot be committed to a public repository, and a golden digest of it would be tens of megabytes of text no
 * reviewer will ever read, which fails the one property that makes this suite work.
 *
 * What a *golden* suite needs is semantic coverage, and these two plus eight views give it: a building whose
 * every expected value is independently known, and a broken one. Scale belongs in `perf.yml` against a
 * generated model. Recorded in docs/testing.md rather than quietly redefined.
 */
const FIXTURES = ["sample", "broken"] as const;

interface Loaded {
  readonly name: string;
  readonly meshes: ElementMesh[];
  readonly guids: readonly Guid[];
  /** What the tessellator dropped. Carried into the drawing so provenance covers the whole pipeline. */
  readonly skipped: readonly { guid?: Guid | null; ifcClass: string; reason: string }[];
}

/**
 * Fixture → drawing input, by exactly the path the product takes.
 *
 * Mirrors `planInput()` in `apps/demo/src/main.ts`. Going through the real tessellator rather than hand-built
 * boxes is the point: `drawings.test.ts` already covers the sectioner with legible in-code geometry, so what is
 * missing — and what a golden suite is for — is the whole chain from committed bytes to drawing.
 */
function load(fixture: string): Loaded {
  const ifc = readFileSync(join(HERE, `${fixture}.ifc`), "utf8");
  const { meshes, guids, skipped } = tessellate(ifc);
  const pascal = (upper: string): string =>
    /^IFC./.test(upper) ? `Ifc${upper.charAt(3)}${upper.slice(4).toLowerCase()}` : upper;
  const mapped: ElementMesh[] = meshes.map((m) => ({
    guid: toGuid(guids.get(m.expressId)),
    ifcClass: pascal(m.ifcType ?? "IFCPRODUCT"),
    positions: m.positions,
    indices: m.indices,
  }));
  return {
    name: fixture,
    meshes: mapped,
    guids: [...guids.values()].map((g) => toGuid(g)).filter((g): g is Guid => g !== null),
    // The tessellator's own losses, translated into the drawing's vocabulary. Without this the drawing reports
    // `incomplete: []` for a model three elements short, which is the exact failure the field exists to prevent.
    skipped: skipped.map((s) => ({ guid: toGuid(guids.get(s.expressId)), ifcClass: pascal(s.type), reason: s.reason })),
  };
}

const loaded = new Map<string, Loaded>(FIXTURES.map((f) => [f, load(f)]));

function drawingFor(fixture: string, view: ViewDefinition): Drawing {
  const { name, meshes, skipped } = loaded.get(fixture)!;
  return generatePlan({ name, meshes, skipped }, view);
}

// ---------------------------------------------------------------------------------------------------
// Tier 1 — semantic digests
// ---------------------------------------------------------------------------------------------------

describe("Tier 1 — semantic digests", () => {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const fixture of FIXTURES) {
    for (const { id, view } of VIEWS) {
      it(`${fixture} / ${id}`, () => {
        const drawing = drawingFor(fixture, view);

        // The paper comes from `fitToPaper`, so the quantisation step is the one this drawing would actually be
        // plotted at. A fixed scale would make the tolerance arbitrary — see the note in `digest.ts`.
        //
        // An empty drawing has no bounds to fit, so `fitToPaper` returns null and A3 at 1:100 stands in. The
        // digest of an empty drawing has no coordinates in it, so the step is irrelevant there by definition.
        const a3 = PAPER_SIZES.find((p) => p.name === "A3")!;
        const paper = fitToPaper(drawing, a3, 10) ?? {
          size: a3,
          scale: 100,
          margin: 10,
          origin: { x: 0, y: 0 },
        };

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
