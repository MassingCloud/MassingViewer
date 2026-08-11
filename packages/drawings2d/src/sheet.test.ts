import { describe, expect, it } from "vitest";
import { sheetFurniture, type SheetItem, type TitleBlockFields } from "./sheet.js";
import { PAPER_SIZES, type Paper } from "./paper.js";
import { makeDrawing } from "./model.js";
import { ARCHITECTURAL } from "./theme.js";
import { toSvg } from "./svg.js";
import { toDxf } from "./dxf.js";
import { toPdf } from "./pdf.js";

/**
 * Sheet furniture — the title block the plan pane did not have.
 *
 * Two things are worth asserting here and nothing else really is. The first is **layout containment**: furniture that
 * runs off the paper is invisible on screen and missing in print, which is the worst combination. The second is the
 * **Y convention**, because `sheet.ts` declares millimetres with Y down while DXF and PDF are Y-up — so each of the
 * three serialisers converts, and a serialiser that forgets puts the title block at the top of the page.
 *
 * The field *content* is barely tested on purpose: that a string passed in comes out again is not a finding.
 */

const paperFor = (name: string, scale = 100, margin = 10): Paper => {
  const size = PAPER_SIZES.find((p) => p.name === name);
  if (size === undefined) throw new Error(`no paper size ${name}`);
  return { size, scale, margin, origin: { x: 0, y: 0 } };
};

const A3 = paperFor("A3");

const FIELDS: TitleBlockFields = {
  project: "Tower A",
  sheetName: "Level 3 General Arrangement",
  sheetNumber: "A-101",
  date: "2026-08-11",
  drawnBy: "MME",
  checkedBy: "RS",
  revision: "C",
  status: "FOR CONSTRUCTION",
};

const texts = (items: readonly SheetItem[]): string[] =>
  items.flatMap((i) => (i.kind === "text" ? [i.text] : []));

