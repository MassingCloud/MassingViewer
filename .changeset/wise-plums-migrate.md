---
"@massing/embed": minor
---

`showMeshes` — an entry point for a host that never hands over IFC text, and `tessellate` becomes optional.

massing converts IFC to Fragments server-side and streams geometry, and *"never parse full IFC in the browser at
runtime"* is one of its hard constraints. Before this, the only route for such a host was `viewport.showModel`,
which works, reports success, and **silently skips three things `openIfc` also does**: rebuilding the snap grid,
handing the model to the kernel, and invalidating a drawing and selection cut from the previous model. 3D renders
and picking works while snapping has no candidates and the first edit lands on whichever model the kernel last
opened.

Both entry points now route through one internal `applyModel`, so the half-wired path no longer exists.
`showMeshes` requires the caller to state how the kernel learns about the model, because both wrong answers are
silent: skipping the handoff leaves the kernel on the previous model, and calling `kernel.open(modelId)` with no
IFC text makes `LocalKernel` start a **blank** one. Sabotage-tested — removing the snap-grid rebuild and ignoring
`alreadyOpen` each fail a named test.

`tessellate` is now optional, so a host that never parses IFC no longer has to ship a `web-ifc` WASM payload it
would never execute. `openIfc` refuses with a sentence naming `showMeshes` when there is no tessellator.
`open()` is deprecated in favour of `openIfc` and delegates to it.
