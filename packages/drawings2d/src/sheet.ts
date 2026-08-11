import type { Point } from "./model.js";
import type { Paper } from "./paper.js";

/**
 * Sheet furniture: the border, title block, revision table and scale bar.
 *
 * ## Why this is not `DrawingEntity`
 *
 * ADR-0004's central rule is that entity geometry lives in **model space, in metres**, and paper is a render-time
 * transform — that is what makes a theme a repaint and a rescale free. A title block is the exact opposite: it is
 * *defined* in paper space. A 60 mm-tall block is 60 mm tall at 1:50 and at 1:200, and expressing it in metres so a
 * transform could scale it back would mean its size depended on the drawing scale, which is precisely wrong.
 *
 * So furniture is a separate, paper-space vocabulary, and the two never mix. `guidCoverage` also stays honest as a
 * result: a title block has no GlobalId and would otherwise count as element geometry that lost its identity.
 *
 * ## Coordinates: millimetres, origin top-left, Y **down**
 *
 * Declared once here and converted by each serialiser, because this repository already has three conventions in play
 * — `pdf.ts` opens by noting that SVG is Y-down while DXF and PDF are Y-up. Y-down matches how a person describes a
 * sheet ("title block bottom right") and matches the SVG viewBox, so it is the one convention where the layout code
 * below can be read against a printed sheet. A serialiser that forgets to flip produces a title block mirrored to the
 * top of the page — visible, at least, rather than subtly wrong.
 */

/** One piece of furniture. Deliberately primitive: every serialiser already knows how to draw these three. */
export type SheetItem =
  | { readonly kind: "line"; readonly from: Point; readonly to: Point; readonly weight: number }
  | {
      readonly kind: "rect";
      readonly at: Point;
      readonly width: number;
      readonly height: number;
      readonly weight: number;
    }
  | {
      readonly kind: "text";
      readonly at: Point;
      readonly text: string;
      /** Cap height in mm. */
      readonly size: number;
      readonly anchor: "start" | "middle" | "end";
      readonly bold?: boolean;
    };

/** One row of the revision history. */
export interface Revision {
  readonly rev: string;
  readonly date: string;
  readonly description: string;
  readonly by?: string;
}

/**
 * What a title block says.
 *
 * Every field is optional and an absent field leaves its cell **labelled but empty**, rather than collapsing the
 * layout. That is deliberate: a title block with a missing "CHECKED BY" box is a drawing someone has to go and get
 * checked, and a layout that quietly closed the gap would hide an incomplete issue sheet. The label is the reminder.
 */
export interface TitleBlockFields {
  readonly project?: string;
  readonly client?: string;
  readonly sheetName?: string;
  readonly sheetNumber?: string;
  /** Overrides the scale derived from `Paper`. Present for "AS NOTED" and "NTS", which no number can express. */
  readonly scaleLabel?: string;
  readonly date?: string;
  readonly drawnBy?: string;
  readonly checkedBy?: string;
  readonly revision?: string;
  /** Issue status, e.g. `FOR CONSTRUCTION`. Drawn prominently, because it is the field people act on. */
  readonly status?: string;
  readonly revisions?: readonly Revision[];
}

export interface SheetOptions {
  /** The outer frame inside the paper margin. */
  readonly border?: boolean;
  readonly titleBlock?: TitleBlockFields;
  /**
   * A graphic scale bar.
   *
   * Worth having rather than decorative: a sheet printed "to fit" is no longer at its stated ratio, and the printed
   * numeric scale then lies. A bar is measured off the paper, so it survives the photocopier.
   */
  readonly scaleBar?: boolean;
}

const THIN = 0.18;
const MEDIUM = 0.35;
const THICK = 0.7;

/** Title block geometry, in mm. Proportioned on ISO 7200's field set rather than copied from any one office's sheet. */
const BLOCK = {
  width: 180,
  height: 56,
  /** The identity strip at the top of the block: project, then sheet name. */
  projectRow: 14,
  nameRow: 14,
  /** The lower band splits into a grid of small labelled cells. */
  cellRow: 14,
  /** Sheet number and revision, given their own tall cell on the right. */
  numberWidth: 56,
  pad: 2,
  labelSize: 2,
  valueSize: 3.2,
} as const;

