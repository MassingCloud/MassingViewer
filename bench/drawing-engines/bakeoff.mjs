import { performance } from "node:perf_hooks";
import { smallBuilding, tiled, triangleCount } from "./fixture.mjs";
import { generatePlan as ownPlan } from "./own-sectioner.mjs";
const { generateFloorPlan } = await import("@ifc-lite/drawing-2d");

const CUT = 1.2;
const opts = { includeHiddenLines: true, includeProjection: true, includeEdges: true, mergeLines: true, useGPU: false };

const score = (name, d, meshes, ms) => {
  const lines = d.lines ?? [];
  const polys = d.cutPolygons ?? [];
  const withId = lines.filter(l => Number.isFinite(l.entityId) && l.entityId > 0).length;
  const perEl = {};
  for (const p of polys) perEl[p.entityId] = (perEl[p.entityId]||0)+1;
  const ids = meshes.map(m=>m.expressId);
  const [south, north, west, east, slab, col] = ids;
  const cats = {};
  for (const l of lines) cats[l.category]=(cats[l.category]||0)+1;
  return {
    name, ms: +ms.toFixed(1), lines: lines.length, cutPolys: polys.length,
    guidCoverage: lines.length ? +(withId/lines.length).toFixed(3) : 0,
    cats,
    doorSplit: (perEl[south]??0) === 2,
    windowSplit: (perEl[north]??0) === 2,
    solidWalls: (perEl[west]??0) === 1 && (perEl[east]??0) === 1,
    slabExcluded: (perEl[slab]??0) === 0,
    column: (perEl[col]??0) === 1,
    typesPreserved: new Set(lines.map(l=>l.ifcType)).size,
  };
};

console.log("=".repeat(96));
console.log("ADR-0004 BAKE-OFF — identical MeshData[] into both engines, plan cut at 1.2 m");
console.log("=".repeat(96));

const meshes = smallBuilding();
console.log(`\nfixture: ${meshes.length} meshes, ${triangleCount(meshes)} triangles\n`);

let t0 = performance.now();
const a = await generateFloorPlan(meshes, CUT, opts);
const sa = score("@ifc-lite/drawing-2d", a, meshes, performance.now()-t0);

t0 = performance.now();
const b = ownPlan(meshes, CUT);
const sb = score("own TS sectioner", b, meshes, performance.now()-t0);

const rows = [sa, sb];
const check = v => v ? "PASS" : "FAIL";
console.log("CORRECTNESS (architectural cases that decide whether a plan is usable)");
console.log("  " + "criterion".padEnd(46) + "ifc-lite".padEnd(14) + "own");
const crit = [
  ["door in cut band -> wall splits into 2 loops", "doorSplit"],
  ["window in cut band -> wall splits into 2 loops", "windowSplit"],
  ["solid walls -> exactly 1 loop each", "solidWalls"],
  ["slab entirely below cut -> 0 cut loops", "slabExcluded"],
  ["column -> 1 loop", "column"],
];
for (const [label, k] of crit) console.log("  " + label.padEnd(46) + check(sa[k]).padEnd(14) + check(sb[k]));
console.log("  " + "identity coverage (pass/fail criterion)".padEnd(46) + `${(sa.guidCoverage*100).toFixed(1)}%`.padEnd(14) + `${(sb.guidCoverage*100).toFixed(1)}%`);
console.log("  " + "ifcType preserved".padEnd(46) + `${sa.typesPreserved} types`.padEnd(14) + `${sb.typesPreserved} types`);

console.log("\nOUTPUT RICHNESS (what each engine actually emits)");
for (const s of rows) console.log(`  ${s.name.padEnd(24)} lines=${String(s.lines).padStart(5)}  cutPolys=${String(s.cutPolys).padStart(4)}  categories=${JSON.stringify(s.cats)}`);

console.log("\nSCALING (wall-clock, single-threaded, no GPU)");
console.log("  " + "meshes".padStart(7) + "triangles".padStart(11) + "ifc-lite".padStart(12) + "own".padStart(10) + "  ratio");
for (const n of [1, 10, 50, 200, 600]) {
  const big = tiled(n);
  const tris = triangleCount(big);
  let s = performance.now(); await generateFloorPlan(big, CUT, opts); const ea = performance.now()-s;
  s = performance.now(); ownPlan(big, CUT); const eb = performance.now()-s;
  console.log("  " + String(big.length).padStart(7) + String(tris).padStart(11) + `${ea.toFixed(0)} ms`.padStart(12) + `${eb.toFixed(0)} ms`.padStart(10) + `  ${(ea/eb).toFixed(2)}x`);
}
