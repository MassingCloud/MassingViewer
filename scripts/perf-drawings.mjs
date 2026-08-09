/**
 * Drawing-generation performance, with a tolerance band and a committed trend.
 *
 * ## Why the band is wide and the trend is committed
 *
 * The plan is explicit about the failure mode: *"p95 frame time with a 20% tolerance band + committed trend JSON
 * (a tight gate on noisy runners trains people to ignore it)."* A GitHub runner's throughput varies by more than
 * a factor of two between a cold and a warm machine, so a 5% gate fails on infrastructure and teaches everyone to
 * re-run it — and a gate that gets re-run reflexively is no longer a gate. That is risk #11 again.
 *
 * So: a generous band catches *regressions of a kind* (an accidental O(n²), a per-element allocation), and the
 * committed trend catches slow drift that no single run would ever trip.
 *
 * ## Why the model is synthesised rather than a committed fixture
 *
 * The plan asks for a 240 MB tower among the bake-off fixtures. A file that size cannot go in a public repository,
 * and a golden digest of it would be unreadable — which is why `fixtures/golden.test.ts` deliberately stops at two
 * fixtures and points here for scale. Generating the geometry is better anyway: the size is a parameter, so the
 * scaling *curve* is measurable, and a quadratic shows up as a shape rather than as one number being large.
 *
 * ## Why this runs in Node with no browser
 *
 * `generatePlan` is a pure function of meshes and a view — no DOM, no GPU, no network. Measuring it through a
 * browser would add SwiftShader's variance to a number that has nothing to do with rendering. Frame time is a
 * separate measurement and belongs in a browser; this one does not.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS = join(ROOT, "perf", "budgets.json");
const TREND = join(ROOT, "perf", "trend.jsonl");

const { generatePlan } = await import(`file://${join(ROOT, "packages/drawings2d/dist/index.js")}`);

/**
 * A deterministic box mesh. Triangle soup, Y-up, metres — the shape `ElementMesh` documents.
 *
 * Hand-built rather than tessellated from IFC on purpose: this measures the *sectioner*, and threading a parser
 * into the measurement would make a parser regression look like a drawing regression.
 */
function box(x0, y0, z0, x1, y1, z1) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 5, 1], [0, 4, 5], [2, 6, 7], [2, 7, 3],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  return new Float32Array(faces.flatMap(([a, b, c]) => [...v[a], ...v[b], ...v[c]]));
}

/** 22 characters from IFC's GlobalId alphabet, from a counter. Deterministic, so runs are comparable. */
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
function guid(n) {
  let out = "";
  for (let i = 0; i < 22; i++) out += B64[(n + i * 7) % 64];
  return out;
}

/**
 * A tower of `storeys` floors, each a grid of `perFloor` walls.
 *
 * Every wall crosses its own storey's cut plane, so a plan at any level sections a full floor and skips the rest —
 * which is the realistic case. A model where everything intersects would measure a situation that never happens.
 */
function tower(storeys, perFloor) {
  const meshes = [];
  const storeyHeight = 3;
  let n = 0;
  for (let s = 0; s < storeys; s++) {
    const z0 = s * storeyHeight;
    for (let i = 0; i < perFloor; i++) {
      const x = (i % 20) * 4;
      const y = Math.floor(i / 20) * 4;
      meshes.push({
        guid: guid(n++),
        ifcClass: i % 7 === 0 ? "IfcColumn" : "IfcWall",
        positions: box(x, z0, y, x + 3.8, z0 + storeyHeight, y + 0.2),
      });
    }
  }
  return { name: `tower-${storeys}x${perFloor}`, meshes };
}

/** p-th percentile of a sorted-on-demand sample, nearest-rank. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Time one case.
 *
 * Warm-ups are discarded, and that is not padding: the first call through a hot path pays JIT compilation, and on a
 * small case that cost dominates the number entirely — making the *fast* cases look slow and inverting the scaling
 * curve this whole script exists to show.
 */
function measure(input, view, runs) {
  for (let i = 0; i < 3; i++) generatePlan(input, view);
  const durations = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const drawing = generatePlan(input, view);
    durations.push(performance.now() - t0);
    // Read something off the result so a future optimiser cannot dead-code the call away.
    if (drawing.entities.length < 0) throw new Error("unreachable");
  }
  return durations;
}

/**
 * The cases, in two families, and the split is the whole reason the scaling check means anything.
 *
 * **`tower-*`** are realistic: a plan sections one floor and rejects the rest on a vertical-extent test. That is
 * what the product does, so it is what the absolute budgets are set against.
 *
 * **`floor-*`** are single-storey, so **every** mesh crosses the cut plane and every one is actually sectioned.
 * These exist because the first version of this script compared per-mesh cost between `small` (40 meshes) and
 * `large` (10 000 meshes across 20 storeys) and concluded scaling was excellent — 26 µs/mesh down to 1 µs/mesh.
 * That comparison was meaningless: the small number was dominated by JIT warm-up and the large one by cheap
 * rejections, so the ratio measured the mix of the workload rather than the cost of the work. A quadratic
 * sectioner would have sailed through it.
 *
 * The scaling check now compares `floor-small` against `floor-large`, where the only difference is how many
 * elements get sectioned.
 */
