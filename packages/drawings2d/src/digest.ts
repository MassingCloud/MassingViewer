import type { Drawing, DrawingEntity, Point } from "./model.js";
import { boundsOf } from "./model.js";
import type { Paper } from "./paper.js";

/**
 * Semantic digest of a drawing — the golden-test representation `docs/testing.md` specifies and nothing
 * implemented.
 *
 * ## Why not snapshot the SVG
 *
 * Because a raw-SVG snapshot fails on every generator refactor, attribute reorder and whitespace change, none of
 * which are regressions — and it fails *unreadably*, so the reflex becomes accepting the new output without
 * reading it. That reflex is risk #11 on the plan's register ("test-suite abandonment via reflexive
 * `--update-snapshots`"), and a suite people route around is worse than no suite because it still reports green.
 *
 * ## What this is invariant to, and what it is not
 *
 * Invariant to: entity order, layer order, refactors, ids, classes, timestamps, generator version, and any
 * coordinate change below the quantisation step.
 *
 * **Not** invariant to: a missing wall, a cut line in the wrong place, a lost `guid`, a role reclassified from
 * `cut` to `projection`, an entity kind changed. Those are the regressions, and each one moves a line in the
 * digest that a reviewer can read.
 *
 * ## The quantisation step is in paper space, on purpose
 *
 * `docs/testing.md` asks for "coordinates quantised to 0.1 mm at paper scale", and the "at paper scale" is
 * load-bearing rather than decorative. A drawing's entities live in **model** space (metres) — that is the central
 * decision of the Semantic Drawing Model — so a fixed model-space tolerance means something different on every
 * sheet: 0.1 mm of paper is 10 mm of building at 1:100 and 500 mm at 1:5000. Quantising in model space would make
 * a digest at 1:5000 sensitive to sub-millimetre model noise nobody can draw, and a digest at 1:1 blind to
 * centimetres. So the scale comes in, and the step means what it says: a difference this digest ignores is a
 * difference that cannot be plotted.
 */

/** 0.1 mm of paper, the finest distinction a plotter can make. */
const PAPER_STEP_MM = 0.1;

export interface DigestOptions {
  /**
   * The paper the drawing will be plotted on, for the quantisation step.
   *
   * Required rather than defaulted. A default scale would silently decide the tolerance of every golden in the
   * repository, and the whole point of the previous note is that the number is not arbitrary.
   */
  readonly paper: Paper;
}

/** One entity, canonicalised to a single line. */
type Line = string;

/** Quantise a model-space length to the digest's step, expressed as an integer count of steps. */
function quantise(metres: number, stepMetres: number): number {
  // `Math.round` on the quotient rather than `toFixed` on the value: `toFixed` is decimal-string rounding and
  // carries a base-10 representation error that puts a coordinate on the wrong side of the step about as often as
  // the step is worth caring about.
  const n = Math.round(metres / stepMetres);
  // `-0` and `0` are different strings and the same coordinate. Left unnormalised, a mirrored fixture produces a
  // digest that differs from its twin in a way no reviewer can see.
  return n === 0 ? 0 : n;
}

const fmt = (n: number): string => String(n);

/** Canonical text for one geometry, with every coordinate quantised. */
function geometryOf(entity: DrawingEntity, step: number): string {
  const p = (pt: Point): string => `${fmt(quantise(pt.x, step))},${fmt(quantise(pt.y, step))}`;
  const g = entity.geometry;
  switch (g.kind) {
    case "polyline": {
      // Points are NOT sorted. A polyline is an ordered path, and sorting its vertices would make a wall drawn
      // start-to-end identical to the same wall drawn as a bowtie — which is exactly the kind of stitching bug
      // this suite exists to catch.
      const pts = g.points.map(p).join(" ");
      return `polyline${g.closed ? "*" : ""}[${pts}]`;
    }
    case "region": {
      // Holes ARE sorted, because their order carries no meaning — nesting does, and that is already expressed by
      // being holes of this outer ring rather than by position in the list.
      const holes = g.region.holes.map((h) => `(${h.map(p).join(" ")})`).sort();
      return `region[outer(${g.region.outer.map(p).join(" ")})${holes.join("")}]`;
    }
    case "arc":
      // Angles quantised in millidegrees rather than by the paper step: an angle is not a length, and applying a
      // length step to radians would make the tolerance depend on the radius.
      return (
        `arc[${p(g.centre)} r=${fmt(quantise(g.radius, step))} ` +
        `${Math.round((g.from * 180_000) / Math.PI)}..${Math.round((g.to * 180_000) / Math.PI)}]`
      );
    case "circle":
      return `circle[${p(g.centre)} r=${fmt(quantise(g.radius, step))}]`;
    case "text":
      // The string itself is part of the digest. A dimension that reads 3000 where it should read 2996 is a
      // drawing defect, and it is invisible to any geometric comparison.
      return `text[${p(g.at)} ${JSON.stringify(g.text)} a=${g.anchor ?? "start"} r=${Math.round(g.rotation ?? 0)}]`;
  }
}

