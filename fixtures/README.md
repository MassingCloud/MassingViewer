# Fixtures

## `sample.ifc` — a small, real IFC4 building

8 × 6 m, single storey, 200 mm walls, 3 m high. 137 STEP entities, 6.5 KB.

```bash
node fixtures/build-sample.mjs      # regenerate (byte-identical every time)
npx vitest run fixtures             # assert the expected values
```

### Why it is authored rather than downloaded

Every downstream thing needs a building-shaped IFC — the drawing bake-off, the demo, golden drawings, E2E,
the perf gates — and there wasn't one:

- massing has **zero** committed `.frag` files, which is why its own Pages demo shows no geometry at all.
- The 58 IFC files in massing's tree are **family/type libraries**: no geometry entities, no storeys. They
  exercise a parser and never reach a sectioner.
- Those files are from `MassingCloud/massing-families`, license "Other", so they could not be committed here
  regardless — see `docs/adr/0003-license-posture.md`.

Authoring it makes it unambiguously MIT and small enough to commit. But the real reason is this: **it has
known-correct expected values.** `sample.test.ts` states the right answers independently and checks them. A
golden drawing generated from a downloaded sample is anchored to nothing — it records what the code did last
time, which is a snapshot, not a test.

It's also a rehearsal of something `LocalKernel` has to do anyway. Writing IFC correctly — entity graph,
placements, unit assignment — is the hard part, and doing it first for a case simple enough to verify by eye
is cheap insurance.

### Deliberate design choices

| Choice | Why |
|---|---|
| **Deterministic GlobalIds**, generated from a counter | A fixture whose ids change per build cannot be golden-tested, cannot have expected values written down, and dirties every unrelated diff. |
| **Fixed timestamp** | Same reason. Regenerating produces no diff, which `gate:fixtures` enforces. |
| **`IfcExtrudedAreaSolid`**, not a faceted BREP | An extrusion is what push/pull edits, and what `set_extrusion_depth` refuses to operate on when absent. A BREP fixture wouldn't exercise the representation the authoring tools care about. |
| **Real `IfcOpeningElement` + `IfcRelVoidsElement`** | A sectioner must *resolve a void*. Pre-split wall segments would hand it two loops and test nothing. |
| **Metres** | The whole codebase is metres internally (`packages/core/src/units.ts`). A millimetre fixture makes every geometric assertion 1000× wrong in a way that reads as a maths bug. |

### What each element is for

| Element | Purpose |
|---|---|
| `Wall-South` + `Door-01` (head 2.1 m) | A plan cut at 1.2 m must yield **two** loops. One loop means the cutter merged across the opening. |
| `Wall-North` + `Window-01` (sill 0.9, head 2.1) | Same test, different geometry — the cut passes through the middle of the opening. |
| `Wall-West`, `Wall-East` | Solid. Exactly one loop each — guards against over-splitting. |
| `Slab-Ground` | Entirely below the cut. Must yield **zero** cut loops. This is the one a naive cutter gets wrong, and the failure is invisible: the plan renders beautifully with a spurious rectangle around the whole building. |
| `Column-01` (300 mm) | A dot in plan. Small features are what get lost to a loose stitch tolerance. |

`sample.test.ts` asserts the *design* too, not just the content — that the cut height still falls inside both
openings, that the slab is still below it, that the column is still small. Otherwise someone can edit the
geometry, leave the file parsing perfectly, and quietly stop testing anything while every golden drawing
keeps passing.

### Verified against a real parser

`@ifc-lite/parser` reads it in 8 ms: schema IFC4, 137 entities, `lengthUnitScale: 1`, and all 8 elements
resolve by GlobalId with `hasGeometry: true`. That round-trip is what settled the accessor-semantics question
recorded in `docs/adr/0004-2d-drawing-engine.md` — having ground truth to check against is exactly the point
of a fixture with known values.

## Not here yet

A large model for the performance gates (the plan calls for up to ~240 MB). `bench/drawing-engines/fixture.mjs`
covers scaling today by tiling a synthetic building to 264,000 triangles, which is enough to measure the
sectioners but is meshes rather than IFC. A large *IFC* fixture is too big to commit and will need generating
on demand in CI instead.
