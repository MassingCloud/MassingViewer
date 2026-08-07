import type { Drawing, DrawingEntity, EntityGeometry, Point } from "./model.js";
import { type Paper, type Transform, transformFor } from "./paper.js";
import { type Paint, type Theme, paintFor } from "./theme.js";

/**
 * PDF 1.7 serialisation — the third pure function of `(Drawing, Theme, Paper)`.
 *
 * With this the claim in `model.ts` is discharged rather than asserted: SVG, DXF and PDF are three functions of
 * the same three inputs, nothing is re-cut, and there is no fourth code path that can drift. The whole file is
 * emit; if you want a different scale you pass a different `Paper`.
 *
 * ## Why no library
 *
 * `jspdf` and `pdf-lib` are both MIT and both fine. Neither is worth taking here. A PDF containing vector
 * linework and Helvetica text is a few hundred lines of a well-documented format; a dependency is bundle weight
 * in a package with a per-package budget, another transitive tree for `license-audit` to walk, and — for
 * `pdf-lib` — an API built around *mutating* existing documents, which is not what this does.
 *
 * ## Three traps, in the order they bite
 *
 * **PDF is Y-up.** This is the third serialiser and the second Y convention: SVG is Y-down, DXF and PDF are
 * Y-up. `toPaper` bakes the SVG flip in, so PDF must not use it — see {@link pdfPoint}. Getting this wrong
 * produces a mirrored plan, which is invisible on a symmetric fixture and obvious to the first person who
 * reads a door swing.
 *
 * **PDF measures in points, not millimetres.** User space is 1/72 inch by default. Everything the paper
 * transform produces is millimetres, so every number crosses a `MM_TO_PT` boundary exactly once.
 *
 * **There are no arcs.** No arc, no ellipse, no circle operator — only cubic Béziers. A door swing has to be
 * approximated, and the approximation is declared in {@link pdfLimitations} rather than hidden.
 *
 * ## What this does that a print-to-PDF does not
 *
 * **Layers survive as Optional Content Groups**, so a reviewer in Acrobat or Bluebeam can switch off the grid or
 * the poché. Layer structure is most of what a drawing *is*, and flattening it is the main thing that makes an
 * exported PDF worse than the drawing it came from.
 *
 * **GlobalIds survive twice.** Each element's linework is wrapped in marked content carrying its GlobalId, and
 * the document has an attached JSON index mapping GlobalId → paper-space bounds. That is what closes the loop
 * the market research says nobody has closed: a markup placed at page coordinates in *someone else's* PDF tool
 * can be resolved back to the IFC element it covers. `toDxf` cannot do this — DXF R12 has nowhere to put it —
 * and it is the reason the PDF path, not the DXF path, is the one that round-trips.
 */

export interface PdfOptions {
  readonly border?: boolean;
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  /** Emit Optional Content Groups so layers toggle in a reader. Default true. */
  readonly layers?: boolean;
  /**
   * Attach the GlobalId → paper-bounds index as an embedded JSON file. Default true.
   *
   * Costs a few KB and is what makes a markup made in another tool resolvable back to an element.
   */
  readonly index?: boolean;
  /**
   * Creation date, as a PDF date string (`D:YYYYMMDDHHmmSS`).
   *
   * A parameter with a fixed default rather than `new Date()`, because a serialiser that embeds the current
   * time cannot be byte-compared. The golden tests need that, and so does anyone who wants to know whether a
   * re-issued sheet actually changed.
   */
  readonly date?: string;
}

/** 1 pt = 1/72 inch; 25.4 mm to the inch. */
const MM_TO_PT = 72 / 25.4;

/** A fixed epoch, so an export with no date argument is still reproducible. */
const DEFAULT_DATE = "D:20260101000000Z";

/**
 * Helvetica advance widths, 1/1000 em, for code points 32–126.
 *
 * Needed because PDF has no `text-anchor`: centring a grid bubble's label means measuring the string. Written
 * as a string rather than a numeric literal array so a diff reads as data — and limited to printable ASCII,
 * with everything else falling back to the average, because a drawing label is not where exotic typography
 * happens and the honest alternative is a 315-entry table nobody can review.
 */
