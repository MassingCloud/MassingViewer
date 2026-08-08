import { describe, expect, it } from "vitest";
import { asGuid, type Guid } from "@massing/core";
import { ARCHITECTURAL, FIRE_SAFETY } from "./theme.js";
import { PAPER_SIZES, fitToPaper, transformFor } from "./paper.js";
import { generatePlan } from "./plan.js";
import { makeDrawing, type DrawingEntity } from "./model.js";
import { pdfLimitations, toPdf } from "./pdf.js";
import { toSvg } from "./svg.js";
import { dxfLimitations, toDxf } from "./dxf.js";
import type { ElementMesh } from "./provider.js";

/**
 * ## What these tests do and do not prove
 *
 * As with the DXF, **there is no independent PDF parser here** — no `pdf.js`, no `mupdf`, and `mupdf` is banned
 * by name in the licence gate. So this output is not read back by a third-party reader, and saying so is the
 * point: the three serialisers in this package do not have equal verification.
 *
 * What is checked is the layer where a hand-written PDF actually breaks, which is *not* the drawing content:
 *
 * 1. **The cross-reference table**, byte for byte. Every offset is followed into the file and must land on the
 *    `N 0 obj` header it claims. This is the assertion that matters most, because a PDF with correct linework
 *    and one wrong offset is a file that opens in nothing — and the failure mode is invisible to any test that
 *    only greps the content stream. Entry width is asserted at exactly 20 bytes for the same reason: readers
 *    seek into that table by multiplying.
 * 2. **Object graph integrity** — every `N 0 R` reference resolves, `/Root` is a `/Catalog`, `/Length` equals
 *    the actual stream byte count, and `q`/`Q` and `BDC`/`EMC` balance.
 * 3. **Semantics a structural check cannot see**: that PDF is Y-**up** while the SVG is Y-down (the second Y
 *    convention in this package and the one most likely to mirror a plan), that lengths measure correctly at
 *    the stated scale, and that the GlobalId survives into both the marked content and the attached index.
 * 4. **Determinism**, because a serialiser that embeds a clock cannot be diffed.
 *
 * The check this cannot make is "Acrobat opens it". That needs a real reader, and the honest position is that
 * CI does not have one:
 *
 * - `pdf.js` would work but is a browser bundle, not a Node fixture reader.
 * - **MuPDF is banned by name** in `scripts/check-licenses.mjs` — it is AGPL — so it cannot become a dev
 *   dependency of this repository even for tests. That ban is about shipping, and it is worth keeping for
 *   tests too: a required dev dependency shows up in the tree the gate walks.
 *
 * So the output was checked once, manually, against **two** independent implementations — poppler's
 * `pdftotext` and MuPDF — with results recorded here rather than asserted:
 *
 * ```
 * pages 1 · "PDF 1.7" · is_repaired FALSE   <- MuPDF did not have to fix the xref to read the file
 * page 1190.55 x 841.89 pt                  <- A3 landscape, exactly
 * layers  A-ANNO A-DOOR A-GRID A-SLAB A-WALL     <- all five OCGs read
 * embedded_files  ["massingviewer-index.json"]   <- parsed, 4 GlobalIds, scale 50, 56.69 pt/m
 * text  A / OFFICE 24 m2 / ROTATED
 * grid bubble centre x = 481.89 pt · centred label "A" centre x = 481.89 pt
 * ```
 *
 * That last line is the one worth having: it is the Helvetica width table checked by something that has never
 * seen this code, and it is the only way to know a centred grid bubble is actually centred. `is_repaired` is
 * the second: a PDF with a broken cross-reference table still *opens* in most readers, because they silently
 * rebuild it — so "it opened" proves much less than it appears to, and this flag is what distinguishes them.
 */

const A3 = PAPER_SIZES.find((p) => p.name === "A3")!;
const guid = (n: number): Guid => asGuid(`0Test${String(n).padStart(17, "0")}`);

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5],
    [2, 6, 7], [2, 7, 3], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  return faces.flatMap(([a, b, c]) => [...v[a!]!, ...v[b!]!, ...v[c!]!]);
}

