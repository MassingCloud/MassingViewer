# ADR-0012 — WebGPU first, WebGL2 fallback, and the fallback is visible

- **Status:** **Accepted** (2026-08-09). Supersedes the project plan's *"WebGL2 baseline forever, WebGPU behind a
  flag"*, whose premise expired.
- **Date:** 2026-08-09

## Context

The plan committed to WebGL2 as the permanent baseline with WebGPU behind a flag. That was correct when written,
and for one specific reason: **Safari had no WebGPU at all**, and Safari/iPad is this project's stated moat —
risk #6 calls it *"the moat, so failure is strategic not cosmetic"*. A renderer the moat platform cannot run is
not a baseline.

That premise no longer holds. WebGPU is baseline in **Safari 26, iOS 26, iPadOS 26 and visionOS 26**, alongside
Chrome 113+ and Firefox 147+. The reason for the original decision is gone, so the decision goes with it.

What exists today: `packages/viewport/src/viewport.ts` constructs `new THREE.WebGLRenderer(...)`, and that is the
only renderer in the repository. There is no WebGPU path and therefore nothing to fall back *from*.

## Decision

**Prefer WebGPU; fall back to WebGL2; report which one is in use.**

Three parts, and the third is not optional.

1. **A renderer seam in `packages/viewport`.** Both renderers are constructed behind one interface. `three@0.185.1`
   already ships "three.webgpu.js", so this costs **no new dependency** — it is an import and an abstraction.
2. **Feature-detect `navigator.gpu`**, and accept that detection is not enough on its own: adapter request can
   fail on a machine that advertises the API, so a failed `init()` falls back rather than failing the app.
3. **The active backend is surfaced in the UI and in telemetry counters.** `docs/deployment.md` already argues
   this for the single-threaded SharedArrayBuffer fallback: *"make the single-threaded fallback visible — a silent
   fallback is a 5× perf cliff."* The same reasoning applies here and it is the part most likely to be dropped as
   polish. A silent WebGL fallback means a user reports "it's slow on my iPad" and nobody can tell whether the
   fast path ever engaged.

## Consequences

**`createViewport` becomes async, and that is the real cost.** `WebGPURenderer.init()` returns `Promise<this>`.
That ripples to `createMassingViewer`, which is currently synchronous, and therefore to massing's integration.
Because federation ([ADR-0013](0013-federation.md)) breaks the same API, the two ship **together** so the consumer
absorbs one breaking change instead of two.

**The memory-leak gate ports, and improves.** Checked in `@types/three` rather than assumed: the WebGPU
renderer's `info.memory` carries `geometries`, `textures` and `programs` — the counts `e2e/memory.spec.ts` asserts
exactly — and *adds* byte-level counters (`attributesSize`, `texturesSize`, `total`). The gate keeps working and
gets a finer signal.

**The visual-regression gate is the actual blocker, and it must be solved first.** Determinism there rests on
`--use-angle=swiftshader`: a software rasteriser producing identical output on any host, with baselines keyed by
renderer string. That is an **ANGLE/WebGL** path. WebGPU needs a Dawn/Vulkan software adapter (SwiftShader has a
Vulkan target, so this is plausible rather than solved), and until it exists the visual baselines say nothing
about the WebGPU renderer. Shipping WebGPU with a WebGL-only visual gate would be a gate that reports green about
a code path it never exercises — the failure mode this repository writes its gates against.

**Not claimed:** that WebGPU is faster here. Nothing in this repository has measured it. The scale fixtures in the
roadmap come first precisely so the claim can be made from numbers instead of from the specification.

## Alternatives rejected

- **Keep WebGL2 only.** Defensible until Safari 26; now it forgoes compute-driven culling, large point clouds and
  GPU picking for no remaining compatibility reason.
- **WebGPU only.** iPadOS 26 is a *floor*, not the installed base. An iPad on iPadOS 18 is a real device in a real
  site office, and it is exactly the user this product claims.
- **Wait for WebGPU to be universal.** The fallback is genuinely cheap — two constructions behind one interface —
  so waiting buys nothing and postpones the seam that makes the swap safe.