/** Truncate to what a cell can hold, with an ellipsis so a clipped value cannot read as a complete one. */
function fit(text: string, widthMm: number, sizeMm: number): string {
  // ~0.55 em average advance for the sans stack every serialiser falls back to. Approximate by design: the exact
  // metric belongs to the font, and each serialiser measures differently.
  const perChar = sizeMm * 0.55;
  const max = Math.max(1, Math.floor(widthMm / perChar));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Build the furniture for one sheet.
 *
 * A pure function of `(Paper, SheetOptions)` — the same shape as the three exporters, so a sheet is reproducible and
 * a serialiser cannot introduce a layout of its own.
 */
export function sheetFurniture(paper: Paper, options: SheetOptions = {}): readonly SheetItem[] {
  const items: SheetItem[] = [];
  const { width: W, height: H } = paper.size;
  const m = paper.margin;

  if (options.border === true) {
    items.push({ kind: "rect", at: { x: m, y: m }, width: W - m * 2, height: H - m * 2, weight: MEDIUM });
  }

  if (options.titleBlock !== undefined) {
    const f = options.titleBlock;
    // Clamped, not assumed. A 180 mm block does not fit inside an A4 portrait margin, and drawing it anyway would put
    // the project name off the paper — a failure nobody sees until it is printed.
    const bw = Math.min(BLOCK.width, W - m * 2);
    const bh = Math.min(BLOCK.height, H - m * 2);
    const bx = W - m - bw;
    const by = H - m - bh;
    const numberWidth = Math.min(BLOCK.numberWidth, bw * 0.35);

    items.push({ kind: "rect", at: { x: bx, y: by }, width: bw, height: bh, weight: THICK });

    const rowY = (n: number) => by + n;
    const label = (x: number, y: number, text: string): SheetItem => ({
      kind: "text",
      at: { x: x + BLOCK.pad, y: y + BLOCK.labelSize + BLOCK.pad },
      text,
      size: BLOCK.labelSize,
      anchor: "start",
    });
    const value = (x: number, y: number, w: number, text: string, bold = false): SheetItem => ({
      kind: "text",
      at: { x: x + BLOCK.pad, y: y + BLOCK.labelSize + BLOCK.pad + BLOCK.valueSize + 1.6 },
      text: fit(text, w - BLOCK.pad * 2, BLOCK.valueSize),
      size: BLOCK.valueSize,
      anchor: "start",
      bold,
    });

    // Row 1 — project, and the client beside it if there is one.
    const r1 = rowY(0);
    items.push(label(bx, r1, "PROJECT"));
    if (f.project !== undefined) items.push(value(bx, r1, bw - numberWidth, f.project, true));
    items.push({ kind: "line", from: { x: bx, y: r1 + BLOCK.projectRow }, to: { x: bx + bw, y: r1 + BLOCK.projectRow }, weight: THIN });

    // Row 2 — the drawing's own title.
    const r2 = rowY(BLOCK.projectRow);
    items.push(label(bx, r2, "DRAWING TITLE"));
    if (f.sheetName !== undefined) items.push(value(bx, r2, bw - numberWidth, f.sheetName, true));
    items.push({ kind: "line", from: { x: bx, y: r2 + BLOCK.nameRow }, to: { x: bx + bw, y: r2 + BLOCK.nameRow }, weight: THIN });

    // Row 3 — the small cells, plus the tall sheet-number cell on the right.
    const r3 = rowY(BLOCK.projectRow + BLOCK.nameRow);
    const cellsWidth = bw - numberWidth;
    const cells: readonly { readonly key: string; readonly text: string | undefined }[] = [
      { key: "SCALE", text: f.scaleLabel ?? `1:${paper.scale}` },
      { key: "DATE", text: f.date },
      { key: "DRAWN", text: f.drawnBy },
      { key: "CHECKED", text: f.checkedBy },
    ];
    const cw = cellsWidth / cells.length;
    cells.forEach((cell, i) => {
      const x = bx + cw * i;
      if (i > 0) items.push({ kind: "line", from: { x, y: r3 }, to: { x, y: by + bh }, weight: THIN });
      items.push(label(x, r3, cell.key));
      if (cell.text !== undefined) items.push(value(x, r3, cw, cell.text));
    });

    // The sheet number cell — the field a reader looks for first, so it gets the largest type on the block.
    const nx = bx + cellsWidth;
    items.push({ kind: "line", from: { x: nx, y: r1 }, to: { x: nx, y: by + bh }, weight: MEDIUM });
    items.push(label(nx, r1, "SHEET"));
    if (f.sheetNumber !== undefined) {
      items.push({
        kind: "text",
        at: { x: nx + BLOCK.pad, y: r1 + 12 },
        text: fit(f.sheetNumber, numberWidth - BLOCK.pad * 2, 6),
        size: 6,
        anchor: "start",
        bold: true,
      });
    }
    items.push(label(nx, r2, "REV"));
    if (f.revision !== undefined) items.push(value(nx, r2, numberWidth, f.revision, true));
    items.push(label(nx, r3, "STATUS"));
    if (f.status !== undefined) items.push(value(nx, r3, numberWidth, f.status, true));

    // The revision table sits directly above the block, growing upward — the CAD convention, and the reason it is
    // anchored to the block's top edge rather than to a fixed height.
    const revs = f.revisions ?? [];
    if (revs.length > 0) {
      const rowH = 5;
      const tableH = rowH * (revs.length + 1);
      const ty = by - tableH;
      items.push({ kind: "rect", at: { x: bx, y: ty }, width: bw, height: tableH, weight: MEDIUM });
      const columns = [
        { key: "REV", w: 0.1 },
        { key: "DATE", w: 0.2 },
        { key: "DESCRIPTION", w: 0.55 },
        { key: "BY", w: 0.15 },
      ];
      let cx = bx;
      for (const [i, column] of columns.entries()) {
        if (i > 0) items.push({ kind: "line", from: { x: cx, y: ty }, to: { x: cx, y: ty + tableH }, weight: THIN });
        items.push({
          kind: "text",
          at: { x: cx + BLOCK.pad, y: ty + 3.6 },
          text: column.key,
          size: BLOCK.labelSize,
          anchor: "start",
        });
        cx += bw * column.w;
      }
      // Newest at the top of the body, because that is the row a reader wants and the one a revision cloud refers to.
      const ordered = [...revs].reverse();
      ordered.forEach((rev, i) => {
        const y = ty + rowH * (i + 1);
        items.push({ kind: "line", from: { x: bx, y }, to: { x: bx + bw, y }, weight: THIN });
        let x = bx;
        for (const [c, column] of columns.entries()) {
          const w = bw * column.w;
          const text = [rev.rev, rev.date, rev.description, rev.by ?? ""][c]!;
          if (text !== "") {
            items.push({
              kind: "text",
              at: { x: x + BLOCK.pad, y: y + 3.6 },
              text: fit(text, w - BLOCK.pad * 2, 2.6),
              size: 2.6,
              anchor: "start",
            });
          }
          x += w;
        }
      });
    }
  }

  if (options.scaleBar === true) {
    /**
     * A bar whose segments are a round number of **metres**, chosen so the bar lands near 60 mm on paper.
     *
     * The round number has to be in model units, not paper units: a bar labelled "1 m" that is 23.7 mm long is
     * usable and a bar labelled "2.37 m" that is exactly 60 mm long is not.
     */
        const target = 60;
    const metresForTarget = (target * paper.scale) / 1000;
    const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    const step = steps.find((s) => s * 4 >= metresForTarget) ?? steps[steps.length - 1]!;
    const mmPerMetre = 1000 / paper.scale;
    const segment = step * mmPerMetre;
    const y = H - m - 6;
    const x0 = m + 2;
    const height = 2.5;

    for (let i = 0; i < 4; i++) {
      items.push({
        kind: "rect",
        at: { x: x0 + segment * i, y },
        width: segment,
        height,
        weight: THIN,
      });
      items.push({
        kind: "text",
        at: { x: x0 + segment * i, y: y - 1 },
        text: `${+(step * i).toFixed(2)}`,
        size: 2.2,
        anchor: "middle",
      });
    }
    items.push({
      kind: "text",
      at: { x: x0 + segment * 4, y: y - 1 },
      text: `${+(step * 4).toFixed(2)} m`,
      size: 2.2,
      anchor: "middle",
    });
  }

  return items;
}
