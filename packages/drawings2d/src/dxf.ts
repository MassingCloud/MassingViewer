import type { Drawing, DrawingEntity, EntityGeometry, Point } from "./model.js";
import { layersIn } from "./model.js";
import { type Paper, transformFor } from "./paper.js";
import { type Theme, paintFor } from "./theme.js";

/**
 * DXF R12 (ASCII) serialisation.
 *
 * The second serialiser, and the point of having it here is that it is the *same function of the same three
 * inputs* as `toSvg`: `(Drawing, Theme, Paper)`. No geometry is computed, nothing is re-cut, and there is no
 * parallel generation path that can drift. massing has `plan_svg` and `plan_dxf` as separate code paths for
 * exactly this job, which is why they disagree.
 *
 * ## Why R12 and not R2000+
 *
 * R12 is the oldest ASCII revision, has no object database, no classes section and no handles, and is read by
 * every CAD application ever written — including the twenty-year-old seat on a site office PC that is the actual
 * recipient of a DXF. Later revisions buy true colour, lineweights and layouts; none of those matter more than
 * the file opening. When a consultant asks for a DXF, they are asking for something their tool can read.
 *
 * ## Model space, not paper space
 *
 * Coordinates are written in **millimetres at the drawing's scale**, matching what the SVG puts on paper, so the
 * two exports measure identically. That is a deliberate choice over writing metres: a consultant scaling off a
 * DXF expects the drawing to measure at its stated scale, and a file in metres at 1:1 measures correctly only if
 * they know to rescale it — which nobody is told.
 */