/**
 * One line per entity: role, IFC class, guid, geometry.
 *
 * `id` and `class` are absent by construction — they are not in the entity model, they are added by the SVG
 * serialiser — so nothing needs stripping here. That is a property of putting the model *before* the renderer,
 * and it is why this digest is short.
 */
function lineOf(entity: DrawingEntity, step: number): Line {
  return [
    entity.role,
    entity.ifcClass ?? "-",
    // The guid is retained in full. It is the reason the whole Semantic Drawing Model exists — plan↔3D selection,
    // markup anchoring and sheet markup all depend on it surviving generation — so a digest that dropped it would
    // be blind to the single most important regression available.
    entity.guid ?? "-",
    geometryOf(entity, step),
  ].join(" ");
}

export interface Digest {
  readonly kind: string;
  readonly name: string;
  /** Layer → its entity lines, sorted. */
  readonly layers: Readonly<Record<string, readonly Line[]>>;
  /** Quantised drawing bounds, so a wholesale shift shows up as one short line rather than as every entity. */
  readonly bounds: string;
  readonly guidCoverage: string;
  /** Elements the generator failed to section, by class and reason. Never omitted when empty. */
  readonly incomplete: readonly string[];
}

/**
 * Digest a drawing.
 *
 * Deterministic and pure. Nothing here reads a clock, a random source, or the filesystem — `provenance.durationMs`
 * is deliberately excluded, because a golden that embedded a timing would fail on a busy machine and teach people
 * that goldens are noise.
 */
export function digestDrawing(drawing: Drawing, options: DigestOptions): Digest {
  // 0.1 mm of paper, converted to metres of model. `scale` is the denominator of 1:N.
  const step = (PAPER_STEP_MM / 1000) * options.paper.scale;

  const layers: Record<string, Line[]> = {};
  for (const entity of drawing.entities) {
    const layer = entity.layer;
    (layers[layer] ??= []).push(lineOf(entity, step));
  }
  // Sorted, so entity order within a layer is not part of the digest. Generators are free to iterate meshes in any
  // order; two that emit the same drawing must produce the same digest, which is what makes the differential
  // oracle in `provider.ts` able to compare them at all.
  for (const lines of Object.values(layers)) lines.sort();

  const b = boundsOf(drawing.entities);
  const q = (n: number) => fmt(quantise(n, step));

  return {
    kind: drawing.kind,
    name: drawing.name,
    // Key order is normalised too. `JSON.stringify` preserves insertion order, so an unsorted object would make
    // the *serialised* digest depend on which layer a generator happened to touch first.
    layers: Object.fromEntries(Object.entries(layers).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))),
    bounds:
      drawing.entities.length === 0
        ? "empty"
        : `${q(b.min.x)},${q(b.min.y)} .. ${q(b.max.x)},${q(b.max.y)}`,
    // Fixed to three decimals rather than raw: the plan makes coverage pass/fail, and a float that renders as
    // 0.9999999999 in one Node version and 1 in another would churn every golden for no reason.
    guidCoverage: drawing.provenance.guidCoverage.toFixed(3),
    incomplete: drawing.provenance.incomplete.map((i) => `${i.ifcClass}: ${i.reason}`).sort(),
  };
}

/**
 * A digest as stable text, for committing and for diffing.
 *
 * One entity per line, so `git diff` on a golden reads as "layer A-WALL lost a polyline" rather than as one
 * reflowed JSON blob. That readability is the requirement, not a nicety — `docs/testing.md` asks for a diff a
 * reviewer can act on, and a reviewer who cannot read the diff accepts it.
 */
export function formatDigest(digest: Digest): string {
  const out: string[] = [`# ${digest.kind} "${digest.name}"`, `bounds ${digest.bounds}`, `guidCoverage ${digest.guidCoverage}`];
  if (digest.incomplete.length > 0) {
    for (const i of digest.incomplete) out.push(`incomplete ${i}`);
  } else {
    // Stated rather than implied by absence. "No line" and "the generator failed nothing" are the same picture,
    // and only one of them is a claim.
    out.push("incomplete none");
  }
  for (const [layer, lines] of Object.entries(digest.layers)) {
    out.push(`layer ${layer} (${lines.length})`);
    for (const line of lines) out.push(`  ${line}`);
  }
  return out.join("\n") + "\n";
}
