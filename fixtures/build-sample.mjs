/**
 * Generates `fixtures/sample.ifc` — a small, real, IFC4 building.
 *
 * ## Why this exists
 *
 * Every downstream thing needs a building-shaped IFC: the drawing bake-off, the walking-skeleton demo,
 * golden drawings, E2E, and the performance gates. There was not one available:
 *
 * - massing has **zero** committed `.frag` files and its Pages demo therefore shows no geometry at all.
 * - The 58 IFC files in massing's tree are **family/type libraries** — no geometry entities, no storeys.
 *   They exercise a parser and never reach a sectioner.
 * - Those files are also from `MassingCloud/massing-families`, whose license is "Other", so they cannot be
 *   committed here regardless (`docs/adr/0003-license-posture.md`).
 *
 * So the fixture is authored from scratch. That makes it unambiguously MIT, small enough to commit, and —
 * the part that matters — **it has known-correct expected values**, which a downloaded sample never does.
 * A golden test against a file whose right answer nobody knows is a snapshot, not a test.
 *
 * ## Why hand-written STEP rather than a library
 *
 * Writing IFC is something `LocalKernel` has to do anyway. Doing it here first, for a case simple enough to
 * verify by eye, is a cheap rehearsal of the hard part: getting the entity graph, the placements, and the
 * unit assignment right such that other tools agree with us.
 *
 * Geometry is `IfcExtrudedAreaSolid` over `IfcArbitraryClosedProfileDef`, not a faceted BREP. That is
 * deliberate: an extrusion is what push/pull edits and what `set_extrusion_depth` refuses to operate on when
 * absent, so the fixture exercises the representation the authoring tools actually care about.
 *
 * Openings are real `IfcOpeningElement` + `IfcRelVoidsElement`, so a plan cut through a door genuinely has
 * to resolve a void rather than being handed two pre-split walls.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Which fixture to emit. `node build-sample.mjs broken` writes `broken.ifc`.
 *
 * One script rather than two because every helper below — the GlobalId counter, the profile maths, the placement
 * graph — is shared, and a second copy would drift. The broken fixture is the *same building* plus three
 * deliberately unsectionable elements, which is what makes a digest diff between the two readable.
 */
const MODE = process.argv[2] === "broken" ? "broken" : "sample";
const OUT = join(dirname(fileURLToPath(import.meta.url)), `${MODE}.ifc`);

// ---------------------------------------------------------------------------------------------------
// GlobalId generation
// ---------------------------------------------------------------------------------------------------

