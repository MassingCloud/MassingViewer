/**
 * IFC at scale, generated rather than committed.
 *
 * The roadmap's benchmark item, and the gate on the Rust decision: *"no measurement yet shows the TypeScript parser
 * is the ceiling"*. This produces buildings of a chosen size in memory, through the same STEP text the real parser
 * reads, so the number measured is the number a user experiences.
 *
 * ## Why generated and never committed
 *
 * The plan already ruled on it: a 240 MB IFC *"cannot be committed to a public repository"*, and a golden digest of
 * one would be *"tens of megabytes of text no reviewer will ever read"*. Generation costs a few hundred milliseconds
 * and gives an exact, reproducible size — and it means the large case can grow without a repository growing with it.
 *
 * ## Why this is not `build-sample.mjs` with a size argument
 *
 * `fixtures/build-sample.mjs` is under the fixture gate, which asserts `sample.ifc` and `broken.ifc` regenerate
 * **byte-identically**. Threading a scale parameter through it would put a perf knob inside a file whose whole job is
 * to be reproducible, and one careless default would break a gate that has nothing to do with performance.
 *
 * A deliberate simplification: these buildings have no openings and no property sets. They exist to scale
 * *geometry* — element count, triangle count, section work. `sample.ifc` is the fixture that carries semantic
 * richness, and it is small on purpose.
 */

/** STEP entity numbering, per document. */
interface Emitter {
  readonly lines: string[];
  next: number;
}

const N = (v: number): string => (Number.isInteger(v) ? `${v}.` : String(v));
const L = (parts: readonly string[]): string => `(${parts.join(",")})`;
const S = (text: string): string => `'${text.replace(/'/g, "''")}'`;

function emit(out: Emitter, type: string, args: string): string {
  const id = `#${out.next++}`;
  out.lines.push(`${id}=${type}(${args});`);
  return id;
}

/**
 * A GlobalId that is a pure function of its index.
 *
 * Deterministic so a regenerated building at the same size is the same building — which is what makes a perf trend
 * comparable across runs rather than a measurement of two different models.
 */
function guid(n: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  let value = n + 1;
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = alphabet[value % 64]! + out;
    value = Math.floor(value / 64) + 7 * (i + 1);
  }
  return out.slice(0, 22);
}

export interface ScaleSpec {
  readonly name: string;
  /** Storeys. Each adds a full floor plate and a ring of walls. */
  readonly storeys: number;
  /** Bays in each direction. Bays² columns and roughly 2·bays·(bays+1) partition walls per storey. */
  readonly bays: number;
}

/**
 * The four sizes, chosen so each answers a different question.
 *
 * Deliberately not a smooth curve: what a benchmark needs is a *small* case that isolates fixed costs, two cases an
 * order of magnitude apart to expose non-linearity, and one large enough that an O(n²) cannot hide.
 */
export const SCALES: readonly ScaleSpec[] = [
  { name: "small", storeys: 1, bays: 2 },
  { name: "medium", storeys: 4, bays: 4 },
  { name: "large", storeys: 10, bays: 6 },
  { name: "xlarge", storeys: 20, bays: 8 },
];

export interface Generated {
  readonly ifc: string;
  readonly elements: number;
  readonly bytes: number;
}

/**
 * Build an IFC of the given size.
 *
 * The entity shape mirrors what the tessellator actually requires — `IfcExtrudedAreaSolid` over
 * `IfcArbitraryClosedProfileDef` — because `broken.ifc` exists to prove that anything else is *reported* rather than
 * drawn, and a perf fixture full of unsupported geometry would measure the refusal path instead of the work.
 */
