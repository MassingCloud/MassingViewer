import { smallBuilding, tiled, triangleCount } from "./fixture.mjs";
import { generatePlan as ownPlan } from "./own-sectioner.mjs";
const { generateFloorPlan } = await import("@ifc-lite/drawing-2d");
const opts = { includeHiddenLines: true, includeProjection: true, includeEdges: true, mergeLines: true, useGPU: false };
const meshes = smallBuilding();

console.log("=== 1. hidden-line discrepancy: stats vs emitted categories ===");
const d = await generateFloorPlan(meshes, 1.2, opts);
console.log(`  stats.hiddenLineCount = ${d.stats.hiddenLineCount}`);
const cats = {}; const vis = {};
for (const l of d.lines) { cats[l.category]=(cats[l.category]||0)+1; vis[l.visibility]=(vis[l.visibility]||0)+1; }
console.log(`  emitted categories   = ${JSON.stringify(cats)}`);
console.log(`  emitted visibility   = ${JSON.stringify(vis)}`);
console.log(`  -> hidden lines are represented as visibility, NOT category: ${vis.hidden ?? 0} lines`);
console.log(`  -> so a renderer must filter on BOTH fields; category alone loses them.`);

console.log("\n=== 2. cut height with nothing to cut (above the building) ===");
for (const h of [5.0, 3.0, 0.0, -1.0]) {
  const r = await generateFloorPlan(meshes, h, opts);
  const o = ownPlan(meshes, h);
  console.log(`  h=${String(h).padStart(5)}  ifc-lite: ${String(r.lines.length).padStart(4)} lines ${String(r.cutPolygons.length).padStart(2)} polys   own: ${String(o.lines.length).padStart(4)} lines ${String(o.cutPolygons.length).padStart(2)} polys`);
}
console.log("  (h=3.0 is exactly the wall top, h=0.0 exactly the wall base — the coplanar cases)");

console.log("\n=== 3. rotated geometry (walls not axis-aligned) ===");
function rotate(meshes, deg) {
  const a = deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
  return meshes.map(m=>{ const p=new Float32Array(m.positions.length);
    for(let i=0;i<m.positions.length;i+=3){ const x=m.positions[i], z=m.positions[i+2];
      p[i]=x*c-z*s; p[i+1]=m.positions[i+1]; p[i+2]=x*s+z*c; }
    return {...m, positions:p}; });
}
for (const deg of [0, 30, 45, 17.3]) {
  const rm = rotate(meshes, deg);
  const r = await generateFloorPlan(rm, 1.2, opts);
  const o = ownPlan(rm, 1.2);
  const per = {}; for (const p of r.cutPolygons) per[p.entityId]=(per[p.entityId]||0)+1;
  const perO = {}; for (const p of o.cutPolygons) perO[p.entityId]=(perO[p.entityId]||0)+1;
  const ok = (per[100]===2 && per[101]===2 && per[104]===undefined);
  const okO = (perO[100]===2 && perO[101]===2 && perO[104]===undefined);
  console.log(`  ${String(deg).padStart(5)}deg  ifc-lite ${r.cutPolygons.length} polys ${ok?"CORRECT":"WRONG "+JSON.stringify(per)}   own ${o.cutPolygons.length} polys ${okO?"CORRECT":"WRONG "+JSON.stringify(perO)}`);
}

console.log("\n=== 4. large model, both engines (the scalability question) ===");
const big = tiled(2000);
console.log(`  ${big.length} meshes, ${triangleCount(big).toLocaleString()} triangles`);
let t=performance.now(); const rb = await generateFloorPlan(big, 1.2, opts); const ea=performance.now()-t;
t=performance.now(); const ob = ownPlan(big, 1.2); const eb=performance.now()-t;
console.log(`  ifc-lite ${ea.toFixed(0)} ms -> ${rb.lines.length.toLocaleString()} lines, ${rb.cutPolygons.length.toLocaleString()} polys`);
console.log(`  own      ${eb.toFixed(0)} ms -> ${ob.lines.length.toLocaleString()} lines, ${ob.cutPolygons.length.toLocaleString()} polys`);
console.log(`  per-triangle: ifc-lite ${(ea*1000/triangleCount(big)).toFixed(2)} us/tri | own ${(eb*1000/triangleCount(big)).toFixed(2)} us/tri`);
