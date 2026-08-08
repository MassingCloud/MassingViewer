import type { SourceMesh } from "@massing/viewport";

/**
 * A minimal IFC tessellator: `IfcExtrudedAreaSolid` over `IfcArbitraryClosedProfileDef` only.
 *
 * ## Why this exists when `@ifc-lite/geometry` is the chosen geometry layer
 *
 * The walking skeleton's job is to prove the viewport renders, orbits and picks. `@ifc-lite/geometry` needs a
 * WASM runtime and a worker; wiring that is `LocalKernel`'s work (M4), and blocking the first demoable
 * milestone on it would be sequencing the hard thing before the thing that proves the easy thing works.
 *
 * It is not throwaway. Extruded profiles are what `LocalKernel` will author, and a fast local tessellation of
 * a profile-plus-depth is exactly what a **push/pull preview** needs — dragging a wall height cannot wait on
 * a worker round-trip per frame. So this is the seed of the preview path, not a stand-in for the real one.
 *
 * ## What it deliberately does not do
 *
 * No booleans, so **openings are ignored** — a wall with a door tessellates as solid. No CSG, no swept solids,
 * no BREPs, no mapped representations, no placement hierarchies beyond a single translation. Those are why
 * ifc-lite exists. This handles precisely the subset `fixtures/sample.ifc` is built from, and it reports what
 * it skipped rather than silently producing a partial model — a viewer missing half a building with no
 * indication is the failure mode this whole codebase keeps designing against.
 */

export interface TessellateResult {
  readonly meshes: SourceMesh[];
  /** expressID → GlobalId, for the viewport's identity resolver. */
  readonly guids: Map<number, string>;
  /** Products present in the file that this tessellator could not handle, and why. */
  readonly skipped: { readonly expressId: number; readonly type: string; readonly reason: string }[];
}

/** One parsed STEP entity: `#12= IFCWALL('guid',$,'Name',...)`. */
interface Entity {
  readonly id: number;
  readonly type: string;
  readonly args: string;
}

