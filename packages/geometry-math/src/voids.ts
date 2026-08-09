/**
 * Subtracting a rectangular void from a rectangular profile.
 *
 * ## Why this exists
 *
 * `fixtures/build-sample.mjs` authors a door and a window as real `IfcOpeningElement` + `IfcRelVoidsElement`, and
 * says why: *"A plan cut at 1.2 m passes through both, so each of those walls must yield TWO loops."* It did not.
 * The tessellator had no handling of voids at all, so every plan showed an unbroken wall where the door is — and
 * the plan calls IFC → plan → markup → PDF "the moat demo". A plan with no door openings is not a drawing anyone
 * would issue.
 *
 * ## Why this shape of solution, and its honest limit
 *
 * A general answer is 3D CSG, which means a WASM boolean kernel this pipeline does not have. What it *does* have is
 * the observation that a wall is an extruded rectangle and an opening is an extruded rectangle through it — and for
 * that case the answer is exact, cheap, and expressible as more extrusions:
 *
 *   - below the sill: the whole profile, floor to sill
 *   - above the head: the whole profile, head to top
 *   - beside the opening: the profile minus the opening's span, sill to head
 *
 * So the wall becomes up to four extrusions and the hole is real — visible in 3D, and cut by any plane a plan
 * generator passes through it. **Anything that is not a four-point profile is refused**, returning `null` so the
 * caller can report it as incomplete rather than silently drawing a wall with no hole. That refusal is the whole
 * difference between a limitation and a lie.
 */

export type Point2 = readonly [number, number];

/** Which parameter of the host rectangle the void spans completely. */
export type VoidAxis = "a" | "b";

export interface VoidSplit {
  /**
   * The host profile with the void's span removed — zero, one, or two rectangles.
   *
   * Zero when the void spans the host entirely: a doorway the full width of a wall segment leaves nothing beside
   * it, which is a real case and not an error.
   */
  readonly beside: readonly Point2[][];
  /** The removed span, as a fraction of the host along {@link axis}. Useful for a caller that wants to report it. */
  readonly span: readonly [number, number];
  readonly axis: VoidAxis;
}

const EPS = 1e-6;

const sub = (p: Point2, q: Point2): Point2 => [p[0] - q[0], p[1] - q[1]];
const dot = (p: Point2, q: Point2): number => p[0] * q[0] + p[1] * q[1];

/**
 * Split a four-point host profile by a four-point void profile.
 *
 * Returns `null` when it cannot answer exactly:
 *
 *  - either profile is not four points — an L-shaped wall needs real CSG;
 *  - the host is degenerate (zero-length edges);
 *  - the void does not span either axis of the host completely, so it is a *pocket* rather than a hole and
 *    removing it would need a profile with an inner loop;
 *  - the void does not overlap the host at all.
 *
 * A `null` is a refusal the caller must report, never a reason to draw the host unchanged.
 */
