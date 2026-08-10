# Roadmap — the settled plan after the 2026-08-09 platform review

This is the plan of record for work after M9. It exists because a proposed four-layer platform
specification (Python API / Rust core / TypeScript client / WebGPU runtime) was reviewed against what actually
exists, and the review changed three things: it **reversed** one decision, **rejected** two recommendations, and
**found that most of the proposed platform is already built** in sibling repositories nobody had mapped.

## What the review found

### The proposed platform is ~80% already built, in eight repositories

The single most useful output of the review. `MassingCloud` holds:

| Repository | What it is | Maps to |
|---|---|---|
| `ibuilder/massing` | FastAPI + Postgres + Redis + Celery, RBAC, tenancy, audit, 96 authoring recipes | "Layer 1: Python Platform" |
| `massingviser` | *A federated AEC platform in pure Python: plugin kernel, 15 capability tokens* | "Layer 1", federation |
| `massingifc` | Framework-agnostic kernel and plugin architecture for a federated AEC platform | contracts, plugin host |
| `massing-pdf` (**MIT**) | PDF markup, calibrated takeoff, issue pins, revision compare, XFDF/BCF | markup, review desk |
| `massing-families` (**CC0** content) | 419 families, 2,769 types, 57 discipline packs, IFC4 | family libraries |
| `massingcapture` | Reality capture for AEC in pure Python, content-first format detection | "digital twin", point clouds |
| `massingbill`, `massingplan` | Billing (G702/G703), CPM scheduling | 5D, 4D |
| **MassingViewer** | this repository | "Layer 3: TypeScript Client" |

**Our own ground truth was wrong about one of these.** The plan records `massingviser` as an *"unrelated Python
project"* needing a README disambiguation line. It is a federated AEC platform with a plugin kernel — the closest
thing in the org to the proposed Layer 1. That mis-characterisation is corrected here.

So what the proposal genuinely *adds* is three things: **a Rust core, WebGPU rendering, and federation.** Its
Phase 1 — upload IFC, convert, load one model, tree/properties/search/isolate/measure/saved views, RBAC, signed
assets — describes software that already ships.

### What was rejected, and why

- **A Rust core — deferred, not refused.** No measurement yet shows the TypeScript parser is the ceiling, and
  cargo + wasm-pack would be a fourth toolchain across two repos. The plan chose npm over pnpm because *"a third
  lockfile format in one org is a self-inflicted CI mystery"*; this is a larger version of the same bet. It gets
  made when a scale fixture proves it, which is why benchmarks come before it below.
- **IfcOpenShell ingestion — refused.** `ifcopenshell` is banned by name in `scripts/check-licenses.mjs` (LGPL),
  and massing's list excludes it too. If the proposal meant *format*-compatible rather than linking the library,
  that is fine and should be said explicitly.
- **The proposal's omission is the product.** It contains no 2D drawing generation at all — no plans, sections,
  sheets, title blocks or DXF/PDF. That loop is the researched market gap and the reason this repository exists.

## Decisions taken

- **[ADR-0012](adr/0012-webgpu-first-webgl-fallback.md)** — WebGPU first, WebGL2 fallback, fallback made visible.
  Reverses the plan's *"WebGL2 baseline forever"*, whose premise expired when Safari 26 / iPadOS 26 shipped WebGPU.
- **[ADR-0013](adr/0013-federation.md)** — federation with explicit per-model state.
- **[ADR-0004 amendment](adr/0004-2d-drawing-engine.md)** — the measured 2D winner is licence-blocked by the
  consumer; our own sectioner is what ships, and the known weaknesses are recorded rather than forgotten.

## The programme, in order

Ordering is by dependency and by blast radius, not by appeal.

### 1. Renderer seam + federation — one breaking change, not two

**Batched deliberately.** `WebGPURenderer.init()` returns `Promise<this>`, so `createViewport` becomes async;
federation replaces `showModel(...)` with add/remove and per-model state. Both break the same viewport API, and
massing is mid-adoption — so they ship together and massing absorbs one break.

Acceptance:
- `navigator.gpu` present → WebGPU; absent → WebGL2; the choice is **reported**, never silent (a silent fallback
  is a 5× cliff nobody notices — `docs/deployment.md`).
- Memory gate still exact. `info.memory` carries `geometries`, `textures`, `programs` on both renderers, and adds
  byte counters on WebGPU — verified in `@types/three`, so the gate ports and improves.
- **Blocker to solve first:** the visual gate's determinism rests on `--use-angle=swiftshader`, an ANGLE/WebGL
  path. WebGPU needs a Dawn/Vulkan software adapter, or the visual baselines mean nothing on the new renderer.