/**
 * IFC GlobalIds are 22 characters of a base64 variant using `0-9 A-Z a-z _ $`.
 *
 * These are generated **deterministically from a counter**, not randomly. A fixture whose GlobalIds change
 * every time it is regenerated cannot be used for golden tests, cannot have expected values written down,
 * and produces a diff on every build. Determinism is the whole point.
 */
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
function guid(n) {
  // Spread the counter across the 22 characters so ids look plausible rather than "000...01",
  // while staying a pure function of n.
  let x = BigInt(n) * 0x9e3779b97f4a7c15n + 0x1234567890abcdefn;
  let out = "";
  for (let i = 0; i < 22; i++) {
    out += B64[Number(x & 63n)];
    x = (x >> 5n) ^ (x * 31n + BigInt(i));
    x &= (1n << 128n) - 1n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// STEP emitter
// ---------------------------------------------------------------------------------------------------

let nextId = 1;
const lines = [];
/** Emit one STEP entity, return its `#id` reference. */
function e(type, args) {
  const id = nextId++;
  lines.push(`#${id}= ${type}(${args});`);
  return `#${id}`;
}
const S = (s) => (s === null || s === undefined ? "$" : `'${String(s).replace(/'/g, "''")}'`);
const L = (arr) => `(${arr.join(",")})`;
const N = (v) => (v === null || v === undefined ? "$" : formatNum(v));
function formatNum(v) {
  // STEP reals must contain a '.' — `3` is an integer and some parsers reject it where a real is expected.
  if (!Number.isFinite(v)) throw new Error(`non-finite number in fixture: ${v}`);
  return Number.isInteger(v) ? `${v}.` : String(v);
}

// --- units, contexts, and the boilerplate every IFC file needs -------------------------------------

const OWNER = "$"; // IfcOwnerHistory is optional in IFC4; omitting it keeps the fixture minimal.

const dimExp = e("IFCDIMENSIONALEXPONENTS", "0,0,0,0,0,0,0");
const metre = e("IFCSIUNIT", "*,.LENGTHUNIT.,$,.METRE.");
const sqMetre = e("IFCSIUNIT", "*,.AREAUNIT.,$,.SQUARE_METRE.");
const cuMetre = e("IFCSIUNIT", "*,.VOLUMEUNIT.,$,.CUBIC_METRE.");
const radian = e("IFCSIUNIT", "*,.PLANEANGLEUNIT.,$,.RADIAN.");
const degreeConv = e(
  "IFCMEASUREWITHUNIT",
  `IFCPLANEANGLEMEASURE(0.0174532925199433),${radian}`,
);
const degree = e("IFCCONVERSIONBASEDUNIT", `${dimExp},.PLANEANGLEUNIT.,'DEGREE',${degreeConv}`);
const unitAssignment = e("IFCUNITASSIGNMENT", L([metre, sqMetre, cuMetre, degree]));

const origin = e("IFCCARTESIANPOINT", L([N(0), N(0), N(0)]));
const dirZ = e("IFCDIRECTION", L([N(0), N(0), N(1)]));
const axis3d = e("IFCAXIS2PLACEMENT3D", `${origin},$,$`);
const worldPlacement = e("IFCLOCALPLACEMENT", `$,${axis3d}`);

const trueNorth = e("IFCDIRECTION", L([N(0), N(1)]));
const geomContext = e(
  "IFCGEOMETRICREPRESENTATIONCONTEXT",
  `$,'Model',3,1.E-05,${axis3d},${trueNorth}`,
);
const bodyContext = e(
  "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
  `'Body','Model',*,*,*,*,${geomContext},$,.MODEL_VIEW.,$`,
);

// --- spatial hierarchy ------------------------------------------------------------------------------
//
// Project -> Site -> Building -> Storey -> elements. Getting this right is what makes a plan generator
// able to find a storey to cut at; the family libraries in massing have no storeys, which is exactly why
// they could not be used.

let gc = 1;
const project = e(
  "IFCPROJECT",
  `${S(guid(gc++))},${OWNER},'MassingViewer sample','A small single-storey building for tests and demos',$,$,$,${L([geomContext])},${unitAssignment}`,
);
const site = e("IFCSITE", `${S(guid(gc++))},${OWNER},'Site',$,$,${worldPlacement},$,$,.ELEMENT.,$,$,${N(0)},$,$`);
const building = e(
  "IFCBUILDING",
  `${S(guid(gc++))},${OWNER},'Building',$,$,${worldPlacement},$,$,.ELEMENT.,$,$,$`,
);
const storeyPlacementPt = e("IFCCARTESIANPOINT", L([N(0), N(0), N(0)]));
const storeyAxis = e("IFCAXIS2PLACEMENT3D", `${storeyPlacementPt},$,$`);
const storeyPlacement = e("IFCLOCALPLACEMENT", `${worldPlacement},${storeyAxis}`);
const storey = e(
  "IFCBUILDINGSTOREY",
  `${S(guid(gc++))},${OWNER},'Level 1',$,$,${storeyPlacement},$,$,.ELEMENT.,${N(0)}`,
);

// ---------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------

/** A closed 2D profile from XY points, extruded along +Z by `height`. */
function extrudedSolid(points2d, height, placementZ = 0) {
  const pts = points2d.map(([x, y]) => e("IFCCARTESIANPOINT", L([N(x), N(y)])));
  // IfcPolyline for a closed profile repeats the first point as the last.
  const poly = e("IFCPOLYLINE", L([...pts, pts[0]]));
  const profile = e("IFCARBITRARYCLOSEDPROFILEDEF", `.AREA.,$,${poly}`);
  const pos = placementZ === 0
    ? axis3d
    : e("IFCAXIS2PLACEMENT3D", `${e("IFCCARTESIANPOINT", L([N(0), N(0), N(placementZ)]))},$,$`);
  return e("IFCEXTRUDEDAREASOLID", `${profile},${pos},${dirZ},${N(height)}`);
}

function shapeRep(solid) {
  return e("IFCSHAPEREPRESENTATION", `${bodyContext},'Body','SweptSolid',${L([solid])}`);
}

function productShape(solid) {
  return e("IFCPRODUCTDEFINITIONSHAPE", `$,$,${L([shapeRep(solid)])}`);
}

function localPlacement(x, y, z, parent = storeyPlacement) {
  const p = e("IFCCARTESIANPOINT", L([N(x), N(y), N(z)]));
  const a = e("IFCAXIS2PLACEMENT3D", `${p},$,$`);
  return e("IFCLOCALPLACEMENT", `${parent},${a}`);
}

/** Rectangle centred on a wall axis from (x0,y0) to (x1,y1), given thickness. Plan coordinates. */
function wallProfile(x0, y0, x1, y1, thickness) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * (thickness / 2);
  const ny = (dx / len) * (thickness / 2);
  return [
    [x0 + nx, y0 + ny],
    [x1 + nx, y1 + ny],
    [x1 - nx, y1 - ny],
    [x0 - nx, y0 - ny],
  ];
}

// ---------------------------------------------------------------------------------------------------
// The building
// ---------------------------------------------------------------------------------------------------

const H = 3.0; // storey height
const T = 0.2; // wall thickness
const contained = [];
const expected = { walls: [], openings: [] };

function wall(name, x0, y0, x1, y1) {
  const solid = extrudedSolid(wallProfile(x0, y0, x1, y1, T), H);
  const g = guid(gc++);
  const w = e(
    "IFCWALL",
    `${S(g)},${OWNER},${S(name)},$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.SOLIDWALL.`,
  );
  contained.push(w);
  expected.walls.push({ name, guid: g, ref: w });
  return w;
}

/** A real void: IfcOpeningElement + IfcRelVoidsElement, so a cut has to resolve it. */
function opening(host, name, x0, y0, x1, y1, sill, head) {
  const solid = extrudedSolid(wallProfile(x0, y0, x1, y1, T + 0.05), head - sill, sill);
  const g = guid(gc++);
  const o = e(
    "IFCOPENINGELEMENT",
    `${S(g)},${OWNER},${S(name)},$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.OPENING.`,
  );
  e("IFCRELVOIDSELEMENT", `${S(guid(gc++))},${OWNER},$,$,${host},${o}`);
  expected.openings.push({ name, guid: g, sill, head });
  return o;
}

// Four walls enclosing 8 x 6 m.
const south = wall("Wall-South", 0, 0, 8, 0);
const north = wall("Wall-North", 0, 6, 8, 6);
wall("Wall-West", 0, 0, 0, 6);
wall("Wall-East", 8, 0, 8, 6);

// A door in the south wall (head 2.1) and a window in the north wall (sill 0.9, head 2.1). A plan cut at
// 1.2 m passes through both, so each of those walls must yield TWO loops.
opening(south, "Door-01", 3.0, 0, 3.9, 0, 0.0, 2.1);
opening(north, "Window-01", 2.0, 6, 3.5, 6, 0.9, 2.1);

// Slab entirely below the cut plane — the element a naive sectioner wrongly includes.
{
  const solid = extrudedSolid(
    [[-0.2, -0.2], [8.2, -0.2], [8.2, 6.2], [-0.2, 6.2]],
    0.2,
    -0.2,
  );
  const g = guid(gc++);
  const s = e(
    "IFCSLAB",
    `${S(g)},${OWNER},'Slab-Ground',$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.FLOOR.`,
  );
  contained.push(s);
  expected.slab = { guid: g };
}

// A 300 mm column mid-floor — a dot in plan, and the small feature most likely to be lost to tolerance.
{
  const solid = extrudedSolid([[3.85, 2.85], [4.15, 2.85], [4.15, 3.15], [3.85, 3.15]], H);
  const g = guid(gc++);
  const c = e(
    "IFCCOLUMN",
    `${S(g)},${OWNER},'Column-01',$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.COLUMN.`,
  );
  contained.push(c);
  expected.column = { guid: g };
}

/**
 * The broken fixture's whole reason to exist: elements a sectioner cannot handle.
 *
 * `DrawingProvenance.incomplete` is the Semantic Drawing Model's honesty feature — the field that makes a plan say
 * "I could not section this wall" instead of rendering perfectly with a wall missing, which is what massing's
 * plans do today. A feature with no failing input has never actually been exercised, so this supplies three
 * distinct failures rather than one:
 *
 * 1. **A degenerate profile** — two points, so the extrusion has no area. The commonest real-world corruption.
 * 2. **An element with no shape representation at all** — valid IFC, and a real occurrence in models exported
 *    from tools that write placeholders.
 * 3. **A zero-height extrusion** — a solid with no vertical extent.
 *
 * Each is authored as valid STEP. A file that failed to *parse* would test the parser, not the sectioner.
 *
 * **Measured outcome, which is not what was expected for all three.** 1 and 2 are dropped by the tessellator and
 * appear in `DrawingProvenance.incomplete`; that is the intended path and the golden digests show it. 3 tessellates
 * successfully into a flat mesh and is classified `below`, so it does *not* produce an incomplete entry. Written
 * down rather than quietly removed: a degenerate-but-drawable element is its own case, and a reader who assumed all
 * three fail would be looking for a bug that is not there.
 */
if (MODE === "broken") {
  // 1. Degenerate: a two-point profile cannot bound an area.
  {
    const solid = extrudedSolid([[1, 1], [2, 2]], H);
    const g = guid(gc++);
    const w = e(
      "IFCWALL",
      `${S(g)},${OWNER},'Wall-Degenerate',$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.SOLIDWALL.`,
    );
    contained.push(w);
    expected.broken = [...(expected.broken ?? []), { name: "Wall-Degenerate", guid: g, why: "profile has 2 points" }];
  }

  // 2. No representation. `$` where the shape belongs — legal, and it happens.
  {
    const g = guid(gc++);
    const w = e(
      "IFCWALL",
      `${S(g)},${OWNER},'Wall-NoShape',$,$,${localPlacement(0, 0, 0)},$,$,.SOLIDWALL.`,
    );
    contained.push(w);
    expected.broken = [...(expected.broken ?? []), { name: "Wall-NoShape", guid: g, why: "no shape representation" }];
  }

  // 3. Zero height: a cut plane has nothing to meet.
  {
    const solid = extrudedSolid([[5, 1], [6, 1], [6, 2], [5, 2]], 0);
    const g = guid(gc++);
    const s2 = e(
      "IFCSLAB",
      `${S(g)},${OWNER},'Slab-ZeroHeight',$,$,${localPlacement(0, 0, 0)},${productShape(solid)},$,.FLOOR.`,
    );
    contained.push(s2);
    expected.broken = [...(expected.broken ?? []), { name: "Slab-ZeroHeight", guid: g, why: "zero extrusion depth" }];
  }
}

// --- aggregation and containment --------------------------------------------------------------------

e("IFCRELAGGREGATES", `${S(guid(gc++))},${OWNER},$,$,${project},${L([site])}`);
e("IFCRELAGGREGATES", `${S(guid(gc++))},${OWNER},$,$,${site},${L([building])}`);
e("IFCRELAGGREGATES", `${S(guid(gc++))},${OWNER},$,$,${building},${L([storey])}`);
e(
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  `${S(guid(gc++))},${OWNER},$,$,${L(contained)},${storey}`,
);

// ---------------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------------

// A fixed timestamp, for the same reason the GlobalIds are deterministic: a fixture that differs on every
// regeneration cannot be golden-tested and dirties the diff.
const STAMP = "2026-08-06T00:00:00";

const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('${MODE}.ifc','${STAMP}',('MassingViewer'),('MassingCloud'),'fixtures/build-sample.mjs','MassingViewer','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;

const body = lines.join("\n");
writeFileSync(OUT, `${header}\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`, "utf8");

const bytes = Buffer.byteLength(`${header}\n${body}`, "utf8");
console.log(`wrote ${OUT}`);
console.log(`  ${nextId - 1} STEP entities, ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  walls: ${expected.walls.length}, openings: ${expected.openings.length}`);
console.log(`\nexpected values (these are what make it a fixture rather than a snapshot):`);
for (const w of expected.walls) console.log(`  ${w.name.padEnd(12)} ${w.guid}`);
for (const o of expected.openings) console.log(`  ${o.name.padEnd(12)} ${o.guid}  sill=${o.sill} head=${o.head}`);
console.log(`  Slab-Ground  ${expected.slab.guid}`);
console.log(`  Column-01    ${expected.column.guid}`);
for (const b of expected.broken ?? []) {
  console.log(`  ${b.name.padEnd(16)} ${b.guid}  UNSECTIONABLE: ${b.why}`);
}