const HELVETICA_WIDTHS = (
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 " +
  "556 556 556 556 556 556 556 556 556 556 " +
  "278 278 584 584 584 556 1015 " +
  "667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 " +
  "278 278 278 469 556 333 " +
  "556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 " +
  "334 260 334 584"
)
  .split(" ")
  .map(Number);

/** Advance width of a string at a given point size, in points. */
function textWidth(text: string, size: number): number {
  let thousandths = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    thousandths += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32]! : 556;
  }
  return (thousandths / 1000) * size;
}

/** Points, to 0.01 — below any device resolution, and it keeps the content stream diffable. */
function pt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * Model point → PDF user space, in points, **without** the SVG Y flip.
 *
 * This duplicates the arithmetic inside `toPaper` rather than calling it and undoing the flip. Undoing a flip is
 * how a sign error hides: `sheetHeight - (sheetHeight - y)` is correct and unreadable, and the next person to
 * touch it has to prove it rather than see it.
 */
function pdfPoint(t: Transform, p: Point): Point {
  return {
    x: (t.offsetX + p.x * t.mmPerMetre) * MM_TO_PT,
    y: (t.offsetY + p.y * t.mmPerMetre) * MM_TO_PT,
  };
}

/** A PDF literal string: escape the three characters that would end it or the object containing it. */
function str(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code < 32 || code > 255) out += "?"; // WinAnsi is single-byte; a CJK glyph needs an embedded font.
    else out += char;
  }
  return `(${out})`;
}

/** A PDF name: `/` plus the token, with anything outside the safe set hex-escaped as `#xx`. */
function name(value: string): string {
  return `/${value.replace(/[^A-Za-z0-9_.-]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}`;
}

/** `#rrggbb` → `r g b` in 0..1, PDF's colour space. Defaults to black rather than throwing on a bad value. */
function rgb(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (m === null) return "0 0 0";
  const value = parseInt(m[1]!, 16);
  const f = (byte: number): string => pt(byte / 255);
  return `${f((value >> 16) & 0xff)} ${f((value >> 8) & 0xff)} ${f(value & 0xff)}`;
}

/**
 * Latin-1 bytes.
 *
 * Not `TextEncoder`, and the difference is a bug rather than a preference: `TextEncoder` emits UTF-8, so `é`
 * becomes two bytes, and a two-byte sequence inside a `/WinAnsiEncoding` literal string renders as two wrong
 * glyphs. It also silently breaks every `/Length` and every xref offset, because those are byte counts.
 */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Cubic Bézier approximation of a circular arc, as PDF path operators.
 *
 * Split so no segment exceeds 90°, with the standard control-point distance `k = 4/3 · tan(θ/4)`, whose worst
 * radial error at 90° is about 0.027% of the radius — 0.03 mm on a metre-radius door swing at 1:1, which is
 * below what a plotter resolves. Declared anyway, because "approximated" and "approximated to a tolerance" are
 * different claims.
 */