- Multi-model: per-model transform, visibility, discipline filter, appearance, selection context. Selection stays
  **GlobalId**-keyed across models, which is the seam massing's `planPaneSelection`/`specPane` already rely on.

### 2. Families — `packages/assets` and a Build-ribbon gallery

419 families, 2,769 types, 57 discipline packs, **CC0-1.0**, IFC4. The four draw verbs (wall, slab, column, plus
door/window openings) are not a family library and were never meant to be.

**Content is loaded, never vendored.** The plan already specifies this: *"Asset packs are code-free plugins. One
`.mvpack` manifest serves 3D families, 2D blocks, markup stamps, hatch patterns and sheet templates."* So
MassingViewer ships the format, the loader and the gallery under MIT; `massing-families` ships content under CC0.

**The integration point is massing's library endpoint, not the catalog repository.** Confirmed with the massing
session on 2026-08-09, against their tree rather than inferred: massing has already vendored their copy of "fetch_families.py"
there, `services/data/families/external/` holds 59 files including the architectural-assemblies pack,
`GET /families/library` is live and returns `external.packs`, and
`POST /projects/{pid}/families/import` copies every `IfcTypeProduct` in, deduped by class and name. So a
connected viewer reads **their** shelf. Fetching `massing-families` independently would give two copies of the
same library, free to drift — and the offline case is a cached pack, not a second fetcher.

**CC0 status, stated because it was worth asking.** massing's permitted list is MIT / BSD-2 / BSD-3 / 0BSD /
Apache-2.0 / ISC and does **not** name CC0-1.0 — while they already ship CC0-1.0 content, with
`"license": "CC0-1.0"` recorded in four places in their own manifest. Their written rule is narrower than their
shipped reality, which is the same shape of defect as this repository's `KNOWN_GOOD` tuple reading as a
seven-package pin. Treated as accepted on the basis of existing practice; the formal list change is with the
repository owner, because a permitted-licence list is not a thing either side should widen quietly.

The licence gate was corrected as part of this review: `massing-families` was blanket-forbidden on the strength of
GitHub reporting `NOASSERTION`, which is a *detection* artefact of its two licence files. Only "upstream/" is
genuinely off limits — it is a derivative of `ibuilder/massing`. Blocking 2,769 types of public-domain content for
a metadata artefact was the gate being wrong, not cautious.

Acceptance: `DRAFT_ELEMENTS` becomes galleries by discipline; the `params[]` form renders as the gallery flyout
*and* the prompt loop's keywords, one schema three renderings; drag-to-place from the gallery; every placed type
carries `MF_Library.License` through into the model, as the library intends.

### 3. Sheets, title blocks, and the review desk — adopt `@massingcloud/pdf-viewer`

**The plan pane has no title block. That is accurate and it is a real gap** — `svg.ts` emits a border and the
drawing, no title block, no revision, no north arrow, no scale bar. Tier-3 rasterisation found this from the other
direction: there was nothing to mask.

`massing-pdf` is **MIT**, public, and already on the plan's M0 list as a package to consume. It treats a markup as
a *record* — author, sheet revision, discipline, measurement, spec clause, IFC object, review status — with
rendering as one projection and XFDF/BCF/CSV/flattened-PDF as others. That is the review desk this product needs,
and rebuilding it here would be waste.

Acceptance: a sheet composes one or more viewports plus a title block from a template; `R38-SHEET-MARKUP` lands
(markup on a generated sheet resolving to an IFC GUID); `@massingcloud/pdf-viewer` is a dependency, not a fork;
its `pdfjs-dist` worker is bundled, never CDN-loaded, so the offline claim holds.

### 4. Benchmarks at scale — before any Rust decision

Two small fixtures today, scale explicitly deferred. Generate rather than commit: small / medium / large /
federated, with budgets measured and not guessed (`perf/README.md`'s posture). This is the gate that decides
whether a Rust core is justified, so it comes before it.

### 5. Then, and only if the numbers say so: Rust, version diffing, capture overlays

- Rust for parse/tessellate/fragment, if the benchmarks show the ceiling.
- Version diffing between milestones — genuinely absent, composes with existing GUID identity.
- Reality-capture overlays via `massingcapture`, rather than a new point-cloud pipeline here.

## What this roadmap does not do

- It does not build a Python platform. Two already exist.
- It does not adopt a runtime asset format in place of IFC parsing. massing already converts server-side and
  streams ".frag"; `showMeshes` (added 2026-08-09) is how such a host feeds this viewer with no IFC text.
- It does not restore the 2D differential oracle. One engine compares against its own previous output, which
  cannot catch a shared wrong assumption. `bench/` still runs both on demand — see `docs/testing.md`.
