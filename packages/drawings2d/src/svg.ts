import type { Drawing, DrawingEntity, EntityGeometry, Point } from "./model.js";
import { type Paper, type Transform, toPaper, toPaperLength, transformFor } from "./paper.js";
import { type Paint, type Theme, paintFor } from "./theme.js";

/**
 * SVG serialisation: a pure function of `(Drawing, Theme, Paper)`.
 *
 * No generation happens here, and no geometry is computed. That is the point of the Semantic Drawing Model —
 * DXF and PDF are two more functions of the same three inputs, so there is no parallel code path to drift.
 *
 * ## Two things this output does that a naive one does not
 *
 * **Every element-derived element carries `data-guid`.** That is what makes a markup anchor to a wall rather
 * than to a page coordinate, and it is the difference between this and every PDF-based review tool.
 *
 * **Clickable linework gets an invisible fat twin.** A 0.5 mm line is roughly one pixel on screen, and hit-testing
 * one pixel with a mouse is not something anyone can do. Each selectable path is emitted twice: the visible
 * stroke, and a transparent copy at `stroke-width: 8` carrying the same `data-guid`. This is a trick massing's
 * plan pane already relies on, and it is load-bearing — without it, plan↔3D selection is technically present and
 * practically unusable.
 */

export interface SvgOptions {
  /** Emit the transparent fat twins that make thin lines clickable. Off for print. */
  readonly interactive?: boolean;
  /** Draw the sheet border. */
  readonly border?: boolean;
  /** Set as the SVG title, for accessibility. Defaults to the drawing's name. */
  readonly title?: string;
}

/** Escape text for XML content and attribute values. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Millimetres, rounded to 0.01 mm — finer than any plotter resolves, and it keeps the output diffable. */
function mm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function pathOf(t: Transform, geometry: EntityGeometry): string | null {
  const move = (p: Point): string => {
    const q = toPaper(t, p);
    return `M${mm(q.x)},${mm(q.y)}`;
  };
  const line = (p: Point): string => {
    const q = toPaper(t, p);
    return `L${mm(q.x)},${mm(q.y)}`;
  };
  const ring = (points: readonly Point[]): string =>
    points.length === 0 ? "" : `${move(points[0]!)}${points.slice(1).map(line).join("")}Z`;

  switch (geometry.kind) {
    case "polyline": {
      if (geometry.points.length < 2) return null;
      const body = `${move(geometry.points[0]!)}${geometry.points.slice(1).map(line).join("")}`;
      return geometry.closed ? `${body}Z` : body;
    }
    case "region": {
      const outer = ring(geometry.region.outer);
      if (outer === "") return null;
      // Holes as additional subpaths. With `fill-rule="evenodd"` an inner ring punches through, which is how a
      // wall with an opening in the cut plane draws correctly with no boolean at render time.
      return [outer, ...geometry.region.holes.map(ring)].filter((s) => s !== "").join("");
    }
    case "circle": {
      const c = toPaper(t, geometry.centre);
      const r = toPaperLength(t, geometry.radius);
      // Two arcs rather than <circle>, so every geometry kind emits one <path> and the styling code has one shape
      // to think about.
      return `M${mm(c.x - r)},${mm(c.y)}a${mm(r)},${mm(r)} 0 1,0 ${mm(r * 2)},0a${mm(r)},${mm(r)} 0 1,0 ${mm(-r * 2)},0Z`;
    }
    case "arc": {
      const c = geometry.centre;
      const r = geometry.radius;
      const from = toPaper(t, { x: c.x + r * Math.cos(geometry.from), y: c.y + r * Math.sin(geometry.from) });
      const to = toPaper(t, { x: c.x + r * Math.cos(geometry.to), y: c.y + r * Math.sin(geometry.to) });
      const rp = toPaperLength(t, r);
      const sweepAngle = geometry.to - geometry.from;
      const large = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
      // The Y flip reverses the sense of rotation, so the sweep flag is inverted relative to model space. A door
      // swing arced the wrong way is the visible symptom of getting this wrong.
      const sweep = sweepAngle > 0 ? 0 : 1;
      return `M${mm(from.x)},${mm(from.y)}A${mm(rp)},${mm(rp)} 0 ${large},${sweep} ${mm(to.x)},${mm(to.y)}`;
    }
    case "text":
      return null;
  }
}

function styleOf(paint: Paint, hasArea: boolean): string {
  const parts: string[] = [];
  parts.push(`stroke:${paint.stroke ?? "#000"}`);
  parts.push(`stroke-width:${mm(paint.weight ?? 0.18)}`);
  parts.push(`fill:${paint.fill ?? "none"}`);
  if (paint.fill !== undefined && paint.fillOpacity !== undefined) {
    parts.push(`fill-opacity:${paint.fillOpacity}`);
  }
  if (paint.dash !== undefined && paint.dash.length > 0) {
    parts.push(`stroke-dasharray:${paint.dash.map(mm).join(" ")}`);
  }
  if (hasArea) parts.push("fill-rule:evenodd");
  // Round joins and caps, because mitred joins on heavy poché outlines produce spikes at acute corners — which
  // read as geometry errors rather than as a rendering artefact.
  parts.push("stroke-linejoin:round", "stroke-linecap:round");
  return parts.join(";");
}