function arcOps(t: Transform, centre: Point, radius: number, from: number, to: number, moveFirst: boolean): string {
  const sweep = to - from;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / segments;
  const at = (angle: number): Point =>
    pdfPoint(t, { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
  const rPt = radius * t.mmPerMetre * MM_TO_PT;

  const ops: string[] = [];
  const start = at(from);
  if (moveFirst) ops.push(`${pt(start.x)} ${pt(start.y)} m`);

  for (let i = 0; i < segments; i++) {
    const a0 = from + step * i;
    const a1 = a0 + step;
    const k = (4 / 3) * Math.tan(step / 4) * rPt;
    const p0 = at(a0);
    const p1 = at(a1);
    // Tangents at the endpoints, scaled by k. The tangent to a circle at angle a is (-sin a, cos a).
    const c1 = { x: p0.x - k * Math.sin(a0), y: p0.y + k * Math.cos(a0) };
    const c2 = { x: p1.x + k * Math.sin(a1), y: p1.y - k * Math.cos(a1) };
    ops.push(`${pt(c1.x)} ${pt(c1.y)} ${pt(c2.x)} ${pt(c2.y)} ${pt(p1.x)} ${pt(p1.y)} c`);
  }
  return ops.join("\n");
}

/**
 * Path construction operators for a geometry, or `null` if it has none.
 *
 * Returns the path only — the painting operator is chosen by the caller, because whether a shape is stroked,
 * filled or both is a property of the *paint*, not of the geometry.
 */
function pathOps(t: Transform, geometry: EntityGeometry): string | null {
  const move = (p: Point): string => {
    const q = pdfPoint(t, p);
    return `${pt(q.x)} ${pt(q.y)} m`;
  };
  const line = (p: Point): string => {
    const q = pdfPoint(t, p);
    return `${pt(q.x)} ${pt(q.y)} l`;
  };
  const ring = (points: readonly Point[]): string | null =>
    points.length < 2 ? null : [move(points[0]!), ...points.slice(1).map(line), "h"].join("\n");

  switch (geometry.kind) {
    case "polyline": {
      if (geometry.points.length < 2) return null;
      const body = [move(geometry.points[0]!), ...geometry.points.slice(1).map(line)];
      if (geometry.closed) body.push("h");
      return body.join("\n");
    }
    case "region": {
      const outer = ring(geometry.region.outer);
      if (outer === null) return null;
      // Holes as further subpaths, punched through by the even-odd fill rule — the same mechanism the SVG uses,
      // so a wall with an opening needs no boolean at render time in either format.
      return [outer, ...geometry.region.holes.map(ring).filter((r): r is string => r !== null)].join("\n");
    }
    case "circle":
      return arcOps(t, geometry.centre, geometry.radius, 0, Math.PI * 2, true) + "\nh";
    case "arc":
      return arcOps(t, geometry.centre, geometry.radius, geometry.from, geometry.to, true);
    case "text":
      return null;
  }
}

/** Graphics-state operators for a paint. Emitted inside `q`/`Q`, so nothing leaks to the next entity. */
function stateOps(paint: Paint): string {
  const ops: string[] = [];
  ops.push(`${pt((paint.weight ?? 0.18) * MM_TO_PT)} w`);
  ops.push(`${rgb(paint.stroke ?? "#000000")} RG`);
  if (paint.fill !== undefined) ops.push(`${rgb(paint.fill)} rg`);
  // Round joins and caps for the same reason as the SVG: mitres on heavy poché outlines spike at acute corners
  // and read as a geometry error.
  ops.push("1 J", "1 j");
  if (paint.dash !== undefined && paint.dash.length > 0) {
    ops.push(`[${paint.dash.map((d) => pt(d * MM_TO_PT)).join(" ")}] 0 d`);
  }
  return ops.join("\n");
}

/**
 * Which painting operator a paint implies.
 *
 * `fillOpacity` is dropped for a filled region rather than approximated: real transparency needs an ExtGState
 * with a soft mask, and faking it by lightening the colour would make the exported poché a different colour
 * from the on-screen poché. A dropped effect is visible; a silently different one is not.
 */
function paintOp(paint: Paint, hasArea: boolean): string {
  if (!hasArea || paint.fill === undefined) return "S";
  return paint.stroke === undefined ? "f*" : "B*";
}

interface PdfObject {
  /** Body without the `N 0 obj` / `endobj` wrapper. */
  readonly body: string;
  /** Raw stream bytes, if this object is a stream. `/Length` is written by the assembler. */
  readonly stream?: Uint8Array;
}

/** Paper-space bounds of an entity, in points, for the index. */
function paperBounds(t: Transform, geometry: EntityGeometry): readonly [number, number, number, number] | null {
  const points: Point[] = [];
  switch (geometry.kind) {
    case "polyline":
      points.push(...geometry.points);
      break;
    case "region":
      points.push(...geometry.region.outer, ...geometry.region.holes.flat());
      break;
    case "text":
      points.push(geometry.at);
      break;
    case "circle":
    case "arc":
      points.push(
        { x: geometry.centre.x - geometry.radius, y: geometry.centre.y - geometry.radius },
        { x: geometry.centre.x + geometry.radius, y: geometry.centre.y + geometry.radius },
      );
      break;
  }
  if (points.length === 0) return null;
  const mapped = points.map((p) => pdfPoint(t, p));
  const xs = mapped.map((p) => p.x);
  const ys = mapped.map((p) => p.y);
  return [
    Math.round(Math.min(...xs) * 100) / 100,
    Math.round(Math.min(...ys) * 100) / 100,
    Math.round(Math.max(...xs) * 100) / 100,
    Math.round(Math.max(...ys) * 100) / 100,
  ];
}

/**
 * The attached index: what a reviewer's tool needs to turn a page coordinate back into an element.
 *
 * Deliberately includes the transform as well as the boxes. Boxes alone answer "which element is under this
 * markup"; the transform also answers "how big is the thing I just measured", which is the question a takeoff
 * asks. Both are unanswerable from a printed PDF, which is why every PDF-based review tool needs a human to
 * calibrate a scale by drawing a line along a known dimension.
 */
function indexJson(drawing: Drawing, paper: Paper, t: Transform, entities: readonly DrawingEntity[]): string {
  const items: string[] = [];
  for (const entity of entities) {
    if (entity.guid === undefined) continue;
    const box = paperBounds(t, entity.geometry);
    if (box === null) continue;
    items.push(
      JSON.stringify({
        id: entity.id,
        guid: entity.guid,
        ifcClass: entity.ifcClass ?? null,
        role: entity.role,
        layer: entity.layer,
        bbox: box,
      }),
    );
  }
  const doc =
    `{"format":"massingviewer-pdf-index","version":1,` +
    `"drawing":${JSON.stringify(drawing.name)},"kind":${JSON.stringify(drawing.kind)},` +
    `"view":${JSON.stringify(drawing.view)},` +
    `"paper":{"size":${JSON.stringify(paper.size.name)},"widthPt":${pt(paper.size.width * MM_TO_PT)},` +
    `"heightPt":${pt(paper.size.height * MM_TO_PT)},"scale":${paper.scale},` +
    `"pointsPerMetre":${pt(t.mmPerMetre * MM_TO_PT)}},` +
    `"guidCoverage":${Math.round(drawing.provenance.guidCoverage * 1000) / 1000},` +
    `"incomplete":${JSON.stringify(drawing.provenance.incomplete)},` +
    `"entities":[${items.join(",")}]}`;
  // Escape non-ASCII so the stream is byte-identical whatever encoder reads this file. A `/Length` computed
  // over UTF-8 and a stream written as Latin-1 disagree, and the failure is a corrupt PDF rather than an error.
  return doc.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** FNV-1a, for the trailer's `/ID`. Deterministic, so the same drawing exports byte-identically. */
function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(4);
}

export function toPdf(drawing: Drawing, theme: Theme, paper: Paper, options: PdfOptions = {}): Uint8Array {
  const t = transformFor(paper);
  const useLayers = options.layers !== false;
  const useIndex = options.index !== false;
  const widthPt = paper.size.width * MM_TO_PT;
  const heightPt = paper.size.height * MM_TO_PT;

  const visible = drawing.entities.filter((e) => paintFor(theme, e).hidden !== true);

  // Layer order is first-appearance order over the *visible* entities, so a reader's layer panel lists exactly
  // what the page contains — an OCG with nothing in it is a checkbox that does nothing.
  const layers = [...new Set(visible.map((e) => e.layer))];
  const layerResource = new Map<string, string>();
  layers.forEach((layer, i) => layerResource.set(layer, `oc${i}`));

  // --- content stream ------------------------------------------------------------------------------
  const content: string[] = [];

  // White background, explicitly: a PDF page is not painted, and the lightest lines of a drawing printed on
  // anything other than white lose their contrast. The SVG does the same for the same reason.
  content.push(`q\n1 1 1 rg\n0 0 ${pt(widthPt)} ${pt(heightPt)} re\nf\nQ`);

  if (options.border === true) {
    const m = paper.margin * MM_TO_PT;
    content.push(
      `q\n0.0667 0.0667 0.0667 RG\n${pt(0.35 * MM_TO_PT)} w\n` +
        `${pt(m)} ${pt(m)} ${pt(widthPt - m * 2)} ${pt(heightPt - m * 2)} re\nS\nQ`,
    );
  }

  for (const layer of layers) {
    const inLayer = visible.filter((e) => e.layer === layer);
    if (useLayers) content.push(`/OC ${name(layerResource.get(layer)!)} BDC`);

    for (const entity of inLayer) {
      const paint = paintFor(theme, entity);
      // Marked content carrying the GlobalId. A reader ignores an unknown tag, and a parser can walk it — so
      // identity travels inside the page as well as in the attached index.
      const marked = entity.guid !== undefined;
      if (marked) {
        const cls = entity.ifcClass === undefined ? "" : ` /Class ${str(entity.ifcClass)}`;
        content.push(`/MV <</GUID ${str(entity.guid!)}${cls} /Role ${str(entity.role)}>> BDC`);
      }

      if (entity.geometry.kind === "text") {
        const size = (paint.fontSize ?? 2.5) * MM_TO_PT;
        const at = pdfPoint(t, entity.geometry.at);
        const anchor = entity.geometry.anchor ?? "start";
        const width = textWidth(entity.geometry.text, size);
        const shift = anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0;
        // Baseline nudge: `toPaper` places text at its anchor point, and the SVG renderer treats that as the
        // baseline. Matching it keeps the two exports aligned rather than off by a cap height.
        const rotation = entity.geometry.rotation ?? 0;
        content.push("q", `${rgb(paint.stroke ?? "#111111")} rg`, "BT", `/F1 ${pt(size)} Tf`);
        if (rotation === 0) {
          content.push(`${pt(at.x + shift)} ${pt(at.y)} Td`);
        } else {
          // No sign inversion, unlike the SVG. PDF is Y-up like model space, so a positive model rotation is
          // already counter-clockwise on the page; the SVG needs `-rotation` only because it flipped Y.
          const c = Math.cos(rotation);
          const s = Math.sin(rotation);
          content.push(
            `${pt(c)} ${pt(s)} ${pt(-s)} ${pt(c)} ${pt(at.x + shift * c)} ${pt(at.y + shift * s)} Tm`,
          );
        }
        content.push(`${str(entity.geometry.text)} Tj`, "ET", "Q");
        if (marked) content.push("EMC");
        continue;
      }

      const path = pathOps(t, entity.geometry);
      if (path === null) {
        if (marked) content.push("EMC");
        continue;
      }
      content.push("q", stateOps(paint), path, paintOp(paint, entity.geometry.kind === "region"), "Q");
      if (marked) content.push("EMC");
    }

    if (useLayers) content.push("EMC");
  }

  const contentBytes = latin1(content.join("\n") + "\n");

  // --- objects -------------------------------------------------------------------------------------
  // Assembled as a list so numbering is positional. Hand-numbering PDF objects is how a `/Root 1 0 R` ends up
  // pointing at a font after someone inserts an object in the middle.
  const objects: PdfObject[] = [];
  const add = (body: string, stream?: Uint8Array): number => {
    objects.push({ body, stream });
    return objects.length; // 1-based, matching PDF object numbers.
  };

  const catalogNum = add("<< placeholder >>"); // 1 — patched below, once its children have numbers.
  const pagesNum = add("<< placeholder >>");
  const pageNum = add("<< placeholder >>");
  const contentNum = add("<< >>", contentBytes);
  const fontNum = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const layerNums = useLayers ? layers.map((layer) => add(`<< /Type /OCG /Name ${str(layer)} >>`)) : [];

  let indexFileNum = 0;
  if (useIndex) {
    const json = latin1(indexJson(drawing, paper, t, visible));
    const streamNum = add(
      `<< /Type /EmbeddedFile /Subtype /application#2Fjson /Params << /Size ${json.length} >> >>`,
      json,
    );
    indexFileNum = add(
      `<< /Type /Filespec /F (massingviewer-index.json) /UF (massingviewer-index.json) ` +
        `/Desc ${str("GlobalId to paper-coordinate index, so a markup can be resolved back to an IFC element")} ` +
        `/AFRelationship /Supplement /EF << /F ${streamNum} 0 R >> >>`,
    );
  }

  const infoNum = add(
    `<< /Title ${str(options.title ?? drawing.name)} ` +
      `/Author ${str(options.author ?? "MassingViewer")} ` +
      `/Subject ${str(options.subject ?? `${drawing.kind} at 1:${paper.scale} on ${paper.size.name}`)} ` +
      `/Creator (MassingViewer) /Producer (MassingViewer drawings2d) ` +
      `/CreationDate ${str(options.date ?? DEFAULT_DATE)} /ModDate ${str(options.date ?? DEFAULT_DATE)} >>`,
  );

  const ocProperties =
    layerNums.length === 0
      ? ""
      : ` /OCProperties << /OCGs [${layerNums.map((n) => `${n} 0 R`).join(" ")}] ` +
        `/D << /Order [${layerNums.map((n) => `${n} 0 R`).join(" ")}] ` +
        `/ON [${layerNums.map((n) => `${n} 0 R`).join(" ")}] /BaseState /ON >> >>`;

  const names =
    indexFileNum === 0
      ? ""
      : ` /Names << /EmbeddedFiles << /Names [(massingviewer-index.json) ${indexFileNum} 0 R] >> >>`;

  objects[catalogNum - 1] = {
    body: `<< /Type /Catalog /Pages ${pagesNum} 0 R${ocProperties}${names} /Lang (en) >>`,
  };
  objects[pagesNum - 1] = { body: `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>` };

  const properties =
    layerNums.length === 0
      ? ""
      : ` /Properties << ${layers.map((l, i) => `${name(layerResource.get(l)!)} ${layerNums[i]} 0 R`).join(" ")} >>`;
  // `/AF` at page level as well as in `/Names`: the associated-files array is what a PDF/A-3 or PDF 2.0 reader
  // looks at, and the name tree is what an older one looks at. Both, so neither has to be the right one.
  const associated = indexFileNum === 0 ? "" : ` /AF [${indexFileNum} 0 R]`;
  objects[pageNum - 1] = {
    body:
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pt(widthPt)} ${pt(heightPt)}] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >>${properties} >> ` +
      `/Contents ${contentNum} 0 R${associated} >>`,
  };

  // --- assemble, tracking byte offsets -------------------------------------------------------------
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const write = (text: string): void => push(latin1(text));

  // The binary comment on line 2 tells every tool in the chain that this is not text. Without it, an FTP in
  // ASCII mode or a naive line-ending normaliser will rewrite the stream bytes and invalidate every offset.
  write("%PDF-1.7\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(offset);
    if (object.stream === undefined) {
      write(`${i + 1} 0 obj\n${object.body}\nendobj\n`);
      return;
    }
    // `/Length` is a byte count, which is why the stream is bytes by this point and not a string.
    const dict = object.body.replace(/>>\s*$/, `/Length ${object.stream.length} >>`);
    write(`${i + 1} 0 obj\n${dict === object.body ? `<< /Length ${object.stream.length} >>` : dict}\nstream\n`);
    push(object.stream);
    write("\nendstream\nendobj\n");
  });

  const xrefOffset = offset;
  write(`xref\n0 ${objects.length + 1}\n`);
  // Every entry is exactly 20 bytes — 10-digit offset, space, 5-digit generation, space, type, 2-byte EOL. A
  // 19- or 21-byte entry produces a file that opens in Acrobat and fails in half of everything else, because
  // readers seek into this table by multiplying rather than by parsing.
  write("0000000000 65535 f \n");
  for (const o of offsets) write(`${String(o).padStart(10, "0")} 00000 n \n`);

  const id = fnv1a(chunks.length === 0 ? new Uint8Array() : concat(chunks));
  write(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R ` +
      `/ID [<${id}> <${id}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return concat(chunks);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * What a PDF export cannot carry, for the caller to surface.
 *
 * Shorter than {@link dxfLimitations} on purpose — and the difference is the argument for which format to hand
 * someone. Data, not a comment in the file, because the person who needs to know is the one clicking Export.
 */
export function pdfLimitations(): readonly string[] {
  return [
    "arcs and circles are cubic Bézier approximations, within 0.03% of the radius",
    "text is Helvetica with WinAnsi encoding, so a character outside Latin-1 becomes '?' — a CJK sheet needs an embedded font",
    "fill opacity is dropped rather than approximated, since real transparency needs a soft mask",
    "streams are uncompressed, which is larger on disk and byte-comparable in review",
    "one drawing per page: a multi-sheet set is several PDFs, until sheets exist",
  ];
}