/** A DXF group: a numeric code and its value, one per line. The entire format is this pair, repeated. */
function group(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

/** Millimetres, to 0.01 — finer than any plotter resolves, and it keeps the file diffable. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * AutoCAD Color Index for a hex colour, by nearest match over the seven standard colours plus greys.
 *
 * R12 has no true colour — only ACI. Approximating is the honest option: the alternative is writing colour 7
 * (black/white) for everything, which loses the line hierarchy that makes a drawing readable, or claiming
 * R2000 support this does not have.
 */
const ACI = [
  { index: 1, rgb: [255, 0, 0] },
  { index: 2, rgb: [255, 255, 0] },
  { index: 3, rgb: [0, 255, 0] },
  { index: 4, rgb: [0, 255, 255] },
  { index: 5, rgb: [0, 0, 255] },
  { index: 6, rgb: [255, 0, 255] },
  { index: 7, rgb: [255, 255, 255] },
  { index: 8, rgb: [128, 128, 128] },
  { index: 9, rgb: [192, 192, 192] },
  { index: 250, rgb: [51, 51, 51] },
  { index: 252, rgb: [102, 102, 102] },
  { index: 254, rgb: [204, 204, 204] },
] as const;

function aciFor(hex: string | undefined): number {
  if (hex === undefined) return 7;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return 7;
  const value = parseInt(m[1]!, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  let best = 7;
  let bestDistance = Infinity;
  for (const candidate of ACI) {
    const [cr, cg, cb] = candidate.rgb;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate.index;
    }
  }
  return best;
}

/**
 * A layer name DXF R12 accepts.
 *
 * R12 permits only uppercase letters, digits and `$ - _`, and silently mangles anything else — so a layer called
 * `A-WALL (new)` arrives as something unpredictable, and the drawing's layer structure, which is the main thing
 * a consultant uses a DXF *for*, is quietly wrong. Sanitising here makes the loss explicit and consistent.
 */
function layerName(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9$\-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned === "" ? "0" : cleaned.slice(0, 31);
}

function polyline(points: readonly Point[], closed: boolean, layer: string, aci: number, at: (p: Point) => Point): string {
  // A POLYLINE plus VERTEX list plus SEQEND, which is the R12 form. LWPOLYLINE is R2000+ and would be silently
  // ignored by exactly the old readers this revision exists to serve.
  let out =
    group(0, "POLYLINE") +
    group(8, layer) +
    group(62, aci) +
    group(66, 1) + // vertices follow
    group(10, 0) +
    group(20, 0) +
    group(30, 0) +
    group(70, closed ? 1 : 0);
  for (const p of points) {
    const q = at(p);
    out += group(0, "VERTEX") + group(8, layer) + group(10, n(q.x)) + group(20, n(q.y)) + group(30, 0);
  }
  return out + group(0, "SEQEND") + group(8, layer);
}

function entityDxf(entity: DrawingEntity, layer: string, aci: number, at: (p: Point) => Point, scale: number): string {
  const geometry: EntityGeometry = entity.geometry;
  switch (geometry.kind) {
    case "polyline":
      return geometry.points.length < 2 ? "" : polyline(geometry.points, geometry.closed, layer, aci, at);
    case "region": {
      // Outer ring and holes as separate closed polylines. R12 has no HATCH and no boundary concept, so a filled
      // region cannot be expressed — the rings are the honest representation, and `provenance` says the fill is
      // lost rather than pretending otherwise.
      let out = polyline(geometry.region.outer, true, layer, aci, at);
      for (const hole of geometry.region.holes) out += polyline(hole, true, layer, aci, at);
      return out;
    }
    case "circle": {
      const c = at(geometry.centre);
      return (
        group(0, "CIRCLE") +
        group(8, layer) +
        group(62, aci) +
        group(10, n(c.x)) +
        group(20, n(c.y)) +
        group(30, 0) +
        group(40, n(geometry.radius * scale))
      );
    }
    case "arc": {
      const c = at(geometry.centre);
      // DXF angles are degrees counter-clockwise; the paper transform flips Y, which reverses the sense — so the
      // start and end swap. Getting this wrong draws a door swinging the wrong way, which is exactly the kind of
      // error a reviewer notices and a test does not.
      const toDeg = (rad: number): number => ((-rad * 180) / Math.PI + 360) % 360;
      return (
        group(0, "ARC") +
        group(8, layer) +
        group(62, aci) +
        group(10, n(c.x)) +
        group(20, n(c.y)) +
        group(30, 0) +
        group(40, n(geometry.radius * scale)) +
        group(50, n(toDeg(geometry.to))) +
        group(51, n(toDeg(geometry.from)))
      );
    }
    case "text": {
      const p = at(geometry.at);
      const height = (entity.attrs?.textHeight as number | undefined) ?? 2.5;
      return (
        group(0, "TEXT") +
        group(8, layer) +
        group(62, aci) +
        group(10, n(p.x)) +
        group(20, n(p.y)) +
        group(30, 0) +
        group(40, n(height)) +
        group(1, geometry.text) +
        (geometry.rotation === undefined || geometry.rotation === 0
          ? ""
          : group(50, n((-geometry.rotation * 180) / Math.PI))) +
        (geometry.anchor === undefined || geometry.anchor === "start"
          ? ""
          : group(72, geometry.anchor === "middle" ? 1 : 2) + group(11, n(p.x)) + group(21, n(p.y)) + group(31, 0))
      );
    }
  }
}

export interface DxfOptions {
  /**
   * Include entities the theme hides.
   *
   * Default false, so a DXF matches the SVG a reviewer approved. True is for handing a consultant everything
   * regardless of discipline styling — and it is a *choice*, because silently exporting hidden linework is how a
   * fire-safety plan arrives with the whole building's below-cut geometry in it.
   */
  readonly includeHidden?: boolean;
}

/**
 * Write DXF R12.
 *
 * What is lost, and stated rather than left to be discovered: no fills (R12 has no HATCH), no lineweights (R12
 * has no lineweight), no true colour (ACI only, matched to the nearest of twelve), and `data-guid` has nowhere to
 * live — DXF R12 has no extended entity data this simple, so **the GlobalId does not survive into a DXF**. That
 * last one matters: a DXF is a delivery format, not a round-trip format, and a markup placed on one cannot come
 * back. The SVG path is the one that keeps identity.
 */
export function toDxf(drawing: Drawing, theme: Theme, paper: Paper, options: DxfOptions = {}): string {
  const t = transformFor(paper);
  const at = (p: Point): Point => {
    const q = { x: t.offsetX + p.x * t.mmPerMetre, y: t.offsetY + p.y * t.mmPerMetre };
    // No Y flip here, unlike SVG: DXF is Y-up like the model, so flipping would mirror the drawing.
    return q;
  };

  const used = layersIn(drawing).map(layerName);
  const layers = [...new Set(used)];

  let out = "";

  // HEADER — the minimum that makes a file open cleanly: the revision, and the extents.
  const min = at(drawing.bounds.min);
  const max = at(drawing.bounds.max);
  out += group(0, "SECTION") + group(2, "HEADER");
  out += group(9, "$ACADVER") + group(1, "AC1009"); // R12
  out += group(9, "$INSBASE") + group(10, 0) + group(20, 0) + group(30, 0);
  out += group(9, "$EXTMIN") + group(10, n(min.x)) + group(20, n(min.y)) + group(30, 0);
  out += group(9, "$EXTMAX") + group(10, n(max.x)) + group(20, n(max.y)) + group(30, 0);
  // Millimetres, so a reader that honours it does not assume inches.
  out += group(9, "$INSUNITS") + group(70, 4);
  out += group(0, "ENDSEC");

  // TABLES — the layer table. A DXF whose entities reference undeclared layers is accepted by AutoCAD and
  // rejected by several others, and the layer structure is the main thing a consultant opens a DXF for.
  out += group(0, "SECTION") + group(2, "TABLES");
  out += group(0, "TABLE") + group(2, "LAYER") + group(70, layers.length + 1);
  out += group(0, "LAYER") + group(2, "0") + group(70, 0) + group(62, 7) + group(6, "CONTINUOUS");
  for (const layer of layers) {
    out += group(0, "LAYER") + group(2, layer) + group(70, 0) + group(62, 7) + group(6, "CONTINUOUS");
  }
  out += group(0, "ENDTAB") + group(0, "ENDSEC");

  // ENTITIES
  out += group(0, "SECTION") + group(2, "ENTITIES");
  for (const entity of drawing.entities) {
    const paint = paintFor(theme, entity);
    if (paint.hidden === true && options.includeHidden !== true) continue;
    out += entityDxf(entity, layerName(entity.layer), aciFor(paint.stroke), at, t.mmPerMetre);
  }
  out += group(0, "ENDSEC");

  out += group(0, "EOF");
  return out;
}

/**
 * What a DXF export cannot carry, for the caller to surface.
 *
 * Returned as data rather than written into a comment in the file, because the person who needs to know is the
 * one clicking Export — not the one who later opens the DXF and cannot see what is absent.
 */
export function dxfLimitations(): readonly string[] {
  return [
    "GlobalIds are not carried — a DXF is a delivery format, not a round trip, and markup cannot come back",
    "no fills: DXF R12 has no HATCH, so poché exports as its outline only",
    "no lineweights: R12 has none, so the cut/projection hierarchy survives as colour only",
    "colours are matched to the nearest AutoCAD Color Index, since R12 has no true colour",
    "layer names are uppercased and stripped to A-Z 0-9 $ - _, which R12 requires",
  ];
}
