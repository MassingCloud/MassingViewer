---
"@massing/viewport": patch
---

The WebGPU probe requires a device, not just an adapter.

ADR-0012 recorded the adapter-exists-but-init-fails path as unreachable here and therefore unproven. That was a
failure of imagination rather than of hardware: stubbing `navigator.gpu.requestAdapter` to return a non-null adapter
forces it in an ordinary browser, and doing so reproduced the original defect exactly — the same 64 occupancy cells.
Having an adapter does not avoid `init()` mutating shared state; only never reaching `init()` does.

`adapter.requestDevice()` is what actually fails on a machine advertising WebGPU it cannot deliver, and it fails
before `three/webgpu` is imported. Two forced shapes — an adapter with no `requestDevice`, one whose `requestDevice`
rejects — now produce zero silhouette change.

Still unguarded, and still recorded: an `init()` that fails despite a working device.