/** Every coordinate a piece of furniture touches, so containment can be asserted without knowing its kind. */
function extent(items: readonly SheetItem[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const item of items) {
    if (item.kind === "line") {
      xs.push(item.from.x, item.to.x);
      ys.push(item.from.y, item.to.y);
    } else if (item.kind === "rect") {
      xs.push(item.at.x, item.at.x + item.width);
      ys.push(item.at.y, item.at.y + item.height);
    } else {
      xs.push(item.at.x);
      ys.push(item.at.y);
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("what gets drawn, and what does not", () => {
  it("draws nothing at all when nothing was asked for", () => {
    // The plan *pane* wants linework alone — a border and title block inside a viewport panel is furniture around a
    // view, not a sheet. Defaulting to drawing them would put a title block in the middle of the 3D app.
    expect(sheetFurniture(A3)).toEqual([]);
  });

  it("draws only the frame for a border", () => {
    const items = sheetFurniture(A3, { border: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("rect");
  });
});

describe("title block layout", () => {
  it("sits inside the paper margin, bottom right", () => {
    const items = sheetFurniture(A3, { titleBlock: FIELDS });
    const e = extent(items);
    expect(e.minX, "the block starts left of the margin").toBeGreaterThanOrEqual(A3.margin - 0.01);
    expect(e.maxX, "the block runs past the right margin").toBeLessThanOrEqual(A3.size.width - A3.margin + 0.01);
    expect(e.maxY, "the block runs past the bottom margin").toBeLessThanOrEqual(A3.size.height - A3.margin + 0.01);
    // Bottom *right*, not merely inside: it must be in the lower-right quadrant, which is where a reader looks.
    expect(e.minX).toBeGreaterThan(A3.size.width / 2);
    expect(e.minY).toBeGreaterThan(A3.size.height / 2);
  });

  it("clamps onto paper too small for the nominal block", () => {
    /**
     * A **custom** small sheet, because none of `PAPER_SIZES` can exercise this.
     *
     * Two earlier versions of this test were green with the clamp removed. A4 at a 10 mm margin leaves 190 mm and the
     * nominal block is 180, so it fitted; A4 at 25 mm leaves 247 mm, because the ISO sizes in this package are
     * *landscape* — A4 is 297 wide, not 210. Only a sheet narrower than any listed size makes the clamp run, and
     * `Paper.size` is any `PaperSize`, so a detail card is a legitimate input rather than a contrived one. It is 60 mm
     * tall so the *height* clamp fires too — at 100 mm it did not, and removing that clamp also left this green.
     */
    const a4: Paper = {
      size: { name: "detail card", width: 150, height: 60 },
      scale: 100,
      margin: 5,
      origin: { x: 0, y: 0 },
    };
    const items = sheetFurniture(a4, { titleBlock: FIELDS });
    const e = extent(items);
    expect(e.minX).toBeGreaterThanOrEqual(a4.margin - 0.01);
    expect(e.maxX).toBeLessThanOrEqual(a4.size.width - a4.margin + 0.01);
    expect(e.minY).toBeGreaterThanOrEqual(a4.margin - 0.01);
    expect(e.maxY).toBeLessThanOrEqual(a4.size.height - a4.margin + 0.01);
  });

  it("labels a cell even when its value is missing", () => {
    /**
     * The judgement worth pinning. An empty CHECKED BY box is a drawing nobody has checked, and a layout that
     * collapsed the empty cell would hide an incomplete issue sheet behind a tidy block. The label is the reminder.
     */
    const items = sheetFurniture(A3, { titleBlock: { project: "Tower A" } });
    const t = texts(items);
    for (const label of ["PROJECT", "DRAWING TITLE", "SCALE", "DATE", "DRAWN", "CHECKED", "SHEET", "REV", "STATUS"]) {
      expect(t, `${label} lost its label when it had no value`).toContain(label);
    }
    // And the absent values are genuinely absent rather than drawn as "undefined".
    expect(t.join(" ")).not.toContain("undefined");
  });

  it("truncates a value too long for its cell, visibly", () => {
    // Clipped silently, a long project name overlaps the sheet number and both become unreadable. An ellipsis says
    // the value is abbreviated, so nobody reads a truncated string as a complete one.
    const items = sheetFurniture(A3, {
      titleBlock: { project: "A Very Long Project Name That No Title Block Cell Could Ever Hope To Contain" },
    });
    const project = texts(items).find((t) => t.startsWith("A Very Long"));
    expect(project, "the long value vanished instead of being truncated").toBeDefined();
    expect(project!.endsWith("…"), `not marked as truncated: ${project!}`).toBe(true);
  });

  it("derives the scale from the paper, and lets a caller override it", () => {
    expect(texts(sheetFurniture(paperFor("A3", 50), { titleBlock: {} }))).toContain("1:50");
    // "AS NOTED" and "NTS" are real title-block values that no ratio can express, which is why the override exists.
    expect(texts(sheetFurniture(A3, { titleBlock: { scaleLabel: "AS NOTED" } }))).toContain("AS NOTED");
  });
});

describe("the revision table", () => {
  it("grows upward from the block, newest first", () => {
    const revisions = [
      { rev: "A", date: "2026-06-01", description: "First issue", by: "MME" },
      { rev: "B", date: "2026-07-01", description: "Coordination", by: "MME" },
      { rev: "C", date: "2026-08-01", description: "Tender", by: "RS" },
    ];
    const withTable = sheetFurniture(A3, { titleBlock: { ...FIELDS, revisions } });
    const without = sheetFurniture(A3, { titleBlock: FIELDS });

    // Upward: the table adds content *above* where the block alone reached, and nothing below it.
    expect(extent(withTable).minY, "the table did not grow upward").toBeLessThan(extent(without).minY);
    expect(extent(withTable).maxY).toBeCloseTo(extent(without).maxY, 5);

    // Newest first, because that is the row a reader wants and the one a revision cloud refers to. Matched on the
    // *description*, which is unique: searching for the revision letter found the block's own REV cell first, and the
    // test failed on its own ambiguity rather than on the ordering.
    const yOf = (description: string): number => {
      const found = withTable.find((i) => i.kind === "text" && i.text === description);
      if (found === undefined || found.kind !== "text") throw new Error(`no row for ${description}`);
      return found.at.y;
    };
    expect(yOf("Tender"), "the newest revision is not at the top of the table").toBeLessThan(yOf("First issue"));
  });

  it("draws no table when there are no revisions", () => {
    const items = sheetFurniture(A3, { titleBlock: { ...FIELDS, revisions: [] } });
    expect(texts(items)).not.toContain("DESCRIPTION");
  });
});

describe("the scale bar", () => {
  it("uses a round number of metres rather than a round number of millimetres", () => {
    /**
     * The whole point of the bar. A bar labelled "2.37 m" that is exactly 60 mm long is useless; a bar labelled
     * "1 m" that happens to be 23.7 mm long is what a scale rule is for. So the roundness has to be in model units.
     */
    for (const scale of [50, 100, 200, 1000]) {
      const items = sheetFurniture(paperFor("A3", scale), { scaleBar: true });
      const labels = texts(items);
      for (const label of labels) {
        const value = Number.parseFloat(label);
        expect(Number.isNaN(value), `unparseable scale label ${label}`).toBe(false);
        // A round value: at most one decimal place, and never a repeating fraction of a metre.
        expect(value, `${label} at 1:${scale} is not a round number of metres`).toBeCloseTo(
          Math.round(value * 10) / 10,
          6,
        );
      }
    }
  });

  it("lands near the target length on paper at every scale, so it is measurable", () => {
    // A bar 4 mm long cannot be measured and a bar 250 mm long does not fit. The step search exists to keep it
    // usable across two orders of magnitude of scale, and this is the assertion that it does.
    for (const scale of [20, 50, 100, 500, 1000]) {
      const items = sheetFurniture(paperFor("A3", scale), { scaleBar: true });
      const e = extent(items);
      const length = e.maxX - e.minX;
      expect(length, `the bar is ${length.toFixed(1)} mm at 1:${scale}`).toBeGreaterThan(20);
      expect(length, `the bar is ${length.toFixed(1)} mm at 1:${scale}`).toBeLessThan(140);
    }
  });

  it("stays on the paper", () => {
    const e = extent(sheetFurniture(A3, { scaleBar: true }));
    expect(e.minX).toBeGreaterThanOrEqual(A3.margin - 0.01);
    expect(e.maxX).toBeLessThanOrEqual(A3.size.width - A3.margin + 0.01);
    expect(e.maxY).toBeLessThanOrEqual(A3.size.height - A3.margin + 0.01);
  });
});

// ===================================================================================================
// The Y convention, across all three serialisers
// ===================================================================================================

const drawing = makeDrawing({
  kind: "plan",
  name: "L3",
  view: { kind: "plan", cutHeight: 1.2 },
  entities: [
    {
      id: "e1",
      role: "cut",
      layer: "A-WALL",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }], closed: false },
      guid: "0aBcDeFgHiJkLmNoPqRsTu" as never,
      ifcClass: "IfcWall",
    },
  ],
  provenance: { generator: "test", generatedAt: "2026-08-11T00:00:00Z", approximations: [], incomplete: [] },
});

describe("each serialiser converts the Y convention exactly once", () => {
  /**
   * The trap `pdf.ts` opens by naming: SVG is Y-down, DXF and PDF are Y-up. Furniture is declared Y-down, so two of
   * the three must flip. A serialiser that forgets draws the title block at the *top* of the page.
   *
   * Asserted as "which half of the page", not as exact coordinates. A coordinate assertion would pin the layout and
   * break on every spacing change; the half is the thing that is actually wrong when the flip is missing.
   */
  it("puts the title block in the bottom half of an SVG", () => {
    const svg = toSvg(drawing, ARCHITECTURAL, A3, { titleBlock: FIELDS });
    const ys = [...svg.matchAll(/<text[^>]*\by="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length, "no title-block text in the SVG at all").toBeGreaterThan(0);
    expect(Math.min(...ys), "SVG title block is in the top half — Y was flipped when it should not have been").
      toBeGreaterThan(A3.size.height / 2);
  });

  it("puts the title block in the bottom half of a DXF, which is Y-up", () => {
    const dxf = toDxf(drawing, ARCHITECTURAL, A3, { titleBlock: FIELDS });
    /**
     * Walked as code/value pairs rather than split on a delimiter.
     *
     * DXF is nothing but `code\nvalue\n` repeated, so a value of `"0"` is textually identical to an entity-start
     * code — splitting on one matched nothing here, and the test failed for a parsing reason rather than a layout
     * one. Pairwise is the only reading that cannot confuse the two.
     */
    const lines = dxf.split("\n");
    const ys: number[] = [];
    let type = "";
    let layer = "";
    let y: number | null = null;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = lines[i]!.trim();
      const value = lines[i + 1]!;
      if (code === "0") {
        if (type === "TEXT" && layer === "SHEET" && y !== null) ys.push(y);
        type = value;
        layer = "";
        y = null;
      } else if (code === "8") layer = value;
      else if (code === "20" && y === null) y = Number(value);
    }
    expect(ys.length, "no title-block TEXT on the SHEET layer").toBeGreaterThan(0);
    // Y-up: the bottom of the page is a *small* y. A missing flip would put these above the midpoint.
    expect(Math.max(...ys), "DXF title block is in the top half — the Y flip is missing").toBeLessThan(
      A3.size.height / 2,
    );
  });

  it("puts the title block in the bottom half of a PDF, which is Y-up and in points", () => {
    const pdf = toPdf(drawing, ARCHITECTURAL, A3, { titleBlock: FIELDS });
    const text = new TextDecoder("latin1").decode(pdf);
    const ys = [...text.matchAll(/([\d.]+) ([\d.]+) Td/g)].map((m) => Number(m[2]));
    expect(ys.length, "no text positioning operators in the PDF").toBeGreaterThan(0);
    const halfPt = ((A3.size.height / 2) * 72) / 25.4;
    expect(Math.max(...ys), "PDF title block is in the top half — the Y flip is missing").toBeLessThan(halfPt);
  });
});

describe("furniture is untrusted text like everything else", () => {
  it("escapes a title-block field in the SVG", () => {
    // A project name is typed by whoever set up the job, so it is the same untrusted path as an element name — and
    // `svg.security.test.ts` exists because this file writes markup by concatenation.
    const svg = toSvg(drawing, ARCHITECTURAL, A3, {
      titleBlock: { project: `</text><script>alert(1)</script>` },
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("escapes a title-block field in the PDF", () => {
    // PDF literal strings end at an unescaped `)`, so a field containing one would terminate the string early and
    // corrupt the content stream — a broken file rather than an injection, but broken all the same.
    const pdf = toPdf(drawing, ARCHITECTURAL, A3, { titleBlock: { project: "Tower (A) \\ B" } });
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text).toContain("Tower \\(A\\) \\\\ B");
  });
});
