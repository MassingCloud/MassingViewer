import { err, ok } from "@massing/core";
import type { Guid } from "@massing/core";
import {
  type Drawing,
  type DrawingEntity,
  type DrawingProvenance,
  type Point,
  type ViewDefinition,
  makeDrawing,
} from "./model.js";
import type { DrawingFailure, DrawingInput, DrawingProvider, ElementMesh } from "./provider.js";
import { type Seg, cutTriangle, nestLoops, stitch } from "./section.js";

/**
 * The built-in plan and section provider.
 *
 * Cuts triangle meshes with a plane and turns the loops into Semantic Drawing Model entities, keeping the
 * `guid` of the element each loop came from — which is the whole reason this exists rather than a generic
 * sectioner. `guid` is what makes a markup anchor to a wall instead of to a page coordinate.
 *
 * Deliberately narrow about what it claims: no hidden-line removal, no grid derivation, no tag placement, no
 * door swings. Those are drawing *intelligence*, they are the reason ADR-0004 kept `@ifc-lite/drawing-2d` for
 * generation, and every one of them is listed in `provenance.approximations` rather than left for a reviewer to
 * notice is missing.
 */

const LAYERS: Record<string, string> = {
  IfcWall: "A-WALL",
  IfcWallStandardCase: "A-WALL",
  IfcSlab: "A-FLOR",
  IfcColumn: "S-COLS",
  IfcBeam: "S-BEAM",
  IfcDoor: "A-DOOR",
  IfcWindow: "A-GLAZ",
  IfcStair: "A-FLOR-STRS",
  IfcRailing: "A-FLOR-HRAL",
  IfcCovering: "A-FINF",
  IfcCurtainWall: "A-GLAZ-CWMG",
};

/** AIA-style layer name, so DXF export lands in layers a consultant recognises. */
function layerFor(ifcClass: string): string {
  return LAYERS[ifcClass] ?? `A-${ifcClass.replace(/^Ifc/, "").toUpperCase().slice(0, 8)}`;
}

/** Iterate a mesh's triangles, whether it is indexed or a soup. */
function* triangles(mesh: ElementMesh): Generator<readonly number[]> {
  const p = mesh.positions;
  if (mesh.indices !== undefined) {
    const idx = mesh.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i]! * 3;
      const b = idx[i + 1]! * 3;
      const c = idx[i + 2]! * 3;
      yield [p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!];
    }
    return;
  }
  for (let i = 0; i + 8 < p.length; i += 9) {
    yield [p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, p[i + 4]!, p[i + 5]!, p[i + 6]!, p[i + 7]!, p[i + 8]!];
  }
}

const toPoint = ([x, z]: readonly [number, number]): Point => ({ x, y: z });

/**
 * Vertical extent of a mesh, so "does this element reach the cut plane" is answerable before cutting it.
 *
 * Cheap, and it is what makes the `incomplete` list meaningful: an element that never reaches the plane is
 * *correctly* absent from the drawing and must not be reported as a failure, while one that straddles the plane
 * and still yields no loops is a real problem.
 */
function verticalExtent(mesh: ElementMesh): { min: number; max: number } | null {
  const p = mesh.positions;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    const y = p[i]!;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Plan-projected bounding box of everything strictly below the plane, for `below` linework. */
function belowFootprint(mesh: ElementMesh, h: number): readonly Point[] | null {
  const p = mesh.positions;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (p[i + 1]! < h - 1e-6) {
      any = true;
      if (p[i]! < minX) minX = p[i]!;
      if (p[i]! > maxX) maxX = p[i]!;
      if (p[i + 2]! < minZ) minZ = p[i + 2]!;
      if (p[i + 2]! > maxZ) maxZ = p[i + 2]!;
    }
  }
  if (!any || maxX - minX < 1e-6 || maxZ - minZ < 1e-6) return null;
  return [
    { x: minX, y: minZ },
    { x: maxX, y: minZ },
    { x: maxX, y: maxZ },
    { x: minX, y: maxZ },
  ];
}

