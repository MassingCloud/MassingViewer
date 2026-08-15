// @vitest-environment node
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatePlan, type ElementMesh } from "@massing/drawings2d";
import { toGuid, type Guid } from "@massing/core";
import { tessellate } from "@massing/tessellate";
import { FEDERATED, SCALES, generate, type ScaleSpec } from "./scale.js";

/**
 * The scale benchmark — the roadmap item that gates the Rust decision.
 *
 * The plan defers a Rust core until *"a scale fixture proves the TypeScript parser is the ceiling"*, and until now
 * nothing measured it: the two committed fixtures are deliberately tiny, and `scripts/perf-drawings.mjs` builds meshes
 * by hand so it measures the **sectioner** rather than the pipeline. This measures parse → tessellate → section, end
 * to end, on generated buildings an order of magnitude apart.
 *
 * ## It reports; it does not gate
 *
 * Run with `SCALE=1`. Without it these appear as skipped, the same posture as Tier-3 rasterisation — a measurement
 * that leaves no trace in the per-PR output is one people forget exists.
 *
 * Not a budget, deliberately. `perf/README.md` already says the existing budgets are *"developer-machine
 * measurements times three, and three is a guess"*; adding four more guessed numbers would be four more gates nobody
 * trusts. What this produces is a **table and a per-element cost**, which is the thing a Rust decision can actually
 * be made from — and the shape of the curve, which is what catches an accidental O(n²) that every absolute number
 * stays inside its band for.
 *
 * ## The one thing it does assert
 *
 * That the pipeline **completes and produces geometry** at every size. A parser that silently drops elements above
 * some entity count, or a sectioner that returns nothing on a large model, is a correctness bug that a timing table
 * would happily report as very fast.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENABLED = process.env.SCALE !== undefined && process.env.SCALE !== "" && process.env.SCALE !== "0";

interface Measurement {
  readonly name: string;
  readonly bytes: number;
  readonly declared: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly parseMs: number;
  readonly cutMs: number;
  readonly cutEntities: number;
}

const results: Measurement[] = [];

function measure(spec: ScaleSpec): Measurement {
  const generated = generate(spec);

  const started = performance.now();
  const { meshes, guids } = tessellate(generated.ifc);
  const parseMs = performance.now() - started;

  const pascal = (upper: string): string =>
    /^IFC./.test(upper) ? `Ifc${upper.charAt(3)}${upper.slice(4).toLowerCase()}` : upper;
  const mapped: ElementMesh[] = meshes.map((m) => ({
    guid: toGuid(guids.get(m.expressId)),
    ifcClass: pascal(m.ifcType ?? "IFCPRODUCT"),
    positions: m.positions,
    indices: m.indices,
  }));

  // Cut mid-storey rather than at a datum: the coplanar nudge is a correctness feature, not something a perf number
  // should be measuring the cost of.
  const cutStarted = performance.now();
  const drawing = generatePlan({ name: spec.name, meshes: mapped, skipped: [] }, { kind: "plan", cutHeight: 1.7 });
  const cutMs = performance.now() - cutStarted;

  const triangles = meshes.reduce((n, m) => n + (m.indices?.length ?? m.positions.length / 3) / 3, 0);

  return {
    name: spec.name,
    bytes: generated.bytes,
    declared: generated.elements,
    meshes: meshes.length,
    triangles: Math.round(triangles),
    parseMs: Math.round(parseMs),
    cutMs: Math.round(cutMs),
    cutEntities: drawing.entities.filter((e) => e.role === "cut").length,
  };
}

describe.runIf(ENABLED)("scale", () => {
  for (const spec of SCALES) {
    it(
      `${spec.name} — ${spec.storeys} storeys, ${spec.bays}x${spec.bays} bays`,
      { timeout: 600_000 },
      () => {
        const m = measure(spec);
        results.push(m);

        // The correctness floor. A timing table cannot tell "fast" from "silently did nothing".
        expect(m.meshes, `${spec.name}: nothing tessellated`).toBeGreaterThan(0);
        expect(m.cutEntities, `${spec.name}: the plan is empty, so the timing means nothing`).toBeGreaterThan(0);
        // Every declared product should tessellate: these buildings contain only geometry the tessellator supports,
        // so a shortfall is the parser dropping elements rather than the fixture being exotic.
        expect(m.meshes, `${spec.name}: ${m.declared - m.meshes} declared products did not tessellate`).toBe(
          m.declared,
        );
      },
    );
  }

  /**
   * The federated case, which every number above is blind to.
   *
   * The roadmap listed *"small / medium / large / federated"*; what shipped substituted `xlarge`, so until
   * 2026-08-15 every scale measurement here was for a single model — while federation ships with per-model GUID
   * resolution, per-model visibility, and a selection path that has to stay correct when two files share an
   * expressID. A second model is not "the same work twice": the costs that appear are the *per-model* ones, and
   * they are invisible at one model by construction.
   *
   * Two buildings of the same size, so their expressIDs collide **completely** — the realistic shape of a
   * federated project, and the hazard `ElementRef` exists for. Different GlobalIds, because IFC4 requires it and
   * because a fixture with colliding GUIDs would be measuring a corrupt project instead.
   */
  it(
    "federated — two models whose expressIDs collide entirely",
    { timeout: 600_000 },
    () => {
      const models = FEDERATED.map((spec) => {
        const generated = generate(spec);
        const started = performance.now();
        const { meshes, guids } = tessellate(generated.ifc);
        return { spec, generated, meshes, guids, parseMs: performance.now() - started };
      });

      // The fixture has to actually exercise the hazard, or this measures two unrelated buildings and says
      // nothing. Asserted rather than assumed: if the generator ever numbered documents differently, this test
      // would keep passing while testing the easy case.
      const idsA = new Set(models[0]!.meshes.map((m) => m.expressId));
      const shared = models[1]!.meshes.filter((m) => idsA.has(m.expressId)).length;
      expect(shared, "the two models share no expressID, so this is not a federated fixture").toBe(
        models[1]!.meshes.length,
      );

      // And their GlobalIds must not collide, which is the other half of the same claim.
      const allGuids = models.flatMap((m) => [...m.guids.values()]);
      expect(new Set(allGuids).size, "the two models share GlobalIds, which IFC4 forbids").toBe(allGuids.length);

      /**
       * Sectioning the federation: one drawing over both models' geometry.
       *
       * This is where a single-model benchmark's blindness costs something real. `generatePlan` keys entities by
       * GlobalId, so a federated cut is only correct if identity survived the merge — and it is only *fast* if
       * nothing in the path is quadratic in models.
       */
      const pascal = (upper: string): string =>
        /^IFC./.test(upper) ? `Ifc${upper.charAt(3)}${upper.slice(4).toLowerCase()}` : upper;
      const mapped: ElementMesh[] = models.flatMap((m) =>
        m.meshes.map((mesh) => ({
          guid: toGuid(m.guids.get(mesh.expressId)),
          ifcClass: pascal(mesh.ifcType ?? "IFCPRODUCT"),
          positions: mesh.positions,
          indices: mesh.indices,
        })),
      );

      const cutStarted = performance.now();
      const drawing = generatePlan({ name: "federated", meshes: mapped, skipped: [] }, { kind: "plan", cutHeight: 1.7 });
      const cutMs = performance.now() - cutStarted;

      const cut = drawing.entities.filter((e) => e.role === "cut");
      expect(cut.length, "the federated plan is empty, so the timing means nothing").toBeGreaterThan(0);

      /**
       * Both models reached the drawing — the assertion a single-model run cannot make.
       *
       * The failure this catches is the one federation is most likely to produce: a merge keyed by expressID
       * rather than by GlobalId silently keeps one model's element per colliding id and drops the other's. The
       * plan would render, look plausible, and be missing an entire consultant's building.
       */
      const drawn = new Set(cut.map((e) => e.guid).filter(Boolean));
      for (const [index, model] of models.entries()) {
        const own = [...model.guids.values()].filter((g) => drawn.has(g as Guid)).length;
        expect(own, `model ${index} contributed no cut geometry to the federated plan`).toBeGreaterThan(0);
      }

      const totalMeshes = models.reduce((n, m) => n + m.meshes.length, 0);
      results.push({
        name: "federated (2 models)",
        bytes: models.reduce((n, m) => n + m.generated.bytes, 0),
        declared: models.reduce((n, m) => n + m.generated.elements, 0),
        meshes: totalMeshes,
        triangles: Math.round(
          models.reduce(
            (n, m) => n + m.meshes.reduce((t, mesh) => t + (mesh.indices?.length ?? mesh.positions.length / 3) / 3, 0),
            0,
          ),
        ),
        parseMs: Math.round(models.reduce((n, m) => n + m.parseMs, 0)),
        cutMs: Math.round(cutMs),
        cutEntities: cut.length,
      });
    },
  );

  it("writes the table, and the per-element cost that a Rust decision needs", () => {
    // Sorted by size so the curve reads in order regardless of which test finished first.
    const rows = [...results].sort((a, b) => a.declared - b.declared);
    const lines = [
      "| case | IFC | products | meshes | triangles | parse ms | µs/element | cut ms | µs/mesh |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r) =>
        [
          r.name,
          `${(r.bytes / 1_048_576).toFixed(2)} MB`,
          r.declared,
          r.meshes,
          r.triangles.toLocaleString("en-GB"),
          r.parseMs,
          Math.round((r.parseMs * 1000) / Math.max(r.declared, 1)),
          r.cutMs,
          Math.round((r.cutMs * 1000) / Math.max(r.meshes, 1)),
        ].join(" | ").replace(/^/, "| ").concat(" |"),
      ),
    ];

    /**
     * Per-element cost is the number that matters, not the total.
     *
     * A total says a big model takes longer, which is not information. Cost *per element* holding roughly steady
     * across an order of magnitude says the pipeline is linear; rising sharply says it is not, and that is the
     * finding that would justify a Rust core — or remove the argument for one.
     */
    const dir = join(HERE, "..", "perf");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scale-report.md"), `${lines.join("\n")}\n`, "utf8");
    for (const line of lines) console.log(line);

    /**
     * Every case reached the table, named rather than counted.
     *
     * This was `rows.length === SCALES.length`, which is a completeness guard and a fragile one: adding the
     * federated case made it fail with "expected 5 to be 4", which is a true statement about a count and tells
     * the reader nothing about what is missing. Naming them means a case that silently stopped producing a row
     * fails with *which* case, and adding one is an intentional edit here rather than a number to bump.
     */
    const named = new Set(rows.map((r) => r.name));
    for (const spec of SCALES) {
      expect(named, `the ${spec.name} case produced no row`).toContain(spec.name);
    }
    expect(
      [...named].some((n) => n.startsWith("federated")),
      "the federated case produced no row, so every number in this table is single-model again",
    ).toBe(true);
  });
});

