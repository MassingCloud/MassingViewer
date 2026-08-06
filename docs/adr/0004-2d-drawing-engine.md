# ADR-0004 — 2D drawing engine: adopt @ifc-lite/drawing-2d, keep our own cutter for interaction

- **Status:** **Accepted** (2026-08-06, on measured results — see "Verdict")
- **Date:** 2026-08-06

## Context

Generating 2D plans and sections from a 3D model is the hardest part of this product, and the part where
the competition is weakest. Arcol states plainly that its drawing creation is underdeveloped; Bluebeam,
Revizto and Procore have no 3D authoring and consume PDFs somebody else made. Closing that loop is the
whole differentiator, so this engine choice matters more than any other dependency decision here.

Two credible paths:

**A. Adopt `@ifc-lite/drawing-2d`** (MPL-2.0, permissive enough — see
`docs/adr/0003-license-posture.md`). It already produces the four line classes that make a drawing look
architectural — cut, projection, hidden, hatching — plus door swings and stair arrows, SVG *and* DXF R12
output, title blocks, a paper-size registry, and a WebGPU compute-shader section cutter. That is a large
amount of genuinely hard work already done.

**B. Port massing's `services/data/src/aec_data/drawings.py`** (1,990 lines of Python) to TypeScript. It
carries drawing *intelligence* that a generic sectioner does not: grid bubbles derived by clustering,
collision-avoiding tag placement, poché keyed by IFC class and level of detail, material-layer build-up
dimension strings that report **declared versus measured** and flag disagreement, keynote leaders, break
lines, callout bubbles, and multi-viewport sheet composition.

## Decision

**Do not choose from the desk. Measure.**

Define `DrawingProvider` first, so either engine — or the remote service — can satisfy it, and the choice
stays reversible. Then run a scored bake-off over **6 fixture IFCs** (2 MB house to 240 MB tower, one
deliberately malformed) times **8 views** (three plans, two sections, two elevations, one axonometric),
recording per (provider, case):

- generation time, cold and warm
- peak worker memory
- entity count by line role
- **`guidCoverage`** — the fraction of drawing entities carrying an IFC GlobalId
- `incomplete[]` length — elements that failed to section
- bounds agreement against a reference, to 1 mm
- SSIM against curated reference renders
- semantic assertions: every `IfcWall` in the cut band has at least one cut entity; every `IfcSpace` has a
  region; door swings present; below-cut linework dashed

### `guidCoverage` is pass/fail, not a score

This is the one criterion that cannot be traded away. Plan-to-3D selection sync, markup anchoring, and
markup on generated sheets all depend on GlobalIds surviving the section cut. A drawing engine that
produces beautiful linework with no element identity can render pictures but **cannot participate in the
review loop** — which is the entire product thesis.

If `@ifc-lite/drawing-2d` wins on everything else but loses GUID fidelity, the hedge is a post-process that
re-associates output loops to GlobalIds via our own mesh-to-guid map. **That must be prototyped during the
bake-off, not assumed to be possible.**

### The loser stays

Whichever engine loses remains in-tree behind the same interface, as a fallback and as a
**differential-testing oracle**. Two providers disagreeing on a golden case is the cheapest bug detector
this project will ever get, and it costs nothing once the interface exists.

## The intermediate representation

Independent of which engine wins, the drawing model is a **Semantic Drawing Model**: entity geometry in
**model space (metres)**, never paper space, with every entity carrying `role` (cut / projection / hidden /
below / poche / grid / dimension / and so on), `ifcClass`, `layer`, and — repeating freely, since one
element becomes many loops — `guid`.

massing's plan generator bakes paper coordinates into its SVG, which freezes scale, paper size, theme and viewport
placement at generation time. Making paper a *render-time* transform buys three things at once:

- **Styling becomes a stylesheet.** Switching an architectural theme to a fire-safety theme is a repaint,
  not a regeneration. (massing's current plan generator takes a discipline flag at *generation* time —
  precisely the anti-pattern this removes.)
- **2D-to-3D sync works**, because identity is on every entity.
- **Export is serialisation.** SVG, DXF and PDF become three pure functions of
  `(Drawing, Theme, PaperTransform)`, with no parallel code paths to drift apart.

Every drawing also carries mandatory provenance: which elements failed to section, the GUID coverage, and
the approximations taken. This is the part most likely to be treated as optional and must not be — **a plan
that is silently missing a wall renders perfectly**, gives no visual cue, and the person who finds out is
on site.

## First-pass spike results (2026-08-06)

An exploratory spike ran against the real packages, ahead of the full scored bake-off. It does not settle
the ADR, but it settles the **pass/fail criterion** and it changes the scope of the question.

### The GUID criterion is MET, and cheaply

`DrawingLine` and `DrawingPolygon` both carry `entityId` (the IFC expressID), `ifcType`, and `modelIndex`.
`MeshData` — the input — carries `expressId`. So element identity survives the section cut.

