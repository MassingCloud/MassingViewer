import { err, ok } from "@massingviewer/core";
import type { Guid } from "@massingviewer/core";
import {
  type Drawing,
  type DrawingEntity,
  type DrawingProvenance,
  type Point,
  type ViewDefinition,
  makeDrawing,
} from "./model";
import type { DrawingFailure, DrawingInput, DrawingProvider, ElementMesh } from "./provider";
import { type Seg, cutTriangle, nestLoops, stitch } from "./section";

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
  const h = view.cutHeight ?? 1.2;
  const belowDepth = view.belowDepth ?? 3;

  const entities: DrawingEntity[] = [];
  const incomplete: { guid: Guid | null; ifcClass: string; reason: string }[] = [];
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