const CASES = [
  { id: "small", storeys: 1, perFloor: 40, runs: 20 },
  { id: "medium", storeys: 5, perFloor: 200, runs: 10 },
  { id: "large", storeys: 20, perFloor: 500, runs: 5 },
  { id: "floor-small", storeys: 1, perFloor: 200, runs: 20 },
  { id: "floor-large", storeys: 1, perFloor: 5000, runs: 5 },
];

const view = { kind: "plan", cutHeight: 1.2 };
const results = [];

for (const c of CASES) {
  const input = tower(c.storeys, c.perFloor);
  const durations = measure(input, view, c.runs);
  const drawing = generatePlan(input, view);
  results.push({
    id: c.id,
    meshes: input.meshes.length,
    entities: drawing.entities.length,
    p50: Math.round(percentile(durations, 50) * 100) / 100,
    p95: Math.round(percentile(durations, 95) * 100) / 100,
    perMeshUs: Math.round((percentile(durations, 50) / input.meshes.length) * 1000),
  });
}

// --- budgets --------------------------------------------------------------------------------------
if (!existsSync(dirname(BUDGETS))) mkdirSync(dirname(BUDGETS), { recursive: true });

/**
 * The band is ±20% on the *committed* budget, and only the upper bound fails.
 *
 * A run faster than the budget is good news, not a failure — a "you got faster, update the number" gate is the
 * single most reliable way to teach people to pass `--update`. It is reported instead, so the budget can be
 * lowered deliberately in a reviewed diff.
 */
const TOLERANCE = 1.2;
const budgets = existsSync(BUDGETS) ? JSON.parse(readFileSync(BUDGETS, "utf8")) : {};
const problems = [];
const notes = [];

for (const r of results) {
  const budget = budgets[r.id];
  if (budget === undefined) {
    notes.push(`${r.id}: no budget — measured p95 ${r.p95} ms. Add it to perf/budgets.json.`);
    continue;
  }
  const ceiling = budget.p95Ms * TOLERANCE;
  if (r.p95 > ceiling) {
    problems.push(
      `${r.id}: p95 ${r.p95} ms exceeds ${budget.p95Ms} ms +20% (${ceiling.toFixed(1)} ms). ` +
        `${r.meshes} meshes, ${r.perMeshUs} µs each — compare against the trend before assuming it is the runner.`,
    );
  } else if (r.p95 < budget.p95Ms * 0.5 && budget.baselined === true) {
    // Only once the budget is a real CI measurement. While every number carries a placeholder runner multiplier,
    // this note fires on all five cases for a reason already written down — and five notes that are always there
    // are five notes nobody reads, which is how the one that matters gets missed.
    notes.push(`${r.id}: p95 ${r.p95} ms is less than half its ${budget.p95Ms} ms budget — consider lowering it.`);
  }
}

/**
 * Superlinearity, which no single budget can express.
 *
 * Compared between the two `floor-*` cases, where every mesh is genuinely sectioned in both — so per-mesh cost is
 * comparing like with like, and 25× the elements should cost roughly 25× the time. If it climbs, something is
 * quadratic, and that is a *shape* rather than a threshold: the absolute numbers can stay comfortably inside every
 * budget while the curve bends. The plan names this class of bug directly (Manifold's serial execution halting the
 * event loop), and a per-case budget cannot see it.
 *
 * 2.5× rather than 4×: with a like-for-like comparison the honest headroom is much smaller, and a threshold set
 * loose enough to never fire is decoration.
 */
const floorSmall = results.find((r) => r.id === "floor-small");
const floorLarge = results.find((r) => r.id === "floor-large");
if (floorSmall && floorLarge && floorLarge.perMeshUs > floorSmall.perMeshUs * 2.5) {
  problems.push(
    `per-mesh cost grew ${(floorLarge.perMeshUs / floorSmall.perMeshUs).toFixed(1)}x from ` +
      `${floorSmall.meshes} to ${floorLarge.meshes} sectioned meshes ` +
      `(${floorSmall.perMeshUs} → ${floorLarge.perMeshUs} µs). That is superlinear scaling, not runner noise.`,
  );
}

// --- trend ----------------------------------------------------------------------------------------
// Appended, never rewritten, and committed. A trend that lives only in a CI artifact is a trend nobody can read
// six months later, which is when slow drift becomes visible.
if (process.env.PERF_TREND === "append") {
  const stamp = process.env.PERF_STAMP ?? "unstamped";
  const line = JSON.stringify({ commit: process.env.GITHUB_SHA ?? "local", at: stamp, results });
  writeFileSync(TREND, (existsSync(TREND) ? readFileSync(TREND, "utf8") : "") + line + "\n", "utf8");
}

console.log("Drawing generation:");
for (const r of results) {
  console.log(
    `  ${r.id.padEnd(7)} ${String(r.meshes).padStart(6)} meshes  ` +
      `p50 ${String(r.p50).padStart(8)} ms  p95 ${String(r.p95).padStart(8)} ms  ${String(r.perMeshUs).padStart(5)} µs/mesh` +
      `  → ${r.entities} entities`,
  );
}
for (const n of notes) console.log(`  note: ${n}`);

if (problems.length > 0) {
  console.error(`\nPerf gate failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("Perf gate passed (p95 within budget +20%, scaling not superlinear).");
