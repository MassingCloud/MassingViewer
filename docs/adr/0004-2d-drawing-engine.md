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

## Status

This ADR is **Proposed**. It becomes Accepted when the table below is filled in, with the verdict and the
reasoning. An empty table means the decision has not been made, whatever anyone remembers deciding.

| Case | Provider | ms cold | ms warm | peak MB | guidCoverage | incomplete | SSIM | verdict |
|---|---|---|---|---|---|---|---|---|
| _(to be filled by the M0 bake-off)_ | | | | | | | | |