expressID is not GlobalId: it is a STEP line number, stable within a file version but **not** across
edits. That gap closes with one map, because we own the parse. `@ifc-lite/parser` exposes GlobalIds and a
reverse lookup, so the hedge this ADR said "must be prototyped, not assumed" turns out to be a lookup
rather than geometry matching.

### Two concrete integration hazards found by running it

Both would have produced silently wrong identity, which is the worst failure mode available here.

1. **`getExpressIdByGlobalId` returns a ROW INDEX, not an expressID**, despite the name. Verified across
   three entities: `getGlobalId(getExpressIdByGlobalId(guid)) === guid` holds, but the return value must
   be used as `expressId[row]` before it can be matched against `DrawingLine.entityId`. Trusting the name
   yields a mapping that looks plausible and is wrong.
2. **The columnar arrays hold string-table indices, not strings.** Reading `entities.globalId[i]` directly
   returns a small integer, which is truthy — the first version of the spike reported "77.6% GlobalId
   coverage" made entirely of nonsense before the accessors (`getGlobalId(row)`) were used instead. Any
   adapter must go through the accessors.

### The scope of the question is bigger than this ADR assumed

The spike was scoped to `@ifc-lite/drawing-2d`. The surrounding packages turn out to matter more:

- **20+ packages on npm, all permissive**, last released three days before this spike. The full transitive
  tree was checked against `scripts/check-licenses.mjs`'s own logic and **passes** — including jszip's
  `(MIT OR GPL-3.0-or-later)`, where the OR means we take MIT.
- **`@ifc-lite/parser` (v3.15) runs in plain Node**, no browser and no WASM for the parse itself: 1,230
  entities in 12 ms. It exposes material layer sets, classifications, georeferencing, quantities,
  inherited property-set merging, spatial hierarchy, schedule extraction, and IFCX federation with
  overlays.
- **`drawing-2d` already ships much of the drawing intelligence** this ADR proposed porting from Python:
  `ARCHITECTURAL_PRESET` / `FIRE_SAFETY_PRESET` / `BUILT_IN_PRESETS`, `DEFAULT_OBJECT_STYLES`,
  `DEFAULT_LAYERS`, `DASH_PATTERNS`, `COMMON_SCALES`, `DXFExporter`, `DoorSymbolGenerator`,
  `EdgeExtractor`, `FRAME_PRESETS`, `DEFAULT_TITLE_BLOCK_FIELDS`, `DEFAULT_NORTH_ARROW`,
  `DEFAULT_SCALE_BAR`.
- **`@ifc-lite/mutations` is property and attribute editing, not geometry authoring.** Its surface is
  `MutablePropertyView`, `ChangeSetManager`, `BulkQueryEngine`, `StoreEditor`, `propertyKey` /
  `quantityKey` / `attributeKey`, `CsvConnector`. There is no `addWall`, no `extrude`, no parametric
  element model. **So it does not replace `LocalKernel`** — which sharpens rather than weakens the plan:
  ifc-lite is a pipeline and a data editor, and the modeller is still ours to build.

### Not yet validated

End-to-end drawing generation. The 58 IFC files available locally are massing's **family/type libraries**
— zero geometry entities and no storeys, so they exercise the parser and not the sectioner. A
building-shaped fixture is a prerequisite, and it is the same fixture M1 needs. Also unmeasured: cold/warm
timings at scale, peak worker memory, and output quality against a reference.

Note the license fence: those 58 files come from `MassingCloud/massing-families`, whose license is
"Other". They are usable for **local measurement only** and must not be committed here — see
`docs/adr/0003-license-posture.md`.

## The bake-off, as actually run

The IFC-fixture problem was sidestepped by a better experiment design. `generateFloorPlan(meshes, …)` takes
`MeshData[]` directly, so **both engines were given byte-identical input**: a synthetic single-storey
building (8 x 6 m, 200 mm walls, 3 m high) built as a triangle soup. Any difference in output is then
attributable to the algorithm, not to two different tessellations of the same wall — which a
parse-then-compare design could never guarantee.

The fixture is deliberately architectural rather than abstract boxes, because the cases that decide whether
a plan is usable are architectural:

- a south wall with a **door** (head 2.1 m) — the cut at 1.2 m must yield **two** loops, not one
- a north wall with a **window** (sill 0.9 m, head 2.1 m) — the cut passes through the opening, also two loops
- two solid walls — exactly one loop each
- a **slab entirely below the cut** — zero cut loops, and this is the one a naive cutter gets wrong
- a 300 mm **column** — a dot in plan, testing small-feature survival

The competing arm is a from-scratch TypeScript sectioner (`own-sectioner.mjs`, ~200 LOC): exact
plane-triangle intersection with the degenerate cases handled, spatial-hash loop stitching, below-cut
footprint projection. Written honestly, not as a straw man — a rigged comparison is worse than none.

### Results

