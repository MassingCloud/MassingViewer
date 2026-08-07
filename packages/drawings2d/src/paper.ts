import type { Drawing, Point } from "./model.js";

/**
 * Paper: the render-time transform from model metres to sheet millimetres.
 *
 * This is where scale lives, and keeping it here rather than in the entity coordinates is the decision the whole
 * package is built on (see `model.ts`). A drawing at 1:50 and the same drawing at 1:100 are one `Drawing` and
 * two `Paper`s — no regeneration, no round trip through the geometry kernel.
 */

export interface PaperSize {
  readonly name: string;
  /** Millimetres. */
  readonly width: number;
  readonly height: number;
}

/** ISO A series, landscape, plus the two ANSI sizes a US project actually uses. */
export const PAPER_SIZES: readonly PaperSize[] = [
  { name: "A4", width: 297, height: 210 },
  { name: "A3", width: 420, height: 297 },
  { name: "A2", width: 594, height: 420 },
  { name: "A1", width: 841, height: 594 },
  { name: "A0", width: 1189, height: 841 },
  { name: "ANSI D", width: 864, height: 559 },
  { name: "ARCH E1", width: 1067, height: 762 },
];

/**
 * Drawing scales, as the denominator of 1:n — and there are **two ladders**, not one.
 *
 * A closed list rather than a free number, because scale is a *convention*: a drawing at 1:87 is not one anyone
 * can measure off, and the ability to type an arbitrary number is how that happens.
 *
 * The split into metric and imperial is not tidiness. A first version merged them into a single sorted list, and
 * auto-fitting a 10 m plan onto A4 chose **1:48** — the exact metric equivalent of 1/4" = 1'-0". It fits, and it
 * is finer than 1:50, so the "largest scale that fits" rule picked it correctly. It is also meaningless on a
 * metric drawing: nobody scales off 1:48 with a metric rule, and an architect handed that sheet would report it
 * as a bug. The reverse is equally true — 1:50 on an imperial set is unmeasurable.
 *
 * So the ladder is a property of the *project*, and {@link fitToPaper} has to be told which one it is in.
 */
export const METRIC_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000] as const;

/** Imperial architectural scales as their exact metric equivalents: 1/4" = 1'-0" is exactly 1:48. */
export const IMPERIAL_SCALES = [1, 12, 16, 24, 32, 48, 96, 192, 384, 480, 960] as const;

export const SCALES = [...new Set([...METRIC_SCALES, ...IMPERIAL_SCALES])].sort((a, b) => a - b);

export type Scale = number;

export type ScaleLadder = "metric" | "imperial";

function ladderFor(ladder: ScaleLadder): readonly number[] {
  return ladder === "imperial" ? IMPERIAL_SCALES : METRIC_SCALES;
}

export interface Paper {
  readonly size: PaperSize;
  /** Denominator of 1:n. */
  readonly scale: Scale;
  /** Millimetres of blank paper at each edge. */
  readonly margin: number;
  /**
   * Where the model origin lands on the sheet, in millimetres from the bottom-left of the printable area.
   *
   * Explicit rather than always-centred because a sheet holds several viewports, and each needs its own
   * placement. {@link fitToPaper} computes a centred one for the common case.
   */
  readonly origin: Point;
}

/**
 * The transform, as the four numbers a serialiser needs.
 *
 * Y is flipped: model space is Y-up (it is a plan of a world where up is up), and SVG is Y-down. Doing the flip
 * here, once, is what keeps every serialiser from having to remember it — and forgetting it produces a mirrored
 * plan, which is both obvious in hindsight and remarkably easy to miss when the fixture is symmetric.
 */
export interface Transform {
  /** Millimetres per model metre. */
  readonly mmPerMetre: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Total sheet height in mm, needed for the Y flip. */
  readonly sheetHeight: number;
}

export function transformFor(paper: Paper): Transform {
  return {
    // 1:100 means one metre becomes 10 mm: 1000 mm / 100.
    mmPerMetre: 1000 / paper.scale,
    offsetX: paper.margin + paper.origin.x,
    offsetY: paper.margin + paper.origin.y,
    sheetHeight: paper.size.height,
  };
}

/** Model point → sheet point, in millimetres with Y already flipped for SVG. */
export function toPaper(t: Transform, p: Point): Point {
  return {
    x: t.offsetX + p.x * t.mmPerMetre,
    y: t.sheetHeight - (t.offsetY + p.y * t.mmPerMetre),
  };
}

/** Model length → paper millimetres. */
export function toPaperLength(t: Transform, metres: number): number {
  return metres * t.mmPerMetre;
}

/**
 * Choose the largest scale on the project's own ladder at which the drawing fits, and centre it.
 *
 * `ladder` defaults to metric. It is a parameter rather than a global because a federated project genuinely has
 * both — a metric architectural set and an imperial structural set from a US consultant — and a single global
 * would silently mis-scale one of them.
 *
 * Returns `null` when it does not fit even at the coarsest scale, rather than inventing a scale or silently
 * clipping. A drawing that does not fit is a real situation with real answers — a bigger sheet, a smaller extent,
 * a split across sheets — and all of them are the caller's to pick. Quietly emitting a clipped drawing is the
 * one outcome that is never right, because it looks finished.
 */
export function fitToPaper(
  drawing: Drawing,
  size: PaperSize,
  margin = 10,
  ladder: ScaleLadder = "metric",
): Paper | null {
  const width = drawing.bounds.max.x - drawing.bounds.min.x;
  const height = drawing.bounds.max.y - drawing.bounds.min.y;
  const availableX = size.width - margin * 2;
  const availableY = size.height - margin * 2;

  for (const scale of ladderFor(ladder)) {
    const mmPerMetre = 1000 / scale;
    const drawnWidth = width * mmPerMetre;
    const drawnHeight = height * mmPerMetre;
    if (drawnWidth > availableX || drawnHeight > availableY) continue;
    // Centre the content, then shift so the model's own minimum lands correctly — the drawing's bounds do not
        // start at the origin, and assuming they do puts the plan off the sheet for any model not modelled at 0,0.
    return {
      size,
      scale,
      margin,
      origin: {
        x: (availableX - drawnWidth) / 2 - drawing.bounds.min.x * mmPerMetre,
        y: (availableY - drawnHeight) / 2 - drawing.bounds.min.y * mmPerMetre,
      },
    };
  }
  return null;
}
