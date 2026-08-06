# Drawing-engine bake-off

The harness behind `docs/adr/0004-2d-drawing-engine.md`. It is committed rather than thrown away for two
reasons: the decision it produced should be **re-runnable** by anyone who doubts it, and it becomes the
differential-testing oracle once both engines are in the product.

```bash
npm install                      # installs the @ifc-lite/* packages
node bench/drawing-engines/bakeoff.mjs
node bench/drawing-engines/edge-cases.mjs
```

## The experiment design, and why it is shaped this way

`generateFloorPlan(meshes, elevation, options)` takes `MeshData[]` directly, which means both engines can be
given **byte-identical input**. That matters more than it sounds: a design that parsed an IFC separately for
each engine could never prove the inputs matched, so any difference in output would be ambiguous between
"the sectioners disagree" and "the tessellators disagree". Feeding meshes isolates the thing being compared.

It also sidesteps needing a real building IFC — the fixture problem that was otherwise blocking this
decision.

## The fixture is architectural on purpose

`fixture.mjs` builds a single-storey building, 8 x 6 m, 200 mm walls, 3 m high, as a triangle soup. Abstract
boxes would have proved nothing, because the cases that decide whether a plan is usable are architectural:

| Element | Why it is in the fixture |
|---|---|
| South wall with a **door** (head 2.1 m) | A cut at 1.2 m must yield **two** loops. A cutter that returns one has merged across the opening. |
| North wall with a **window** (sill 0.9 m, head 2.1 m) | The cut passes *through* the opening — same test, different geometry. |
| Two solid walls | Exactly one loop each. Guards against over-splitting. |
| **Slab entirely below the cut** | Must yield **zero** cut loops. This is the one a naive cutter gets wrong, and the failure is invisible: the plan renders beautifully with a spurious rectangle around the whole building. |
| 300 mm **column** | A dot in plan. Small features are what get lost to tolerance bugs. |

`tiled(n)` replicates the building to measure scaling, up to 264,000 triangles.

## The competing arm is not a straw man

`own-sectioner.mjs` (~200 LOC) is a real implementation: exact plane-triangle intersection with the
degenerate cases handled, spatial-hash loop stitching (O(n), not O(n²)), and below-cut footprint projection.
It is the "port `drawings.py`" arm reduced to its core.

A rigged comparison is worse than no comparison, so what it *omits* is stated rather than hidden: no
hidden-line removal, no silhouette or crease edges, no hatching, no material layers, no door swings, no line
merging. The results account for that asymmetry — it emits 56 lines where ifc-lite emits 104, and is
correspondingly faster.

## What the run found

Both engines pass all five architectural criteria at 100% identity coverage, and both handle rotated
geometry. The decision turned on two things neither README would have told us:

- **Coplanar cuts.** At exactly the wall top (h=3.0) or base (h=0.0), ifc-lite yields 7–8 loops and ours
  yields **zero**. Cutting exactly at a datum is the normal case in BIM, not an edge case.
- **Speed on the narrow path.** Ours is **8.5x faster** doing cut-only (1.03 vs 8.81 µs/triangle) — which is
  why it survives as the interaction engine rather than being deleted.

Full numbers and the three integration hazards are in the ADR.

## Keep this honest

If you change either engine, re-run both scripts and update the ADR's table. A benchmark whose numbers no
longer match the code is worse than no benchmark, because the ADR cites it as evidence for a decision
somebody else is now relying on.
