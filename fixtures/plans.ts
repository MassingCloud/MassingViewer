import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toGuid, type Guid } from "@massing/core";
import {
  PAPER_SIZES,
  fitToPaper,
  generatePlan,
  type Drawing,
  type ElementMesh,
  type Paper,
  type ViewDefinition,
} from "@massing/drawings2d";
// The tessellator lives in `apps/demo`, which is a wart: an IFC→mesh step is not app code, and this suite needs
// the same one the product uses or it is testing a different pipeline. Imported by relative path rather than
// duplicated — a second tessellator is how the digest ends up asserting the wrong geometry confidently. Moving it
// into `@massing/ifc` is recorded in docs/testing.md as outstanding.
import { tessellate } from "@massing/tessellate";

/**
 * The fixture → drawing pipeline, shared by every golden tier.
 *
 * Extracted from `golden.test.ts` when Tier 3 arrived, for the reason that file already states about the
 * tessellator: **two definitions of "the drawing under test" is how one tier blesses geometry the other never
 * looked at.** Tier 1 compares a semantic digest, Tier 3 compares pixels; if they disagree about which view, which
 * paper, or which fixture, a regression can hide in the gap between them and both stay green.
 *
 * Not a `.test.ts` file, so the default Vitest run does not try to execute it as a suite.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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
export const VIEWS: readonly { readonly id: string; readonly view: ViewDefinition }[] = [
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
export const FIXTURES = ["sample", "broken"] as const;

export interface Loaded {
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

/** Parsed once per process. Every tier reads the same meshes, so parsing cost is paid once for all of them. */
export const loaded = new Map<string, Loaded>(FIXTURES.map((f) => [f, load(f)]));

export function drawingFor(fixture: string, view: ViewDefinition): Drawing {
  const { name, meshes, skipped } = loaded.get(fixture)!;
  return generatePlan({ name, meshes, skipped }, view);
}

/**
 * The sheet a drawing would actually be plotted on.
 *
 * A3 at whatever scale `fitToPaper` picks, because the digest's quantisation tolerance and the raster's pixel grid
 * both mean nothing unless they are measured at a real plot scale — a fixed scale would make either tolerance
 * arbitrary. See the note in `digest.ts`.
 *
 * An empty drawing has no bounds to fit, so `fitToPaper` returns null and A3 at 1:100 stands in. That case is why
 * this is one function rather than three copies: it was already written twice in `golden.test.ts`, and getting the
 * fallback subtly different in a third place would silently change what a tier compares.
 */
export function paperFor(drawing: Drawing): Paper {
  const a3 = PAPER_SIZES.find((p) => p.name === "A3")!;
  return fitToPaper(drawing, a3, 10) ?? { size: a3, scale: 100, margin: 10, origin: { x: 0, y: 0 } };
}