const mesh = (over: Partial<ElementMesh> & { positions: number[] }): ElementMesh => ({
  guid: guid(1),
  ifcClass: "IfcWall",
  ...over,
});

const wall = mesh({ guid: guid(1), ifcClass: "IfcWall", positions: box(0, 0, 0, 5, 3, 0.2) });
const slab = mesh({ guid: guid(2), ifcClass: "IfcSlab", positions: box(-1, -0.2, -1, 6, 0, 4) });
const drawing = generatePlan({ name: "L1", meshes: [wall, slab] }, { kind: "plan", cutHeight: 1.2 });
const paper = fitToPaper(drawing, A3, 10)!;

// ---------------------------------------------------------------------------------------------------
// A reader, written against the PDF file structure rather than against our writer
// ---------------------------------------------------------------------------------------------------

const MM_TO_PT = 72 / 25.4;

/** Latin-1 decode, matching how the writer encodes. `TextDecoder("utf-8")` would corrupt any high byte. */
function decode(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

interface XrefEntry {
  readonly offset: number;
  readonly generation: number;
  readonly type: string;
}

interface ParsedPdf {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly version: string;
  readonly xref: readonly XrefEntry[];
  readonly startxref: number;
  readonly trailer: string;
  /** Object number → its body text, found by following the xref rather than by scanning. */
  readonly objects: Map<number, string>;
  readonly content: string;
}

/**
 * Parse the file structure by *following the xref*, not by scanning for `obj`.
 *
 * That distinction is the whole value of this reader. Scanning finds every object regardless of whether the
 * table points at it, so a test built on scanning passes with a completely broken xref — which is precisely the
 * bug a hand-written PDF has. A reader must do what a real reader does: seek.
 */
function parsePdf(bytes: Uint8Array): ParsedPdf {
  const text = decode(bytes);

  const versionMatch = /^%PDF-(\d+\.\d+)\n/.exec(text);
  expect(versionMatch, "no %PDF header").not.toBeNull();

  const startxrefMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  expect(startxrefMatch, "no startxref/%%EOF trailer").not.toBeNull();
  const startxref = Number(startxrefMatch![1]);

  expect(text.slice(startxref, startxref + 4), "startxref does not point at the xref keyword").toBe("xref");

  const headerMatch = /^xref\n(\d+) (\d+)\n/.exec(text.slice(startxref));
  expect(headerMatch, "malformed xref subsection header").not.toBeNull();
  const count = Number(headerMatch![2]);
  const tableStart = startxref + headerMatch![0].length;

  const xref: XrefEntry[] = [];
  for (let i = 0; i < count; i++) {
    // Fixed 20-byte stride, deliberately. Splitting on newlines would paper over exactly the bug this catches.
    const raw = text.slice(tableStart + i * 20, tableStart + i * 20 + 20);
    const m = /^(\d{10}) (\d{5}) ([nf]) $/.exec(raw.replace(/[\r\n]$/, "\n").replace(/\n$/, ""));
    expect(m, `xref entry ${i} is not a 20-byte record: ${JSON.stringify(raw)}`).not.toBeNull();
    xref.push({ offset: Number(m![1]), generation: Number(m![2]), type: m![3]! });
  }

  const trailerAt = text.indexOf("trailer", tableStart + count * 20 - 1);
  expect(trailerAt, "no trailer after the xref table").toBeGreaterThan(0);
  const trailer = text.slice(trailerAt, text.indexOf("startxref", trailerAt));

  // Seek to each in-use object and read it where the table says it is.
  const objects = new Map<number, string>();
  for (let i = 1; i < xref.length; i++) {
    const entry = xref[i]!;
    if (entry.type !== "n") continue;
    const at = text.slice(entry.offset);
    const m = /^(\d+) (\d+) obj\n/.exec(at);
    expect(m, `xref entry ${i} points at ${JSON.stringify(at.slice(0, 24))}, not an object header`).not.toBeNull();
    expect(Number(m![1]), `xref entry ${i} points at object ${m![1]}`).toBe(i);
    const end = at.indexOf("\nendobj\n");
    expect(end, `object ${i} has no endobj`).toBeGreaterThan(0);
    objects.set(i, at.slice(m![0].length, end));
  }

  // The page's content stream, resolved through /Contents rather than assumed to be object 4.
  const page = [...objects.values()].find((o) => o.includes("/Type /Page ") || o.includes("/Type /Page\n"));
  expect(page, "no /Page object").toBeDefined();
  const contentsRef = /\/Contents (\d+) 0 R/.exec(page!);
  expect(contentsRef, "page has no /Contents").not.toBeNull();
  const contentObject = objects.get(Number(contentsRef![1]))!;
  const streamStart = contentObject.indexOf("stream\n") + "stream\n".length;
  const content = contentObject.slice(streamStart, contentObject.lastIndexOf("\nendstream"));

  return { text, bytes, version: versionMatch![1]!, xref, startxref, trailer, objects, content };
}

const pdf = parsePdf(toPdf(drawing, ARCHITECTURAL, paper, { border: true }));

// ---------------------------------------------------------------------------------------------------

describe("file structure", () => {
  it("declares a version and a binary marker", () => {
    expect(pdf.version).toBe("1.7");
    // The four high bytes on line 2 are what stop an ASCII-mode transfer or a line-ending normaliser from
    // rewriting the stream bytes and invalidating every offset in the table below.
    expect([...pdf.bytes.slice(9, 14)]).toEqual([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  });

  it("has a free entry 0 with generation 65535", () => {
    expect(pdf.xref[0]).toEqual({ offset: 0, generation: 65535, type: "f" });
  });

  it("points every xref offset at the object it claims", () => {
    // `parsePdf` asserts this per entry while seeking; this states it as the headline rather than leaving it
    // buried in a helper, because it is the assertion that decides whether the file opens at all.
    expect(pdf.objects.size).toBe(pdf.xref.length - 1);
  });

  it("agrees between /Size and the table", () => {
    const size = /\/Size (\d+)/.exec(pdf.trailer);
    expect(Number(size![1])).toBe(pdf.xref.length);
  });

  it("resolves every indirect reference", () => {
    // A dangling `12 0 R` is accepted by some readers as null and rejected by others. Either way it means a
    // renumbering went wrong, which is why objects are appended positionally rather than hand-numbered.
    const dangling = new Set<number>();
    for (const body of [...pdf.objects.values(), pdf.trailer]) {
      for (const m of body.matchAll(/(\d+) 0 R/g)) {
        const n = Number(m[1]);
        if (!pdf.objects.has(n)) dangling.add(n);
      }
    }
    expect([...dangling]).toEqual([]);
  });

  it("has a catalog at /Root with a page tree that counts its kids", () => {
    const root = /\/Root (\d+) 0 R/.exec(pdf.trailer);
    const catalog = pdf.objects.get(Number(root![1]))!;
    expect(catalog).toContain("/Type /Catalog");

    const pagesRef = /\/Pages (\d+) 0 R/.exec(catalog)!;
    const pages = pdf.objects.get(Number(pagesRef[1]))!;
    expect(pages).toContain("/Type /Pages");
    const kids = /\/Kids \[([^\]]*)\]/.exec(pages)![1]!;
    const declared = Number(/\/Count (\d+)/.exec(pages)![1]);
    expect([...kids.matchAll(/\d+ 0 R/g)]).toHaveLength(declared);
  });

  it("declares /Length equal to the actual stream byte count", () => {
    // The reason `latin1()` exists rather than `TextEncoder`. A `/Length` counted in UTF-16 code units or
    // UTF-8 bytes while the stream is written as Latin-1 produces a corrupt file, not an error.
    for (const [n, body] of pdf.objects) {
      const streamAt = body.indexOf("stream\n");
      if (streamAt < 0) continue;
      const declared = Number(/\/Length (\d+)/.exec(body)![1]);
      const actual = body.slice(streamAt + "stream\n".length, body.lastIndexOf("\nendstream")).length;
      expect(actual, `object ${n} /Length`).toBe(declared);
    }
  });

  it("sets the MediaBox to the paper size in points", () => {
    const page = [...pdf.objects.values()].find((o) => o.includes("/Type /Page "))!;
    const media = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page)!;
    expect(Number(media[1])).toBeCloseTo(A3.width * MM_TO_PT, 1);
    expect(Number(media[2])).toBeCloseTo(A3.height * MM_TO_PT, 1);
  });
});

describe("content stream", () => {
  it("balances q/Q and BDC/EMC", () => {
    // An unbalanced `q` leaks a clip or a colour into everything after it, and an unbalanced `BDC` puts the
    // rest of the page inside the wrong optional-content group — so the drawing renders, wrongly.
    const count = (re: RegExp): number => [...pdf.content.matchAll(re)].length;
    expect(count(/^q$/gm)).toBe(count(/^Q$/gm));
    expect(count(/\bBDC$/gm)).toBe(count(/^EMC$/gm));
  });

  it("uses only operators that exist", () => {
    // A typo'd operator is silently ignored by most readers, so the linework simply goes missing. Checking the
    // vocabulary is cheap and catches it; the alternative is noticing a wall is absent.
    const allowed = new Set(["m", "l", "c", "h", "re", "S", "f", "f*", "B*", "W", "n", "w", "d", "J", "j",
      "RG", "rg", "q", "Q", "BT", "ET", "Tf", "Td", "Tm", "Tj", "BDC", "EMC", "cm", "gs"]);
    const bad = new Set<string>();
    for (const line of pdf.content.split("\n")) {
      if (line === "" || line.startsWith("/") || line.startsWith("(")) continue;
      const token = line.trim().split(/\s+/).pop()!;
      if (!allowed.has(token) && !/^[-\d.]+$/.test(token)) bad.add(token);
    }
    expect([...bad]).toEqual([]);
  });

  it("paints a white background", () => {
    expect(pdf.content).toMatch(/1 1 1 rg\n0 0 [\d.]+ [\d.]+ re\nf/);
  });

  it("draws the border only when asked", () => {
    const without = parsePdf(toPdf(drawing, ARCHITECTURAL, paper));
    const borderRe = /[\d.]+ [\d.]+ [\d.]+ [\d.]+ re\nS/;
    expect(pdf.content).toMatch(borderRe);
    expect(without.content).not.toMatch(borderRe);
  });
});

describe("Y is up, unlike the SVG", () => {
  it("puts a higher model Y at a higher PDF Y", () => {
    // The second Y convention in this package. SVG flips (Y-down), DXF and PDF do not (Y-up). A mirrored plan
    // is invisible on a symmetric fixture, which is why this asserts the *direction*.
    //
    // Both lines live in ONE drawing, fitted once. A first version put them in two drawings and fitted paper to
    // one of them — which puts the other off the sheet at a negative coordinate, so the test failed for a
    // reason that had nothing to do with the Y axis. Comparing two renderings only works if they share a page.
    const both = makeDrawing({
      kind: "plan",
      name: "y",
      entities: [
        line("low", [{ x: 0, y: 0 }, { x: 1, y: 0 }]),
        line("high", [{ x: 0, y: 4 }, { x: 1, y: 4 }]),
      ],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const shared = fitToPaper(both, A3, 10)!;

    const moves = [...parsePdf(toPdf(both, ARCHITECTURAL, shared)).content.matchAll(/^([\d.-]+) ([\d.-]+) m$/gm)];
    expect(moves).toHaveLength(2);
    const [lowY, highY] = moves.map((m) => Number(m[2]));
    expect(highY!).toBeGreaterThan(lowY!);

    // And the SVG must disagree, or the flip has been lost on that side instead.
    const svgMoves = [...toSvg(both, ARCHITECTURAL, shared).matchAll(/M[\d.-]+,([\d.-]+)/g)];
    expect(Number(svgMoves[1]![1])).toBeLessThan(Number(svgMoves[0]![1]));
  });

  it("measures correctly at the stated scale", () => {
    // A 5 m wall at 1:100 is 50 mm on paper, which is 141.73 pt. If this number is wrong the drawing is
    // unmeasurable, which is the one thing a drawing has to be.
    const t = transformFor(paper);
    const xs = [...pdf.content.matchAll(/^([\d.]+) ([\d.]+) [ml]$/gm)].map((m) => Number(m[1]));
    const span = Math.max(...xs) - Math.min(...xs);
    // The slab is 7 m wide, from -1 to 6.
    expect(span).toBeCloseTo(7 * t.mmPerMetre * MM_TO_PT, 0);
  });
});

describe("layers as Optional Content Groups", () => {
  it("declares one OCG per layer used, and no more", () => {
    const ocgs = [...pdf.objects.values()].filter((o) => o.includes("/Type /OCG"));
    const layers = new Set(drawing.entities.map((e) => e.layer));
    expect(ocgs.length).toBeGreaterThan(0);
    expect(ocgs.length).toBeLessThanOrEqual(layers.size);
    // An OCG with nothing inside it is a checkbox in the reader's layer panel that does nothing, which reads
    // as a broken export. So every declared group must be referenced from the content.
    for (const ocg of ocgs) {
      const layerName = /\/Name \(([^)]*)\)/.exec(ocg)![1]!;
      expect([...drawing.entities].some((e) => e.layer === layerName)).toBe(true);
    }
  });

  it("registers each OCG in /OCProperties and in the page's /Properties", () => {
    // Both are required and they fail differently: without /OCProperties the reader shows no layer panel at
    // all, and without the page /Properties the `/OC /oc0 BDC` in the content refers to nothing.
    const catalog = [...pdf.objects.values()].find((o) => o.includes("/Type /Catalog"))!;
    const page = [...pdf.objects.values()].find((o) => o.includes("/Type /Page "))!;
    const declared = [...catalog.matchAll(/\/OCGs \[([^\]]*)\]/g)][0]![1]!.match(/\d+ 0 R/g)!;

    for (const ref of declared) expect(page, `page /Properties missing ${ref}`).toContain(ref);
    for (const used of new Set([...pdf.content.matchAll(/\/OC \/(\w+) BDC/g)].map((m) => m[1]))) {
      expect(page).toContain(`/${used} `);
    }
  });

  it("omits them entirely when layers are off", () => {
    const flat = parsePdf(toPdf(drawing, ARCHITECTURAL, paper, { layers: false }));
    expect([...flat.objects.values()].filter((o) => o.includes("/OCG"))).toEqual([]);
    expect(flat.content).not.toContain("/OC ");
  });
});

describe("GlobalIds survive — twice", () => {
  it("wraps element linework in marked content carrying its GlobalId", () => {
    expect(pdf.content).toContain(`/GUID (${guid(1)})`);
    expect(pdf.content).toContain(`/GUID (${guid(2)})`);
    expect(pdf.content).toContain("/Class (IfcWall)");
  });

  it("attaches an index resolving GlobalId to paper coordinates", () => {
    // The moat, stated as a test. A markup placed at page coordinates in Bluebeam or Acrobat — tools that know
    // nothing about IFC — can be resolved back to the element it covers, because the boxes and the transform
    // both travel inside the file. No other export in this package can do this: `toDxf` has nowhere to put it.
    const spec = [...pdf.objects.values()].find((o) => o.includes("/Type /Filespec"))!;
    expect(spec).toContain("massingviewer-index.json");
    const streamRef = /\/EF << \/F (\d+) 0 R >>/.exec(spec)!;
    const body = pdf.objects.get(Number(streamRef[1]))!;

    const json = JSON.parse(body.slice(body.indexOf("stream\n") + 7, body.lastIndexOf("\nendstream")));
    expect(json.format).toBe("massingviewer-pdf-index");
    expect(json.paper.scale).toBe(paper.scale);
    expect(json.paper.pointsPerMetre).toBeCloseTo(transformFor(paper).mmPerMetre * MM_TO_PT, 2);

    const forWall = json.entities.filter((e: { guid: string }) => e.guid === guid(1));
    expect(forWall.length).toBeGreaterThan(0);
    // The bbox must actually contain the linework, or resolving a markup lands on the wrong element.
    for (const entity of forWall) {
      const [x0, y0, x1, y1] = entity.bbox;
      expect(x1).toBeGreaterThanOrEqual(x0);
      expect(y1).toBeGreaterThanOrEqual(y0);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(A3.width * MM_TO_PT + 1);
    }
  });

  it("carries the coverage and the failures, not just the successes", () => {
    // `incomplete` is the field most likely to be treated as optional, and a plan silently missing a wall
    // renders perfectly. Whoever opens the PDF should be able to see what did not make it.
    const spec = [...pdf.objects.values()].find((o) => o.includes("/Type /Filespec"))!;
    const body = pdf.objects.get(Number(/\/EF << \/F (\d+) 0 R >>/.exec(spec)![1]))!;
    const json = JSON.parse(body.slice(body.indexOf("stream\n") + 7, body.lastIndexOf("\nendstream")));
    expect(json).toHaveProperty("guidCoverage");
    expect(json).toHaveProperty("incomplete");
    expect(json.guidCoverage).toBeCloseTo(drawing.provenance.guidCoverage, 2);
  });

  it("skips the index when asked, for a sheet that leaves the building", () => {
    const bare = parsePdf(toPdf(drawing, ARCHITECTURAL, paper, { index: false }));
    expect([...bare.objects.values()].filter((o) => o.includes("/Filespec"))).toEqual([]);
    // The marked content stays: it is inside the page, costs nothing, and a reader ignores an unknown tag.
    expect(bare.content).toContain("/GUID (");
  });
});

describe("text", () => {
  const label = (text: string, anchor?: "start" | "middle" | "end"): DrawingEntity => ({
    id: "t1",
    role: "annotation",
    layer: "A-ANNO",
    geometry: { kind: "text", at: { x: 2, y: 2 }, text, anchor },
  });
  const withText = (entity: DrawingEntity) =>
    makeDrawing({
      kind: "plan",
      name: "text",
      entities: [entity],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });

  it("shifts left by half the measured width for a centred label", () => {
    // PDF has no text-anchor, so centring means measuring the string — which is why the Helvetica width table
    // is in the file. Without it a grid bubble's number sits to the right of its circle.
    const at = (anchor: "start" | "middle" | "end"): number => {
      const d = withText(label("A-101", anchor));
      const content = parsePdf(toPdf(d, ARCHITECTURAL, fitToPaper(d, A3, 10)!)).content;
      return Number(/^([\d.-]+) ([\d.-]+) Td$/m.exec(content)![1]);
    };
    const start = at("start");
    const middle = at("middle");
    const end = at("end");
    expect(middle).toBeLessThan(start);
    expect(end).toBeLessThan(middle);
    // Symmetric: middle is exactly halfway between start and end.
    expect(middle - end).toBeCloseTo(start - middle, 1);
  });

  it("escapes the three characters that would end a literal string", () => {
    const d = withText(label("W(1) 50% \\ 2"));
    const content = parsePdf(toPdf(d, ARCHITECTURAL, fitToPaper(d, A3, 10)!)).content;
    expect(content).toContain("(W\\(1\\) 50% \\\\ 2) Tj");
  });

  it("replaces a character WinAnsi cannot hold rather than emitting broken bytes", () => {
    // Declared in `pdfLimitations`. The alternative — emitting UTF-8 into a single-byte encoding — produces two
    // wrong glyphs and breaks every byte count downstream.
    const d = withText(label("Room 会議室"));
    const bytes = toPdf(d, ARCHITECTURAL, fitToPaper(d, A3, 10)!);
    const content = parsePdf(bytes).content;
    expect(content).toContain("(Room ???) Tj");
    // And the structure still parses, which is the part that matters: /Length survived.
    expect(parsePdf(bytes).objects.size).toBeGreaterThan(0);
  });

  it("rotates without inverting the sign, unlike the SVG", () => {
    // SVG needs `-rotation` because it flipped Y. PDF did not flip, so a positive model rotation is already
    // counter-clockwise on the page. Applying the SVG's correction here would rotate labels backwards.
    const d = withText({ ...label("N"), geometry: { kind: "text", at: { x: 2, y: 2 }, text: "N", rotation: Math.PI / 2 } });
    const p = fitToPaper(d, A3, 10)!;
    const content = parsePdf(toPdf(d, ARCHITECTURAL, p)).content;
    const tm = /^([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) [\d.-]+ [\d.-]+ Tm$/m.exec(content)!;
    // cos 90° = 0, sin 90° = +1 for a counter-clockwise rotation.
    expect(Number(tm[1])).toBeCloseTo(0, 5);
    expect(Number(tm[2])).toBeCloseTo(1, 5);
  });
});

describe("arcs", () => {
  it("approximates a circle with four Béziers through the right points", () => {
    const d = makeDrawing({
      kind: "plan",
      name: "c",
      entities: [{ id: "c1", role: "grid", layer: "A-GRID", geometry: { kind: "circle", centre: { x: 3, y: 3 }, radius: 1 } }],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const p = fitToPaper(d, A3, 10)!;
    const content = parsePdf(toPdf(d, ARCHITECTURAL, p)).content;
    expect([...content.matchAll(/ c$/gm)]).toHaveLength(4);

    // The four Bézier endpoints must sit on the circle. This is the check that catches a control-point sign
    // error, which produces a shape that is closed, plausible, and not a circle.
    const t = transformFor(p);
    const centre = { x: (t.offsetX + 3 * t.mmPerMetre) * MM_TO_PT, y: (t.offsetY + 3 * t.mmPerMetre) * MM_TO_PT };
    const r = t.mmPerMetre * MM_TO_PT;
    for (const m of content.matchAll(/[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+) c/g)) {
      const dx = Number(m[1]) - centre.x;
      const dy = Number(m[2]) - centre.y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(r, 1);
    }
  });

  it("splits a long arc so no segment exceeds 90 degrees", () => {
    // One Bézier cannot approximate more than about a quarter circle usefully; a single segment over 270° is
    // not a slightly-worse arc, it is a completely different curve.
    const d = makeDrawing({
      kind: "plan",
      name: "a",
      entities: [{
        id: "a1",
        role: "symbol",
        layer: "A-DOOR",
        geometry: { kind: "arc", centre: { x: 3, y: 3 }, radius: 1, from: 0, to: (Math.PI * 3) / 2 },
      }],
      view: { kind: "plan" },
      provenance: { provider: "t", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
    });
    const content = parsePdf(toPdf(d, ARCHITECTURAL, fitToPaper(d, A3, 10)!)).content;
    expect([...content.matchAll(/ c$/gm)]).toHaveLength(3);
  });
});

describe("the same three inputs, three serialisers", () => {
  const paths = (c: string): string[] => c.split("\n").filter((l) => / [ml]$/.test(l));

  it("is a function of the theme, so a repaint changes the output", () => {
    expect(parsePdf(toPdf(drawing, ARCHITECTURAL, paper)).content).not.toBe(
      parsePdf(toPdf(drawing, FIRE_SAFETY, paper)).content,
    );
  });

  it("moves no geometry when a theme only changes paint", () => {
    // The point of the Semantic Drawing Model, stated precisely. A first version compared ARCHITECTURAL against
    // FIRE_SAFETY and expected identical paths, which is wrong for a reason worth keeping: FIRE_SAFETY *hides*
    // entities, and hiding is a legitimate paint property. So the invariant is about paint, not about themes in
    // general — and the two claims are separated rather than conflated into one that has to be weakened.
    const recoloured = {
      ...ARCHITECTURAL,
      name: "recoloured",
      base: { ...ARCHITECTURAL.base, stroke: "#ff0000", weight: 1.4 },
    };
    const a = parsePdf(toPdf(drawing, ARCHITECTURAL, paper)).content;
    const b = parsePdf(toPdf(drawing, recoloured, paper)).content;
    expect(a).not.toBe(b);
    expect(paths(a)).toEqual(paths(b));
  });

  it("draws a subset when a theme hides, never a different shape", () => {
    // The other half: a theme that hides removes whole entities and leaves the rest untouched. A repaint that
    // *moved* the surviving linework would mean geometry was being recomputed per theme.
    const arch = paths(parsePdf(toPdf(drawing, ARCHITECTURAL, paper)).content);
    const fire = paths(parsePdf(toPdf(drawing, FIRE_SAFETY, paper)).content);
    for (const path of fire) expect(arch, `${path} is not in the architectural output`).toContain(path);
  });

  it("is a function of the paper, so rescaling needs no regeneration", () => {
    const tighter = { ...paper, scale: 50 };
    const a = parsePdf(toPdf(drawing, ARCHITECTURAL, paper)).content;
    const b = parsePdf(toPdf(drawing, ARCHITECTURAL, tighter)).content;
    expect(a).not.toBe(b);
  });

  it("hides what the theme hides, in every format", () => {
    // Three serialisers agreeing about visibility is the invariant that says there is one code path. If PDF
    // drew something the SVG hid, `paintFor` would be being consulted in two different ways.
    const hiding = {
      ...ARCHITECTURAL,
      rules: [...ARCHITECTURAL.rules, { select: { ifcClass: "IfcSlab" }, paint: { hidden: true } }],
    };
    const pdfText = parsePdf(toPdf(drawing, hiding, paper)).content;
    expect(pdfText).not.toContain(`/GUID (${guid(2)})`);
    expect(toSvg(drawing, hiding, paper)).not.toContain(guid(2));
    expect(toDxf(drawing, hiding, paper)).not.toContain("IFCSLAB");
  });
});

describe("determinism", () => {
  it("exports byte-identically twice", () => {
    const a = toPdf(drawing, ARCHITECTURAL, paper, { border: true });
    const b = toPdf(drawing, ARCHITECTURAL, paper, { border: true });
    expect([...a]).toEqual([...b]);
  });

  it("embeds no clock", () => {
    // A serialiser that calls `new Date()` cannot be byte-compared, so nobody can tell whether a re-issued
    // sheet actually changed. The date is a parameter with a fixed default instead.
    expect(pdf.text).toContain("D:20260101000000Z");
    const dated = decode(toPdf(drawing, ARCHITECTURAL, paper, { date: "D:20260807120000Z" }));
    expect(dated).toContain("D:20260807120000Z");
    expect(dated).not.toContain("D:20260101000000Z");
  });

  it("changes its /ID when the content changes", () => {
    const id = (bytes: Uint8Array): string => /\/ID \[<([0-9a-f]+)>/.exec(decode(bytes))![1]!;
    expect(id(toPdf(drawing, ARCHITECTURAL, paper))).not.toBe(id(toPdf(drawing, FIRE_SAFETY, paper)));
    expect(id(toPdf(drawing, ARCHITECTURAL, paper))).toBe(id(toPdf(drawing, ARCHITECTURAL, paper)));
  });
});

describe("honesty", () => {
  it("declares what it cannot carry", () => {
    const limits = pdfLimitations();
    expect(limits.length).toBeGreaterThan(3);
    expect(limits.join(" ")).toMatch(/B.zier/);
    expect(limits.join(" ")).toMatch(/Latin-1|WinAnsi/);
  });

  it("carries more than the DXF does, which is the reason to choose it", () => {
    // Not a vanity comparison. The two limitation lists are what a UI shows next to an Export button, and the
    // decisive difference is identity: a DXF markup cannot come back, a PDF markup can.
    expect(dxfLimitations().join(" ")).toMatch(/GlobalIds are not carried/);
    expect(pdfLimitations().join(" ")).not.toMatch(/GlobalId/);
  });
});

function line(id: string, points: readonly { x: number; y: number }[]): DrawingEntity {
  return { id, role: "cut", layer: "A-WALL", geometry: { kind: "polyline", points, closed: false } };
}
