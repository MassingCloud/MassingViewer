/**
 * A building-shaped fixture, as MeshData[].
 *
 * The bake-off needs both engines to see *identical* input, and `generateFloorPlan(meshes, ...)` takes
 * MeshData directly — so building the meshes here sidesteps the whole IFC-parse-and-tessellate path.
 * That is the right experiment design regardless of convenience: it isolates the sectioner, which is the
 * thing being compared. Any difference in output is then attributable to the algorithm and not to two
 * different tessellations of the same wall.
 *
 * Geometry is a plausible small building rather than abstract boxes, because the interesting cases are
 * architectural: a wall with an opening in it, two walls meeting at a corner, a slab below the cut plane,
 * and a column that is only a dot in plan.
 */

/** Axis-aligned box as a triangle soup. 12 triangles, 36 vertices (no index sharing — matches how a
 *  tessellator emits per-face normals). */
function box(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // z0 face
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], // z1 face
  ];
  const faces = [
    [0, 1, 2, 3, [0, 0, -1]], // bottom in z
    [5, 4, 7, 6, [0, 0, 1]],
    [4, 5, 1, 0, [0, -1, 0]],
    [6, 7, 3, 2, [0, 1, 0]],
    [7, 4, 0, 3, [-1, 0, 0]],
    [5, 6, 2, 1, [1, 0, 0]],
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  let n = 0;
  for (const [a, b, c, d, nrm] of faces) {
    for (const i of [a, b, c, a, c, d]) {
      positions.push(v[i][0], v[i][1], v[i][2]);
      normals.push(nrm[0], nrm[1], nrm[2]);
      indices.push(n++);
    }
  }
  return { positions, normals, indices };
}

/** A wall with a rectangular opening, as four boxes (below / above / left / right of the hole).
 *  Modelling the opening as a void in the solid is what makes a plan cut interesting: the cut at door
 *  height must show TWO wall segments, not one. */
function wallWithOpening(a, b, thickness, height, opening) {
  const parts = [];
  const [ax, az] = a;
  const [bx, bz] = b;
  const horizontal = Math.abs(bz - az) < 1e-9;
  const t = thickness / 2;

  const spanStart = horizontal ? ax : az;
  const spanEnd = horizontal ? bx : bz;
  const lo = Math.min(spanStart, spanEnd);
  const hi = Math.max(spanStart, spanEnd);
  const cross = horizontal ? az : ax;

  const seg = (s0, s1, y0, y1) =>
    horizontal
      ? box([s0, y0, cross - t], [s1, y1, cross + t])
      : box([cross - t, y0, s0], [cross + t, y1, s1]);

  if (!opening) {
    parts.push(seg(lo, hi, 0, height));
    return parts;
  }
  const { at, width, sill, head } = opening;
  const o0 = lo + at;
  const o1 = o0 + width;
  parts.push(seg(lo, o0, 0, height)); // left of opening
  parts.push(seg(o1, hi, 0, height)); // right of opening
  if (sill > 0) parts.push(seg(o0, o1, 0, sill)); // below (a window's sill wall)
  if (head < height) parts.push(seg(o0, o1, head, height)); // above (the lintel)
  return parts;
}

function merge(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  let base = 0;
  for (const p of parts) {
    positions.push(...p.positions);
    normals.push(...p.normals);
    for (const i of p.indices) indices.push(i + base);
    base += p.positions.length / 3;
  }
  return { positions, normals, indices };
}

const GREY = [0.8, 0.8, 0.8, 1];

function mesh(expressId, ifcType, parts, color = GREY) {
  const m = merge(Array.isArray(parts) ? parts : [parts]);
  return {
    expressId,
    ifcType,
    modelIndex: 0,
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.indices),
    color,
  };
}

/**
 * A single-storey building, 8 m x 6 m, walls 200 mm, 3 m high.
 *
 * Y is up (which is what drawing-2d's 'y' axis section expects); X/Z is the plan plane, matching the
 * convention in @massing/geometry-math.
 *
 * Expected at a 1.2 m plan cut:
 *   - 4 walls cut → 4 closed loops, but the south wall is split by a door opening whose head is at
 *     2.1 m, so it contributes TWO loops. 5 wall loops total.
 *   - the north wall has a window with sill 0.9 m and head 2.1 m → cut at 1.2 m passes through the
 *     opening, so it also contributes two loops. 6 wall loops.
 *   - the slab is entirely below the cut → projection/below only, never a cut loop.
 *   - the column is cut → 1 loop.
 */
export function smallBuilding() {
  const H = 3.0;
  const T = 0.2;
  const meshes = [];
  let id = 100;

  /**
   * Push one element, taking the next expressId.
   *
   * A helper rather than a repeated `mesh(id++, …)`: the trailing `id++` was a dead increment, and the obvious fix —
   * dropping the `++` on the last line only — makes adding a seventh element a silent duplicate-id bug. Owning the
   * counter here means a caller cannot get it wrong, and the increment stays genuinely live.
   */
  const add = (ifcType, geometry, color) => void meshes.push(mesh(id++, ifcType, geometry, color));

  // South wall (z=0) with a door: 0.9 m wide at 3.0 m along, head 2.1 m, no sill.
  add("IfcWall", wallWithOpening([0, 0], [8, 0], T, H, { at: 3.0, width: 0.9, sill: 0, head: 2.1 }));
  // North wall (z=6) with a window: 1.5 m wide at 2.0 m along, sill 0.9 m, head 2.1 m.
  add("IfcWall", wallWithOpening([0, 6], [8, 6], T, H, { at: 2.0, width: 1.5, sill: 0.9, head: 2.1 }));
  // West and east walls, solid.
  add("IfcWall", wallWithOpening([0, 0], [0, 6], T, H, null));
  add("IfcWall", wallWithOpening([8, 0], [8, 6], T, H, null));

  // Slab, 200 mm, entirely below the cut plane.
  add("IfcSlab", box([-0.2, -0.2, -0.2], [8.2, 0, 6.2]), [0.6, 0.6, 0.6, 1]);

  // A 300 mm square column mid-floor — a dot in plan, and a good test of small-feature survival.
  add("IfcColumn", box([3.85, 0, 2.85], [4.15, H, 3.15]));

  return meshes;
}

/** Scale the fixture up by tiling it, to measure how each engine behaves as triangle count grows. */
export function tiled(times) {
  const out = [];
  let id = 1000;
  for (let i = 0; i < times; i++) {
    for (const m of smallBuilding()) {
      const dx = (i % 10) * 10;
      const dz = Math.floor(i / 10) * 8;
      const positions = new Float32Array(m.positions.length);
      for (let k = 0; k < m.positions.length; k += 3) {
        positions[k] = m.positions[k] + dx;
        positions[k + 1] = m.positions[k + 1];
        positions[k + 2] = m.positions[k + 2] + dz;
      }
      out.push({ ...m, expressId: id++, positions });
    }
  }
  return out;
}

export function triangleCount(meshes) {
  return meshes.reduce((n, m) => n + m.indices.length / 3, 0);
}
