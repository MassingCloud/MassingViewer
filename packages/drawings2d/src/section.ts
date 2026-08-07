/**
 * Cutting a triangle soup with a horizontal plane.
 *
 * Ported from the bake-off harness in `bench/drawing-engines/own-sectioner.mjs`, which ADR-0004 measured at
 * 8.5× faster than `@ifc-lite/drawing-2d` on cut-only work (1.03 vs 8.81 µs/tri) — which is why it survives as
 * the **interaction** engine even though ifc-lite won the generation bake-off on coplanar-cut correctness.
 *
 * "Interaction" is the whole justification for keeping it: re-cutting as a user drags a section plane needs to
 * happen inside a frame, and a generator that takes 8× longer cannot. Correctness at a datum is the generator's
 * problem, not the scrubber's.
 */

/**
 * Tolerance for "on the plane", in metres.
 *
 * 1 µm: far below any real building feature and far above float noise at building coordinates. The value
 * matters because the degenerate case — a vertex exactly on the plane — is the normal case in BIM, not a rare
 * one: floors and ceilings sit at round numbers, and people cut at round numbers.
 */
const EPS = 1e-6;

/** Quantum for endpoint matching when stitching, in metres. 0.1 mm — below tolerance, above float noise. */
const QUANTUM = 1e-4;

export type Seg = readonly [readonly [number, number], readonly [number, number]];

/**
 * Intersect one triangle with the plane `y = h`. Returns the segment in (x, z), or null.
 *
 * Three cases, and the third is why this is not a two-liner:
 *
 * - all three vertices on one side → nothing
 * - two one side, one the other → a segment across the two crossing edges
 * - **a vertex exactly on the plane** → the case that breaks naive implementations. Treating "on the plane" as
 *   being on a side produces duplicate or zero-length segments, which then corrupt the stitch into open loops —
 *   and an open loop becomes a wall with a gap in it. Vertices within EPS are snapped to the plane, and
 *   triangles lying *in* the plane are dropped entirely, because the faces above and below already supply that
 *   boundary.
 */
export function cutTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  h: number,
): Seg | null {
  const da = ay - h;
  const db = by - h;
  const dc = cy - h;

  const sa = Math.abs(da) < EPS ? 0 : da > 0 ? 1 : -1;
  const sb = Math.abs(db) < EPS ? 0 : db > 0 ? 1 : -1;
  const sc = Math.abs(dc) < EPS ? 0 : dc > 0 ? 1 : -1;

  // Zeros count as touching, not crossing — so a triangle resting on the plane contributes nothing.
  if (sa === sb && sb === sc) return null;
  if (sa >= 0 && sb >= 0 && sc >= 0) return null;
  if (sa <= 0 && sb <= 0 && sc <= 0) return null;

  const found: [number, number][] = [];
  const edge = (
    x0: number, z0: number, d0: number, s0: number,
    x1: number, z1: number, d1: number, s1: number,
  ): [number, number] | null => {
    if (s0 === 0) return [x0, z0];
    if (s1 === 0) return [x1, z1];
    if (d0 > 0 === d1 > 0) return null;
    const t = d0 / (d0 - d1);
    return [x0 + t * (x1 - x0), z0 + t * (z1 - z0)];
  };

  for (const [p, q] of [
    [[ax, az, da, sa], [bx, bz, db, sb]],
    [[bx, bz, db, sb], [cx, cz, dc, sc]],
    [[cx, cz, dc, sc], [ax, az, da, sa]],
  ] as const) {
    const r = edge(p[0]!, p[1]!, p[2]!, p[3]!, q[0]!, q[1]!, q[2]!, q[3]!);
    if (r !== null) found.push(r);
  }

  // A vertex on the plane is discovered by both of its edges, so deduplicate before deciding.
  const unique: [number, number][] = [];
  for (const p of found) {
    if (!unique.some((u) => Math.abs(u[0] - p[0]) < 1e-7 && Math.abs(u[1] - p[1]) < 1e-7)) unique.push(p);
  }
  if (unique.length !== 2) return null;
  if (Math.hypot(unique[0]![0] - unique[1]![0], unique[0]![1] - unique[1]![1]) < 1e-7) return null;
  return [unique[0]!, unique[1]!];
}

