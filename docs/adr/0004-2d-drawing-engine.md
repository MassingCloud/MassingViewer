# ADR-0004 — 2D drawing engine: decision deferred to a measured bake-off

- **Status:** Proposed — awaiting the M0 bake-off result
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

## Status

This ADR is **Proposed**. It becomes Accepted when the table below is filled in, with the verdict and the
reasoning. An empty table means the decision has not been made, whatever anyone remembers deciding.

| Case | Provider | ms cold | ms warm | peak MB | guidCoverage | incomplete | SSIM | verdict |
|---|---|---|---|---|---|---|---|---|
| _(awaiting a building-shaped fixture — see "Not yet validated")_ | | | | | | | | |
