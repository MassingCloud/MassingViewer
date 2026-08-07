import type { Guid } from "@massingviewer/core";

/**
 * The Semantic Drawing Model.
 *
 * ## The one decision this whole package rests on
 *
 * **Entity geometry is in model space, in metres. Never paper space.**
 *
 * massing's generator bakes paper coordinates into the SVG it emits — a `T(x, y)` transform applied at
 * generation time. That single choice freezes scale, paper size, theme and viewport placement into the output,
 * so changing any of them means regenerating the drawing from the 3D model. Wanting the same plan at 1:50
 * instead of 1:100 becomes a round trip through the geometry kernel.
 *
 * Here, paper is a *render-time* transform. Three things fall out of that, and they are the three hardest
 * features in a drawing tool:
 *
 * - **Styling is a stylesheet.** A theme is selectors → paint. Switching an architectural plan to a
 *   fire-safety plan is a *repaint*, not a regeneration.
 * - **2D↔3D selection sync works**, because every entity carries the `guid` of the element it came from — and
 *   carries it *repeatedly*, since one wall can produce several loops.
 * - **Export is serialisation.** SVG, DXF and PDF are three pure functions of `(Drawing, Theme, Paper)`. There
 *   is no parallel `plan_svg` and `plan_dxf` code path to drift apart.
 */

/**
 * What a piece of linework *means*, which is what a theme selects on.
 *
 * This is the vocabulary of an architectural drawing rather than of a renderer: the difference between `cut`
 * and `projection` is the difference between a wall the section plane passes through and one it does not, and
 * it is why a plan reads as a plan instead of as a wireframe.
 */
export type EntityRole =
  /** The section plane passes through it. Heaviest line weight. */
  | "cut"
  /** Visible below or beyond the cut, seen in projection. */
  | "projection"
  /** Occluded, drawn dashed when shown at all. */
  | "hidden"
  /** Below the cut plane — a convention, drawn lighter and dashed. */
  | "below"
  /** Fill inside a cut profile, by material or IFC class. */
  | "poche"
  | "hatch"
  | "grid"
  | "dimension"
  | "annotation"
  | "tag"
  | "symbol"
  /** The sheet border and title block. */
  | "sheet";

export type Point = { readonly x: number; readonly y: number };

/** A closed region: one outer ring, and holes. Rings are metres, in model space. */
export interface Region {
  readonly outer: readonly Point[];
  readonly holes: readonly (readonly Point[])[];
}

export type EntityGeometry =
  | { readonly kind: "polyline"; readonly points: readonly Point[]; readonly closed: boolean }
  | { readonly kind: "region"; readonly region: Region }
  | { readonly kind: "arc"; readonly centre: Point; readonly radius: number; readonly from: number; readonly to: number }
  | { readonly kind: "circle"; readonly centre: Point; readonly radius: number }
  | { readonly kind: "text"; readonly at: Point; readonly text: string; readonly rotation?: number; readonly anchor?: "start" | "middle" | "end" };

/**
 * One thing on the drawing.
 *
 * `guid` is the load-bearing field, and it is optional only because grid lines and the sheet border genuinely
 * have no element behind them. Everything derived from a building element must carry one — the KPI in
 * {@link DrawingProvenance.guidCoverage} exists to make its absence a visible number rather than a silent
 * degradation, because a plan with no identity renders perfectly and cannot be marked up.
 */
export interface DrawingEntity {
  readonly id: string;
  readonly role: EntityRole;
  readonly geometry: EntityGeometry;
  /** The element this came from. Absent for grid, sheet furniture, and annotation the user authored. */
  readonly guid?: Guid;
  /** IFC class of that element, for theming: a cut `IfcWall` and a cut `IfcSlab` are not drawn alike. */
  readonly ifcClass?: string;
  /** CAD layer, so DXF export and layer visibility both have something real to work with. */
  readonly layer: string;
  /** Free-form, carried through to the output as `data-*`. Used for door swings, keynote refs, and the like. */
  readonly attrs?: Readonly<Record<string, string | number>>;
}

export type DrawingKind = "plan" | "section" | "elevation" | "axon" | "detail";

export interface Drawing {
  readonly kind: DrawingKind;
  readonly name: string;
  /** Model-space bounds of the content, metres. Used to fit the drawing to paper. */
  readonly bounds: { readonly min: Point; readonly max: Point };
  readonly entities: readonly DrawingEntity[];
  /**
   * How the model was cut, so a drawing can be regenerated identically and so a reviewer can see the
   * assumptions. A plan that does not record its cut height is a plan nobody can reproduce.
   */
  readonly view: ViewDefinition;
  readonly provenance: DrawingProvenance;
}