/**
 * Stitch segments into closed loops using a spatial hash on endpoints.
 *
 * Hashing rather than pairwise float comparison is what makes this linear instead of quadratic — on a real
 * model a single storey produces tens of thousands of segments, and O(n²) there is the difference between a
 * drawing appearing and a tab locking up.
 *
 * Open chains are returned too, marked. Dropping them silently is the tempting simplification and it is wrong:
 * an open chain means the mesh was not watertight at the cut, and that is information the caller must be able
 * to report through `DrawingProvenance.incomplete` rather than discover from a wall that has a gap in it.
 */
export function stitch(segments: readonly Seg[]): { loops: [number, number][][]; open: [number, number][][] } {
  const key = (x: number, z: number): string => `${Math.round(x / QUANTUM)},${Math.round(z / QUANTUM)}`;

  const adjacency = new Map<string, { seg: number; end: 0 | 1 }[]>();
  for (const [i, seg] of segments.entries()) {
    for (const end of [0, 1] as const) {
      const k = key(seg[end][0], seg[end][1]);
      const bucket = adjacency.get(k);
      if (bucket) bucket.push({ seg: i, end });
      else adjacency.set(k, [{ seg: i, end }]);
    }
  }

  const used = new Uint8Array(segments.length);
  const loops: [number, number][][] = [];
  const open: [number, number][][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start] === 1) continue;
    used[start] = 1;
    const seg = segments[start]!;
    const chain: [number, number][] = [[seg[0][0], seg[0][1]], [seg[1][0], seg[1][1]]];
    let head = chain[1]!;
    let closed = false;

    for (;;) {
      const candidates = adjacency.get(key(head[0], head[1])) ?? [];
      const next = candidates.find((c) => used[c.seg] === 0);
      if (next === undefined) break;
      used[next.seg] = 1;
      const other = segments[next.seg]![next.end === 0 ? 1 : 0];
      head = [other[0], other[1]];
      chain.push(head);
      if (key(head[0], head[1]) === key(chain[0]![0], chain[0]![1])) {
        closed = true;
        break;
      }
    }
    // Three distinct points minimum, plus the repeated closing point.
    if (closed && chain.length >= 4) loops.push(chain);
    else if (chain.length >= 2) open.push(chain);
  }
  return { loops, open };
}

/** Signed area of a ring. Positive is counter-clockwise. */
export function signedArea(ring: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** True when `inner` lies inside `outer`, tested on a vertex by ray casting. */
export function ringContains(
  outer: readonly (readonly [number, number])[],
  inner: readonly (readonly [number, number])[],
): boolean {
  const probe = inner[0];
  if (probe === undefined) return false;
  let inside = false;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[i]!;
    const b = outer[j]!;
    if (a[1] > probe[1] !== b[1] > probe[1]) {
      const x = ((b[0] - a[0]) * (probe[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (probe[0] < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Group loops into regions of one outer ring plus its holes.
 *
 * Necessary because a wall with a doorway in the cut plane produces two loops, and drawing them as two separate
 * filled shapes fills the doorway in. Nesting is decided by containment and ordered by area, largest first, so
 * an outer ring is always considered before anything it could contain.
 */
export function nestLoops(loops: readonly [number, number][][]): {
  outer: [number, number][];
  holes: [number, number][][];
}[] {
  const byArea = [...loops]
    .map((ring) => ({ ring, area: Math.abs(signedArea(ring)) }))
    .sort((a, b) => b.area - a.area);

  const regions: { outer: [number, number][]; holes: [number, number][][] }[] = [];
  const claimed = new Set<number>();

  for (const [i, candidate] of byArea.entries()) {
    if (claimed.has(i)) continue;
    const holes: [number, number][][] = [];
    for (let j = i + 1; j < byArea.length; j++) {
      if (claimed.has(j)) continue;
      if (ringContains(candidate.ring, byArea[j]!.ring)) {
        holes.push(byArea[j]!.ring);
        claimed.add(j);
      }
    }
    regions.push({ outer: candidate.ring, holes });
    claimed.add(i);
  }
  return regions;
}
