# ADR-0013 — Federation: many models, explicit per-model state

- **Status:** **Accepted** (2026-08-09)
- **Date:** 2026-08-09

## Context

Today this viewer holds **one** model. `viewport.showModel(meshes, resolveGuid, modelId)` *replaces* whatever was
there, `disposeScene`s it, and clears the selection. `createMassingViewer` takes a single `modelId`. There is no
way to hold an architectural model and a structural model at once, which is the ordinary condition of every real
coordination session.

This is the one genuine architectural gap the 2026-08-09 platform review found. Everything else the review
proposed either exists in a sibling repository or was rejected for cause; federation is absent and needed.

## Decision

**A federation manager with explicit per-model state — not scene groups.**

Models are registered, not swapped. Each carries its own state:

- transform (site-to-project alignment is per model, and getting it wrong is the classic federation bug)
- visibility, and a discipline filter
- appearance preset, so structural can be ghosted under architectural
- clipping participation
- selection context

**Identity stays GlobalId-keyed across models.** This is not a preference: massing's `planPaneSelection` and
`specPane` already cross modes by GlobalId, and `@massing/markup` anchors topics to GlobalIds. A federation that
introduced a per-model transient id as the cross-boundary identity would break both. Where a GlobalId collides
across models — and it does, because two consultants can export the same GUID — the pair `(modelId, guid)` is the
key, with `modelId` first so a single-model host reads unchanged.

## Consequences

**A breaking change to the viewport API, batched with [ADR-0012](0012-webgpu-first-webgl-fallback.md).**
`showModel` becomes add/remove/update against a registry. ADR-0012 makes `createViewport` async for
`WebGPURenderer.init()`. Both break the same surface, massing is mid-adoption, so **they ship together** and the
consumer absorbs one break rather than two. This is the whole reason they are sequenced adjacently in
`docs/roadmap.md` rather than by appeal.

**`showMeshes` generalises rather than changes meaning.** Added 2026-08-09 for a host that never hands over IFC
text, it already takes an explicit statement of how the kernel learns about the model. Federation adds *which*
model, which is the same shape of explicitness — and the reason that field was made required rather than defaulted
applies again: with several models loaded, "the kernel's current model" stops being a well-defined idea at all.

**The memory gate becomes more load-bearing, not less.** It asserts that twenty model replacements leave exactly
the same GPU buffer count. Under federation the equivalent invariant is that adding and removing a model returns
to baseline, per model — and with several models resident, a leak per add is far easier to introduce and far
harder to notice. The gate extends to add/remove cycles.

**Per-model state is a migration surface.** Saved views, markup and drawings all become model-scoped. Every
persisted artefact already carries `{schemaVersion, data}` with one pure `vN→vN+1` step per version, and a golden
fixture of each old format committed while it was current. That machinery exists precisely for this.

## Alternatives rejected

- **Scene groups with a naming convention.** What the proposal reviewed on 2026-08-09 warned against, correctly:
  *"avoid naive layering via generic scene groups alone."* State ends up implicit in the graph, and "is this model
  hidden" becomes a traversal instead of a lookup.
- **One merged model at import.** Cheap, and it destroys the thing federation is for — per-model visibility,
  per-model transforms, and knowing which consultant an element came from.
- **Defer until after families and sheets.** Rejected because it would mean two breaking API changes for massing
  instead of one, and because both of those features are model-scoped: building them single-model first would mean
  building them twice.
