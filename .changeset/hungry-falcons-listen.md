---
"@massing/viewport": patch
---

Two fixes on surfaces that reported success while doing nothing.

**Selection stopped highlighting as soon as a second model was loaded.** Federation added a model registry, but
`select()` still resolved through a single `index` that pointed at *the only* model — an empty map whenever two were
present. Nothing was recoloured, while `selection` still updated and listeners still fired. Selection is now held as
`(modelId, expressId)` pairs, because an expressId is unique only within one IFC file; the shared colour cache had
the same collision, so deselecting could restore the other model's colour.

`select(expressIds, modelId?)` takes an optional model. `pick()` already returns it, so precise selection was always
available. Omitting it selects the id in every model that contains it — the deliberate reading of an ambiguous
request, and identical to the old behaviour for a single-model host. Removing a model now prunes only that model's
selection and cached colours, and notifies listeners when that actually drops something.

**A failed WebGPU initialisation was not free.** On a host advertising `navigator.gpu` with no obtainable adapter,
the seam imported `three/webgpu`, constructed a `WebGPURenderer` and awaited an `init()` that failed — after which
the WebGL2 renderer built in its place drew a measurably different picture. The probe now asks `requestAdapter()`
before importing or constructing anything, and reports "advertised but no adapter" as **not** degraded: nothing
failed, and WebGL2 is the correct answer on a device with no GPU. `degraded: true` is now reserved for an adapter
that exists and still will not initialise. See the 2026-08-11 amendment to ADR-0012.
