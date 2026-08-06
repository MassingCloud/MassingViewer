/**
 * The competing implementation: a section cutter written from scratch in TypeScript-shaped JS.
 *
 * This is the "port drawings.py" arm of the ADR-0004 bake-off, reduced to its core. drawings.py's
 * `cut_baked_guided` does exactly this: tessellate, intersect every triangle with the cut plane, stitch the
 * resulting segments into closed loops, and carry the element's GlobalId through so the output knows what
 * it came from.
 *
 * Written honestly rather than as a straw man — a rigged comparison is worse than no comparison. It does
 * the real work: exact plane-triangle intersection with the degenerate cases handled, spatial-hash loop
 * stitching, and below-cut footprint projection.
 *
 * What it deliberately does NOT do, because those are weeks each and the point is to measure the core:
 * hidden-line removal, silhouette/crease edges, hatching, material layers, door swings, or line merging.
 * That asymmetry is recorded in the results rather than hidden.
 */

const EPS = 1e-9;

/**
 * Intersect one triangle with the plane y = h, returning a segment or null.
 *
 * The three cases that matter, and the reason this is not a two-liner:
 *  - all three vertices on one side → no intersection
 *  - two vertices one side, one the other → one segment across the two crossing edges
 *  - a vertex exactly ON the plane → the classic degenerate case. Treating "on the plane" as a side
 *    produces duplicated or zero-length segments that then corrupt the stitch. Vertices within EPS are
 *    snapped to the plane and coplanar triangles are dropped entirely (the faces above and below will
 *    supply the boundary).
 */
function triPlane(ax, ay, az, bx, by, bz, cx, cy, cz, h) {
  const da = ay - h;
  const db = by - h;
  const dc = cy - h;

  const sa = Math.abs(da) < EPS ? 0 : da > 0 ? 1 : -1;
  const sb = Math.abs(db) < EPS ? 0 : db > 0 ? 1 : -1;
  const sc = Math.abs(dc) < EPS ? 0 : dc > 0 ? 1 : -1;

  // Entirely one side (zeros count as "touching", not crossing).
  if (sa === sb && sb === sc) return null;
  if (sa >= 0 && sb >= 0 && sc >= 0) return null;
  if (sa <= 0 && sb <= 0 && sc <= 0) return null;

  const pts = [];
  const edge = (x0, y0, z0, d0, x1, y1, z1, d1) => {
    if (d0 === 0) return [x0, z0];
    if (d1 === 0) return [x1, z1];
    if ((d0 > 0) === (d1 > 0)) return null;
    const t = d0 / (d0 - d1);
    return [x0 + t * (x1 - x0), z0 + t * (z1 - z0)];
  };

  for (const [p, q] of [
    [[ax, ay, az, da, sa], [bx, by, bz, db, sb]],
    [[bx, by, bz, db, sb], [cx, cy, cz, dc, sc]],
    [[cx, cy, cz, dc, sc], [ax, ay, az, da, sa]],
  ]) {
    const r = edge(p[0], p[1], p[2], p[4] === 0 ? 0 : p[3], q[0], q[1], q[2], q[4] === 0 ? 0 : q[3]);
    if (r) pts.push(r);
  }

  // Deduplicate — a vertex on the plane is found by both its edges.
  const uniq = [];
  for (const p of pts) {
    if (!uniq.some((u) => Math.abs(u[0] - p[0]) < 1e-7 && Math.abs(u[1] - p[1]) < 1e-7)) uniq.push(p);
  }
  if (uniq.length !== 2) return null;
  if (Math.hypot(uniq[0][0] - uniq[1][0], uniq[0][1] - uniq[1][1]) < 1e-7) return null;
  return uniq;
}

/**
 * Stitch segments into closed loops via a spatial hash on endpoints.
 *
 * Quantising to a grid rather than comparing floats pairwise is what makes this O(n) instead of O(n squared).
 * The quantum has to be looser than the intersection's own error but tighter than any real feature —
 * 0.1 mm here, which is below manufacturing tolerance and far above float noise at building scale.
 */
function stitch(segments) {
  const Q = 1e-4;
  const key = (x, z) => `${Math.round(x / Q)},${Math.round(z / Q)}`;

  const adjacency = new Map();
  for (let i = 0; i < segments.length; i++) {
    for (const end of [0, 1]) {
      const k = key(segments[i][end][0], segments[i][end][1]);
      if (!adjacency.has(k)) adjacency.set(k, []);
      adjacency.get(k).push({ seg: i, end });
    }
  }

  const used = new Uint8Array(segments.length);
  const loops = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const loop = [segments[start][0], segments[start][1]];
    let head = segments[start][1];

    for (;;) {
      const candidates = adjacency.get(key(head[0], head[1])) ?? [];
      let next = null;
      for (const c of candidates) {
        if (used[c.seg]) continue;
        next = c;
        break;
      }
      if (!next) break;
      used[next.seg] = 1;
      head = segments[next.seg][next.end === 0 ? 1 : 0];
      loop.push(head);
      // Closed?
      if (key(head[0], head[1]) === key(loop[0][0], loop[0][1])) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** Plan-projected footprint of everything strictly below the cut — the dashed below-cut linework. */
function belowFootprint(mesh, h) {
  const p = mesh.positions;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, any = false;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] < h - EPS) {
      any = true;
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
  }
  return any ? { minX, maxX, minZ, maxZ } : null;
}

/**
 * Generate a plan at height `h` from MeshData[].
 *
 * Output shape mirrors the fields the bake-off compares, so the two engines can be scored identically.
 */
export function generatePlan(meshes, h) {
  const lines = [];
  const cutPolygons = [];
  const below = [];
  let triangles = 0;

  for (const m of meshes) {
    const p = m.positions;
    const idx = m.indices;
    const segments = [];
    for (let i = 0; i < idx.length; i += 3) {
      triangles++;
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const s = triPlane(
        p[a], p[a + 1], p[a + 2],
        p[b], p[b + 1], p[b + 2],
        p[c], p[c + 1], p[c + 2],
        h,
      );
      if (s) segments.push(s);
    }

    for (const s of segments) {
      lines.push({
        line: { start: { x: s[0][0], y: s[0][1] }, end: { x: s[1][0], y: s[1][1] } },
        category: "cut",
        visibility: "visible",
        entityId: m.expressId,
        ifcType: m.ifcType,
        modelIndex: m.modelIndex ?? 0,
        depth: 0,
      });
    }

    for (const loop of stitch(segments)) {
      cutPolygons.push({
        polygon: { outer: loop.map(([x, z]) => ({ x, y: z })), holes: [] },
        entityId: m.expressId,
        ifcType: m.ifcType,
        modelIndex: m.modelIndex ?? 0,
        isCut: true,
      });
    }

    const bf = belowFootprint(m, h);
    if (bf) below.push({ ...bf, entityId: m.expressId, ifcType: m.ifcType });
  }

  return { lines, cutPolygons, below, stats: { totalTriangles: triangles, polygonCount: cutPolygons.length } };
}