export interface ViewDefinition {
  readonly kind: DrawingKind;
  /** Metres above project zero. */
  readonly cutHeight?: number;
  readonly storey?: string;
  readonly axis?: "x" | "y";
  readonly offset?: number;
  readonly viewDepth?: number;
  /** How far below the cut still counts as `below`, metres. */
  readonly belowDepth?: number;
}

/**
 * What happened during generation, including what did not work.
 *
 * Mandatory, and the field most likely to be treated as optional. **A plan silently missing a wall renders
 * perfectly** — there is no visual cue, no error, and the person who finds out is on site. So a generator must
 * say which elements it failed to section and what fraction of its output carries a GlobalId, and the UI is
 * expected to show both.
 */
export interface DrawingProvenance {
  readonly provider: string;
  readonly providerVersion: string;
  readonly durationMs: number;
  /** Elements that could not be sectioned, and why. An empty array is a claim, not an absence of data. */
  readonly incomplete: readonly { readonly guid: Guid | null; readonly ifcClass: string; readonly reason: string }[];
  /** Fraction of *element-derived* entities carrying a GlobalId, 0..1. */
  readonly guidCoverage: number;
  /** Honest shortcuts: "hidden lines: z-sort only", "arcs tessellated at 2 mm". */
  readonly approximations: readonly string[];
}

// ---------------------------------------------------------------------------------------------------
// Construction and queries
// ---------------------------------------------------------------------------------------------------

/**
 * Assemble a drawing, computing bounds and `guidCoverage` rather than trusting a caller to.
 *
 * Coverage counts only entities that *should* have a guid — anything whose role is element-derived. Including
 * grid lines and the sheet border in the denominator would make coverage depend on how much furniture the
 * theme drew, and a number that moves for reasons unrelated to what it measures stops being read.
 */
export function makeDrawing(input: {
  readonly kind: DrawingKind;
  readonly name: string;
  readonly entities: readonly DrawingEntity[];
  readonly view: ViewDefinition;
  readonly provenance: Omit<DrawingProvenance, "guidCoverage">;
}): Drawing {
  const elementRoles = new Set<EntityRole>(["cut", "projection", "hidden", "below", "poche", "hatch"]);
  const derived = input.entities.filter((e) => elementRoles.has(e.role));
  const withGuid = derived.filter((e) => e.guid !== undefined).length;

  return {
    kind: input.kind,
    name: input.name,
    bounds: boundsOf(input.entities),
    entities: input.entities,
    view: input.view,
    provenance: {
      ...input.provenance,
      guidCoverage: derived.length === 0 ? 1 : withGuid / derived.length,
    },
  };
}

/** Model-space extent of a set of entities. An empty set yields a degenerate box at the origin, not NaN. */
export function boundsOf(entities: readonly DrawingEntity[]): { min: Point; max: Point } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (p: Point): void => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const entity of entities) {
    for (const p of pointsOf(entity.geometry)) see(p);
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Every point a geometry occupies, for bounds. Arcs contribute their extremes, not their exact extent. */
function pointsOf(geometry: EntityGeometry): readonly Point[] {
  switch (geometry.kind) {
    case "polyline":
      return geometry.points;
    case "region":
      return [...geometry.region.outer, ...geometry.region.holes.flat()];
    case "text":
      return [geometry.at];
    case "circle":
    case "arc": {
      // The bounding box of the full circle. Over-estimating an arc's extent is the safe direction: a drawing
      // fitted to slightly-too-large bounds has a margin, one fitted to too-small bounds is clipped.
      const { centre, radius } = geometry;
      return [
        { x: centre.x - radius, y: centre.y - radius },
        { x: centre.x + radius, y: centre.y + radius },
      ];
    }
  }
}

/** Every distinct GlobalId in the drawing, for the 3D side of selection sync. */
export function guidsIn(drawing: Drawing): readonly Guid[] {
  const seen = new Set<Guid>();
  for (const entity of drawing.entities) if (entity.guid !== undefined) seen.add(entity.guid);
  return [...seen];
}

/**
 * Every entity belonging to an element.
 *
 * Returns a list rather than one entity because **one element produces many loops** — a wall crossing the cut
 * plane in an L shape yields several, and selecting the wall must light all of them. A lookup that returned
 * the first would light one leg of the L and look like a bug in the model.
 */
export function entitiesFor(drawing: Drawing, guid: Guid): readonly DrawingEntity[] {
  return drawing.entities.filter((e) => e.guid === guid);
}

/** Distinct layers, in first-appearance order, for a layer panel and for DXF tables. */
export function layersIn(drawing: Drawing): readonly string[] {
  const seen = new Set<string>();
  for (const entity of drawing.entities) seen.add(entity.layer);
  return [...seen];
}
