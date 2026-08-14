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

**Settled 2026-08-09: `modelmaker` is the platform**, and this repository integrates with it. `massingviser` is
analysed for what is worth borrowing server-side — its Python geometry pipeline (BVH picking, frustum culling,
clash, LOD, crease-aware tessellation), its capability-family contracts, its content-addressed versioning — and
**not** adopted as a second browser viewer. See [ADR-0014](adr/0014-python-server-javascript-viewport.md), which
also draws the Reflex boundary: Python and Rust own the server, compiled JavaScript owns the viewport, and a Reflex
shell (if adopted) mounts `@massing/embed` as a React component rather than putting a WebSocket in the snapping
path.

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

**Landed 2026-08-10: `packages/assets`** — the format, parser and queries, with 18 tests. It reads the real
`snake_case` document shape (modelled on massing-families' own `_family_index()` rather than invented), maps it to
one `camelCase` type, groups by discipline then category *preserving the library's own order*, searches label / key
/ classification, and reports the families the library itself calls L200 proxies so a gallery cannot present them
as finished geometry. It performs **no I/O** — the host owns the transport, which makes a cached offline pack and a
live endpoint the same code path. Every entry carries its `license` through, defaulting from the library rather
than blank, because that string follows the object into any model that imports it.

Still to do for item 2: the Build-ribbon gallery UI, drag-to-place, and wiring to massing's endpoint.

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

### 4. Benchmarks at scale — **measured 2026-08-10, and the answer is "not yet"**

`fixtures/scale.ts` generates buildings in memory rather than committing them, and `fixtures/scale.test.ts` measures
parse → tessellate → section end to end. Run it with `SCALE=1`; the generator's own correctness tests run every PR,
because a generator emitting subtly invalid STEP would make every number below authoritative-looking noise.

| case | IFC | products | triangles | parse ms | µs/element | cut ms | µs/mesh |
|---|---|---|---|---|---|---|---|
| small | 0.01 MB | 16 | 192 | 10 | 625 | 7 | 438 |
| medium | 0.07 MB | 144 | 1,728 | 85 | 590 | 14 | 97 |
| large | 0.34 MB | 640 | 7,680 | 130 | 203 | 11 | 17 |
| xlarge | 1.11 MB | 2,000 | 24,000 | 256 | 128 | 29 | 15 |

**Cost per element falls monotonically as the model grows** — 625 → 128 µs — so the pipeline is linear or better and
the small cases are dominated by fixed costs and JIT warm-up. Section cost per mesh flattens at ~15 µs. **Nothing
here says the TypeScript parser is a ceiling**, which is the evidence the Rust decision was waiting for, and the
answer at these sizes is no.

Three honest limits on that conclusion, because it is the kind of result that gets over-read:

- **The largest case is 1.11 MB.** The plan's motivating fixture is a *240 MB tower* — roughly 200× this. Linear
  extrapolation at 128 µs/element puts a model that size near **a minute** of parse, which *is* the regime where a
  Rust core would earn its toolchain. That is an extrapolation, not a measurement, and the fixture does not reach it.
- **Absolute times vary run to run** — xlarge parse measured 138 ms and 256 ms on consecutive runs of the same code
  on a loaded developer machine. The *shape* of the curve is the finding; the absolute numbers are not budget
  material, which is why this reports rather than gates.
- **Nothing here measures memory**, and peak worker memory is the other half of what breaks on a large model.

What would change the decision: extending the generator past ~100,000 elements and finding per-element cost rising,
or finding peak memory unacceptable. `massingviser`'s Python geometry pipeline (BVH picking, culling, clash, LOD) is
the comparison to borrow rather than repeat — see ADR-0014.

### 4b. What the benchmark does not yet cover

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

## M9 seam: validated from tarballs, 2026-08-14

The plan's risk #1 is divergence — every week both repositories hold a copy of the engine is debt at compound
interest — and M9 closes it by having massing consume `@massing/*` instead of its own `apps/web/src/viewer`. Nothing
had exercised that path, so "the seam is ready" rested on a ledger rather than on a consumer.

It has now been exercised without publishing anything. `npm pack --workspaces` produced 26 tarballs; installing them
as a set into an empty project — one with no access to `@massing/*` on any registry — resolved cleanly, and from
there:

- `@massing/embed` exports `createMassingViewer` as a function, plus the seam ledger
- `seamCoverage()` reports `ready: true`, `ratio: 1`, `gaps: []`
- `@massing/kernel-local` exports `createLocalKernel`; `@massing/drawings2d` exports `generatePlan`, `toSvg` and
  `sheetFurniture`

So the packaging, the dependency closure and the public surface all hold for a real outside consumer. **The only
remaining step on this side is publishing**, which is deliberately not automated here.

What this does *not* prove: that massing's application code compiles against these packages, or that deleting
`apps/web/src/viewer` leaves its test suite green. Those need the other repository and are the actual M9 work; this
removes the packaging unknown from in front of them.


---

# Reconciliation, 2026-08-14 — what shipped, what did not, and what is blocked

The programme above was written on 2026-08-09 and is still the plan. This section states, item by item, what is
actually true of the repository now, because a roadmap whose items are never marked off becomes a wish list that
reads like a status report.

## The five programme items

| # | Item | State |
|---|---|---|
| 1 | Renderer seam + federation | **Done**, and both halves needed fixing afterwards. The WebGPU fallback was not transparent — twice. Selection silently stopped highlighting the moment a second model loaded. See ADR-0012 and ADR-0013. |
| 2 | Families — `@massing/assets` + a Build-ribbon gallery | **Done.** Library parsing, `galleryFor` layout, a rendered panel with discipline tabs, search, drag-to-place, and availability dimmed with a reason. |
| 3 | Sheets, title blocks, review desk | **Half done.** Sheet furniture — border, title block, revision table, scale bar — ships across SVG, DXF and PDF, and 2D is now a peer surface rather than a side pane (ADR-0015). The **review desk is blocked**: it needs `@massingcloud/pdf-viewer` on npm. |
| 4 | Benchmarks at scale | **Done**, and extended: the drawing benchmark is joined by a main-thread measurement that found sectioning blocking for ~450 ms and is now the check that it stays fixed. |
| 5 | Rust, version diffing, capture overlays | **Not started, and correctly so.** Nothing measured says the TypeScript parser is the ceiling. |

## What shipped since the plan was written, that the plan did not ask for

Each of these came out of a defect found while doing something else, which is the honest reason they exist:

- **2D as a peer of 3D** — a canvas-mode reducer ported from upstream, because the plan pane was a strip.
- **Sectioning in a Worker** — the main-thread measurement asked for it.
- **A long-task measurement**, deliberately a report rather than a gate.
- **Three gate repairs**: the bundle budget, the message gate and the doc-path gate were each passing on stale or
  incomplete data. All three now refuse rather than reassure.

## Not done, in the order I would take them

1. **The two publishes.** `@massing/*` unblocks M9, and `@massingcloud/pdf-viewer` unblocks the review desk. Both
   are outside this repository's control. The packaging half of M9 is proven — see the tarball run above — so
   nothing technical stands in front of the first one.
2. **massing consumes the packages, and deletes its own viewer.** This is risk #1, the only one the plan says can
   end the project, and it is the one item where every week of delay costs something.
3. ~~**Tessellator out of `apps/demo`.**~~ **Done.** `@massing/tessellate` at layer 2, imported by both apps and by
   `fixtures/`; `SourceMesh` moved to `@massing/core` so a producer need not depend on a renderer. The divergence
   was worse than "two copies": the shell's had no `refDirection` and no `IfcRelVoidsElement`, so a rotated wall
   drew unrotated and a wall with a door drew solid — both silent, both shipped. Each is now pinned by a test
   verified by removing the behaviour and watching that test fail.
4. **The p95 frame-time gate.** Expect the same threshold problem the long-task measurement hit.
5. **Boot cost.** 148–182 ms of script evaluation, and `three` is not code-split. The trap is the service worker:
   changing the chunk graph is what broke the offline test twice on 2026-08-13.

## Known and unexplained

- **The offline-reload test, still.** It failed a fourth time on 2026-08-14, on a commit that changed only
  markdown — which is proof on its own that no code change caused it. What the trace from that run *did* establish:
  the navigation and every subresource failed while the precache provably held all of them, so the worker was not
  serving. That is a materially narrower statement than the two previous diagnoses, both of which were
  preconditions that turned out to be proxies, and neither of which this evidence supports.

  What has changed since: the worker now bounds its navigation fetch (a real defect on its own — an unbounded
  network-first shell hangs on a captive portal instead of opening from cache, unit-tested and sabotage-checked),
  the test wakes the worker before cutting the network, and — the part that matters — **the test now asserts
  delivery and names what was not served.** The next failure arrives with its cause attached instead of
  `element(s) not found`. None of this is claimed as the fix; the local harness also dies intermittently with
  `ECONNREFUSED`, which is a second unexplained thing in the same neighbourhood.

  **The diagnostic paid for itself immediately.** It failed again on 2026-08-14 and reported, instead of
  `element(s) not found`: `controlled: true`, with the document, the stylesheet and `sw-register.js` all served
  and exactly one asset missing — `/assets/index-DnnvlkEi.js`, the entry chunk (four on the retry). So the
  worker *was* running, controlling and serving, and missed specific assets the precondition had just confirmed
  were in Cache Storage. That rules out the previous reading, which was "the worker never started".

  The leading candidate is now `Vary`. `cache.match` honours it, and the two halves match differently: the
  precondition matches a **URL string**, while the worker matches the browser's real `Request`. Those disagree
  precisely when a stored response carries a `Vary` header, which would make the precondition pass on an entry
  the worker cannot then find. Not confirmed — it is a hypothesis with a mechanism, which is one more than the
  previous two rounds had, and it is checkable locally by comparing `cache.match(url)` against
  `cache.match(new Request(url))` after install.

  A second candidate worth eliminating in the same sitting: the precondition searches **every** cache
  (`for (const key of keys)`), and `activate` deletes all but the current one — so matching in a cache that is
  about to be deleted is a false positive by construction.
- The iPad `#dyn-hud` draft test has flaked three times under load and passes in isolation every time. Attributed
  to contention on each occasion, never root-caused. The offline test looked exactly like this and turned out to be
  a real race.
- German is 119/119 translated and **not native-reviewed**.
- `AA_TOLERANCE` in the raster suite has never run on Linux.
- The seam ledger in `@massing/embed` reports `ready` against 24 capabilities, and has not grown to cover the
  federation and sheet surface added since. It is measuring an older shape of the facade.