export function createPlanProvider(): DrawingProvider {
  return {
    id: "massingviewer-sectioner",
    version: "0.0.0",
    // Elevations and axonometrics need projection and hidden-line work this does not do. Claiming them and
    // producing something wrong is worse than refusing — see the capability-honesty note in kernel-api.
    kinds: ["plan", "section"],

    async generate(input, view, options) {
      if (!["plan", "section"].includes(view.kind)) {
        return err({
          code: "unsupported_kind",
          message: `this provider makes plans and sections, not ${view.kind}s`,
        } satisfies DrawingFailure);
      }
      if (input.meshes.length === 0) {
        return err({ code: "no_geometry", message: "there is no geometry to cut" } satisfies DrawingFailure);
      }
      return ok(generatePlan(input, view, options?.onProgress));
    },
  };
}

/**
 * Cut a plan. Exported directly as well as through the provider, because the interaction path — re-cutting while
 * a user drags a section plane — wants it synchronously inside a frame, with no promise in the way.
 */
export function generatePlan(
  input: DrawingInput,
  view: ViewDefinition,
  onProgress?: (fraction: number, note: string) => void,
): Drawing {
  const started = Date.now();
  const requested = view.cutHeight ?? 1.2;
  const belowDepth = view.belowDepth ?? 3;

  /**
   * Move the cut plane off any face it is exactly coincident with, and say so.
   *
   * ## The bug this fixes, measured
   *
   * `section.ts` discards triangles coplanar with the cut plane — deliberately, and documented there. The
   * consequence was measured against `fixtures/sample.ifc` at every distinct vertical extent, comparing the exact
   * height against 1 mm either side:
   *
   * | datum | 1 mm below | exactly at | 1 mm above |
   * |---|---|---|---|
   * | 0.000 | 1 | **0** | 6 |
   * | 0.900 | 6 | **5** | 7 |
   * | 2.100 | 7 | **3** | 5 |
   * | 3.000 | 5 | **0** | 0 |
   *
   * **Every datum loses loops at the exact height**, and at 2.100 seven become three — four walls gone from the
   * drawing. `docs/adr/0004-2d-drawing-engine.md` calls this *"the normal case in BIM, not an edge case"*, because
   * a slab top sitting precisely on a storey elevation is ubiquitous and plans are cut at storey elevations.
   *
   * The part that made it dangerous rather than merely wrong: it was **silent**. `incomplete[]` cannot see it,
   * because the sectioner does not know it dropped anything, so the drawing was wrong *and* reported complete.
   *
   * ## Why a nudge rather than exact coplanar handling
   *
   * Robust coplanar handling is most of the difficulty in a sectioner — it is the reason ADR-0004 preferred to
   * adopt one rather than write one. This is the standard general-position technique: perturb the plane
   * infinitesimally so no face is exactly on it, and the degenerate case stops existing.
   *
   * ## The size is measured, not chosen — and the sweep found something worse than the original bug
   *
   * Cutting a unit cube at a series of heights just above its bottom face:
   *
   * | height above the face | closed loops | reported incomplete |
   * |---|---|---|
   * | 1 µm | 0 | — |
   * | 10 µm | 1 | 1 open chain discarded |
   * | **50 µm** | **0** | **4 open chains — "the mesh is not watertight there"** |
   * | 100 µm | 1 | none |
   * | 500 µm | 1 | none |
   *
   * **It is not monotonic.** 50 µm is worse than 10 µm, and both are worse than 100 µm. Within about 0.1 mm of a
   * face this sectioner produces unstable garbage — and it accuses a perfectly watertight cube of not being
   * watertight, which is a false accusation in a provenance field a reviewer is supposed to trust.
   *
   * Two consequences. First, `NUDGE` is **100 µm**, the smallest value the sweep found clean; 1 µm — the obvious
   * choice, and the first thing tried — changes nothing at all, because the straddle test below reads
   * `extent.min < h - 1e-6` and a nudge of exactly that epsilon leaves `0 < 0`. Second, this is independent
   * evidence for replacing the whole cutter with a watertight boolean rather than tuning it: an epsilon that has to
   * be found by sweeping is an epsilon that will be wrong on somebody's model.
   *
   * 100 µm is 0.1 mm in model space and 1 µm on paper at 1:100, far inside any construction tolerance, and for a
   * prismatic wall the plan coordinates of the loop do not depend on the cut height at all. On a *sloped* face they
   * would shift by up to 0.1 mm, which is the digest's own quantisation step — worth knowing, and still invisible.
   *
   * It nudges **up**, because a plan cut at a storey elevation means the storey above it. That is a judgement, so
   * it is declared.
   *
   * ## What this actually achieves, and what it does not
   *
   * Measured on `fixtures/sample.ifc` after the fix — every datum now yields the **same loop count as the height
   * 1 mm above it**, which is the semantic being claimed:
   *
   * | datum | 1 mm below | exactly at | 1 mm above |
   * |---|---|---|---|
   * | −0.200 | 0 | **1** | 1 |
   * | 0.000 | 1 | **6** | 6 |
   * | 0.900 | 6 | **7** | 7 |
   * | 2.100 | 7 | **5** | 5 |
   * | 3.000 | 5 | **0** | 0 |
   *
   * **It is a mitigation, not a cure.** At the nudged height the sectioner still discards some open chains — six at
   * y=0, two at 0.9 and 2.1 — where 1 mm above it discards none. Those are now *reported* in `incomplete[]` rather
   * than lost silently, which is the whole difference between this and the bug, but they are still losses. Clearing
   * them needs the watertight boolean, not a bigger epsilon: the sweep above shows the fragile zone is millimetres
   * wide, and a nudge large enough to escape it would be large enough to skip real geometry.
   *
   * The exact fix is still a watertight boolean (`manifold-3d`, Apache-2.0 and now licence-cleared) intersecting
   * the solid with a thin slab. This is not a substitute for that; it is the difference between a drawing that
   * silently loses walls today and one that does not.
   */
  const NUDGE = 1e-4;
  /**
   * Within this of a face, the plane counts as coincident. **1 µm, and 1 nm is far too tight — this is the detail
   * the first version of the fix got wrong.**
   *
   * Tessellated positions are `Float32Array`, so a datum authored as 0.9 arrives as `0.899999976158142090` and 2.1
   * as `2.09999990463256836` — off by 2.4e-8 and 9.5e-8. A 1e-9 window missed both, so the nudge fired at y=0 and
   * y=3 (exactly representable) and silently did nothing at the two datums that mattered most. The measured result
   * went from `0, 0, 5, 3, 0` loops to `1, 6, 5, 3, 0`: half a fix, which is the kind that looks like a fix.
   *
   * 1 µm covers float32 quantisation at building coordinates with room to spare, and is still four orders of
   * magnitude below anything a drawing shows.
   */
  const COINCIDENT = 1e-6;

  let coincidentWith: number | null = null;
  for (const mesh of input.meshes) {
    for (let i = 1; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i]!;
      if (Math.abs(y - requested) <= COINCIDENT) {
        coincidentWith = y;
        break;
      }
    }
    if (coincidentWith !== null) break;
  }

  const h = coincidentWith === null ? requested : requested + NUDGE;

  const entities: DrawingEntity[] = [];
  /**
   * What did not make it into the drawing — seeded with what never made it into the *input*.
   *
   * Losses upstream of here are still losses in the drawing, and until the golden suite looked, they were
   * invisible: a plan built from a model whose tessellator had dropped three elements reported `incomplete: []`
   * and full coverage. `DrawingProvenance.incomplete` exists precisely so a plan cannot be quietly short of a
   * wall, and it was only ever reporting the last stage of a two-stage pipeline.
   *
   * Prefixed so the caller's reason survives verbatim: "the tessellator: no shape representation" tells a reader
   * which stage lost it, which is the first thing anyone needs to know.
   */
  const incomplete: { guid: Guid | null; ifcClass: string; reason: string }[] = (input.skipped ?? []).map((s) => ({
    guid: s.guid ?? null,
    ifcClass: s.ifcClass,
    reason: `before generation: ${s.reason}`,
  }));
  let n = 0;

  for (const mesh of input.meshes) {
    n += 1;
    onProgress?.(n / input.meshes.length, mesh.name ?? mesh.ifcClass);

    const extent = verticalExtent(mesh);
    if (extent === null) {
      incomplete.push({ guid: mesh.guid, ifcClass: mesh.ifcClass, reason: "the mesh has no vertices" });
      continue;
    }

    const straddles = extent.min < h - 1e-6 && extent.max > h + 1e-6;

    if (straddles) {
      const segments: Seg[] = [];
      for (const t of triangles(mesh)) {
        const seg = cutTriangle(t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!, t[6]!, t[7]!, t[8]!, h);
        if (seg !== null) segments.push(seg);
      }
      const { loops, open } = stitch(segments);

      if (loops.length === 0) {
        // Straddling the plane and yielding nothing closed is a real failure, and the *only* signal a user would
        // otherwise get is a wall missing from the plan — which looks exactly like a wall that is not there.
        incomplete.push({
          guid: mesh.guid,
          ifcClass: mesh.ifcClass,
          reason:
            open.length > 0
              ? `crosses the cut plane but produced ${open.length} open chain(s) — the mesh is not watertight there`
              : "crosses the cut plane but produced no closed loop",
        });
      } else if (open.length > 0) {
        incomplete.push({
          guid: mesh.guid,
          ifcClass: mesh.ifcClass,
          reason: `${open.length} open chain(s) discarded alongside ${loops.length} closed loop(s)`,
        });
      }

      for (const [i, region] of nestLoops(loops).entries()) {
        const common = {
          guid: mesh.guid ?? undefined,
          ifcClass: mesh.ifcClass,
          layer: layerFor(mesh.ifcClass),
          attrs: mesh.attrs,
        };
        // Poché first, cut outline second: the fill must be under the line, and SVG is painted in document
        // order. Emitting them the other way round draws a solid over its own outline and loses the heaviest
        // line in the drawing.
        entities.push({
          id: `${mesh.guid ?? `m${n}`}-poche-${i}`,
          role: "poche",
          geometry: {
            kind: "region",
            region: { outer: region.outer.map(toPoint), holes: region.holes.map((ring) => ring.map(toPoint)) },
          },
          ...common,
        });
        entities.push({
          id: `${mesh.guid ?? `m${n}`}-cut-${i}`,
          role: "cut",
          geometry: { kind: "polyline", points: region.outer.map(toPoint), closed: true },
          ...common,
        });
        for (const [j, hole] of region.holes.entries()) {
          entities.push({
            id: `${mesh.guid ?? `m${n}`}-cut-${i}-h${j}`,
            role: "cut",
            geometry: { kind: "polyline", points: hole.map(toPoint), closed: true },
            ...common,
          });
        }
      }
      continue;
    }

    // Entirely below the plane and within the view depth: drawn dashed, the standard convention for something
    // you can see but are not cutting through.
    if (extent.max <= h + 1e-6 && extent.max > h - belowDepth) {
      const footprint = belowFootprint(mesh, h);
      if (footprint !== null) {
        entities.push({
          id: `${mesh.guid ?? `m${n}`}-below`,
          role: "below",
          geometry: { kind: "polyline", points: footprint, closed: true },
          guid: mesh.guid ?? undefined,
          ifcClass: mesh.ifcClass,
          layer: layerFor(mesh.ifcClass),
          attrs: mesh.attrs,
        });
      }
    }
    // Entirely above the plane: correctly absent, and NOT an `incomplete` entry. Reporting it would make the
    // list meaningless — on any real model most elements are above any given cut.
  }

  const provenance: Omit<DrawingProvenance, "guidCoverage"> = {
    provider: "massingviewer-sectioner",
    providerVersion: "0.0.0",
    durationMs: Date.now() - started,
    incomplete,
    // Stated, not implied. Each of these is a real difference from a drawing an architect would issue, and a
    // reviewer is entitled to know which before trusting it.
    approximations: [
      // Declared per drawing, not as a standing caveat: this one only applies when it happened, and a reviewer
      // needs to know that the plane they asked for is not quite the plane that was cut.
      ...(coincidentWith === null
        ? []
        : [
            `the cut plane was coincident with a face at ${coincidentWith} m, so it was moved up by ` +
              `${NUDGE} m to avoid discarding coplanar geometry — a plan cut at a storey elevation shows the ` +
              `storey above it`,
          ]),
      "below-cut linework is a bounding box, not a projected outline",
      "no hidden-line removal",
      "no grid lines, bubbles, dimensions, tags or keynotes",
      "no door swings or stair direction arrows",
      "poché is a flat fill, not a material hatch",
    ],
  };

  return makeDrawing({
    kind: view.kind,
    name: input.name,
    entities,
    view: { ...view, cutHeight: h, belowDepth },
    provenance,
  });
}