export function generate(spec: ScaleSpec): Generated {
  const out: Emitter = { lines: [], next: 1 };
  let guidIndex = 0;

  const owner = "$";
  const origin = emit(out, "IFCCARTESIANPOINT", L([N(0), N(0), N(0)]));
  const axis = emit(out, "IFCAXIS2PLACEMENT3D", `${origin},$,$`);
  const dirZ = emit(out, "IFCDIRECTION", L([N(0), N(0), N(1)]));
  const worldPlacement = emit(out, "IFCLOCALPLACEMENT", `$,${axis}`);
  const context = emit(
    out,
    "IFCGEOMETRICREPRESENTATIONCONTEXT",
    `$,'Model',3,1.E-05,${axis},$`,
  );
  const bodyContext = emit(
    out,
    "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
    `'Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$`,
  );

  const products: string[] = [];
  const BAY = 6; // metres between grid lines
  const H = 3.4; // storey height
  const T = 0.2; // wall thickness

  const solid = (points: readonly (readonly [number, number])[], height: number, z: number): string => {
    const ids = points.map(([x, y]) => emit(out, "IFCCARTESIANPOINT", L([N(x), N(y)])));
    // A closed IfcPolyline repeats its first point as its last.
    const poly = emit(out, "IFCPOLYLINE", L([...ids, ids[0]!]));
    const profile = emit(out, "IFCARBITRARYCLOSEDPROFILEDEF", `.AREA.,$,${poly}`);
    const at =
      z === 0
        ? axis
        : emit(
            out,
            "IFCAXIS2PLACEMENT3D",
            `${emit(out, "IFCCARTESIANPOINT", L([N(0), N(0), N(z)]))},$,$`,
          );
    return emit(out, "IFCEXTRUDEDAREASOLID", `${profile},${at},${dirZ},${N(height)}`);
  };

  const shape = (s: string): string => {
    const rep = emit(out, "IFCSHAPEREPRESENTATION", `${bodyContext},'Body','SweptSolid',${L([s])}`);
    return emit(out, "IFCPRODUCTDEFINITIONSHAPE", `$,$,${L([rep])}`);
  };

  const product = (type: string, name: string, s: string, extra: string): void => {
    const id = emit(
      out,
      type,
      `${S(guid(guidIndex++))},${owner},${S(name)},$,$,${worldPlacement},${shape(s)},$${extra}`,
    );
    products.push(id);
  };

  const span = spec.bays * BAY;

  for (let storey = 0; storey < spec.storeys; storey++) {
    const z = storey * H;

    // One floor plate per storey.
    product(
      "IFCSLAB",
      `Slab L${storey}`,
      solid(
        [
          [0, 0],
          [span, 0],
          [span, span],
          [0, span],
        ],
        0.3,
        z,
      ),
      ",.FLOOR.",
    );

    // Partition walls on every grid line, both directions.
    for (let i = 0; i <= spec.bays; i++) {
      const at = i * BAY;
      product(
        "IFCWALL",
        `Wall X${i} L${storey}`,
        solid(
          [
            [0, at - T / 2],
            [span, at - T / 2],
            [span, at + T / 2],
            [0, at + T / 2],
          ],
          H,
          z,
        ),
        ",.SOLIDWALL.",
      );
      product(
        "IFCWALL",
        `Wall Y${i} L${storey}`,
        solid(
          [
            [at - T / 2, 0],
            [at + T / 2, 0],
            [at + T / 2, span],
            [at - T / 2, span],
          ],
          H,
          z,
        ),
        ",.SOLIDWALL.",
      );
    }

    // A column at every grid intersection.
    for (let x = 0; x <= spec.bays; x++) {
      for (let y = 0; y <= spec.bays; y++) {
        const cx = x * BAY;
        const cy = y * BAY;
        product(
          "IFCCOLUMN",
          `Col ${x}-${y} L${storey}`,
          solid(
            [
              [cx - 0.2, cy - 0.2],
              [cx + 0.2, cy - 0.2],
              [cx + 0.2, cy + 0.2],
              [cx - 0.2, cy + 0.2],
            ],
            H,
            z,
          ),
          ",.COLUMN.",
        );
      }
    }
  }

  const header = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`,
    `FILE_NAME('${spec.name}.ifc','2026-01-01T00:00:00',(''),(''),'MassingViewer scale generator','','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
  ].join("\n");

  const ifc = `${header}\n${out.lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`;
  return { ifc, elements: products.length, bytes: ifc.length };
}
