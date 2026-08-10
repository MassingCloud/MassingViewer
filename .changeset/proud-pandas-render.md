---
"@massing/viewport": minor
"@massing/embed": minor
---

The renderer seam is wired in: WebGPU first, WebGL2 fallback, and the choice is reported.

**`createViewport` and `createMassingViewer` are now async.** `WebGPURenderer.init()` returns a promise, so the
renderer cannot be constructed synchronously — this is the whole cost of ADR-0012, and it is a breaking change to
both signatures. It is deliberately batched with federation (ADR-0013), which breaks the same surface, so a consumer
absorbs one change rather than two.

`Viewport.backend` is new: `{ backend, reason, degraded }`. Exposed rather than internal because ADR-0012 makes
surfacing it a requirement — *"a silent WebGL fallback means a user reports 'it's slow on my iPad' and nobody can
tell whether the fast path ever engaged."* Absent WebGPU is **not** flagged as degraded; only advertised-and-failed
is, because a warning that fires on every pre-iPadOS-26 device is one nobody reads.

`three/webgpu` is imported dynamically, so the ~1 MB WebGPU entry point never reaches a WebGL-only visitor.

`webGpuProbe` is injectable on both, so the advertised-but-unusable-adapter branch can be tested without hardware.
