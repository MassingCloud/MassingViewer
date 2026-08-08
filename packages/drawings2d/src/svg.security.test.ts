// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { makeDrawing, type DrawingEntity } from "./model.js";
import { fitToPaper, PAPER_SIZES } from "./paper.js";
import { ARCHITECTURAL } from "./theme.js";
import { toSvg } from "./svg.js";

/**
 * Can hostile content in a drawing escape into the DOM?
 *
 * ## Why this file is the control, and what it is not
 *
 * The plan called SVG sanitisation "the primary control, not defence-in-depth", and the threat it named is real:
 * sheet SVG is generated from IFC that arrives from consultants and subs, and with `LocalKernel` generating
 * drawings in the browser **there is no server escaping in front of it**. `apps/demo` assigns `toSvg` output
 * straight to `innerHTML`.
 *
 * But the control that fits is not a DOMPurify-style sanitiser, and it is worth being precise about why:
 *
 * - A **sanitiser** parses a document someone else produced and strips what it does not trust. That is the right
 *   tool for *imported* SVG — which this codebase does not do yet: `packages/fileio/src/support.ts` lists `svg` as
 *   `planned`. **When SVG import lands, a sanitiser becomes mandatory, and this test does not cover it.**
 * - For SVG this package *generates*, the only way hostile content reaches the DOM is an interpolation site that
 *   forgot to escape. A sanitiser downstream would hide those bugs rather than prevent them.
 *
 * So the control here is: every field a drawing carries is fed hostile content, and the output must not contain an
 * executable construct. That found a real hole on the first run — see the attribute-name test below.
 */

const A3 = PAPER_SIZES.find((p) => p.name === "A3")!;

/** Payloads chosen to break out of a text node, an attribute value, and an attribute name respectively. */
const PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><script>alert(1)</script><x y="`,
  `" onload="alert(1)`,
  `';!--"<XSS>=&{()}`,
  `<img src=x onerror=alert(1)>`,
] as const;

function render(entity: DrawingEntity, name = "plan"): string {
  const drawing = makeDrawing({
    kind: "plan",
    name,
    entities: [entity],
    view: { kind: "plan" },
    provenance: { provider: "p", providerVersion: "0", durationMs: 0, incomplete: [], approximations: [] },
  });
  return toSvg(drawing, ARCHITECTURAL, fitToPaper(drawing, A3, 10)!, { interactive: true, border: true });
}

const line = (over: Partial<DrawingEntity> = {}): DrawingEntity => ({
  id: "e1",
  role: "cut",
  layer: "A-WALL",
  geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
  ...over,
});

/**
 * Parse the SVG and inspect the element tree.
 *
 * **Not a regex over the string**, and that distinction caught a false positive on the first run. `entity.id` with
 * the payload `" onload="alert(1)` renders as `id="&quot; onload=&quot;alert(1)"` — one attribute, correctly
 * escaped, entirely inert. A string check for `/\son\w+=/` flags it anyway, because the escaped text *contains*
 * those characters.
 *
 * Parsing asks the question that actually matters: after the browser has read this, what elements and attributes
 * exist? That is the same lesson as validating any instrument — a detector that reports danger where there is none
 * is a detector whose real findings get ignored.
 */
function executableIn(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror") !== null) return "malformed XML";

  for (const element of doc.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    if (tag === "script" || tag === "foreignobject" || tag === "img" || tag === "iframe" || tag === "use") {
      return `<${tag}>`;
    }
    for (const attr of element.attributes) {
      // An event handler as a real ATTRIBUTE, which is what would execute. Escaped text inside a value is inert.
      if (/^on/i.test(attr.name)) return `${tag}[${attr.name}]`;
      if (/^\s*javascript:/i.test(attr.value)) return `${tag}[${attr.name}] javascript: URL`;
    }
  }
  return null;
}

describe("hostile content cannot escape into the DOM", () => {
  it("escapes every string field a drawing carries", () => {
    for (const payload of PAYLOADS) {
      const cases: readonly [string, string][] = [
        ["entity.id", render(line({ id: payload }))],
        ["entity.layer", render(line({ layer: payload }))],
        ["entity.ifcClass", render(line({ ifcClass: payload }))],
        ["attrs value", render(line({ attrs: { swing: payload } }))],
        ["text content", render(line({ geometry: { kind: "text", at: { x: 1, y: 1 }, text: payload } }))],
        ["drawing.name", render(line(), payload)],
      ];
      for (const [field, svg] of cases) {
        const found = executableIn(svg);
        expect(found, `${field} with ${JSON.stringify(payload)} produced ${found}`).toBeNull();
      }
    }
  });

  it("sanitises attribute NAMES, which escaping cannot fix", () => {
    // The hole this file found. A previous version escaped only the value, so an `attrs` KEY carrying a quote
    // broke out and injected a new attribute: `{ 'x" onload="alert(1)': '1' }` rendered as
    // `data-x onload="alert(1)="1"`, which executes.
    //
    // Escaping is not available here — there is no escape syntax inside an attribute *name* — so the character
    // set is restricted instead. `attrs` is author-supplied by a `DrawingProvider`, and a custom provider is this
    // package's advertised extension point, so the data is not automatically trustworthy.
    for (const payload of PAYLOADS) {
      const svg = render(line({ attrs: { [payload]: "1" } }));
      expect(executableIn(svg), `an attrs key ${JSON.stringify(payload)} escaped`).toBeNull();
    }
  });

  it("drops a key that sanitises to nothing rather than emitting a bare data-", () => {
    const svg = render(line({ attrs: { "!!!": "1" } }));
    expect(svg).not.toContain('data-=""');
    expect(svg).not.toContain(" data-=");
  });

  it("holds for arbitrary strings, not just the payloads I thought of", () => {
    // The payload list is a guess about what an attacker would try. A property test is the part that does not
    // depend on my imagination.
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ minLength: 1, maxLength: 40 }), (a, b) => {
        const svg = render(line({ id: a, layer: b, ifcClass: a, attrs: { [b]: a } }));
        return executableIn(svg) === null;
      }),
      { numRuns: 500 },
    );
  });

  it("relies on asGuid to protect the guid field, which is worth knowing", () => {
    // There is deliberately no hostile-`guid` case above: `asGuid` REFUSES anything that is not 22 GlobalId
    // characters, so this field is protected by validation at the type boundary rather than by escaping at the
    // render site. Naming which control does the work matters — if `asGuid` ever loosened, this file would not
    // catch it, and that is the point of saying so here.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const core = require("@massing/core") as { asGuid: (s: string) => string };
      core.asGuid('"><script>alert(1)</script>');
    }).toThrow();
  });
});