function dataAttrs(entity: DrawingEntity): string {
  const parts: string[] = [];
  if (entity.guid !== undefined) parts.push(` data-guid="${xml(entity.guid)}"`);
  if (entity.ifcClass !== undefined) parts.push(` data-class="${xml(entity.ifcClass)}"`);
  parts.push(` data-role="${entity.role}"`);
  for (const [key, value] of Object.entries(entity.attrs ?? {})) {
    // `data-` names must be lowercase and hyphenated; a camelCase key silently becomes a different attribute.
    const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    parts.push(` data-${name}="${xml(String(value))}"`);
  }
  return parts.join("");
}

export function toSvg(drawing: Drawing, theme: Theme, paper: Paper, options: SvgOptions = {}): string {
  const t = transformFor(paper);
  const { size } = paper;
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(size.width)}mm" height="${mm(size.height)}mm" ` +
      `viewBox="0 0 ${mm(size.width)} ${mm(size.height)}" data-drawing="${xml(drawing.name)}" ` +
      `data-kind="${drawing.kind}" data-scale="1:${paper.scale}" data-theme="${xml(theme.name)}">`,
  );
  out.push(`<title>${xml(options.title ?? drawing.name)}</title>`);
  // White, explicitly. An SVG with no background is transparent, and a transparent drawing printed on anything
  // other than white paper loses its lightest lines.
  out.push(`<rect x="0" y="0" width="${mm(size.width)}" height="${mm(size.height)}" fill="#ffffff"/>`);

  if (options.border === true) {
    const m = paper.margin;
    out.push(
      `<rect x="${mm(m)}" y="${mm(m)}" width="${mm(size.width - m * 2)}" height="${mm(size.height - m * 2)}" ` +
        `fill="none" stroke="#111111" stroke-width="0.35" data-role="sheet"/>`,
    );
  }

  // Grouped by layer, so layer visibility is a CSS toggle on a `<g>` and DXF export has its tables ready.
  const byLayer = new Map<string, DrawingEntity[]>();
  for (const entity of drawing.entities) {
    const bucket = byLayer.get(entity.layer);
    if (bucket) bucket.push(entity);
    else byLayer.set(entity.layer, [entity]);
  }

  const hitTwins: string[] = [];

  for (const [layer, entities] of byLayer) {
    out.push(`<g data-layer="${xml(layer)}">`);
    for (const entity of entities) {
      const paint = paintFor(theme, entity);
      if (paint.hidden === true) continue;

      if (entity.geometry.kind === "text") {
        const at = toPaper(t, entity.geometry.at);
        const anchor = entity.geometry.anchor ?? "start";
        // Font size is in points; 1 pt = 0.3528 mm, and the viewBox is in millimetres.
        const px = mm((paint.fontSize ?? 2.5) * 0.3528 * 2.83);
        const rotation =
          entity.geometry.rotation === undefined || entity.geometry.rotation === 0
            ? ""
            : ` transform="rotate(${mm((-entity.geometry.rotation * 180) / Math.PI)} ${mm(at.x)} ${mm(at.y)})"`;
        out.push(
          `<text x="${mm(at.x)}" y="${mm(at.y)}" font-size="${px}" font-family="sans-serif" ` +
            `text-anchor="${anchor}" fill="${paint.stroke ?? "#111"}"${rotation}${dataAttrs(entity)}>` +
            `${xml(entity.geometry.text)}</text>`,
        );
        continue;
      }

      const d = pathOf(t, entity.geometry);
      if (d === null) continue;
      const hasArea = entity.geometry.kind === "region";
      out.push(`<path id="${xml(entity.id)}" d="${d}" style="${styleOf(paint, hasArea)}"${dataAttrs(entity)}/>`);

      // The fat twin. Only for element-derived entities: a transparent 8 mm band over every grid line and
      // dimension would swallow the clicks meant for the geometry underneath.
      if (options.interactive === true && entity.guid !== undefined) {
        hitTwins.push(
          `<path d="${d}" fill="none" stroke="transparent" stroke-width="8" pointer-events="stroke" ` +
            `data-hit="1" data-guid="${xml(entity.guid)}"/>`,
        );
      }
    }
    out.push(`</g>`);
  }

  if (hitTwins.length > 0) {
    // Last, so they sit above the visible linework and win the hit test — while being invisible.
    out.push(`<g data-hit-layer="1">${hitTwins.join("")}</g>`);
  }

  out.push(`</svg>`);
  return out.join("\n");
}