/**
 * Split a STEP argument list at top-level commas.
 *
 * Cannot be `args.split(",")`: arguments contain nested parentheses (`(#1,#2,#3)`) and quoted strings that may
 * themselves contain commas and escaped quotes (`''`). A naive split silently mis-associates every argument
 * after the first list, which produces geometry in the wrong place rather than an error.
 */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inString) {
      if (c === "'") {
        // `''` is an escaped quote inside a STEP string, not the end of it.
        if (args[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

const refId = (s: string): number | null => {
  const m = /^#(\d+)$/.exec(s.trim());
  return m ? Number(m[1]) : null;
};
const refList = (s: string): number[] =>
  splitArgs(s.trim().replace(/^\(|\)$/g, ""))
    .map(refId)
    .filter((n): n is number => n !== null);
const num = (s: string): number => Number(s.trim().replace(/\.$/, ""));
const str = (s: string): string | null => {
  const t = s.trim();
  return t.startsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : null;
};

/** Parse the DATA section into an entity table. */
export function parseStep(text: string): Map<number, Entity> {
  const entities = new Map<number, Entity>();
  const data = text.slice(text.indexOf("DATA;") + 5);
  // Entities can wrap across lines in the wild; match on the `#id= TYPE(...)` shape with a non-greedy body
  // terminated by `);` rather than assuming one per line.
  for (const m of data.matchAll(/#(\d+)=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\);/g)) {
    entities.set(Number(m[1]), { id: Number(m[1]), type: m[2]!, args: m[3]! });
  }
  return entities;
}

/** Products this tessellator will try. Openings are excluded — they are voids, not geometry to draw. */
const DRAWN = new Set([
  "IFCWALL", "IFCWALLSTANDARDCASE", "IFCSLAB", "IFCCOLUMN", "IFCBEAM",
  "IFCROOF", "IFCPLATE", "IFCMEMBER", "IFCFOOTING", "IFCSTAIR", "IFCRAILING", "IFCCOVERING",
]);

const CLASS_COLOR: Record<string, [number, number, number, number]> = {
  IFCWALL: [0.82, 0.80, 0.76, 1],
  IFCWALLSTANDARDCASE: [0.82, 0.80, 0.76, 1],
  IFCSLAB: [0.62, 0.62, 0.64, 1],
  IFCCOLUMN: [0.55, 0.58, 0.64, 1],
  IFCBEAM: [0.55, 0.58, 0.64, 1],
};

/**
 * Triangulate a simple polygon by fan from vertex 0.
 *
 * Correct only for convex polygons, and every profile in the fixture is a rectangle. A concave profile would
 * produce overlapping triangles — visible, not silent — and the honest fix is ear-clipping via `earcut` when
 * a real profile needs it. Stated rather than pretended: this is the subset boundary.
 */
function fanTriangles(pointCount: number): number[] {
  const tris: number[] = [];
  for (let i = 1; i < pointCount - 1; i++) tris.push(0, i, i + 1);
  return tris;
}

/** Build a prism from a closed 2D profile extruded along +Z, translated by `offset`. */
function prism(
  profile: readonly [number, number][],
  depth: number,
  offset: readonly [number, number, number],
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const n = profile.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const [ox, oy, oz] = offset;

  // IFC extrudes along local +Z; the viewport is Y-up. Map profile (x,y) -> world (x, z_profile, y_profile)
  // so the extrusion direction becomes world +Y. Doing this here rather than rotating the scene keeps the
  // geometry in the same coordinate convention as @massing/geometry-math (plan = world X/Z).
  const at = (i: number, h: number): [number, number, number] => [
    profile[i]![0] + ox,
    h + oy,
    profile[i]![1] + oz,
  ];

  const push = (p: [number, number, number], nrm: [number, number, number]) => {
    positions.push(p[0], p[1], p[2]);
    normals.push(nrm[0], nrm[1], nrm[2]);
    return positions.length / 3 - 1;
  };

  // Caps. Emitted with their own vertices so the flat normal is correct — sharing vertices with the walls
  // would average the normals and light the prism like a sphere.
  const bottom = [...Array(n).keys()].map((i) => push(at(i, 0), [0, -1, 0]));
  const top = [...Array(n).keys()].map((i) => push(at(i, depth), [0, 1, 0]));
  for (const [a, b, c] of chunk3(fanTriangles(n))) indices.push(bottom[a]!, bottom[c]!, bottom[b]!);
  for (const [a, b, c] of chunk3(fanTriangles(n))) indices.push(top[a]!, top[b]!, top[c]!);

  // Sides.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = at(i, 0);
    const p1 = at(j, 0);
    const dx = p1[0] - p0[0];
    const dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dz) || 1;
    const nrm: [number, number, number] = [dz / len, 0, -dx / len];
    const a = push(at(i, 0), nrm);
    const b = push(at(j, 0), nrm);
    const c = push(at(j, depth), nrm);
    const d = push(at(i, depth), nrm);
    indices.push(a, b, c, a, c, d);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function* chunk3(arr: number[]): Generator<[number, number, number]> {
  for (let i = 0; i < arr.length; i += 3) yield [arr[i]!, arr[i + 1]!, arr[i + 2]!];
}

export function tessellate(ifcText: string): TessellateResult {
  const ents = parseStep(ifcText);
  const meshes: SourceMesh[] = [];
  const guids = new Map<number, string>();
  const skipped: TessellateResult["skipped"] = [];

  /** Accumulated translation from a chain of IfcLocalPlacement / IfcAxis2Placement3D. */
  function placementOffset(id: number | null): [number, number, number] {
    let x = 0;
    let y = 0;
    let z = 0;
    let cursor = id;
    const guard = new Set<number>();
    while (cursor !== null && !guard.has(cursor)) {
      guard.add(cursor);
      const e = ents.get(cursor);
      if (!e || e.type !== "IFCLOCALPLACEMENT") break;
      const [rel, axis] = splitArgs(e.args);
      const ax = ents.get(refId(axis ?? "") ?? -1);
      if (ax?.type === "IFCAXIS2PLACEMENT3D") {
        const pt = ents.get(refId(splitArgs(ax.args)[0] ?? "") ?? -1);
        if (pt?.type === "IFCCARTESIANPOINT") {
          const c = splitArgs(pt.args[0] === "(" ? pt.args.slice(1, -1) : pt.args.replace(/^\(|\)$/g, ""));
          // IFC is Z-up; the viewport is Y-up. Same swap as in `prism`.
          x += num(c[0] ?? "0");
          z += num(c[1] ?? "0");
          y += num(c[2] ?? "0");
        }
      }
      cursor = refId(rel ?? "");
    }
    return [x, y, z];
  }

  /** The first IfcExtrudedAreaSolid reachable from a product's representation. */
  function solidOf(shapeId: number | null): { profile: [number, number][]; depth: number; localZ: number } | null {
    const shape = ents.get(shapeId ?? -1);
    if (!shape || shape.type !== "IFCPRODUCTDEFINITIONSHAPE") return null;
    for (const repId of refList(splitArgs(shape.args)[2] ?? "()")) {
      const rep = ents.get(repId);
      if (rep?.type !== "IFCSHAPEREPRESENTATION") continue;
      for (const itemId of refList(splitArgs(rep.args)[3] ?? "()")) {
        const item = ents.get(itemId);
        if (item?.type !== "IFCEXTRUDEDAREASOLID") continue;
        const [profileRef, posRef, , depthStr] = splitArgs(item.args);
        const profileEnt = ents.get(refId(profileRef ?? "") ?? -1);
        if (profileEnt?.type !== "IFCARBITRARYCLOSEDPROFILEDEF") continue;
        const polyline = ents.get(refId(splitArgs(profileEnt.args)[2] ?? "") ?? -1);
        if (polyline?.type !== "IFCPOLYLINE") continue;

        const pts: [number, number][] = [];
        for (const pid of refList(polyline.args)) {
          const p = ents.get(pid);
          if (p?.type !== "IFCCARTESIANPOINT") continue;
          const c = splitArgs(p.args.replace(/^\(|\)$/g, ""));
          pts.push([num(c[0] ?? "0"), num(c[1] ?? "0")]);
        }
        // A closed IfcPolyline repeats its first point; drop the duplicate or the fan produces a zero-area
        // triangle and the side loop emits a degenerate quad.
        if (pts.length > 2 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) {
          pts.pop();
        }
        if (pts.length < 3) continue;

        // The extrusion's own placement can lift it (the slab sits at z = -0.2).
        let localZ = 0;
        const pos = ents.get(refId(posRef ?? "") ?? -1);
        if (pos?.type === "IFCAXIS2PLACEMENT3D") {
          const pt = ents.get(refId(splitArgs(pos.args)[0] ?? "") ?? -1);
          if (pt?.type === "IFCCARTESIANPOINT") {
            const c = splitArgs(pt.args.replace(/^\(|\)$/g, ""));
            localZ = num(c[2] ?? "0");
          }
        }
        return { profile: pts, depth: num(depthStr ?? "0"), localZ };
      }
    }
    return null;
  }

  for (const ent of ents.values()) {
    if (!DRAWN.has(ent.type)) continue;
    const a = splitArgs(ent.args);
    const guid = str(a[0] ?? "");
    if (guid) guids.set(ent.id, guid);

    const solid = solidOf(refId(a[6] ?? ""));
    if (!solid) {
      skipped.push({
        expressId: ent.id,
        type: ent.type,
        reason: "no IfcExtrudedAreaSolid over IfcArbitraryClosedProfileDef found",
      });
      continue;
    }

    const [ox, oy, oz] = placementOffset(refId(a[5] ?? ""));
    const g = prism(solid.profile, solid.depth, [ox, oy + solid.localZ, oz]);
    meshes.push({
      expressId: ent.id,
      ifcType: ent.type,
      modelIndex: 0,
      positions: g.positions,
      normals: g.normals,
      indices: g.indices,
      color: CLASS_COLOR[ent.type] ?? [0.75, 0.75, 0.75, 1],
    });
  }

  return { meshes, guids, skipped };
}