/**
 * A generator test that runs on **every** PR, unlike the measurements above.
 *
 * The generator is the thing the benchmark's trustworthiness rests on: if it emitted subtly invalid STEP, or a
 * different building each time, every number above would be noise and the table would still look authoritative.
 */
describe("the scale generator", () => {
  it("is deterministic, so a trend compares like with like", () => {
    const a = generate({ name: "t", storeys: 1, bays: 1 });
    const b = generate({ name: "t", storeys: 1, bays: 1 });
    expect(a.ifc).toBe(b.ifc);
  });

  it("grows with the spec, in both directions", () => {
    const base = generate({ name: "t", storeys: 1, bays: 1 });
    expect(generate({ name: "t", storeys: 2, bays: 1 }).elements).toBeGreaterThan(base.elements);
    expect(generate({ name: "t", storeys: 1, bays: 2 }).elements).toBeGreaterThan(base.elements);
  });

  it("emits IFC our own tessellator fully accepts, which is the point of the shape it uses", () => {
    // If the generator produced geometry the tessellator refuses, the benchmark would time the refusal path and
    // report it as excellent throughput.
    const { ifc, elements } = generate({ name: "t", storeys: 1, bays: 2 });
    const { meshes, skipped } = tessellate(ifc);
    expect(skipped, `the generator emitted geometry the tessellator refuses: ${skipped[0]?.reason ?? ""}`).toEqual([]);
    expect(meshes).toHaveLength(elements);
  });

  it("gives every element a distinct GlobalId", () => {
    // A duplicate would collapse elements in any guid-keyed map downstream, quietly shrinking the model the
    // benchmark thinks it is measuring.
    const { ifc, elements } = generate({ name: "t", storeys: 2, bays: 2 });
    const { guids } = tessellate(ifc);
    expect(new Set([...guids.values()]).size).toBe(elements);
  });

  it("produces a plan with cut geometry at a mid-storey height", () => {
    const { ifc } = generate({ name: "t", storeys: 1, bays: 2 });
    const { meshes, guids } = tessellate(ifc);
    const mapped: ElementMesh[] = meshes.map((m) => ({
      guid: toGuid(guids.get(m.expressId)) as Guid,
      ifcClass: "IfcWall",
      positions: m.positions,
      indices: m.indices,
    }));
    const drawing = generatePlan({ name: "t", meshes: mapped, skipped: [] }, { kind: "plan", cutHeight: 1.7 });
    expect(drawing.entities.filter((e) => e.role === "cut").length).toBeGreaterThan(0);
  });
});
