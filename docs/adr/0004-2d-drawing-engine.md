# ADR-0004 — 2D drawing engine: adopt @ifc-lite/drawing-2d, keep our own cutter for interaction

- **Status:** **Amended** (2026-08-09) — the measured verdict stands and was **not implemented**, because the
  winner's licence is refused by the consumer this repository exists to serve. See "Amendment: the winner is
  licence-blocked" at the end. Originally **Accepted** (2026-08-06, on measured results — see "Verdict").
- **Date:** 2026-08-06, amended 2026-08-09

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

### An integration hazard found by running it

Identity in ifc-lite is **expressID-keyed throughout**, and the columnar table is **row**-indexed. Mixing
the two returns a different element's data with no error. Details, and a correction to what an earlier
version of this ADR claimed here, are under "Integration hazards" below.

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

### Integration hazards found by running it (both corrupt identity silently)

**1. The columnar arrays are ROW-indexed; the accessors are EXPRESSID-indexed. Mixing them returns another
element's data, with no error.**

`entities.expressId[]`, `.globalId[]`, `.name[]` are parallel arrays indexed 0..n-1 by row. But
`getGlobalId(id)`, `getName(id)`, `getTypeName(id)` and `getExpressIdByGlobalId()` all speak **expressID**.
For `Wall-South` in `fixtures/sample.ifc`: expressID **36**, row **4**. `getGlobalId(36)` is correct;
`getGlobalId(4)` returns empty. There is no type distinction between the two, so the mistake compiles and
usually returns *something*.

The arrays also hold **string-table indices, not strings** — `globalId[4]` is the number `13`. Because that
is truthy, a naive read produces confident nonsense: the first version of the probe reported
"77.6% GlobalId coverage" made entirely of small integers.

**Correction to an earlier version of this ADR.** It claimed `getExpressIdByGlobalId` returns a row index
"despite the name". That was wrong, and the ADR asserted it as a verified finding. Checked against ground
truth read directly out of `fixtures/sample.ifc` — where `#36` is unambiguously `Wall-South` — the function
returns **36**, i.e. an expressID, and is correctly named. The original probe had called `getGlobalId(row)`
and compared the answer against that row's `expressId`, which is comparing two different entities. The
round-trip `getGlobalId(getExpressIdByGlobalId(g)) === g` holds.

The underlying hazard is real and is arguably worse than the one first written down, because it applies to
every accessor rather than one function. The correct rule: **never index the columnar arrays and pass the
result to an accessor.** Go expressID-to-expressID throughout.

**2. Hidden lines are `visibility: 'hidden'`, not `category: 'hidden'`.** `stats.hiddenLineCount` reports 35,
and `category` only ever contains `cut` and `projection`. A renderer filtering on `category` alone silently
drops every hidden line while the stats insist they were produced. The SDM adapter must read **both** fields.

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

---

## Amendment: the winner is licence-blocked, and the code never adopted it

**2026-08-09.** Three artefacts in this repository disagreed with each other, and this section resolves that
rather than leaving the contradiction for someone to trip over.

### What the disagreement was

1. **This ADR** says *"Adopt `@ifc-lite/drawing-2d`"*, on measured results, and the consequences section
   describes `packages/drawings2d` wrapping it behind `DrawingProvider`.
2. **The code never did.** `@ifc-lite` appears in `packages/drawings2d` and `packages/viewport` **only in doc
   comments** — there is not one real import anywhere in `packages/*/src` or `apps/*/src`. What ships is our own
   sectioner: `packages/drawings2d/src/section.ts`, plus `plan.ts`, `svg.ts`, `dxf.ts` and `pdf.ts` on top of it.
   `@ifc-lite/drawing-2d` is a **root devDependency**, used by `bench/drawing-engines/` and nothing else.
3. **`scripts/check-consumer-licenses.mjs`** — added 2026-08-09 — now refuses exactly this adoption.
   `@ifc-lite/*` is MPL-2.0, and the gate holds the runtime closure of `@massing/embed` to *massing's* permitted
   list, which is MIT / MIT-0 / BSD-2 / BSD-3 / 0BSD / Apache-2.0 / ISC.

### Why the decision goes this way rather than the other

Not re-litigated on merit: **the consumer refused the licence, in writing.** massing's constraint, stated
verbatim during the M9 integration discussion:

> MPL-2.0 and BSL-1.0 are *not* on our permitted list — we tolerate weak copyleft only where it's already
> unavoidable in the ifcopenshell/certifi core, and a new one entering through a viewer dependency isn't that.

`ADR-0003` calls MPL-2.0 "permissive enough" **for this repository**, and that is still true — it is why the
bake-off was allowed to consider it, and why `resvg` and `axe-core` remain devDependencies here. But the whole
purpose of this repository is to be consumed by massing, and a dependency the consumer will not accept is not
available, however good it measured. Adopting it would move the problem into massing's audit, in massing's
repository, for a reason originating here.

### What therefore ships

**Our own sectioner, as the only drawing generator.** The bake-off's finding about *why* ifc-lite won is not
withdrawn and should not be forgotten — it is now a list of known weaknesses in what we ship:

- **Coplanar cuts.** Our cutter drops coplanar triangles by design, so a cut exactly at a datum emits **zero**
  loops. This ADR called that "the *normal* case in BIM, not an edge case", and it remains true. `plan-0050` in
  the golden suite exists to keep the grazing case visible, and `fixtures/plans.ts` documents it as the
  degenerate view.
- **The absent 6–12 months.** Projection bands, hidden-line removal, silhouette and crease edges, line merging,
  door symbols, north arrows, scale bars. Some of this now exists in `drawings2d`; the rest does not, and the
  plan already lists z-sort HLR as v1's honest approximation with exact BREP HLR cut.

Two consequences follow, and both are better recorded than assumed:

- **`DrawingProvider` keeps earning its place.** It was designed so either engine could back it. That is now what
  makes this reversible: if massing ever accepts MPL-2.0, or if ifc-lite relicenses, the adoption is a provider
  swap rather than a rewrite.
- **The differential oracle is gone, and that is a real loss.** The bake-off's best by-product was two engines
  disagreeing on a golden case being the cheapest bug detector available. With one engine, Tier 1 compares our
  sectioner against *its own previous output*, which cannot catch a shared wrong assumption. `bench/` still runs
  both, so the comparison is available on demand — it is simply no longer automatic. Noted in `docs/testing.md`.

### What was wrong in the original consequences section

- *"`packages/drawings2d` wraps `@ifc-lite/drawing-2d` behind `DrawingProvider`"* — it does not, and never did.
- *"add the `@ifc-lite/*` set to `scripts/check-fragments-version.mjs` as a coupled group"* — not done, and now
  should not be: that gate's `KNOWN_GOOD` already carries five pre-registered packages that are not installed,
  and adding four more phantom entries is how a gate's appearance drifts from its scope. See the note there.