export function splitProfileByVoid(host: readonly Point2[], voidProfile: readonly Point2[]): VoidSplit | null {
  if (host.length !== 4 || voidProfile.length !== 4) return null;

  const p0 = host[0]!;
  // The two edge vectors *from p0*, which is all a rectangle needs and makes no assumption about winding order
  // beyond the four points being given in sequence.
  const a = sub(host[1]!, p0);
  const b = sub(host[3]!, p0);
  const aa = dot(a, a);
  const bb = dot(b, b);
  if (aa < EPS || bb < EPS) return null;

  // The void's corners as fractions of the host's own axes. Working in the host's frame rather than in world
  // coordinates is what makes this exact for a wall at any angle, without a special case for rotation.
  let sMin = Infinity;
  let sMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const q of voidProfile) {
    const d = sub(q, p0);
    const s = dot(d, a) / aa;
    const t = dot(d, b) / bb;
    sMin = Math.min(sMin, s);
    sMax = Math.max(sMax, s);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }

  // No overlap at all: not a void in this host.
  if (sMax <= EPS || sMin >= 1 - EPS || tMax <= EPS || tMin >= 1 - EPS) return null;

  /**
   * Which axis does the void go all the way through?
   *
   * An opening is modelled slightly *thicker* than its host so the boolean is unambiguous — `build-sample.mjs`
   * uses `T + 0.05` — so "spans completely" means covering [0, 1] with room to spare rather than exactly.
   */
  const spansA = sMin <= EPS && sMax >= 1 - EPS;
  const spansB = tMin <= EPS && tMax >= 1 - EPS;

  // A pocket, not a hole. Expressing it needs an inner loop in the profile, which an
  // `IfcArbitraryClosedProfileDef` cannot carry — so this is a refusal rather than an approximation.
  if (!spansA && !spansB) return null;

  // When the void spans both — an opening larger than the wall segment — treat the *shorter* host axis as the one
  // it passes through, because that is the direction a door goes through a wall.
  const axis: VoidAxis = spansB && (!spansA || bb <= aa) ? "b" : "a";

  const [lo, hi] = axis === "b" ? [sMin, sMax] : [tMin, tMax];
  const clampedLo = Math.max(0, Math.min(1, lo));
  const clampedHi = Math.max(0, Math.min(1, hi));

  /** A sub-rectangle of the host over one axis' parameter range. */
  const piece = (from: number, to: number): Point2[] => {
    const at = (u: number, v: number): Point2 =>
      axis === "b"
        ? [p0[0] + a[0] * u + b[0] * v, p0[1] + a[1] * u + b[1] * v]
        : [p0[0] + a[0] * v + b[0] * u, p0[1] + a[1] * v + b[1] * u];
    // Emitted in the same rotational order as the host, so a caller's winding-dependent triangulation still works.
    return [at(from, 0), at(to, 0), at(to, 1), at(from, 1)];
  };

  const beside: Point2[][] = [];
  if (clampedLo > EPS) beside.push(piece(0, clampedLo));
  if (clampedHi < 1 - EPS) beside.push(piece(clampedHi, 1));

  return { beside, span: [clampedLo, clampedHi], axis };
}

export interface Band {
  /** Profile for this band. */
  readonly profile: readonly Point2[];
  /** Bottom of the band, in the host extrusion's own coordinate (metres from its base). */
  readonly from: number;
  /** Top of the band. */
  readonly to: number;
}

export interface VoidCut {
  /** Metres from the host's base to the bottom of the opening. */
  readonly sill: number;
  /** Metres from the host's base to the top of the opening. */
  readonly head: number;
  readonly profile: readonly Point2[];
}

/**
 * Decompose an extruded host into bands, given the voids through it.
 *
 * The output is a list of extrusions that together are the host minus the voids. One band with the whole profile
 * and the whole depth means "no voids applied" — which is what a caller gets when every void was refused, and is
 * exactly the behaviour that must be *reported* rather than passed off as a hole.
 *
 * Voids are applied one at a time in sill order. Two openings at the same height in one wall therefore produce a
 * correct result only if they do not overlap, which is true of every real wall and is why this is not worth a
 * general interval algebra.
 */
export function bandsForVoids(
  profile: readonly Point2[],
  depth: number,
  voids: readonly VoidCut[],
): { readonly bands: readonly Band[]; readonly applied: number; readonly refused: number } {
  if (voids.length === 0 || depth <= 0) {
    return { bands: [{ profile, from: 0, to: depth }], applied: 0, refused: 0 };
  }

  let bands: Band[] = [{ profile, from: 0, to: depth }];
  let applied = 0;
  let refused = 0;

  for (const cut of [...voids].sort((x, y) => x.sill - y.sill)) {
    const split = splitProfileByVoid(profile, cut.profile);
    if (split === null) {
      refused += 1;
      continue;
    }

    const next: Band[] = [];
    for (const band of bands) {
      // Bands that do not meet the opening's vertical range survive untouched.
      const overlapFrom = Math.max(band.from, cut.sill);
      const overlapTo = Math.min(band.to, cut.head);
      if (overlapTo - overlapFrom <= EPS) {
        next.push(band);
        continue;
      }

      // Below the opening, and above it: the full profile.
      if (overlapFrom - band.from > EPS) next.push({ profile: band.profile, from: band.from, to: overlapFrom });
      if (band.to - overlapTo > EPS) next.push({ profile: band.profile, from: overlapTo, to: band.to });
      // Beside it: the profile with the opening's span removed. Zero pieces is legitimate — an opening as wide as
      // the wall leaves nothing beside it.
      for (const piece of split.beside) next.push({ profile: piece, from: overlapFrom, to: overlapTo });
    }
    bands = next;
    applied += 1;
  }

  return { bands, applied, refused };
}