| Criterion | `@ifc-lite/drawing-2d` | own sectioner |
|---|---|---|
| Door in cut band → 2 loops | PASS | PASS |
| Window in cut band → 2 loops | PASS | PASS |
| Solid walls → 1 loop each | PASS | PASS |
| Slab below cut → 0 cut loops | PASS | PASS |
| Column → 1 loop | PASS | PASS |
| **Identity coverage** | **100%** | **100%** |
| `ifcType` preserved | yes (3 types) | yes (2 — no projection, so the slab never appears) |
| Rotated geometry (0/30/45/17.3°) | correct | correct |
| **Cut exactly at wall top (h=3.0)** | **7 loops** | **0 loops** |
| **Cut exactly at wall base (h=0.0)** | **8 loops** | **0 loops** |
| Cut above the building (h=5.0) | 35 projection lines | nothing |
| Lines emitted (132-tri fixture) | 104 (28 cut + 76 projection) | 56 (cut only) |
| 264,000 triangles | 2,326 ms → 208k lines | 273 ms → 112k lines |
| Per triangle | 8.81 µs | 1.03 µs |

## Verdict

**Adopt `@ifc-lite/drawing-2d`.** Three reasons, in order of weight:

1. **It is correct on the degenerate cuts where ours produces nothing.** Cutting exactly at a datum is the
   *normal* case in BIM, not an edge case — a slab top sitting precisely on a storey elevation is
   ubiquitous. Our cutter drops coplanar triangles by design (documented, deliberate) and therefore emits
   **zero** loops at h=3.0 and h=0.0. That is not a bug to fix cheaply; robust coplanar handling is most of
   the difficulty in a sectioner.
2. **The surrounding work is already done.** Projection bands (visible-below / dashed-overhead), hidden-line
   removal, silhouette and crease edges, line merging, architectural and fire-safety presets, object styles,
   layers, dash patterns, scales, a DXF exporter, door symbols, title blocks, north arrows, scale bars. That
   is the 6-12 months this ADR was weighing, and it exists.
3. **It scales acceptably.** 2.3 s for 264,000 triangles, single-threaded with the GPU path disabled — fine
   inside a Worker, and there is a `useGPU` path plus a WebGPU compute cutter not yet exercised.

### The loser does not get deleted — it gets a different job

This is the finding worth keeping. Our sectioner is **8.5x faster on the cut-only path** (1.03 vs
8.81 µs/triangle). That is not a curiosity, it is a role:

- **`@ifc-lite/drawing-2d`** generates *drawings* — the full, correct, richly-classified output that gets
  styled, dimensioned, placed on a sheet and plotted.
- **our cutter** powers *interaction* — live cut lines while a user drags a section plane, where 60 fps
  matters far more than hidden-line fidelity and where nothing is being plotted.

Two engines for two jobs, behind one `DrawingProvider`. It also remains the differential-testing oracle the
original decision wanted: the two disagreeing on a golden case is the cheapest bug detector available, and
we now know exactly where they legitimately differ (coplanar cuts, projection) so a disagreement outside
those is a real signal.

### Integration hazards found by running it (all three would corrupt identity silently)

1. **`getExpressIdByGlobalId` returns a ROW INDEX, not an expressID**, despite the name. Use
   `expressId[row]` before matching `DrawingLine.entityId`.
2. **Columnar arrays hold string-table indices, not strings.** `entities.globalId[i]` is a truthy integer;
   the first probe reported "77.6% GlobalId coverage" of pure nonsense. Always use the accessors.
3. **Hidden lines are `visibility: 'hidden'`, not `category: 'hidden'`.** `stats.hiddenLineCount` says 35,
   and `category` never contains `hidden` — the categories are `cut` and `projection`. A renderer filtering
   on `category` alone silently drops every hidden line while the stats insist they were produced. The SDM
   adapter must read **both** fields.

### Consequences

- `packages/drawings2d` wraps `@ifc-lite/drawing-2d` behind `DrawingProvider`, adapting into the Semantic
  Drawing Model and resolving expressID → GlobalId on the way through.
- Never patch ifc-lite in-tree. MPL-2.0 requires modifications to *their files* stay MPL and be published;
  adapting at the boundary keeps that boundary clean. This is also what keeps the provider swappable.
- Pin exact versions and add the `@ifc-lite/*` set to `scripts/check-fragments-version.mjs` as a coupled
  group. Release velocity is high (parser 3.15, wasm 4.3, renderer 1.41) — active, and therefore churny.
- massing's drawing *intelligence* is still to be ported, because ifc-lite does not have it: grid bubbles by
  clustering, collision-avoiding tag placement, poché by class and LOD, and material-layer build-up
  dimensions that report declared-vs-measured and flag disagreement. That work now sits on top of a working
  sectioner instead of underneath a missing one.
- Not measured, and deliberately deferred: peak worker memory, the GPU path, and output quality against a
  curated reference render. Those need the M1 fixture and a browser; they gate nothing now that correctness
  and identity are settled.
